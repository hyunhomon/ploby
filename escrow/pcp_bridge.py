"""The Proof-Carrying Payments core (pcp/, in this repository) as the escrow uses it.

The mandate language, the two-reading compiler, the readback and the Kiln client (its cache,
metering and budget guards) live in pcp/; the Kiln key and the Monad test keys in .env, the
Kiln cache and usage log in harness/runs/ (both local, gitignored).
"""
from pathlib import Path

from pcp import compiler, form, kiln, lang, mandate, readback  # noqa: F401
from pcp import domain as domains

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PACK = ROOT / 'domains' / 'escrow.json'


def domain():
    """The escrow domain pack: who project expenses may be paid to."""
    return domains.Domain.load(PACK)
