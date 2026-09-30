#!/usr/bin/env python3
"""A project ready for the live demo, through the running server: python3 harness/demo_setup.py [--api URL]

Creates the demo project as the client (expense rules by form: AWS, Vercel, 가비아, Figma, Adobe Stock; at most
200,000원 per purchase including VAT; 500,000원 in total; until 2026-10-31), signs policy v1 as both parties and
deposits the initial funding, so the chain opens it and reserves the milestones. Then it prints where to click.
The server must be running (python3 -m escrow.server); nothing here calls a model.
"""
import argparse
import json
import urllib.request

SPEC = {'as': 'client', 'name': 'Cafe Ondam website renewal',
        'rules': {'mode': 'form', 'form': {'vendors': ['aws', 'vercel', 'gabia', 'figma', 'adobe-stock'], 'budget': 500000,
                                           'max_per_purchase': 200000, 'until': '2026-10-31'}},
        'milestones': [{'title': 'Design mockups', 'start_by': '2026-11-10', 'due_at': '2026-11-20', 'grace_days': 2,
                        'units': [{'title': 'Main page mockup', 'criteria': ['One desktop and one mobile mockup'], 'amount': 1000000},
                                  {'title': 'Sub-page mockups', 'criteria': ['Menu and store-info pages'], 'amount': 500000}]},
                       {'title': 'Responsive build', 'start_by': '2026-11-21', 'due_at': '2026-12-10', 'grace_days': 2,
                        'units': [{'title': 'Responsive site', 'criteria': ['Mobile and desktop layouts', 'Domain connected'], 'amount': 2500000}]}],
        'ends_at': '2026-12-31'}


def main():
    ap = argparse.ArgumentParser(prog='python3 harness/demo_setup.py')
    ap.add_argument('--api', default='http://127.0.0.1:3010/api')
    ap.add_argument('--web', default='http://localhost:5173')
    a = ap.parse_args()

    def call(method, path, body=None):
        req = urllib.request.Request(a.api + path, data=None if body is None else json.dumps(body).encode(),
                                     method=method, headers={'Content-Type': 'application/json'})
        return json.loads(urllib.request.urlopen(req, timeout=60).read())
    pid = call('POST', '/projects', SPEC)['id']
    v = None
    for role, action, p in [('client', 'sign_policy', {'version': 1}), ('client', 'deposit', {'amount': 4500000}),
                            ('contractor', 'sign_policy', {'version': 1})]:
        r = call('POST', f'/projects/{pid}/actions', {'as': role, 'action': action, **p})
        v = r['view']
        print(f'{role:10} {r["result"][:90]}')
    chain = v.get('chain') or {}
    print(f"\nproject {pid}: {v['status']}, chain {'on, ' + str(chain.get('pending', 0)) + ' calls on the way' if chain.get('enabled') else 'off'}")
    print(f"client      {a.web}/#/p/{pid}?tab=overview&as=client")
    print(f"contractor  {a.web}/#/p/{pid}?tab=expenses&as=contractor   → Hand it to the agent")
    print(f"auditor     python3 -m escrow.audit {pid}")


if __name__ == '__main__':
    main()
