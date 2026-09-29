"""Ploby's API (docs/api.md): python3 -m escrow.server [--port 3010] [--data var]

JSON over HTTP, standard library only. The web app (frontend/, Vite) proxies /api here. Every request first
runs the keeper, so an elapsed deadline's fallback is applied before anyone reads or acts.
"""
import argparse
import json
import re
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import ai, audit, chain, policy as pol
from .core import Refused
from .pcp_bridge import domain
from .store import Store

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SAMPLES = HERE / 'samples' / 'index.json'
IMPLEMENTATION = {  # PROJECT_OVERVIEW: 현재 구현 and 목표 설계 are never mixed
    'current': [
        '결정론적 정책 엔진 (오프체인): APPROVE·HOLD·BLOCK, 예약·정산 회계, 기한과 타임아웃, 변경 주문',
        'Monad testnet PlobyEscrow: 예치·예약·지급·환불을 온체인에서 집행 (정책의 작업자 지갑에만 지급, 예치금 초과 불가, '
        '클라이언트 일시정지 중 새 예약 불가), HOLD·BLOCK도 온체인 기록',
        '서명된 해시 체인 로그: 모든 변경이 한 줄, 재생하면 같은 상태. 체인 호출마다 그 줄의 로그 헤드를 싣고 tx 해시를 로그에 되씀',
        '작업자의 구매 에이전트 (Kiln): 계획 1회, 요청만 하고 판정은 정책, BLOCK이면 대안·HOLD면 대기·정지면 중단',
        '감사: python3 -m escrow.audit — 로그·증빙·공개 체인만으로 모든 지급의 근거와 온체인 일치를 재구성',
        '양측 정책 서명과 버전 (데모 키 HMAC — 지갑 서명 대체)',
        '구매 전 약정 → 지출 → 증빙 → 정산, 사후 청구, 마일스톤 선예약·검수·타임아웃, 분쟁 해결자',
        'Kiln qwen3-32b 판독: 경비 규칙 문장(두 번의 독립 판독), 견적서·영수증, 변경 주문 초안, 구매 계획',
        '텍스트 문서 업로드 = E1 증빙, 원문은 로그 밖 오프체인 저장소 (해시만 로그에)',
        '데모 시계: 기한을 앞당겨 타임아웃 결과를 확인',
    ],
    'target': [
        '프로젝트별 불변 ProjectEscrow 컨트랙트가 판정 자체까지 온체인에서 강제 (현재: 판정은 오프체인 엔진, 자금 집행은 공용 PlobyEscrow)',
        'EIP-712 / EIP-1271 서명, 정책 서명 서비스, 릴레이어·키퍼의 권한 분리',
        '암호화 증빙 저장소, Evidence Attestation, E2(DKIM)·E3(공급자 API) 증빙',
        '공급자 직접 지급 (DIRECT_VENDOR), 공유 인보이스 배분 레지스트리',
        '프로젝트 자산 인계와 보류액, 보안 동결·RECOVERY_ONLY·마이그레이션',
        'RFC 8785 + keccak256 정책 해시 (현재는 정렬 JSON + sha256)',
    ],
}


def meta():
    d = domain()
    return {'roles': list(pol.parties().values()),
            'vendors': [{'id': r['id'], 'name': r['name'], 'category': r['category'],
                         'category_ko': d.category_name(r['category'])} for r in d.registry],
            'categories': [{'id': c, 'name_ko': d.category_name(c)} for c in d.categories],
            'defaults': dict(pol.DEFAULT_PERIODS), 'ai': {'enabled': ai.enabled(), 'model': 'qwen3-32b'},
            'chain': chain_meta(), 'implementation': IMPLEMENTATION}


def chain_meta():
    dep = chain.deployment()
    if not dep:
        return {'enabled': False}
    base = dep['explorer']
    return {'enabled': chain.enabled(), 'network': 'Monad testnet', 'chain_id': dep['chain_id'],
            'escrow': dep['escrow']['address'], 'escrow_url': f"{base}address/{dep['escrow']['address']}",
            'token': dep['token']['address'], 'token_url': f"{base}address/{dep['token']['address']}",
            'client_wallet': dep['roles']['client'], 'operator': dep['roles']['operator'], 'explorer': base}


def samples():
    if not SAMPLES.exists():
        return []
    out = []
    for s in json.loads(SAMPLES.read_text(encoding='utf-8')):
        path = HERE / s['file']
        if path.exists():
            out.append({'id': s['id'], 'name': s['name'], 'kind': s['kind'],
                        'text': path.read_text(encoding='utf-8')})
    return out


