"""The SmartEscrow demo: the cafe-website story end to end on the scenario clock, with its evidence.

    python3 -m escrow.demo [--chain sim|monad] [--sample N] [--out runs/demo.json]      the full story
    python3 -m escrow.demo --changed [--chain ...] [--out runs/demo-changed.json]        changed words, new project
    python3 -m escrow.demo --audit runs/<project-id>                                    another person's check

A run writes runs/<project-id>/{log.jsonl, policy.json} (the records) and the run JSON the viewer reads
(web/index.html, schema of web/sample-run.json). The AI reads (Kiln qwen3-32b, cached on rerun); code decides
(pcp mandate.decide); the chain records (evidenceHash = the decision's log head) and settles.
--audit uses only the workdir's log and the chain (--chain monad|sim|none, default: the chain the log's first
line names): it re-derives every decision from the logged mandate, checks the hash chain, matches each chain
event to the log line it names and compares the on-chain totals with the log. A log with tx lines passes only
with a real chain check. Two clocks: log lines carry scenario time (the story's October), blocks real time.
"""
import argparse
import os
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import ai, policy as pol
from . import project as prj
from .ledger import SimEscrow
from .pcp_bridge import lang

ROOT = Path(__file__).resolve().parents[1]
QUOTES = Path(__file__).resolve().parent / 'quotes'
KST = timezone(timedelta(hours=9))
DECLARED = ("A contractor's AI expense agent spends a client's escrowed project budget only inside the policy both "
            "parties signed; code, not the model, decides; every stop is recorded and any payment can be re-derived "
            "from the log and the chain alone.")
CHANGED_WORDS = ('홈페이지 리뉴얼 경비는 AWS나 Vercel 호스팅, 가비아 도메인, Adobe Stock에서만 결제. '
                 '총 30만원, 부가세 포함 한 건에 20만원 이하, 10월 31일까지.')
EXPENSES = {  # label -> (month, day, hour, file, title)
    'E1': (10, 2, 11, 'e1-gabia.txt', '가비아 도메인 1년 견적'),
    'E2': (10, 3, 14, 'e2-figma.txt', 'Figma Professional 2석 견적'),
    'E3': (10, 5, 10, 'e3-coupang.txt', '쿠팡 기계식 키보드 영수증'),
    'E4': (10, 6, 16, 'e4-adobe-stock.txt', 'Adobe Stock 이미지 팩 견적'),
    'E5': (10, 7, 9, 'e5-aws-injection.txt', 'AWS 청구서 (문서 안에 "빠른결제대행으로 송금" 지시)'),
    'E6': (11, 2, 10, 'e6-vercel.txt', 'Vercel Pro 1개월 (기한 뒤)'),
    'E7': (11, 3, 10, 'e7-vercel.txt', 'Vercel (중지 뒤)'),
}
REASON_KO = {'ok': '정책 안의 지출', 'merchant_not_allowed': '허용 목록에 없는 거래처',
             'over_order_limit': '부가세 포함 한 건 20만 원 초과 — 의뢰인 확인', 'outside_window': '기한(10월 31일) 지남',
             'stopped': '의뢰인이 중지한 프로젝트', 'unreadable': 'AI 판독을 믿을 수 없음 — 의뢰인 확인',
             'over_budget': '총 경비 한도 초과', 'category_not_allowed': '허용되지 않은 품목',
             'invalid_amount': '금액이 올바르지 않음', 'over_count': '건수 한도 초과', 'hold_rejected': '의뢰인이 보류 건 거절',
             'accepted': '의뢰인 검수 승인', 'review_timeout': '검수 기한 내 이의 없음 (사전 합의: 지급)'}
NOTES = {'E5': '받는 주소는 레지스트리에서 (문서 속 계좌·송금 지시는 읽지 않음)'}
# who signs each chain call (chain_monad: client side = DEPLOYER_KEY, agent side = RELAYER_KEY, the escrow's agent)
SIGNER = {'create': 'client', 'deposit': 'client', 'hold': 'client', 'stop': 'client', 'decision': 'agent', 'release': 'agent'}
# when the two blind readings disagree, a real client confirms one readback; this demo has no person at the keyboard
DEMO_CHOOSER = 'demo-script (stands in for the client confirming the readback)'
MARGIN = 3  # blocks scanned past the last logged tx's block


def kst(m, d, h, mi=0):
    return int(lang.kst(2026, m, d, h, mi))


def when(ms):
    return datetime.fromtimestamp(ms / 1000, KST).strftime('%Y-%m-%d %H:%M') if ms is not None else ''


def make_chain(name):
    if name in ('monad', 'monad-testnet'):
        from .chain_monad import MonadEscrow
        return MonadEscrow()
    return SimEscrow()


