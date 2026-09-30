#!/usr/bin/env python3
"""What an edited record looks like to the auditor: python3 harness/tamper.py [--offline]

Copies the committed evidence (evidence/) to a scratch folder and edits the contractor's receipt notice for E1:
the claimed amount goes from 24,200원 to 14,200원, which the engine would still accept.

1. A plain edit: the line's signature no longer matches, so the auditor names that exact line.
2. A forger who also re-signs the line: the demo keys are public in this repository, so the signature and the
   recomputed hash chain now check out offline. The chain does not: every call after the edit carries the log
   head the real log had at that line, and the contract paid 24,200원, not 14,200원. The auditor says so.

The committed evidence is not touched. Step 2 reads the public chain (no keys); --offline skips it.
"""
import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from escrow import audit, policy as pol  # noqa: E402
from escrow.core import raw  # noqa: E402


def edited(lines, resign):
    n = next(i for i, t in enumerate(lines) if json.loads(t)['op'] == 'submit_receipt')
    line = json.loads(lines[n])
    line['params']['claimed'] = 14200
    if resign:
        line['sig'] = pol.sign(line['by'], raw({k: v for k, v in line.items() if k != 'sig'}))
    return n, lines[:n] + [raw(line)] + lines[n + 1:]


def main():
    ap = argparse.ArgumentParser(prog='python3 harness/tamper.py')
    ap.add_argument('--offline', action='store_true')
    a = ap.parse_args()
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    pid = json.loads((ROOT / 'evidence' / 'runs.json').read_text(encoding='utf-8'))['project']
    ok = True
    for step, resign in ((1, False), (2, True)):
        tmp = Path(tempfile.mkdtemp(prefix='ploby-tamper-'))
        shutil.copytree(ROOT / 'evidence', tmp / 'evidence')
        log = tmp / 'evidence' / 'projects' / pid / 'log.jsonl'
        n, lines = edited(log.read_text(encoding='utf-8').splitlines(), resign)
        log.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        print(f"== {step}. line #{n} (submit_receipt): claimed 24,200 -> 14,200"
              f"{', re-signed with the public demo key' if resign else ''}\n")
        if resign and a.offline:
            print('(skipped: --offline)\n')
            continue
        r = audit.audit(str(log), str(tmp / 'evidence'), offline=a.offline)
        print(audit.render(r).split('\npayments')[0] if r['replay']['ok'] else audit.render(r))
        if r['replay']['ok']:
            c = r.get('chain') or {}
            for p in c.get('problems', [])[:4]:
                print(f'  [!!] {p}')
            print(f"  ... {len(c.get('problems', []))} chain problems; verdict: records "
                  f"{'consistent' if r['verdict']['records_consistent'] else 'NOT consistent'}")
            ok &= not r['verdict']['records_consistent']
        else:
            ok &= r['replay']['refused']['line'] == n
        print()
        shutil.rmtree(tmp, ignore_errors=True)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
