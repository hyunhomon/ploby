"""Portable evidence export. Only public verifier code and this project's recorded sources are included."""
import hashlib
import io
import json
import zipfile
from dataclasses import dataclass
from pathlib import Path

from . import audit, policy

ROOT = Path(__file__).resolve().parents[1]


@dataclass
class Download:
    filename: str
    body: bytes


def export(store, pid):
    # Capture one immutable prefix. Export must never run the keeper or advance a deadline.
    with store.lock:
        project = store.get(pid)
        lines = store.lines(pid)
        head = project.head
    files = {f'data/projects/{pid}/log.jsonl': ''.join(
        json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n' for x in lines).encode()}
    missing = []
    for doc in audit.document_refs(lines):
        path = store.root / 'docs' / f"{doc['id']}.json"
        if path.is_file():
            files[f"data/docs/{path.name}"] = path.read_bytes()
        else:
            missing.append(doc['id'])
    # A closed allowlist avoids copying keys, caches, other projects, or private workspace files.
    for package in ('escrow', 'pcp'):
        for path in (ROOT / package).glob('*.py'):
            files[f'{package}/{path.name}'] = path.read_bytes()
    for name in ('domains/escrow.json', 'pipeline.json', 'deployments/monad-testnet.json',
                 'src/PlobyEscrow.sol', 'src/TestKRW.sol', 'requirements.txt'):
        path = ROOT / name
        if path.is_file():
            files[name] = path.read_bytes()
    files['verify.py'] = (
        '"""Verify this snapshot without the Ploby server or a private key. Exit 2 means incomplete."""\n'
        'import hashlib, json, pathlib, sys\n'
        'root = pathlib.Path(__file__).resolve().parent\n'
        'manifest = json.loads((root / "manifest.json").read_text())\n'
        'for name, digest in manifest["files"].items():\n'
        '    path = root / name\n'
        '    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:\n'
        '        sys.exit("Archive file missing or changed: " + name)\n'
        'from escrow.audit import main\n'
        'sys.argv[1:1] = [str(root / "data/projects" / manifest["project"] / "log.jsonl"), '
        '"--data", str(root / "data")]\n'
        'sys.exit(main())\n'
    ).encode()
    files['README.txt'] = (
        'Ploby evidence snapshot\n\n'
        'Unzip, then run: python3 verify.py\n'
        'Without network: python3 verify.py --offline\n'
        'Machine-readable report: python3 verify.py --json\n'
        'Wallet signatures require: python3 -m pip install -r requirements.txt\n'
        'Exit codes: 0 verified, 1 inconsistent, 2 incomplete (read the reasons).\n\n'
        'The manifest detects accidental changes to this archive. It is not an independent signature.\n'
        'The verifier recomputes the recorded policy and log, checks original document hashes,\n'
        'and compares recorded transactions with the public chain. E1 uploads do not establish vendor authenticity.\n'
        'The live chain can have advanced since this snapshot. No private keys or API credentials are included.\n'
    ).encode()
    manifest = {'schema': 'ploby.evidence/1', 'project': pid, 'head': head, 'lines': len(lines),
                'missing_documents': missing,
                'files': {name: hashlib.sha256(body).hexdigest() for name, body in sorted(files.items())}}
    files['manifest.json'] = policy.canonical(manifest)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, body in sorted(files.items()):
            archive.writestr(name, body)
    return Download(f'ploby-{pid}-{head[:8]}.zip', stream.getvalue())