def call_usage(calls):
    """One step's AI usage: recorded tokens/cost/seconds (a cached replay shows what it cost when live)."""
    u = [c.get('usage') or {} for c in calls]
    return {'tokens': sum((x.get('prompt_tokens') or 0) + (x.get('completion_tokens') or 0) for x in u),
            'cost_usd': round(sum(x.get('cost') or 0 for x in u), 6),
            'seconds': round(sum(c.get('latency_ms') or 0 for c in calls) / 1000, 2),
            'cached': all(c.get('cached') for c in calls) if calls else False,
            'generation_ids': [c.get('generation_id') for c in calls]}


class Run:
    """One story on one chain: drives the Project, keeps the steps and Kiln calls for the run JSON."""

    def __init__(self, chain, sample=0, runs=ROOT / 'runs'):
        self.chain, self.sample, self.steps, self.calls, self.seqs = chain, sample, [], [], {}
        pid = '0x' + os.urandom(32).hex()
        self.workdir = Path(runs) / pid
        self.pr = prj.Project(self.workdir, chain, project_id=pid)
        self.compiled = self.doc = None
        self.t0 = time.time()

    # -- steps
    def step(self, at, actor, action, title, out=None, outcome='INFO', reason=None, vendor=None, amount=None,
             payee=None, kind=None, ai_use=None, note=None, **extra):
        out = out or {}
        amount = int(amount) if isinstance(amount, float) and amount.is_integer() else amount
        tx = (out.get('chain') or {}).get(kind) if kind else None
        s = {'n': len(self.steps) + 1, 'at': when(at), 'actor': actor, 'action': action, 'title': title,
             'outcome': outcome, 'reason': reason,
             'reason_ko': (REASON_KO.get(reason, reason) if reason else None) and REASON_KO.get(reason, reason) + (
                 f' · {note}' if note else ''),
             'vendor': vendor, 'amount': amount, 'payee': payee, 'log_index': out.get('log_index'),
             'log_head': '0x' + out['log_head'] if out.get('log_head') else None,
             'tx': tx['tx'] if tx and tx['ok'] else None, 'tx_error': tx['error'] if tx and not tx['ok'] else None,
             'chain_signer': SIGNER.get(kind) if tx else None, 'ai': ai_use, 'balances': self.balances(), **extra}
        self.steps.append(s)
        amt = f'{amount:>10,}' if isinstance(amount, (int, float)) else ' ' * 10
        txt = s['tx'] or (f"chain refused: {s['tx_error']}" if s['tx_error'] else '')
        print(f"{s['n']:>2} {s['at']} {actor:<10} {action:<16} {outcome:<7} {reason or '':<20} {amt}  "
              f"log#{s['log_index'] if s['log_index'] is not None else '-'} {txt}  {title}", flush=True)
        return s

    def balances(self):
        st = self.pr.state()
        return {k: st[k] for k in ('deposited', 'reserved', 'paid', 'refunded', 'available')}

    # -- the story's moves
    def policy(self, words, at, milestones=pol.MILESTONES, title='카페 홈페이지 리뉴얼'):
        """Compile the words (two blind readings), pick the option, propose, both sign, deposit (activates)."""
        c = ai.compile_policy(words, at, sample=self.sample)
        self.calls += c['calls']
        ok = [o for o in c['options'] if o['ok']]
        if not ok:
            raise SystemExit(f"neither reading built a mandate: {[o['error'] for o in c['options']]}")
        chosen = next((o for o in ok if o['source'] == 'writer'), ok[0])
        by = 'agreement' if c['agree'] else DEMO_CHOOSER
        if not c['agree']:  # show what a client would be asked to confirm: both readbacks and PCP's findings
            print(f"readings disagree (same mandate: {c['same']}); a client would confirm one readback. "
                  f"PCP problems: {c['problems'] or '-'}; differences: {c['differences'] or '-'}", flush=True)
            for o in c['options']:
                print(f"  [{o['source']}] {'ok' if o['ok'] else 'FAILED ' + str(o['error'])}  hash {str(o['hash'])[:16]}  "
                      f"problems {o['problems'] or '-'}", flush=True)
                for line in o['readback']:
                    print(f'      {line}', flush=True)
            print(f"  -> {chosen['source']} chosen by the {DEMO_CHOOSER}", flush=True)
        reading = {'agree': c['agree'], 'same': c['same'], 'chosen': chosen['source'], 'chosen_by': by,
                   'differences': c['differences'], 'problems': c['problems'],
                   'readings': [{k: o[k] for k in ('source', 'ok', 'hash', 'readback', 'problems', 'error')}
                                for o in c['options']],
                   'hashes': {o['source']: o['hash'] for o in c['options']},
                   'generation_ids': [x.get('generation_id') for x in c['calls']], 'model': ai.routing.stage('quote')['model']}
        parties = {p: self.pr.address_of(p) for p in ('client', 'contractor', 'resolver')}
        self.doc = pol.make(title, parties, milestones, words, chosen['module'])
        self.compiled = {'words': words, 'reading': reading, 'readback': self.doc['expense']['readback'],
                         'readings': reading['readings'],
                         'expressions': chosen['expressions']}
        out = self.pr.propose_policy(self.doc, at, reading=reading)
        use = {'flow': 'policy (write/read/reread)', **call_usage(c['calls']),
               'extracted': {'agree': c['agree'], 'same': c['same'], 'chosen': chosen['source'], 'by': by,
                             'problems': c['problems'][:2]}}
        self.step(at, 'client', 'policy', f"경비 정책 두 번의 블라인드 판독 → {chosen['source']} 채택"
                  + ('' if c['agree'] else ' (판독 불일치 — 의뢰인 확인 대신 데모 스크립트가 선택)'), out,
                  ai_use=use, policy_hash=out['policy_hash'])
        h = out['policy_hash']
        self.sigs = {}
        for i, party in enumerate(pol.SIGNERS):
            self.sigs[party] = pol.sign(party, h)
            o = self.pr.sign(party, self.sigs[party], at + (i + 1) * 60000)
            self.step(at + (i + 1) * 60000, party, 'sign', f"{'의뢰인' if party == 'client' else '작업자'} 서명 (같은 정책 해시)",
                      o, 'SIGNED')
        need = pol.required_deposit(self.doc)
        o = self.pr.deposit(need, at + 10 * 60000)
        created = (o.get('chain') or {}).get('create') or {}
        self.step(at + 10 * 60000, 'client', 'deposit', '예치 → 프로젝트 활성 (체인에 프로젝트 생성·예치)', o, 'FUNDED',
                  amount=need, kind='deposit', create_tx=created.get('tx'))
        return h

    def expense(self, label, file=None, at=None, title=None):
        m, d, h, fname, t = EXPENSES[label]
        at = at or kst(m, d, h)
        text = (QUOTES / (file or fname)).read_text(encoding='utf-8')
        r = ai.read_quote(text, sample=self.sample)
        self.calls += r['calls']
        use = call_usage(r['calls'])
        source = {'file': f'escrow/quotes/{file or fname}', 'digest': r['digest'], 'fields': r['fields'],
                  'problems': r['problems'], 'model': ai.routing.stage('quote')['model'], 'generation_ids': use['generation_ids']}
        if r['ok']:
            out = self.pr.request_expense(r['proposal'], source, at)
        else:
            out = self.pr.request_ai_failed(source, at, proposal=r['proposal'])
        d_ = self.pr.state()['decisions'][out['seq'] - 1]
        self.seqs[label] = out['seq']
        p = r['proposal'] or {}
        extracted = {'vendor_text': r['fields'].get('vendor_text'), 'merchant': p.get('merchant'),
                     'amount': p.get('amount'), 'fee': p.get('fee'), 'total': out['total'], 'units': p.get('units')}
        if r['problems']:
            extracted['problems'] = r['problems']
        self.step(at, 'ai', 'expense', f'{label} {title or t} — AI 판독·규칙 결정', out, out['verdict'], out['reason'],
                  d_['vendor'], out['total'], kind='decision', note=NOTES.get(label),
                  ai_use={'flow': 'quote', **use, 'extracted': extracted}, label=label,
                  evidence_hash=out['evidence_hash'], document=source['file'], document_digest=r['digest'])
        return out

    def settle(self, label, at):
        seq = self.seqs[label]
        out = self.pr.settle(seq, at)
        d = self.pr.state()['decisions'][seq - 1]
        return self.step(at, 'agent', 'release', f'{label} 지급 (레지스트리 주소로, 에이전트 키가 전송)', out, 'PAID', 'ok', d['vendor'],
                         d['total'], out['payee'], kind='release', label=label, evidence_hash=d['evidence'],
                         evidence_log_index=d['log_index'])

    def hold(self, label, approve, at):
        seq = self.seqs[label]
        out = self.pr.hold(seq, approve, at)
        d = self.pr.state()['decisions'][seq - 1]
        return self.step(at, 'client', 'approve_hold' if approve else 'reject_hold',
                         f"{label} 보류 건 {'승인' if approve else '거절 — 지급 안 됨'}", out,
                         'APPROVE' if approve else 'BLOCK', None if approve else 'hold_rejected', d['vendor'], d['total'],
                         kind='hold', label=label, evidence_hash=d['evidence'])

    def milestone_paid(self, out, at, actor, action, mid, reason):
        m = next(m for m in self.pr.state()['milestones'] if m['id'] == mid)
        self.step(at, actor, action, f"{mid} {m['title']} — " + ('의뢰인 승인' if reason == 'accepted' else '검수 기한 경과·이의 없음'),
                  out, 'APPROVE', reason, 'contractor', m['amount'], out['payee'], kind='decision', label=mid,
                  evidence_hash=m['evidence'])
        self.step(at, 'agent', 'release', f'{mid} 작업자에게 지급 (에이전트 키가 전송)', out, 'PAID', 'ok',
                  'contractor', m['amount'], out['payee'], kind='release', label=mid, evidence_hash=m['evidence'],
                  evidence_log_index=m['log_index'])

    def submit(self, mid, at):
        out = self.pr.submit_milestone(mid, at)
        m = next(m for m in self.pr.state()['milestones'] if m['id'] == mid)
        self.step(at, 'contractor', 'milestone_submit', f"{mid} {m['title']} 제출 (검수 {m['review_days']}일, 기한 {when(m['due_at'])})",
                  out, amount=m['amount'], label=mid)

    def accept(self, mid, at):
        self.milestone_paid(self.pr.accept_milestone(mid, at), at, 'client', 'milestone_accept', mid, 'accepted')

    def tick(self, at):
        out = self.pr.tick(at)
        if not out.get('paid'):
            return self.step(at, 'anyone', 'tick', '시간 경과 확인 — 지급할 마일스톤 없음 (검수 기한 전)', out)
        for o, mid in zip(out['lines'], out['paid']):
            self.milestone_paid(o, at, 'anyone', 'milestone_timeout', mid, 'review_timeout')

    def stop(self, at, why):
        out = self.pr.stop(at, why)
        self.step(at, 'client', 'stop', f'의뢰인이 에이전트 중지: {why}', out, 'STOP', kind='stop')

    def close(self, at):
        out = self.pr.close(at)
        self.step(at, 'client', 'close', '정산·환불 = 예치 − 지급 − 미결 예약 (체인 밖: 레거시 계약에 withdraw 없음)', out,
                  'REFUND', amount=out['refund'])

    def audit(self, at):
        a = self.pr.audit()
        bad = [c for c in a['onchain'] if not c['ok']]
        self.audit_result = a
        self.step(at, 'auditor', 'audit', f"제3자 감사 (로그 + 체인 이벤트만): {'모두 일치' if a['all_ok'] else '불일치'}"
                  f" — 이벤트 {len(a['onchain'])}건, 불일치 {len(bad)}건, 누락 {len(a['missing'])}건", {},
                  'INFO' if a['all_ok'] else 'BLOCK', all_ok=a['all_ok'])
        return a

    # -- the run JSON
    def document(self, title):
        st = self.pr.state()
        ch = self.chain
        dep = getattr(ch, 'explorer_base', None)
        chain = {'name': ch.name, 'chain_id': 10143 if ch.name == 'monad-testnet' else None,
                 'explorer': dep.rsplit('/tx/', 1)[0] if dep else None, 'escrow': getattr(ch, 'escrow', None),
                 'token': getattr(ch, 'token', None), 'project_id': self.pr.project_id,
                 'reads': 'projects(projectId) (budget, deposited, spent, stopped); events by projectId topic',
                 'writes': 'createProject, deposit, recordDecision (evidenceHash = log head), approveHold/rejectHold, stopProject',
                 'settles': 'release(projectId, evidenceHash, payee, amount): test-token transfer to the registry payee',
                 'onchain_project': ch.project(self.pr.project_id)}
        receipts = []
        for d in st['decisions']:
            receipts.append({'seq': d['seq'], **self.pr.receipt(d['seq'])})
        for m in st['milestones']:
            if m['status'] == 'paid':
                receipts.append({'seq': m['id'], **self.pr.receipt(m['id'])})
        for r in receipts:
            r['log_head'] = '0x' + r['log_head'] if r.get('log_head') else None
            r['total'] = int(r['total']) if isinstance(r['total'], float) and r['total'].is_integer() else r['total']
        a = self.audit_result
        live = ai.usage_by_flow(self.calls)
        rec = ai.usage_by_flow(self.calls, recorded=True)
        c = self.compiled
        return {
            'title': title, 'declared_function': DECLARED,
            'generated_at': datetime.now(KST).isoformat(timespec='seconds'),
            'mode': 'sim' if ch.name == 'sim' else 'live', 'workdir': str(self.workdir.relative_to(ROOT)),
            'wall_seconds': round(time.time() - self.t0, 1), 'chain': chain,
            'policy': {'version': self.doc['version'], 'hash': st['policy_hash'], 'words': c['words'],
                       'readback': c['readback'], 'agree': c['reading']['agree'], 'same': c['reading']['same'],
                       'chosen': c['reading']['chosen'], 'chosen_by': c['reading']['chosen_by'],
                       'readings': c['readings'], 'expressions': c['expressions'], 'mandate_hash': '0x' + st['mandate_hash'],
                       'signatures': self.sigs,
                       'milestones': [{'id': m['id'], 'title': m['title'], 'amount': m['amount']} for m in self.doc['milestones']]},
            'steps': self.steps, 'receipts': receipts,
            'audit': {**{k: a[k] for k in ('log_chain_ok', 'bad_line', 'replay_error', 'match', 'missing', 'all_ok')},
                      'replay_state_hash': '0x' + a['replay_state_hash'] if a['replay_state_hash'] else None,
                      'live_state_hash': '0x' + a['live_state_hash'] if a['live_state_hash'] else None,
                      'onchain': [{**e, 'matches': e['ok'], 'why': e['why'] or (
                          f"evidenceHash = log head #{e['log_index']}" if e['log_index'] is not None else 'matches the log')}
                          for e in a['onchain']]},
            'usage': {'by_flow': rec, 'this_run': live,
                      'total_cost_usd': round(sum(r['cost_usd'] for r in rec), 6),
                      'this_run_cost_usd': round(sum(r['cost_usd'] for r in live), 6),
                      'energy_assumption': (f'추정값 (상한 아님): FuriosaAI RNGD 카드 1장({ai.WATTS} W 공개 TDP)이 측정 지연(초) 동안 '
                                            '일한다고 가정 — Wh = W × 초 / 3600, 네트워크 시간 포함. Kiln 엔드포인트의 하드웨어는 공개되지 않아 '
                                            '알 수 없음 : 카드 N장이 한 요청을 나눠 처리하면 N배, Kiln이 요청을 묶어 '
                                            '처리하면 한 호출의 몫은 더 작음. by_flow는 캐시 재실행도 처음 실시간 실행 때 기록된 사용량으로 셈 '
                                            '(this_run = 이번 실행의 실제 과금).')},
            'criteria': self.criteria(a, receipts),
        }

    def boundary(self):
        """The signed boundary in words, from the chosen reading's expressions (the readback when they do not parse)."""
        ex = self.compiled['expressions'] or {}
        vendors = re.findall(r'm == "([\w.-]+)"', ex.get('merchant_ok') or '')
        order = re.fullmatch(r'\s*total\s*<=\s*(\S+)\s*', ex.get('order_ok') or '')
        until = re.search(r'day_end\((\d+),\s*(\d+),\s*(\d+)\)', ex.get('window_ok') or '')
        if not (vendors and order and until and ex.get('budget')):
            return ' / '.join(self.compiled['readback'])
        return (f"{len(vendors)} vendors ({', '.join(vendors)}), {order.group(1)} 원/건 VAT 포함, 총 {ex['budget']} 원, "
                f"~{until.group(1)}-{int(until.group(2)):02}-{int(until.group(3)):02}")

    def criteria(self, a, receipts):
        """Challenge B's items, each computed from this run's own steps, receipts, audit and Kiln calls."""
        S, st = self.steps, self.pr.state()
        n = lambda f: [s['n'] for s in S if f(s)]  # noqa: E731
        sim = self.chain.name == 'sim'
        approved = {s.get('label') for s in S if s['action'] == 'approve_hold'}
        stopped = [s for s in S if s['action'] == 'expense' and (s['outcome'] == 'BLOCK' or (
            s['outcome'] == 'HOLD' and s.get('label') not in approved))]
        stops = sorted({s['n'] for s in stopped} | set(n(lambda s: s['action'] == 'reject_hold')))
        why = ', '.join(f"{s.get('label')} {s['reason']}" for s in stopped)
        on_chain = [s for s in stopped if s['tx']]
        txs = n(lambda s: s['tx'] and s['log_index'] is not None)
        ai_steps = [s for s in S if s['ai']]
        tokens = sum(s['ai']['tokens'] for s in ai_steps)
        signs = n(lambda s: s['action'] == 'sign' and s['outcome'] == 'SIGNED')
        funded = n(lambda s: s['action'] == 'deposit' and s['outcome'] == 'FUNDED')
        stop = n(lambda s: s['action'] == 'stop' and s['outcome'] == 'STOP')
        paid = [r for r in receipts if r.get('status') == 'paid']
        expenses = [s for s in S if s['action'] == 'expense']
        return [
            {'id': 'function', 'text': f'Declared function (one sentence, top of the run): {DECLARED}',
             'ok': bool(DECLARED) and bool(n(lambda s: s['action'] == 'policy')), 'steps': n(lambda s: s['action'] == 'policy')},
            {'id': 'boundary', 'text': f'Boundary: the signed mandate ({self.boundary()}), signed by both '
             f"({', '.join(p for p, v in st['signed'].items() if v) or 'nobody'}) and enforced in code (pcp mandate.decide) "
             f"before any chain call — {len(expenses)} requests decided, each a log line. On chain only: release needs a "
             f"recorded APPROVE, stays within budget = the whole deposit ({st['deposited']:,}), stop",
             'ok': all(st['signed'].values()) and bool(funded) and bool(expenses)
             and all(s['log_index'] is not None for s in expenses),
             'steps': n(lambda s: s['action'] in ('policy', 'sign', 'deposit'))},
            {'id': 'out_of_scope', 'text': f'>=2 requests outside scope stop and are recorded: {len(stopped)} stopped ({why}); '
             f'each a log line, {len(on_chain)} also a recordDecision tx' + (
                 f' ({len(stopped) - len(on_chain)} refused by the chain and logged)' if len(on_chain) < len(stopped) else ''),
             'ok': len(stopped) >= 2 and all(s['log_index'] is not None for s in stopped), 'steps': stops},
            {'id': 'kiln_usage', 'text': f"Kiln token usage by flow ({len(self.calls)} calls, {tokens:,} tokens, "
             f"{ai.routing.stage('quote')['model']}) + energy estimate with its assumption",
             'ok': bool(self.calls) and all(s['ai']['tokens'] > 0 for s in ai_steps), 'steps': [s['n'] for s in ai_steps]},
            {'id': 'tx_log', 'text': f'Testnet tx hash with the matching log entry (evidenceHash = log head): {len(txs)} txs'
             + (' — simulated chain, not a testnet' if sim else f' on {self.chain.name}'),
             'ok': bool(txs) and a['all_ok'] and not sim, 'steps': txs},
            {'id': 'human', 'text': f'Human: grant a budget ({len(signs)} signatures + deposit), follow spending (balances '
             f"per step), stop ({'step ' + str(stop[0]) if stop else 'none in this run'}), receipts ({len(paid)} paid)",
             'ok': len(signs) == len(st['signed']) and bool(funded) and bool(stop) and bool(paid),
             'steps': n(lambda s: s['action'] in ('sign', 'deposit', 'approve_hold', 'reject_hold', 'stop', 'close'))},
            {'id': 'reconstruct', 'text': 'Another person reconstructs from the records alone '
             f'(python3 -m escrow.demo --audit {self.workdir.relative_to(ROOT)})' + (
                 ' — sim: the simulated chain is gone after the run, so a standalone audit of this workdir fails' if sim else ''),
             'ok': a['all_ok'] and bool(n(lambda s: s['action'] == 'audit')), 'steps': n(lambda s: s['action'] == 'audit')},
        ]

    def finish(self, title, out_path):
        (self.workdir / 'policy.json').write_text(json.dumps(
            {'policy_hash': pol.policy_hash(self.doc), 'signatures': self.sigs, 'doc': self.doc,
             'reading': self.compiled['reading']}, ensure_ascii=False, indent=1), encoding='utf-8')
        run = self.document(title)
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding='utf-8')
        print(f"\nrun -> {out_path}   records -> {self.workdir}/   audit all_ok={run['audit']['all_ok']}   "
              f"wall {run['wall_seconds']}s")
        for r in run['usage']['by_flow']:
            print(f"  kiln {r['flow']:<7} calls {r['calls']} (live {r['live_calls']})  tokens {r['prompt_tokens']}+"
                  f"{r['completion_tokens']}  ${r['cost_usd']:.6f}  {r['seconds']}s  ~{r['energy_wh']} Wh (1 card est.)")
        return run


