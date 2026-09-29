"""The pipeline's model stages, and which model runs each — one place to route a stage to
another model or to switch its reasoning, then measure the change with harness/gate.py.

    write    words -> the six expressions (compiler.py)
    read     words -> the form, blind to the writer (compiler.py)
    reread   both again, when they disagree or code finds a fault (compiler.py)
    quote    a vendor document -> its fields (escrow/ai.py)

Defaults below; pipeline.json at the repository root overrides them per stage
({"reread": {"model": "deepseek-v4.1-flash", "think": false}}), and so does the environment
(PCP_STAGE_REREAD=deepseek-v4.1-flash:think).
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = {
    'write': {'model': 'qwen3-32b', 'think': False},
    'read': {'model': 'qwen3-32b', 'think': False},
    'reread': {'model': 'qwen3-32b', 'think': True},
    'quote': {'model': 'qwen3-32b', 'think': False},
}


def stage(name):
    """{'model', 'think'} for a stage: defaults, then pipeline.json, then PCP_STAGE_<NAME>."""
    s = dict(DEFAULTS[name])
    config = ROOT / 'pipeline.json'
    if config.exists():
        s.update(json.loads(config.read_text()).get(name, {}))  # keys starting with _ are notes
    env = os.environ.get(f'PCP_STAGE_{name.upper()}')
    if env:
        model, _, mode = env.partition(':')
        s['model'] = model or s['model']
        s['think'] = mode == 'think' if mode else s['think']
    return s


def all_stages():
    return {name: stage(name) for name in DEFAULTS}
