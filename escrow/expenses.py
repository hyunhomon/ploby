"""Project expenses (ADR 0005; PROJECT_OVERVIEW §5.3, §5.5, §6): Reserve -> Spend -> Settle. Every HOLD
has a class, a client deadline, a resolver deadline and a final fallback. The model's reading of a document
enters as an input; the rules below decide.

Request rules, in the overview's §6 order. Mandatory (a failure is BLOCK): allocation (the same document
again would allocate one invoice over 100%), state (ACTIVE, not paused), window, payment_mode, vendor,
category (the signed PCP mandate), payee (the policy's contractor wallet, for reimbursement), per_purchase
(the mandate), expense_budget, funds. Evidence (a reading code cannot trust: HOLD). Risk signals
(probable_duplicate, split_pattern, price_anomaly: HOLD, never BLOCK, never APPROVE).
"""
from .core import Refused, whole, won
from .pcp_bridge import domain

E_LIVE = {'HOLD_REVIEW', 'RESERVED', 'SPEND_REPORTED', 'EVIDENCE_SUBMITTED', 'DISPUTED', 'RETRO_REVIEW'}
KO_HOLD = {'CLIENT_REVIEW': '클라이언트 검토', 'POLICY_OR_SYSTEM_AMBIGUITY': '정책·시스템 판단 불가',
           'EVIDENCE_DEFECT': '증빙 결함', 'INTEGRITY_RISK': '무결성 위험', 'EXCESS_AMOUNT': '약정 상한 초과'}
RULES = [  # (id, Korean label, kind) in the §6 order
    ('allocation', '인보이스 배분 100% 이내 (같은 문서 재사용 금지)', 'mandatory'),
    ('state', '프로젝트 상태 (진행 중, 새 약정 일시정지 아님)', 'mandatory'),
    ('window', '정책 기간', 'mandatory'),
    ('payment_mode', '결제 방식 (환급)', 'mandatory'),
    ('vendor', '허용 공급자', 'mandatory'),
    ('category', '허용 카테고리', 'mandatory'),
    ('payee', '수취인 (정책에 등록된 작업자 지갑)', 'mandatory'),
    ('per_purchase', '건별 한도 (부가세·수수료 포함)', 'mandatory'),
    ('expense_budget', '경비 예산 잔여', 'mandatory'),
    ('category_budget', '카테고리 예산 잔여', 'mandatory'),
    ('funds', '예치금 가용 잔액', 'mandatory'),
    ('evidence', '문서 판독과 증빙 수준', 'evidence'),
    ('probable_duplicate', '중복 가능성 (같은 공급자·같은 금액)', 'risk'),
    ('split_pattern', '분할 청구 (건별 한도 회피)', 'risk'),
    ('price_anomaly', '가격 이상 (카테고리 대표값 대비)', 'risk'),
]
LABEL = {r: l for r, l, _ in RULES}
KIND = {r: k for r, _, k in RULES}
CLOSED_E = {'BLOCKED', 'REJECTED', 'EXPIRED', 'CANCELLED'}
ASSET = 'tKRW'


def fields_of(reading, manual):
    """(the proposal the rules run on, evidence ok, the hold class if not, why). The model's reading when it
    is clean; the contractor's own fields only when the reading failed (then the request is at most held)."""
    prop = reading.get('proposal') if reading.get('ok') else None
    unavailable = reading.get('source') == 'unavailable'
    m = None
    if manual:
        d = domain()
        v = manual.get('vendor')
        try:
            m = {'merchant': v, 'category': d.by_id[v]['category'] if v in d.by_id else 'unknown',
                 'item': str(manual.get('item') or '')[:120], 'amount': whole(manual.get('amount'), 'manual.amount'),
                 'fee': whole(manual.get('fee') or 0, 'manual.fee', 0), 'units': 1}
        except Refused:
            m = None
    if prop and m and (m['merchant'] != prop['merchant'] or m['amount'] + m['fee'] != prop['amount'] + prop['fee']):
        return prop, False, 'EVIDENCE_DEFECT', '작업자가 적은 값과 문서 판독 결과가 다름'
    if prop:
        return prop, True, None, None
    cls = 'POLICY_OR_SYSTEM_AMBIGUITY' if unavailable else 'EVIDENCE_DEFECT'
    why = '판독 서비스를 쓸 수 없음' if unavailable else '; '.join(reading.get('problems') or ['문서를 읽지 못함'])
    return m, False, cls, why + (' — 작업자가 적은 값으로만 판단' if m else '')