def story(chain, sample, out):
    """The full story: E1..E7, M1 accepted, M2 by silence, stop, close, receipts, audit."""
    r = Run(chain, sample)
    print(f'SmartEscrow demo · chain {chain.name} · project {r.pr.project_id}')
    r.policy(pol.WORDS, pol.ISSUED)
    for label, at in (('E1', None), ('E2', None), ('E3', None), ('E4', None)):
        o = r.expense(label, at=at)
        if o['verdict'] == 'APPROVE':
            r.settle(label, kst(*EXPENSES[label][:3], 5))
    if r.pr.state()['decisions'][r.seqs['E4'] - 1]['status'] == 'held':
        r.hold('E4', False, kst(10, 6, 18))
    if r.expense('E5')['verdict'] == 'APPROVE':
        r.settle('E5', kst(10, 7, 9, 5))
    elif r.pr.state()['decisions'][r.seqs['E5'] - 1]['status'] == 'held':
        r.hold('E5', False, kst(10, 7, 11))
    r.submit('M1', kst(10, 10, 17))
    r.accept('M1', kst(10, 11, 10))
    r.submit('M2', kst(10, 20, 17))
    r.tick(kst(10, 22, 9))
    r.tick(kst(10, 24, 9))
    r.expense('E6')
    r.stop(kst(11, 3, 9), '프로젝트 종료 — 더 이상 경비 지출 안 함')
    r.expense('E7')
    r.close(kst(11, 3, 12))
    r.audit(kst(11, 3, 12, 30))
    return r.finish('SmartEscrow — 카페 홈페이지 리뉴얼' + (' (시뮬레이션)' if chain.name == 'sim' else ' (Monad 테스트넷)'), out)


