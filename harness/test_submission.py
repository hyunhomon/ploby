"""Submission regressions: python3 -m unittest harness.test_submission (wallet checks need requirements.txt)."""
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from escrow import audit, bundle, wallet
from escrow.core import Refused
from escrow.store import Store
from harness.check import World, reader, drafter, spec


class SubmissionChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ploby-submission-')
        self.addCleanup(self.tmp.cleanup)
        self.w = World(self.tmp.name, 'demo')
        self.w.activate()

    def test_pause_stops_rerun_even_when_quote_is_already_allocated(self):
        w = self.w
        ids = [w.doc(k) for k in ('q-gabia', 'q-figma', 'q-vercel')]
        w.st.planner = lambda *_: ({'needs': [{'need': str(i), 'offers': [d], 'why': ''} for i, d in enumerate(ids)],
                                    'skip': []}, {'ok': True, 'usage': {}, 'problems': []})
        w.st.agent_run(w.pid, 'contractor', 'Launch tools', ids)
        w.act('client', 'pause', reason='Stop')
        before = w.P.ledger()
        result, _ = w.st.agent_run(w.pid, 'contractor', 'Launch tools', ids)
        self.assertEqual(len(result['tried']), 1)
        self.assertEqual(result['tried'][0]['rule'], 'allocation')
        self.assertTrue(result['stopped'])
        self.assertEqual(w.P.ledger(), before)

    def test_empty_and_offline_audits_never_claim_full_verification(self):
        r = audit.audit(str(self.w.st.path(self.w.pid)), str(self.w.st.root), offline=True)
        self.assertEqual(r['verdict']['status'], 'incomplete')
        self.assertIn('no_completed_payment', r['verdict']['reasons'])
        self.assertIn('chain_unchecked', r['verdict']['reasons'])
        self.assertIn('demo_authorization', r['verdict']['reasons'])

    def test_all_referenced_originals_affect_the_verdict(self):
        w = self.w
        w.act('contractor', 'request_commitment', document=w.doc('q-gabia'))
        target, data = str(w.st.path(w.pid)), str(w.st.root)
        with patch('escrow.audit.doc_check', return_value={'found': False}):
            r = audit.audit(target, data, offline=True)
            self.assertEqual(r['evidence']['status'], 'incomplete')
            self.assertIn('missing_documents', r['verdict']['reasons'])
        with patch('escrow.audit.doc_check', return_value={'found': True, 'hash_ok': False}):
            r = audit.audit(target, data, offline=True)
            self.assertEqual(r['verdict']['status'], 'failed')
            self.assertFalse(r['verdict']['records_consistent'])

    def test_export_contains_only_this_project_and_runs_without_server(self):
        w = self.w
        w.act('contractor', 'request_commitment', document=w.doc('q-gabia'))
        w.st.document('Not part of this project', 'private unrelated document')
        before = w.st.path(w.pid).read_bytes()
        archive = bundle.export(w.st, w.pid)
        with zipfile.ZipFile(io.BytesIO(archive.body)) as z:
            names = z.namelist()
            self.assertEqual(len([n for n in names if n.startswith('data/docs/')]), 1)
            self.assertFalse(any('.env' in n or 'harness/runs' in n for n in names))
            target = Path(self.tmp.name) / 'unpacked'
            z.extractall(target)
        self.assertEqual(before, w.st.path(w.pid).read_bytes())
        run = subprocess.run([sys.executable, 'verify.py', '--offline', '--json'], cwd=target,
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 2, run.stderr)
        self.assertEqual(json.loads(run.stdout)['head'], w.P.head)


@unittest.skipUnless(wallet.available(), 'Install requirements.txt for wallet verification')
class WalletChecks(unittest.TestCase):
    def setUp(self):
        from eth_account import Account
        self.accounts = {r: Account.create() for r in ('client', 'contractor', 'resolver')}
        self.tmp = tempfile.TemporaryDirectory(prefix='ploby-wallet-')
        self.addCleanup(self.tmp.cleanup)
        self.st = Store(self.tmp.name, reader=reader, drafter=drafter)
        sp = {**spec(), 'wallets': {r: a.address for r, a in self.accounts.items()}}
        self.pid = self.st.create('client', sp)['id']

    def proof(self, role, action, params):
        from eth_account.messages import encode_typed_data
        intent = self.st.wallet_intent(self.pid, role, action, params)
        signed = self.accounts[role].sign_message(encode_typed_data(full_message=intent['typed_data']))
        return {'head': intent['head'], 'expires': intent['expires'], 'signature': '0x' + bytes(signed.signature).hex()}

    def act(self, role, action, **params):
        return self.st.act(self.pid, role, action, {**params, 'wallet': self.proof(role, action, params)})

    def activate(self):
        self.act('client', 'sign_policy', version=1)
        self.act('contractor', 'sign_policy', version=1)
        self.act('client', 'deposit', amount=4500000)

    def test_wallet_approves_budget_and_pause_and_replays_independently(self):
        self.activate()
        self.act('client', 'pause', reason='Pause new commitments')
        r = audit.audit(str(self.st.path(self.pid)), self.tmp.name, offline=True)
        self.assertTrue(r['replay']['ok'])
        self.assertEqual(r['authorization']['status'], 'verified')
        self.assertEqual(r['authorization']['wallet_actions'], 4)
        self.assertTrue(self.st.replay(self.pid).paused)

    def test_wallet_project_requires_approval_for_client_actions(self):
        with self.assertRaises(Refused):
            self.st.act(self.pid, 'client', 'sign_policy', {'version': 1})
        self.assertEqual(len(self.st.get(self.pid).log), 1)

    def test_wallet_approval_must_match_action_and_current_state(self):
        proof = self.proof('client', 'sign_policy', {'version': 1})
        self.act('contractor', 'sign_policy', version=1)
        with self.assertRaises(Refused) as result:
            self.st.act(self.pid, 'client', 'sign_policy', {'version': 1, 'wallet': proof})
        self.assertEqual(result.exception.code, 'wallet_stale')

    def test_wallet_agent_approval_replays_authorized_offers(self):
        self.activate()
        from harness.check import SAMPLES
        sample = SAMPLES['q-gabia']
        d = self.st.document(sample['name'], sample['text'])['id']
        self.st.planner = lambda *_: ({'needs': [{'need': 'Domain', 'offers': [d], 'why': 'Launch'}], 'skip': []},
                                     {'ok': True, 'usage': {}, 'problems': []})
        p = {'task': 'Buy a domain', 'offers': [d]}
        result, _ = self.st.agent_run(self.pid, 'contractor', p['task'], p['offers'], self.proof('contractor', 'agent_run', p))
        self.assertEqual(result['tried'][0]['result'], 'APPROVE')
        self.assertEqual(self.st.replay(self.pid).expenses['E1']['reserved'], 24200)


if __name__ == '__main__':
    unittest.main()
