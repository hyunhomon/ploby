"""Optional EIP-712 action approvals. Private keys stay in the user's wallet.

The off-chain engine and independent auditor verify these proofs. PlobyEscrow still trusts its operator
for policy decisions and the demo funding wallet still sends chain transactions. These are distinct guarantees.
"""
import functools
import json
import re

from . import policy
from .core import Refused

SCHEME = 'ploby.wallet/1'
FIELDS = [('project', 'string'), ('role', 'string'), ('operation', 'string'), ('policyHash', 'bytes32'),
          ('projectBudget', 'uint256'), ('expenseBudget', 'uint256'), ('parameters', 'string'),
          ('previousHead', 'bytes32'), ('expiresAt', 'uint256'), ('escrow', 'address')]


def available():
    try:
        from eth_account import Account  # noqa: F401
        return True
    except ImportError:
        return False


def configure(doc, wallets, deployment):
    if not wallets:
        return
    if not available():
        raise Refused('Wallet approval requires pip install -r requirements.txt', 'wallet_unavailable')
    if not isinstance(wallets, dict) or set(wallets) != set(policy.ROLES):
        raise Refused('Enter the client, contractor and resolver wallet addresses.', 'invalid')
    addresses = [str(wallets[r]).strip() for r in policy.ROLES]
    if any(not re.fullmatch(r'0x[0-9a-fA-F]{40}', a) or int(a, 16) == 0 for a in addresses):
        raise Refused('Use valid nonzero Ethereum wallet addresses.', 'invalid')
    if len(set(a.lower() for a in addresses)) != len(addresses):
        raise Refused('Each party must use a different wallet.', 'invalid')
    if not deployment:
        raise Refused('The wallet approval domain needs the testnet deployment.', 'invalid')
    for role, address in zip(policy.ROLES, addresses):
        doc[role + 'Address'] = address
    doc['authorization'] = {'scheme': SCHEME, 'chainId': deployment['chain_id'],
                            'escrow': deployment['escrow']['address']}


def required(project, role):
    return role in policy.ROLES and (project.doc or {}).get('authorization', {}).get('scheme') == SCHEME


def action_params(action, params):
    p = {k: v for k, v in params.items() if k not in ('as', 'action', 'lang', 'wallet')}
    if action == 'agent_run':
        return {'task': str(p.get('task') or '').strip(), 'offers': list(dict.fromkeys(p.get('offers') or []))}
    return p


def typed_data(project, role, action, params, expires):
    p = action_params(action, params)
    version = project.version(p.get('version')) if action == 'sign_policy' else project.active or project.versions[0]
    d = version['doc']
    auth = d['authorization']
    return {'domain': {'name': 'Ploby action approval', 'version': '1', 'chainId': auth['chainId']},
            'primaryType': 'ActionApproval',
            'types': {'EIP712Domain': [{'name': n, 'type': t} for n, t in
                                      [('name', 'string'), ('version', 'string'), ('chainId', 'uint256')]],
                      'ActionApproval': [{'name': n, 'type': t} for n, t in FIELDS]},
            'message': {'project': project.id, 'role': role, 'operation': action, 'policyHash': version['hash'],
                        'projectBudget': d['projectBudget'], 'expenseBudget': d['expenseBudget'],
                        'parameters': policy.canonical(p).decode(), 'previousHead': '0x' + project.head,
                        'expiresAt': expires, 'escrow': auth['escrow']}}


@functools.lru_cache(maxsize=2048)
def recover(encoded, signature):
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    return Account.recover_message(encode_typed_data(full_message=json.loads(encoded)), signature=signature).lower()


def verify(project, role, action, params, proof, at):
    if not required(project, role):
        return
    if not isinstance(proof, dict):
        raise Refused('This action needs the party’s wallet signature.', 'wallet_required')
    expires = proof.get('expires')
    if isinstance(expires, bool) or not isinstance(expires, int) or at > expires * 1000:
        raise Refused('The wallet approval expired. Review and sign again.', 'wallet_expired')
    # Bind every approval to its exact predecessor, operation, policy and parameters. Relayer log lines can
    # change the head while a wallet is open; that requires a new explicit approval, never an automatic retry.
    data = typed_data(project, role, action, params, expires)
    if proof.get('head') != project.head:
        raise Refused('The records changed. Review the latest state and sign again.', 'wallet_stale')
    signature = proof.get('signature')
    if not isinstance(signature, str) or not re.fullmatch(r'0x[0-9a-fA-F]{130}', signature):
        raise Refused('The wallet signature is invalid.', 'wallet_invalid')
    try:
        signer = recover(policy.canonical(data).decode(), signature)
    except ImportError:
        raise Refused('Wallet verification requires pip install -r requirements.txt', 'wallet_unavailable') from None
    except (ValueError, TypeError, KeyError):
        raise Refused('The wallet signature is invalid.', 'wallet_invalid') from None
    if signer != project.doc[role + 'Address'].lower():
        raise Refused('The signature does not match this party and action.', 'wallet_invalid')


def check_line(project, line):
    role, action = line['by'], line['op']
    if action == 'create' or not required(project, role):
        return
    params, inputs = line.get('params') or {}, line.get('inputs') or {}
    if action == 'request_commitment' and params.get('via'):
        task = next((t for t in project.agent_tasks if t['id'] == params['via'].get('task')), None)
        document = (inputs.get('document') or {}).get('id')
        if task and task.get('wallet') and document in {o['id'] for o in task['offers']}:
            return  # exactly the offers the contractor authorized the agent to request; policy still decides
    if action == 'agent_task':
        action = 'agent_run'
        params = {'task': params['task'], 'offers': [o['id'] for o in params['offers']]}
    verify(project, role, action, params, inputs.get('wallet'), line['at'])