def changed(chain, sample, out):
    """Condition changed: Figma dropped, total 30만 -> new policy hash -> new project. E1 gabia paid (24,200);
    E2 figma and E3 coupang BLOCK merchant_not_allowed; E4 adobe-stock 203,500 HOLD over_order_limit, which the
    client approves (paid: 227,700 spent); E5 AWS 180,000 would make 407,700 > 30만 -> BLOCK over_budget; stop, close."""
    r = Run(chain, sample)
    print(f'SmartEscrow demo (changed words) · chain {chain.name} · project {r.pr.project_id}')
    r.policy(CHANGED_WORDS, pol.ISSUED, title='카페 홈페이지 리뉴얼 (정책 변경)')
    for label in ('E1', 'E2', 'E3', 'E4', 'E5'):
        m, d, h = EXPENSES[label][:3]
        o = r.expense(label)
        if o['verdict'] == 'HOLD' and r.pr.state()['decisions'][r.seqs[label] - 1]['status'] == 'held':
            r.hold(label, True, kst(m, d, h + 1))
            r.settle(label, kst(m, d, h + 1, 5))
        elif o['verdict'] == 'APPROVE':
            r.settle(label, kst(m, d, h, 5))
    r.stop(kst(10, 7, 12), '정책 변경 재실행 종료 — 더 이상 경비 지출 안 함')
    r.close(kst(10, 7, 18))
    r.audit(kst(10, 7, 18, 30))
    return r.finish('SmartEscrow — 정책 변경 재실행 (Figma 제외, 총 30만 원)', out)