def route(store, method, path, query, body):
    role = (query.get('as') or [None])[0] or body.get('as')
    parts = [p for p in path.split('/') if p][1:]  # after 'api'
    if method == 'GET' and parts == ['meta']:
        return meta()
    if parts == ['clock']:
        if method == 'POST':
            return store.advance(body.get('advance', 0), reset=bool(body.get('reset')))
        return {'now': store.now(), 'offset': store.offset}
    if method == 'GET' and parts == ['samples']:
        return samples()
    if parts == ['documents'] and method == 'POST':
        return store.document(body.get('name'), body.get('text'))
    if len(parts) == 2 and parts[0] == 'documents' and method == 'GET':
        d = store.doc_text(parts[1])
        return {'id': d['id'], 'name': d['name'], 'text': d['text']}
    if parts == ['rules', 'compile'] and method == 'POST':
        return store.compile_rules(body.get('words'))
    if parts == ['projects']:
        if method == 'POST':
            return store.create(body.get('as'), body)
        return store.listing(role or 'client')
    if len(parts) == 2 and parts[0] == 'projects' and method == 'GET':
        return store.view(parts[1], role or 'client')
    if len(parts) == 3 and parts[0] == 'projects' and parts[2] == 'chain' and method == 'GET':
        return store.onchain_state(parts[1])
    if len(parts) == 3 and parts[0] == 'projects' and parts[2] == 'audit' and method == 'GET':
        store.get(parts[1])  # a known project: the auditor then reads its log file, not the server's state
        return audit.audit(parts[1], str(store.root), offline=not chain.deployment())
    if len(parts) == 3 and parts[0] == 'projects' and parts[2] == 'agent' and method == 'POST':
        result, view = store.agent_run(parts[1], body.get('as'), body.get('task'), body.get('offers'))
        return {'ok': True, 'result': result, 'view': view}
    if len(parts) == 3 and parts[0] == 'projects' and parts[2] == 'actions' and method == 'POST':
        text, view = store.act(parts[1], body.get('as'), body.get('action'), body)
        return {'ok': True, 'result': text, 'view': view}
    raise Refused(f'없는 경로: {method} {path}', 'invalid')


def handler(store):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def send(self, code, obj):
            data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send(204, {})

        def handle_method(self, method):
            url = urlparse(self.path)
            if not re.match(r'^/api(/|$)', url.path):
                return self.send(404, {'ok': False, 'error': 'API는 /api 아래에 있습니다', 'code': 'invalid'})
            body = {}
            if method == 'POST':
                n = int(self.headers.get('Content-Length') or 0)
                try:
                    body = json.loads(self.rfile.read(n) or b'{}') if n else {}
                except json.JSONDecodeError:
                    return self.send(400, {'ok': False, 'error': 'JSON 본문이 아닙니다', 'code': 'invalid'})
                if not isinstance(body, dict):
                    return self.send(400, {'ok': False, 'error': 'JSON 본문은 객체여야 합니다', 'code': 'invalid'})
            try:
                self.send(200, route(store, method, url.path, parse_qs(url.query), body))
            except Refused as e:
                self.send(400, {'ok': False, 'error': str(e), 'code': e.code})
            except Exception as e:  # a bug: say so, change nothing (commit only appends after a clean apply)
                traceback.print_exc()
                self.send(500, {'ok': False, 'error': f'서버 오류: {type(e).__name__}: {e}', 'code': 'server'})

        def do_GET(self):
            self.handle_method('GET')

        def do_POST(self):
            self.handle_method('POST')

        def log_message(self, fmt, *args):
            pass
    return Handler


def main():
    ap = argparse.ArgumentParser(prog='python3 -m escrow.server')
    ap.add_argument('--port', type=int, default=3010)
    ap.add_argument('--data', default=str(ROOT / 'var'))
    a = ap.parse_args()
    store = Store(a.data)
    try:
        server = ThreadingHTTPServer(('127.0.0.1', a.port), handler(store))
    except OSError as e:
        raise SystemExit(f'포트 {a.port}을(를) 열 수 없습니다 ({e.strerror}). 이미 실행 중인 서버를 끄거나 '
                         f'--port 3011 처럼 다른 포트를 쓰세요 (그 경우 frontend/vite.config.ts의 프록시도 맞춰야 함).')
    rail = None
    if chain.enabled():
        try:
            rail = chain.Rail()
            store.start_chain(rail)
        except (RuntimeError, OSError, KeyError) as e:
            print(f'chain off: {type(e).__name__}', flush=True)
    print(f'Ploby API on http://127.0.0.1:{a.port}/api  data {a.data}  ({len(store.projects)} projects)  '
          f"Kiln {'on' if ai.enabled() else 'off (readings are HOLD)'}  "
          f"chain {'Monad testnet ' + rail.escrow if rail else 'off (no deployment or keys; PLOBY_CHAIN=off)'}", flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
