"""JSON-RPC signing for Base Sepolia (replaces Foundry cast on Vercel)."""
import re

from eth_account import Account
from web3 import Web3
from web3.exceptions import ContractLogicError, Web3Exception

from .abis import ESCROW_ABI, USDC_ABI

B32 = re.compile(r'^0x[0-9a-fA-F]{64}$')


class RpcError(Exception):
    pass


class Rpc:
    def __init__(self, url, chain_id):
        self.w3 = Web3(Web3.HTTPProvider(url, request_kwargs={'timeout': 120}))
        if not self.w3.is_connected():
            raise RpcError('RPC is not reachable')
        self.chain_id = int(chain_id)

    def address(self, key):
        return Web3.to_checksum_address(Account.from_key(key).address)

    def keccak_text(self, text):
        return Web3.to_bytes(hexstr=Web3.keccak(text=str(text)).hex())

    def keccak_hex(self, text):
        return '0x' + Web3.keccak(text=str(text)).hex()

    def _contract(self, address, abi):
        return self.w3.eth.contract(address=Web3.to_checksum_address(address), abi=abi)

    def erc20_uint(self, token, sig, *args):
        contract = self._contract(token, USDC_ABI)
        fn = getattr(contract.functions, sig.split('(')[0])
        try:
            return int(fn(*args).call())
        except (ContractLogicError, Web3Exception) as e:
            raise RpcError(str(e)) from e

    def send(self, key, to, abi, fn_name, *args):
        account = Account.from_key(key)
        contract = self._contract(to, abi)
        fn = getattr(contract.functions, fn_name)
        try:
            tx = fn(*args).build_transaction({
                'from': account.address,
                'nonce': self.w3.eth.get_transaction_count(account.address),
                'chainId': self.chain_id,
                'gas': 800_000,
            })
            tx['gas'] = int(self.w3.eth.estimate_gas(tx) * 1.2)
            if 'maxFeePerGas' not in tx:
                block = self.w3.eth.get_block('pending')
                base = block.get('baseFeePerGas') or self.w3.eth.gas_price
                tx['maxFeePerGas'] = int(base * 2)
                tx['maxPriorityFeePerGas'] = self.w3.to_wei(0.001, 'gwei')
            signed = account.sign_transaction(tx)
            tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
        except ContractLogicError as e:
            raise RpcError(str(e)) from e
        except Web3Exception as e:
            raise RpcError(str(e)) from e
        if receipt['status'] != 1:
            raise RpcError('transaction reverted')
        h = receipt['transactionHash'].hex()
        return h if h.startswith('0x') else '0x' + h

    @staticmethod
    def b32(value):
        if isinstance(value, str) and B32.match(value):
            return Web3.to_bytes(hexstr=value)
        raise RpcError('expected a 32-byte hash')
