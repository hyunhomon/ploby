"""Minimal ABIs for the deployed Base Sepolia contracts (cast-free RPC)."""

USDC_ABI = [
    {
        'inputs': [{'name': 'to', 'type': 'address'}, {'name': 'amount', 'type': 'uint256'}],
        'name': 'mint',
        'outputs': [],
        'stateMutability': 'nonpayable',
        'type': 'function',
    },
    {
        'inputs': [{'name': 'spender', 'type': 'address'}, {'name': 'amount', 'type': 'uint256'}],
        'name': 'approve',
        'outputs': [{'name': '', 'type': 'bool'}],
        'stateMutability': 'nonpayable',
        'type': 'function',
    },
    {
        'inputs': [{'name': 'account', 'type': 'address'}],
        'name': 'balanceOf',
        'outputs': [{'name': '', 'type': 'uint256'}],
        'stateMutability': 'view',
        'type': 'function',
    },
    {
        'inputs': [
            {'name': 'owner', 'type': 'address'},
            {'name': 'spender', 'type': 'address'},
        ],
        'name': 'allowance',
        'outputs': [{'name': '', 'type': 'uint256'}],
        'stateMutability': 'view',
        'type': 'function',
    },
]

ESCROW_ABI = [
    {
        'inputs': [
            {'name': 'projectId', 'type': 'bytes32'},
            {'name': 'policyHash', 'type': 'bytes32'},
            {'name': 'budget', 'type': 'uint256'},
        ],
        'name': 'createProject',
        'outputs': [],
        'stateMutability': 'nonpayable',
        'type': 'function',
    },
    {
        'inputs': [{'name': 'projectId', 'type': 'bytes32'}],
        'name': 'deposit',
        'outputs': [],
        'stateMutability': 'nonpayable',
        'type': 'function',
    },
    {
        'inputs': [
            {
                'components': [
                    {'name': 'projectId', 'type': 'bytes32'},
                    {'name': 'evidenceHash', 'type': 'bytes32'},
                    {'name': 'policyHash', 'type': 'bytes32'},
                    {'name': 'amount', 'type': 'uint256'},
                    {'name': 'decision', 'type': 'uint8'},
                    {'name': 'timestamp', 'type': 'uint256'},
                ],
                'name': 'decision',
                'type': 'tuple',
            },
            {'name': 'payee', 'type': 'address'},
        ],
        'name': 'recordDecision',
        'outputs': [],
        'stateMutability': 'nonpayable',
        'type': 'function',
    },
    {
        'inputs': [
            {'name': 'projectId', 'type': 'bytes32'},
            {'name': 'evidenceHash', 'type': 'bytes32'},
        ],
        'name': 'approveHold',
        'outputs': [],
        'stateMutability': 'nonpayable',
        'type': 'function',
    },
    {
        'inputs': [
            {'name': 'projectId', 'type': 'bytes32'},
            {'name': 'evidenceHash', 'type': 'bytes32'},
        ],
        'name': 'rejectHold',
        'outputs': [],
        'stateMutability': 'nonpayable',
        'type': 'function',
    },
    {
        'inputs': [
            {'name': 'projectId', 'type': 'bytes32'},
            {'name': 'evidenceHash', 'type': 'bytes32'},
            {'name': 'payee', 'type': 'address'},
            {'name': 'amount', 'type': 'uint256'},
        ],
        'name': 'release',
        'outputs': [],
        'stateMutability': 'nonpayable',
        'type': 'function',
    },
]