def audit_dir(workdir, chain_name=None):
    """Another person's check from the workdir's log and the chain only; prints and returns the audit (+ 'chain',
    'chain_checked', 'chain_problems', 'onchain_project'). chain_name 'monad' | 'sim' | 'none'; default: the
    auditor's chain, Monad testnet — never the one the log names about itself ('none' checks the log alone). On Monad: each logged tx's receipt (mined, same status) gives the scan
    window [create block, highest block + MARGIN]; payments after it are ruled out by projects(id): spent ==
    the log's paid, deposited, policy hash, stopped. A log with any tx line passes only with that real chain
    check (a log naming no chain, or the sim chain that died with the demo process, cannot pass)."""
    workdir = Path(workdir)
    entries = prj.read_log(workdir)
    if not entries:
        raise SystemExit(f'{workdir}: no log.jsonl')
    lines = [json.loads(e['line']) for e in entries]
    first, pid = lines[0], lines[0]['project_id']
    name = {'monad': 'monad-testnet', 'none': None}.get(chain_name or 'monad', chain_name)
    if first.get('chain') != name:
        print(f"  (the log names chain {first.get('chain')!r}; the auditor checks {name!r})")
    chain = make_chain(name) if name in ('monad-testnet', 'sim') else None
    real = chain is not None and chain.name == 'monad-testnet'
    txs = [(i, x) for i, x in enumerate(lines) if x.get('op') == 'tx']
    sent = {x['tx']: (i, x) for i, x in txs if x.get('tx')}
    problems, blocks, times = [], {}, {}
    if real:
        with ThreadPoolExecutor(4) as pool:
            blocks = dict(zip(sent, pool.map(chain.tx_block, sent)))
        for tx, (block, ok) in blocks.items():
            i, x = sent[tx]
            if block is None:
                problems.append(f'log#{i} {x["kind"]} tx {tx} has no receipt on {name}')
            elif ok != bool(x.get('ok')):
                problems.append(f'log#{i} {x["kind"]} tx {tx}: logged ok={x.get("ok")}, chain status ok={ok}')
        mined = [b for b, _ in blocks.values() if b is not None]
        create = next((blocks[x['tx']][0] for _, x in txs if x.get('kind') == 'create' and x.get('tx') in blocks), None)
        # nothing mined: scan one window only; projects(id) below still shows a project the log does not
        chain.created[pid.lower()] = create or (min(mined) if mined else chain.deploy_block)
        chain.until[pid.lower()] = max(mined) + MARGIN if mined else chain.deploy_block
    a = prj.audit(workdir, chain)
    try:
        book = prj.fold(entries)
    except Exception as e:  # the audit already names the line; list what folds
        book = None
        problems.append(f'the log does not fold: {type(e).__name__}: {e}')
    onchain = chain.project(pid) if real else None
    if real and book is not None:
        if onchain is None:
            if book.paid:
                problems.append(f'the log pays {int(book.paid):,} but project {pid} is not on {name}')
            elif sent:
                problems.append(f'project {pid} is not on {name}')
        else:
            for k, want in (('spent', int(round(book.paid))), ('deposited', int(round(book.deposited))),
                            ('policy_hash', book.policy_hash), ('stopped', bool(book.stopped))):
                if onchain[k] != want:
                    problems.append(f'on-chain {k} {onchain[k]} != the log\'s {want}')
    matched = [e for e in a['onchain'] if e['ok']]
    checked = real and not problems and bool(matched) and len(matched) == len(a['onchain'])
    a.update(chain=name, chain_checked=checked, chain_problems=problems, onchain_project=onchain,
             log_only_ok=a['all_ok'], all_ok=a['all_ok'] and not problems and (checked or not txs))
    addr = chain.address_of if chain else prj.payee_address
    print(f'audit {workdir}  project {pid}  chain {name}' + ('' if real else ' (no chain to check: log only)')
          + (' — the sim chain lived only in the demo process' if name == 'sim' else ''))
    print(f"  log hash chain ok: {a['log_chain_ok']}   {len(entries)} lines ({len(txs)} tx lines)   head {entries[-1]['head'][:16]}…")
    print(f"  replay (every decision re-derived from the logged mandate): "
          f"{'ok' if a['replay_error'] is None else a['replay_error']}   state {str(a['replay_state_hash'])[:16]}…")
    if book is not None:
        print(f"  policy {book.policy_hash}  signed by {sorted(book.signatures)}  mandate {book.doc['expense']['mandate_hash'][:16]}…")
        for d in book.decisions:
            payee = addr(d['vendor']) if d['status'] == 'paid' else '-'
            print(f"  #{d['seq']} {when(d['at'])} {str(d['vendor']):<15} {int(d['total']):>9,}  {d['verdict']:<7} {d['reason']:<20} "
                  f"{d['status']:<8} log#{d['log_index']}  payee {payee}")
        for m in book.milestones:
            print(f"  {m['id']} {m['title']:<10} {m['amount']:>9,}  {m['status']:<8} by {m['paid_by'] or '-'}  log#{'-' if m['log_index'] is None else m['log_index']}")
    if real:
        span = (chain.created.get(pid.lower()), chain.until.get(pid.lower()))
        print(f'  scanned blocks {span[0]}..{span[1]} (logged txs\' receipts + {MARGIN}); after that: projects(id) '
              f'{json.dumps(onchain)}')
        bs = sorted({e['block'] for e in a['onchain']})
        with ThreadPoolExecutor(4) as pool:
            times = dict(zip(bs, pool.map(chain.block_time, bs)))
        print('  two clocks: "scenario" = the logged line\'s story time; "block" = the chain\'s real time')
    for e in a['onchain']:
        at = sent.get(e['tx'], (None, {}))[1].get('at')
        clocks = f"scenario {when(at) or '-':<16} block {when(times[e['block']]) if real else '-'}"
        print(f"  chain {e['event']:<16} block {e['block']}  {e['tx'][:18]}…  {clocks}  {'ok ' if e['ok'] else 'BAD'} "
              f"{'log#' + str(e['log_index']) if e['log_index'] is not None else ''} {e['why']}")
    for m in a['missing'] + problems:
        print(f'  MISSING {m}' if m in a['missing'] else f'  PROBLEM {m}')
    if txs and not checked and not problems:
        print(f'  the log has {len(txs)} tx lines but no real chain check ran ({name or "no chain"}): cannot pass')
    print('verdict: ' + ('NOT OK' if not a['all_ok'] else 'ALL OK — every payment was allowed by the signed policy'
                         + (' and matches the chain' if checked else ' (log only: the log has no chain txs)')))
    return a


def main(argv=None):
    ap = argparse.ArgumentParser(prog='python3 -m escrow.demo')
    ap.add_argument('--chain', choices=('sim', 'monad', 'none'), help='run: sim (default) | monad; '
                    '--audit: the chain to check against (default: monad; none = the log alone)')
    ap.add_argument('--sample', type=int, default=0)
    ap.add_argument('--out')
    ap.add_argument('--changed', action='store_true')
    ap.add_argument('--audit', metavar='WORKDIR')
    a = ap.parse_args(argv)
    if a.audit:
        return 0 if audit_dir(a.audit, a.chain)['all_ok'] else 1
    if a.chain == 'none':
        ap.error('a run needs a chain: --chain sim or --chain monad')
    name = a.chain or 'sim'
    chain = make_chain(name)
    out = a.out or ('runs/demo-changed.json' if a.changed else 'runs/demo.json' if name == 'monad' else 'runs/demo-sim.json')
    run = (changed if a.changed else story)(chain, a.sample, ROOT / out if not Path(out).is_absolute() else out)
    return 0 if run['audit']['all_ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
