"""Vercel entrypoint for the api service (`escrow.wsgi:app`).

Uses the same routes as ``python3 -m escrow.server``. Project data is written
under ``/tmp/ploby`` and mirrored to Vercel Blob when ``BLOB_READ_WRITE_TOKEN``
is set. Chain work runs synchronously after each request on Vercel.
"""
import json
import os
import re
import threading
import traceback
from pathlib import Path
from urllib.parse import parse_qs

from .core import Refused
from .data import open_data
from .server import route

ROOT = Path(__file__).resolve().parent.parent
_store = None
_ready = threading.Lock()

_STATUS = {
    200: '200 OK',
    204: '204 No Content',
    400: '400 Bad Request',
    404: '404 Not Found',
    405: '405 Method Not Allowed',
    500: '500 Internal Server Error',
}


def get_store():
    global _store
    if _store is not None:
        return _store
    with _ready:
        if _store is None:
            from .chain import Chain
            from .store import Store
            data_path = os.environ.get('PLOBY_DATA')
            if not data_path:
                data_path = '/tmp/ploby' if os.environ.get('VERCEL') else str(ROOT / 'var')
            data = open_data(data_path)
            chain = Chain(ROOT, data)
            store = Store(data, chain=chain)
            for pid, project in list(store.projects.items()):
                if project.status in ('ACTIVE', 'CLOSING', 'CLOSED'):
                    chain.schedule(pid)
            _store = store
    return _store


def _json(start_response, code, obj):
    data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    start_response(_STATUS[code], [
        ('Content-Type', 'application/json; charset=utf-8'),
        ('Content-Length', str(len(data))),
        ('Access-Control-Allow-Origin', '*'),
        ('Access-Control-Allow-Headers', 'Content-Type'),
    ])
    return [data]


def app(environ, start_response):
    method = environ.get('REQUEST_METHOD', 'GET')
    if method == 'OPTIONS':
        return _json(start_response, 204, {})
    if method not in ('GET', 'POST'):
        return _json(start_response, 405, {'ok': False, 'error': '없는 경로: ' + method, 'code': 'invalid'})
    path = environ.get('PATH_INFO') or '/'
    if not re.match(r'^/api(/|$)', path):
        return _json(start_response, 404, {'ok': False, 'error': 'API는 /api 아래에 있습니다', 'code': 'invalid'})
    query = parse_qs(environ.get('QUERY_STRING') or '', keep_blank_values=True)
    body = {}
    if method == 'POST':
        n = int(environ.get('CONTENT_LENGTH') or 0)
        raw = environ['wsgi.input'].read(n) if n else b'{}'
        try:
            body = json.loads(raw or b'{}')
        except json.JSONDecodeError:
            return _json(start_response, 400, {'ok': False, 'error': 'JSON 본문이 아닙니다', 'code': 'invalid'})
        if not isinstance(body, dict):
            return _json(start_response, 400, {'ok': False, 'error': 'JSON 본문은 객체여야 합니다', 'code': 'invalid'})
    try:
        store = get_store()
        payload = route(store, method, path, query, body)
        if store.chain and store.chain.enabled and os.environ.get('VERCEL'):
            store.chain.drain()
        return _json(start_response, 200, payload)
    except Refused as e:
        return _json(start_response, 400, {'ok': False, 'error': str(e), 'code': e.code})
    except Exception as e:
        traceback.print_exc()
        return _json(start_response, 500, {'ok': False, 'error': f'서버 오류: {type(e).__name__}: {e}', 'code': 'server'})