class Expenses:
    def expense(self, eid):
        e = self.expenses.get(eid)
        if e is None:
            raise Refused(f'경비 {eid}이 없습니다', 'invalid')
        return e

    def risk(self):
        return self.doc.get('riskRules') or {}

    def evaluate(self, prop, evidence_ok, doc_id, at, onchain=None):
        """[Rule] in §6 order, the first mandatory failure (or None), the risk signals raised. `onchain` (the
        contract's pause flag and available balance, when read) can only make the state and funds rules stricter."""
        rules = []

        def rule(name, ok, detail=''):
            rules.append({'rule': name, 'label': LABEL[name], 'ok': ok, 'detail': detail, 'kind': KIND[name]})
        prior = self.documents.get(doc_id)
        rule('allocation', prior is None, f'이미 {prior}에 100% 배분된 문서' if prior else '')
        chain = onchain or {}  # the escrow contract's state, read before the line (store.onchain)
        why = (f'프로젝트 {self.status}' if self.status != 'ACTIVE' else '새 약정 일시정지 중' if self.paused else
               '클라이언트가 온체인에서 일시정지함' if chain.get('paused') else '')
        rule('state', not why, why)
        m, d = self.mandate(), self.doc
        in_window = m.ok('window_ok', float(at)) and d['startsAt'] <= at <= d['endsAt']
        rule('window', in_window, '' if in_window else '정책 기간 밖')
        rule('payment_mode', 'REIMBURSEMENT' in d['allowedPaymentModes'], '환급 (작업자에게 지급)')
        if prop is None:
            for name in ('vendor', 'category', 'payee', 'per_purchase', 'expense_budget', 'category_budget', 'funds'):
                rule(name, None, '공급자·금액을 알 수 없음')
        else:
            total, units = prop['amount'] + prop['fee'], float(prop.get('units') or 1)
            rule('vendor', m.ok('merchant_ok', prop['merchant']), domain().name_of(prop['merchant']))
            rule('category', m.ok('category_ok', prop['category']), domain().category_name(prop['category']))
            rule('payee', bool(d['contractorAddress']), f"작업자 {d['contractorAddress'][:10]}…")
            rule('per_purchase', m.ok('order_ok', float(total), units), won(total))
            rule('expense_budget', total <= self.expense_capacity(), f'잔여 {won(self.expense_capacity())}')
            cap = (d.get('categoryBudgets') or {}).get(prop['category'])
            left = None if cap is None else cap - self.category_used(prop['category'])
            rule('category_budget', left is None or total <= left,
                 '카테고리 예산 없음' if left is None else f"{domain().category_name(prop['category'])} 잔여 {won(left)}")
            avail = min(self.available, chain['available']) if 'available' in chain else self.available
            rule('funds', total <= avail, f'가용 {won(avail)}' + (' (온체인 잔액 기준)' if avail < self.available else ''))
        rule('evidence', evidence_ok, 'E1 업로드 문서, 판독 일치' if evidence_ok else '판독 결과를 신뢰할 수 없음')
        signals = self.signals(prop, at) if prop else {}
        for name in ('probable_duplicate', 'split_pattern', 'price_anomaly'):
            rule(name, name not in signals, signals.get(name, ''))
        failed = next((r for r in rules if r['kind'] == 'mandatory' and r['ok'] is False), None)
        return rules, failed, signals

    def category_used(self, category):
        """Reserved plus released in one category (the category budget's use)."""
        return sum(e['reserved'] + e['paid'] for e in self.expenses.values() if e['category'] == category)

    def signals(self, prop, at):
        """Risk signals (recommend HOLD only): another request for the same vendor and total within the
        duplicate window; requests to the same vendor within the split window whose sum the per-purchase rule
        would refuse although each passes; a total above factor x the category's typical amount (all pinned in
        the policy's riskRules)."""
        r, m, out = self.risk(), self.mandate(), {}
        total = prop['amount'] + prop['fee']
        near = [e for e in self.expenses.values() if e['vendor'] == prop['merchant'] and e['status'] not in CLOSED_E]
        dup = [e for e in near if e['maximum'] == total and at - e['requested_at'] <= r.get('duplicateWindowSeconds', 0) * 1000]
        if dup:
            out['probable_duplicate'] = f"{dup[0]['id']}와 같은 공급자·같은 금액 ({won(total)})"
        recent = [e for e in near if at - e['requested_at'] <= r.get('splitWindowSeconds', 0) * 1000 and e['maximum']]
        combined = total + sum(e['maximum'] for e in recent)
        if recent and not m.ok('order_ok', float(combined), 1.0):
            out['split_pattern'] = f"{', '.join(e['id'] for e in recent)}와 합치면 {won(combined)} — 건별 한도 초과"
        typical = (r.get('typicalAmounts') or {}).get(prop['category'])
        factor = r.get('anomalyFactor') or 0
        if typical and factor and total > typical * factor:
            out['price_anomaly'] = f"{domain().category_name(prop['category'])} 대표값 {won(typical)}의 {factor}배 초과"
        return out

    def new_expense(self, kind, prop, reading, document, manifest, at):
        self.seq['E'] += 1
        eid = f"E{self.seq['E']}"
        total = (prop['amount'] + prop['fee']) if prop else None
        e = {'id': eid, 'kind': kind, 'status': None, 'hold_class': None, 'version': self.active['version'],
             'vendor': prop and prop['merchant'], 'category': prop and prop['category'], 'item': prop and prop['item'],
             'payment_mode': 'REIMBURSEMENT', 'payee': self.doc['contractorAddress'], 'assurance': 'E1' if document else 'E0',
             'quote': {'amount': prop and prop['amount'], 'fee': prop and prop['fee'], 'total': total, 'document': document,
                       'reading': reading, 'manifest_hash': manifest},
             'maximum': total, 'reserved': 0, 'expires_at': None, 'spent_at': None, 'evidence_deadline': None,
             'receipt': None, 'review_deadline': None, 'resolver_deadline': None, 'payable': None,
             'paid': 0, 'excess': 0, 'excess_paid': 0, 'settlement': None, 'timeout': None, 'decision': None,
             'out_of_scope': False, 'resolution': None, 'requested_at': at, 'objection': None}
        self.expenses[eid] = e
        if document:
            self.documents.setdefault(document['id'], eid)
        return e

    def reserve(self, e, at):
        e['reserved'] = e['maximum']
        self.expense_reserved += e['maximum']
        e['status'] = 'RESERVED'
        e['expires_at'] = at + self.period('reservationValiditySeconds')
        return f"{won(e['maximum'])} 예약 — 구매 약정 {e['id']} 성립 (예약 유효기간 안에 구매 보고)"

    def settle(self, e, amount, status, at, timeout=None):
        """Pay `amount` to the committed payee; the unused part of the reservation returns to available."""
        self.expense_reserved -= e['reserved']
        self.expense_released += amount
        e['paid'], e['reserved'], e['status'], e['timeout'] = e['paid'] + amount, 0, status, timeout
        e['settlement'] = {'payee': e['payee'], 'amount': e['paid'], 'asset': ASSET, 'at': at}
        return amount

    def release(self, e, status, timeout=None):
        back = e['reserved']
        self.expense_reserved -= back
        e['reserved'], e['status'], e['timeout'] = 0, status, timeout
        return back

    # -- contractor: before buying
    def op_request_commitment(self, line, p, i):
        self.need(line, 'contractor')
        self.state_is('ACTIVE', 'CLOSING')
        return self.request(line, i, retro=False)

    def op_retroactive_request(self, line, p, i):
        self.need(line, 'contractor')
        self.state_is('ACTIVE', 'CLOSING')
        return self.request(line, i, retro=True)

    def request(self, line, i, retro):
        reading, document, at = i.get('reading') or {}, i.get('document'), line['at']
        prop, evidence_ok, cls, why = fields_of(reading, i.get('manual'))
        rules, failed, signals = self.evaluate(prop, evidence_ok, document and document['id'], at, i.get('chain'))
        e = self.new_expense('RETROACTIVE' if retro else 'COMMITMENT', prop, reading, document, i.get('manifest'), at)
        via = (line.get('params') or {}).get('via')
        e['via'] = via if isinstance(via, dict) and via.get('task') in {t['id'] for t in self.agent_tasks} else None
        name = domain().name_of(e['vendor']) if e['vendor'] else '알 수 없는 공급자'
        if failed:
            e['status'] = 'BLOCKED'
            e['decision'] = {'result': 'BLOCK', 'reason': failed['rule'], 'rules': rules}
            e['out_of_scope'] = failed['rule'] in ('vendor', 'category')
            return (f"{e['id']} {name} 요청 BLOCK — {failed['label']} 위반"
                    + (' (범위 밖: 변경 주문으로만 가능)' if e['out_of_scope'] else ''))
        review = at + self.period('clientReviewPeriodSeconds')
        if retro:
            e['status'], e['review_deadline'] = 'RETRO_REVIEW', review
            e['hold_class'] = 'CLIENT_REVIEW' if evidence_ok else cls
            e['decision'] = {'result': 'HOLD', 'reason': 'retroactive', 'rules': rules}
            return f"{e['id']} 사후 청구 {won(e['maximum'] or 0)} — 사전 약정이 없어 클라이언트가 응답하지 않으면 거절"
        if not evidence_ok or signals:
            reason = why if not evidence_ok else '; '.join(signals.values())
            e['status'], e['review_deadline'] = 'HOLD_REVIEW', review
            e['hold_class'] = cls if not evidence_ok else ('CLIENT_REVIEW' if set(signals) == {'price_anomaly'} else 'INTEGRITY_RISK')
            e['decision'] = {'result': 'HOLD', 'reason': reason, 'rules': rules}
            return f"{e['id']} 요청 HOLD ({reason}) — 클라이언트 확인 필요, 응답 없으면 만료 (약정 없음)"
        e['decision'] = {'result': 'APPROVE', 'reason': 'all rules passed', 'rules': rules}
        return f"{e['id']} {name} {e['item'] or ''} APPROVE: " + self.reserve(e, at)

    def op_answer_request(self, line, p, i):
        self.need(line, 'client')
        e = self.expense(p.get('expense'))
        if e['status'] not in ('HOLD_REVIEW', 'RETRO_REVIEW'):
            raise Refused('클라이언트 응답을 기다리는 요청이 아닙니다')
        if line['at'] > e['review_deadline']:
            raise Refused('응답 기한이 지났습니다', 'deadline')
        reason = str(p.get('reason') or '').strip()
        if not p.get('approve'):
            e['status'], e['resolution'] = 'REJECTED', {'by': 'client', 'accept': False, 'reason': reason}
            return f"클라이언트가 {e['id']} 요청을 거절했습니다" + (f' ({reason})' if reason else '') + ' — 사전 약정이 없어 최종'
        if not e['maximum'] or not e['vendor']:
            raise Refused('공급자·금액을 알 수 없는 요청은 승인할 수 없습니다 (작업자가 다시 요청)', 'invalid')
        prop = {'merchant': e['vendor'], 'category': e['category'], 'item': e['item'], 'amount': e['quote']['amount'],
                'fee': e['quote']['fee'], 'units': 1}
        rules, failed, _ = self.evaluate(prop, True, None, line['at'])  # mandatory rules again, at approval time
        if failed:
            raise Refused(f"승인할 수 없습니다: {failed['label']} ({failed['detail']})")
        e['resolution'] = {'by': 'client', 'accept': True, 'reason': reason}
        if e['status'] == 'RETRO_REVIEW':
            self.expense_released += e['maximum']
            e['paid'], e['status'] = e['maximum'], 'SETTLED'
            e['settlement'] = {'payee': e['payee'], 'amount': e['maximum'], 'asset': ASSET, 'at': line['at']}
            return f"클라이언트가 {e['id']} 사후 청구를 승인해 {won(e['maximum'])}이 작업자에게 정산됐습니다"
        return f"클라이언트가 HOLD된 {e['id']}을(를) 승인했습니다: " + self.reserve(e, line['at'])

    def op_cancel_reservation(self, line, p, i):
        self.need(line, 'contractor')
        e = self.expense(p.get('expense'))
        if e['status'] != 'RESERVED':
            raise Refused('구매 전 예약만 취소할 수 있습니다')
        back = self.release(e, 'CANCELLED')
        return f"작업자가 미사용 예약 {e['id']}을(를) 취소했습니다 ({won(back)} 가용 복귀)"

    def op_report_spend(self, line, p, i):
        self.need(line, 'contractor')
        e = self.expense(p.get('expense'))
        if e['status'] != 'RESERVED':
            raise Refused('예약된 구매 약정만 구매 보고할 수 있습니다')
        if line['at'] > e['expires_at']:
            raise Refused('예약이 만료됐습니다', 'deadline')
        e['status'], e['spent_at'] = 'SPEND_REPORTED', line['at']
        e['evidence_deadline'] = line['at'] + self.period('evidenceSubmissionPeriodSeconds', e['version'])
        return f"작업자가 {e['id']} 구매를 보고했습니다 — 증빙 제출 기한 시작"

    # -- contractor: after buying
    def read_receipt(self, e, reading, document):
        """(hold class or None, why, eligible) for a receipt against its commitment."""
        prop = reading.get('proposal') if reading.get('ok') else None
        prior = document and self.documents.get(document['id'])
        if prior and prior != e['id']:
            return 'INTEGRITY_RISK', f'이미 {prior}에 쓰인 문서', None
        if not prop and reading.get('source') == 'unavailable':
            return 'POLICY_OR_SYSTEM_AMBIGUITY', '판독 서비스를 쓸 수 없음', None
        if not prop:
            return 'EVIDENCE_DEFECT', '; '.join(reading.get('problems') or ['영수증을 읽지 못함']), None
        if prop['merchant'] != e['vendor']:
            return 'EVIDENCE_DEFECT', f"영수증 발행처가 약정 공급자({domain().name_of(e['vendor'])})와 다름", None
        return None, None, prop['amount'] + prop['fee']

    def op_submit_receipt(self, line, p, i):
        """The submission notice for a settlement: the claimed amount (at most the cap) and the receipt."""
        self.need(line, 'contractor')
        e = self.expense(p.get('expense'))
        if e['status'] != 'SPEND_REPORTED':
            raise Refused('구매 보고된 약정에만 영수증을 낼 수 있습니다')
        if line['at'] > e['evidence_deadline']:
            raise Refused('증빙 제출 기한이 지났습니다', 'deadline')
        claimed = whole(p.get('claimed'), 'claimed')
        if claimed > e['maximum']:
            raise Refused(f"청구액은 약정 상한 {won(e['maximum'])}을 넘을 수 없습니다 (초과분은 변경 주문)", 'invalid')
        reading, document, at = i.get('reading') or {}, i.get('document'), line['at']
        cls, why, eligible = self.read_receipt(e, reading, document)
        e['receipt'] = {'document': document, 'claimed': claimed, 'reading': reading, 'eligible': eligible, 'at': at,
                        'manifest_hash': i.get('manifest'), 'supplements': []}
        if document:
            self.documents.setdefault(document['id'], e['id'])
        e['review_deadline'] = at + self.period('clientReviewPeriodSeconds', e['version'])
        if cls:
            e['status'], e['hold_class'], e['payable'] = 'EVIDENCE_SUBMITTED', cls, min(claimed, e['maximum'])
            return (f"{e['id']} 제출 통지 ({won(claimed)}) — {why} → HOLD {KO_HOLD[cls]}: 클라이언트는 승인할 수 없고, "
                    f"기한까지 분쟁 해결로 넘어감" + (' (작업자 증빙 보완 가능)' if cls == 'EVIDENCE_DEFECT' else ''))
        if eligible > e['maximum']:
            e['hold_class'], e['excess'] = 'EXCESS_AMOUNT', eligible - e['maximum']
            paid = self.settle(e, claimed, 'PARTIALLY_SETTLED', at)
            return (f"{e['id']} 실제 {won(eligible)} > 약정 상한 {won(e['maximum'])}: 약정분 {won(paid)} 즉시 정산, "
                    f"초과 {won(e['excess'])}은 양자 변경 주문 없이는 미지급")
        e['status'], e['hold_class'], e['payable'] = 'EVIDENCE_SUBMITTED', 'CLIENT_REVIEW', min(claimed, eligible)
        return f"{e['id']} 제출 통지 ({won(e['payable'])}) — 클라이언트 검토, 침묵하면 기한에 자동 정산"

    def op_supplement_evidence(self, line, p, i):
        """An evidence supplement (ADR 0001): a replacement document for an EVIDENCE_DEFECT. It cannot raise the
        claimed amount, change the payee, or move any deadline."""
        self.need(line, 'contractor')
        e = self.expense(p.get('expense'))
        if e['hold_class'] != 'EVIDENCE_DEFECT' or e['status'] not in ('EVIDENCE_SUBMITTED', 'DISPUTED'):
            raise Refused('증빙 결함 상태에서만 보완할 수 있습니다')
        if e['status'] == 'DISPUTED' and line['at'] > e['resolver_deadline']:
            raise Refused('분쟁 해결 기한이 지났습니다', 'deadline')
        reading, document = i.get('reading') or {}, i.get('document')
        if not e['receipt']:  # the notice was never sent (evidence deadline missed): the late receipt goes to the resolver
            claimed = whole(p.get('claimed'), 'claimed')
            if claimed > e['maximum']:
                raise Refused(f"청구액은 약정 상한 {won(e['maximum'])}을 넘을 수 없습니다", 'invalid')
            e['receipt'] = {'document': document, 'claimed': claimed, 'reading': reading, 'eligible': None,
                            'at': line['at'], 'manifest_hash': i.get('manifest'), 'supplements': []}
            e['payable'] = claimed
            if document:
                self.documents.setdefault(document['id'], e['id'])
            return f"작업자가 기한 뒤 {e['id']} 영수증을 냈습니다 — 늦은 제출이라 증빙 결함 유지, 분쟁 해결자가 판단"
        cls, why, eligible = self.read_receipt(e, reading, document)
        e['receipt']['supplements'].append(document)
        if document:
            self.documents.setdefault(document['id'], e['id'])
        if cls:
            return f"작업자가 {e['id']} 증빙을 보완했지만 여전히 결함 ({why}) — 기한은 그대로"
        e['receipt']['eligible'] = eligible
        e['hold_class'] = 'CLIENT_REVIEW'
        e['payable'] = min(e['receipt']['claimed'], eligible, e['maximum'])
        e['excess'] = max(eligible - e['maximum'], 0)
        where = '클라이언트 검토 (원래 기한 유지)' if e['status'] == 'EVIDENCE_SUBMITTED' else '분쟁 해결자 검토 (침묵 시 정산)'
        return f"작업자가 {e['id']} 증빙을 보완해 결함이 해소됐습니다 ({won(e['payable'])}) — {where}"

    # -- client
    def op_review_settlement(self, line, p, i):
        self.need(line, 'client')
        e = self.expense(p.get('expense'))
        if e['status'] != 'EVIDENCE_SUBMITTED' or e['hold_class'] != 'CLIENT_REVIEW':
            raise Refused('클라이언트 검토 중인 정산이 아닙니다')
        if line['at'] > e['review_deadline']:
            raise Refused('검토 기한이 지났습니다', 'deadline')
        reason = str(p.get('reason') or '').strip()
        if p.get('approve'):
            paid = self.settle(e, e['payable'], 'SETTLED', line['at'])
            e['resolution'] = {'by': 'client', 'accept': True, 'reason': reason}
            return f"클라이언트가 {e['id']} 정산을 승인해 {won(paid)}이 작업자에게 지급됐습니다"
        if not reason:
            raise Refused('이의 사유를 적어 주세요', 'invalid')
        return self.escalate(e, line['at'], f'클라이언트 이의: {reason}')

    def op_escalate_settlement(self, line, p, i):
        self.need(line, 'client')
        e = self.expense(p.get('expense'))
        if e['status'] != 'EVIDENCE_SUBMITTED' or e['hold_class'] in ('CLIENT_REVIEW', None):
            raise Refused('분쟁 해결로 넘길 HOLD가 아닙니다')
        if line['at'] > e['review_deadline']:
            raise Refused('검토 기한이 지났습니다', 'deadline')
        return self.escalate(e, line['at'], f"클라이언트 요청: {str(p.get('reason') or '').strip() or '사유 없음'}")

    def escalate(self, e, at, why, timeout=None):
        e['status'], e['timeout'], e['objection'] = 'DISPUTED', timeout, why
        e['resolver_deadline'] = at + self.period('resolverReviewPeriodSeconds', e['version'])
        return f"{e['id']} → 분쟁 해결 ({KO_HOLD.get(e['hold_class'], e['hold_class'])}; {why}) — 약정과 예약은 유지"

    # -- resolver
    def op_resolve_expense(self, line, p, i):
        self.need(line, 'resolver')
        e = self.expense(p.get('expense'))
        if e['status'] != 'DISPUTED':
            raise Refused('분쟁 해결 중인 경비가 아닙니다')
        if line['at'] > e['resolver_deadline']:
            raise Refused('분쟁 해결 기한이 지났습니다', 'deadline')
        reason = str(p.get('reason') or '').strip()
        if not reason:
            raise Refused('결정 사유를 적어 주세요', 'invalid')
        if p.get('accept'):
            if not e['receipt']:
                raise Refused('제출된 영수증이 없어 지급할 수 없습니다', 'invalid')
            paid = self.settle(e, e['payable'], 'SETTLED', line['at'])
            e['resolution'] = {'by': 'resolver', 'accept': True, 'reason': reason}
            return f"분쟁 해결자가 {e['id']} 정산을 결정했습니다 ({won(paid)}, 약정 상한 이내)"
        back = self.release(e, 'REJECTED')
        e['resolution'] = {'by': 'resolver', 'accept': False, 'reason': reason}
        return f"분쟁 해결자가 {e['id']}을(를) 거절했습니다 ({reason}) — 예약 {won(back)} 가용 복귀"

    # -- deadlines
    def expense_clocks(self):
        out = []
        for e in self.expenses.values():
            s = e['status']
            if s in ('HOLD_REVIEW', 'RETRO_REVIEW', 'EVIDENCE_SUBMITTED'):
                out.append((e['review_deadline'], s.lower(), e['id']))
            elif s == 'RESERVED':
                out.append((e['expires_at'], 'reservation', e['id']))
            elif s == 'SPEND_REPORTED':
                out.append((e['evidence_deadline'], 'evidence', e['id']))
            elif s == 'DISPUTED':
                out.append((e['resolver_deadline'], 'resolver_review', e['id']))
        return out

    def expense_timeout(self, kind, e, at):
        if kind == 'hold_review':
            e['status'], e['timeout'] = 'EXPIRED', 'REJECTED_BY_TIMEOUT'
            return f"{e['id']} HOLD 요청에 클라이언트 응답 없음 — 만료 (약정은 생기지 않음)"
        if kind == 'retro_review':
            e['status'], e['timeout'] = 'REJECTED', 'REJECTED_BY_TIMEOUT'
            e['resolution'] = {'by': 'keeper', 'accept': False, 'reason': 'client silent'}
            return f"{e['id']} 사후 청구에 클라이언트 응답 없음 — 거절 (침묵으로 지급되지 않음)"
        if kind == 'reservation':
            back = self.release(e, 'EXPIRED', 'REJECTED_BY_TIMEOUT')
            return f"{e['id']} 구매 보고 없이 예약 만료 — {won(back)} 가용 복귀"
        if kind == 'evidence':
            e['hold_class'] = 'EVIDENCE_DEFECT'
            return self.escalate(e, at, '증빙 제출 기한 경과', 'ESCALATED_BY_TIMEOUT')
        if kind == 'evidence_submitted':
            if e['hold_class'] == 'CLIENT_REVIEW':
                paid = self.settle(e, e['payable'], 'SETTLED', at, 'RELEASED_BY_TIMEOUT')
                e['resolution'] = {'by': 'keeper', 'accept': True, 'reason': 'client silent'}
                return f"{e['id']} 클라이언트 검토 기한 경과 — {won(paid)} 자동 정산 (RELEASED_BY_TIMEOUT)"
            return self.escalate(e, at, '클라이언트 기한 경과', 'ESCALATED_BY_TIMEOUT')
        if kind == 'resolver_review':
            cls = e['hold_class']
            if cls in ('CLIENT_REVIEW', 'POLICY_OR_SYSTEM_AMBIGUITY') and e['receipt']:
                paid = self.settle(e, e['payable'], 'SETTLED', at, 'RELEASED_BY_TIMEOUT')
                e['resolution'] = {'by': 'keeper', 'accept': True, 'reason': f'resolver silent ({cls})'}
                return f"{e['id']} 분쟁 해결 기한 경과 ({KO_HOLD[cls]}) — {won(paid)} 정산 (RELEASED_BY_TIMEOUT)"
            back = self.release(e, 'REJECTED', 'REJECTED_BY_TIMEOUT')
            e['resolution'] = {'by': 'keeper', 'accept': False, 'reason': f'resolver silent ({cls})'}
            return f"{e['id']} 분쟁 해결 기한 경과 ({KO_HOLD.get(cls, cls)}) — 거절, 예약 {won(back)} 가용 복귀"
        raise Refused(f'알 수 없는 기한 {kind}', 'invalid')
