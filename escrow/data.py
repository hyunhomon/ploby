"""Project data on disk, mirrored to Vercel Blob when BLOB_READ_WRITE_TOKEN is set."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

BLOB = 'https://blob.vercel-storage.com'


class DataRoot:
    """Local tree under ``local``; optional Blob mirror for serverless persistence."""

    def __init__(self, local: Path, token: Optional[str] = None, prefix: str = 'ploby'):
        self.local = Path(local)
        self.token = token or os.environ.get('BLOB_READ_WRITE_TOKEN') or ''
        self.prefix = (os.environ.get('PLOBY_BLOB_PREFIX') or prefix).strip('/')
        self.local.mkdir(parents=True, exist_ok=True)
        (self.local / 'projects').mkdir(parents=True, exist_ok=True)
        (self.local / 'docs').mkdir(parents=True, exist_ok=True)
        if self.token:
            self._hydrate()

    def _key(self, rel: str) -> str:
        rel = rel.lstrip('/')
        return f'{self.prefix}/{rel}' if self.prefix else rel

    def _hydrate(self):
        cursor = None
        while True:
            q = {'prefix': self._key('') + '/'}
            if cursor:
                q['cursor'] = cursor
            url = BLOB + '?' + urllib.parse.urlencode(q)
            req = urllib.request.Request(url, headers={'Authorization': f'Bearer {self.token}'})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    payload = json.loads(r.read())
            except urllib.error.HTTPError:
                return
            for item in payload.get('blobs') or []:
                name = item.get('pathname') or ''
                if not name.startswith(self._key('')):
                    continue
                rel = name[len(self._key('')) :].lstrip('/')
                if not rel:
                    continue
                self._pull(rel, download_url=item.get('url') or item.get('downloadUrl'))
            cursor = payload.get('cursor')
            if not cursor:
                break

    def _pull(self, rel: str, download_url: Optional[str] = None):
        path = self.local / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if download_url:
            with urllib.request.urlopen(download_url, timeout=60) as r:
                path.write_bytes(r.read())
            return
        url = f'{BLOB}/{urllib.parse.quote(self._key(rel), safe="")}'
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {self.token}'})
        with urllib.request.urlopen(req, timeout=60) as r:
            path.write_bytes(r.read())

    def _push(self, rel: str, data: bytes):
        if not self.token:
            return
        url = f'{BLOB}/{urllib.parse.quote(self._key(rel), safe="")}'
        req = urllib.request.Request(
            url,
            data=data,
            method='PUT',
            headers={
                'Authorization': f'Bearer {self.token}',
                'Content-Type': 'application/octet-stream',
                'x-content-type': 'application/octet-stream',
            },
        )
        urllib.request.urlopen(req, timeout=60)

    def write_text(self, rel: str, text: str):
        path = self.local / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        data = text.encode('utf-8')
        path.write_bytes(data)
        self._push(rel, data)

    def read_text(self, rel: str) -> Optional[str]:
        path = self.local / rel
        if path.exists():
            return path.read_text(encoding='utf-8')
        if self.token:
            try:
                self._pull(rel)
            except urllib.error.HTTPError:
                return None
            if path.exists():
                return path.read_text(encoding='utf-8')
        return None

    def append_line(self, rel: str, line: str):
        path = self.local / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('a', encoding='utf-8', newline='\n') as f:
            f.write(line + '\n')
        self._push(rel, path.read_bytes())

    def exists(self, rel: str) -> bool:
        if (self.local / rel).exists():
            return True
        if not self.token:
            return False
        try:
            self._pull(rel)
        except urllib.error.HTTPError:
            return False
        return (self.local / rel).exists()

    def list_project_ids(self):
        seen = set()
        base = self.local / 'projects'
        if base.exists():
            for d in base.iterdir():
                if (d / 'log.jsonl').exists():
                    seen.add(d.name)
        return sorted(seen)


def open_data(local) -> DataRoot:
    return DataRoot(Path(local))
