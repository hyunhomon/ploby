#!/usr/bin/env python3
"""Deploy TestKRW and PlobyEscrow to Monad testnet (chain 10143): python3 script/deploy_ploby.py

Keys come from .env (MONAD_RPC, DEPLOYER_KEY/ADDRESS, RELAYER_KEY/ADDRESS; see .env.example) and are never
printed. The deployer is the demo client's wallet; the relayer is the escrow's operator (Ploby's engine).
After deploying, the client wallet mints demo tKRW and approves the escrow once, so a deposit is one call.
Idempotent: when deployments/monad-testnet.json names two contracts that have code, nothing is deployed.
Test assets only: tKRW is an open-mint token, 1 unit = 1 KRW.
"""
import json
import os
import re
import subprocess
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FOUNDRY = Path.home() / '.foundry' / 'bin'
OUT = ROOT / 'deployments' / 'monad-testnet.json'
MIN_OPERATOR_GAS = 0.5  # MON; below this the deployer sends TOP_UP
TOP_UP = '1'
CLIENT_FLOAT = 10 ** 12  # demo tKRW minted to the client wallet (1조 원 of test money)

env = dict(os.environ)
for line in (ROOT / '.env').read_text(encoding='utf-8').splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip()
RPC = env['MONAD_RPC']


def run(*args):
    r = subprocess.run([str(FOUNDRY / args[0]), *args[1:]], capture_output=True, text=True, env=env, cwd=ROOT)
    if r.returncode:
        raise SystemExit(f'{args[0]} {args[1]} failed: {r.stderr.strip()[:400]}')
    return r.stdout


def rpc(method, params):
    req = urllib.request.Request(RPC, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method,
                                                       'params': params}).encode(),
                                 headers={'Content-Type': 'application/json', 'User-Agent': 'ploby/1'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read()).get('result')


def has_code(address):
    return len(rpc('eth_getCode', [address, 'latest']) or '0x') > 2


def create(contract, *ctor):
    args = ['forge', 'create', contract, '--rpc-url', RPC, '--private-key', env['DEPLOYER_KEY'], '--broadcast']
    out = run(*args, *(['--constructor-args', *ctor] if ctor else []))
    return {'address': re.search(r'Deployed to: (0x[0-9a-fA-F]{40})', out).group(1),
            'tx': re.search(r'Transaction hash: (0x[0-9a-fA-F]{64})', out).group(1)}


def send(to, signature, *args):
    out = json.loads(run('cast', 'send', to, signature, *[str(a) for a in args], '--rpc-url', RPC,
                         '--private-key', env['DEPLOYER_KEY'], '--json'))
    return out.get('transactionHash') or out.get('data', {}).get('transactionHash')


def main():
    dep = json.loads(OUT.read_text(encoding='utf-8')) if OUT.exists() else {}
    if dep.get('escrow', {}).get('contract') == 'PlobyEscrow' and has_code(dep['token']['address']) \
            and has_code(dep['escrow']['address']):
        print(f"already deployed: tKRW {dep['token']['address']}, PlobyEscrow {dep['escrow']['address']}")
        return dep
    run('forge', 'build')
    client, operator = env['DEPLOYER_ADDRESS'], env['RELAYER_ADDRESS']
    token = create('src/TestKRW.sol:TestKRW')
    escrow = create('src/PlobyEscrow.sol:PlobyEscrow', token['address'], operator)
    block = int(rpc('eth_getTransactionReceipt', [escrow['tx']])['blockNumber'], 16)
    dep = {'chain': 'monad-testnet', 'chain_id': 10143, 'rpc_env': 'MONAD_RPC',
           'explorer': 'https://testnet.monadvision.com/', 'token': {**token, 'contract': 'TestKRW', 'symbol': 'tKRW'},
           'escrow': {**escrow, 'contract': 'PlobyEscrow', 'operator': operator, 'block': block},
           'roles': {'client': client, 'operator': operator},
           'setup': {'mint': send(token['address'], 'mint(address,uint256)', client, CLIENT_FLOAT),
                     'approve': send(token['address'], 'approve(address,uint256)', escrow['address'], 2 ** 256 - 1)}}
    if int(rpc('eth_getBalance', [operator, 'latest']), 16) < MIN_OPERATOR_GAS * 10 ** 18:
        out = json.loads(run('cast', 'send', operator, '--value', f'{TOP_UP}ether', '--rpc-url', RPC,
                             '--private-key', env['DEPLOYER_KEY'], '--json'))
        dep['setup']['operator_gas'] = out.get('transactionHash')
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(dep, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: dep[k] for k in ('token', 'escrow', 'roles', 'setup')}, indent=2))
    return dep


if __name__ == '__main__':
    main()
