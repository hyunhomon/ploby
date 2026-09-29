#!/usr/bin/env python3
"""Deploy MockUSDC and ExpenseEscrow to Monad testnet (chain 10143); top up the agent's gas.

Keys come from .env (MONAD_RPC, DEPLOYER_KEY/ADDRESS, RELAYER_KEY/ADDRESS; see .env.example)
and are never printed. The deployer is the escrow owner and the demo client; the relayer is the escrow agent.
Idempotent: when deployments/monad-testnet.json exists and both contracts have code, nothing is sent.
Test assets only: MockUSDC is an open-mint token (1 base unit = 1 KRW in the demo).
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
MIN_AGENT_GAS = 0.5  # MON; below this the deployer sends TOP_UP
TOP_UP = '1'

env = dict(os.environ)
for line in (ROOT / '.env').read_text().splitlines():
    if '=' in line and not line.startswith('#'):
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
                                 headers={'Content-Type': 'application/json', 'User-Agent': 'smartescrow/0.1'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read()).get('result')


def has_code(address):
    return len(rpc('eth_getCode', [address, 'latest']) or '0x') > 2


def create(contract, *ctor):
    args = ['forge', 'create', contract, '--rpc-url', RPC, '--private-key', env['DEPLOYER_KEY'], '--broadcast']
    out = run(*args, *(['--constructor-args', *ctor] if ctor else []))
    return {'address': re.search(r'Deployed to: (0x[0-9a-fA-F]{40})', out).group(1),
            'tx': re.search(r'Transaction hash: (0x[0-9a-fA-F]{64})', out).group(1)}


def main():
    dep = json.loads(OUT.read_text()) if OUT.exists() else {}
    if dep and has_code(dep['token']['address']) and has_code(dep['escrow']['address']):
        print(f'already deployed: token {dep["token"]["address"]}, escrow {dep["escrow"]["address"]}')
        return dep
    run('forge', 'build')
    deployer, agent = env['DEPLOYER_ADDRESS'], env['RELAYER_ADDRESS']
    token = create('src/MockUSDC.sol:MockUSDC')
    escrow = create('src/ExpenseEscrow.sol:ExpenseEscrow', token['address'], agent)
    dep = {'chain': 'monad-testnet', 'chain_id': 10143, 'rpc_env': 'MONAD_RPC',
           'explorer': 'https://testnet.monadvision.com/tx/', 'token': token,
           'escrow': {**escrow, 'owner': deployer, 'agent': agent,
                      'block': int(rpc('eth_getTransactionReceipt', [escrow['tx']])['blockNumber'], 16)},
           'roles': {'client': deployer, 'agent': agent}}
    if int(rpc('eth_getBalance', [agent, 'latest']), 16) < MIN_AGENT_GAS * 10 ** 18:
        out = json.loads(run('cast', 'send', agent, '--value', f'{TOP_UP}ether', '--rpc-url', RPC,
                             '--private-key', env['DEPLOYER_KEY'], '--json'))
        dep['funding'] = {'agent': out.get('data', out)['transactionHash']}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(dep, indent=2) + '\n')
    print(json.dumps({k: dep[k] for k in ('token', 'escrow', 'roles')}, indent=2))
    return dep


if __name__ == '__main__':
    main()
