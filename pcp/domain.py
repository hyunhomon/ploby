"""A domain pack: who can be paid in one world, what its things are called, and how people
talk about it. Nothing else in the engine knows a domain; a new one is a JSON file, or a
POST while the engine runs.

    {"id": "escrow", "title": "…",
     "registry": [{"id": "coupang", "name": "쿠팡", "category": "general"}, …]   (or "registry_file")

     optional, with their defaults:
     "agent": "an AI agent that buys for a person"   who the mandate binds (for the compiler)
     "currency": "KRW"                               amounts are in it
     "fees": "fees"            "fees_ko": "수수료"     what a total includes
     "counterparty": "payee"   "counterparties": "Payees"   "counterparty_ko": "결제처"
     "units": "people or items"   "unit": "person or item"   "unit_ko": "1개"   what `units` counts
     "timezone": "+09:00"      "timezone_name": "Asia/Seoul"
     "categories_ko": {}       category id -> its Korean name, for the readback
     "examples": […]           {now, words, fill, form}: shown to the writer (fill) and the reader
                               (form); generated from the registry when absent
     "catalog": […]            offers for demos and the agent}

The registry's order is the vault's payee order. A proposal's category comes from the
registry, never from the agent.
"""
import json
import re
from pathlib import Path

from . import form, lang

ROOT = Path(__file__).resolve().parents[1]
ID = re.compile(r'[a-z0-9][a-z0-9-]{0,39}$')
DEFAULTS = {'agent': 'an AI agent that buys for a person', 'currency': 'KRW', 'fees': 'fees', 'fees_ko': '수수료',
            'counterparty': 'payee', 'counterparties': 'Payees', 'counterparty_ko': '결제처', 'units': 'people or items',
            'unit': 'person or item', 'unit_ko': '1개', 'timezone': '+09:00', 'timezone_name': 'Asia/Seoul',
            'categories_ko': {}, 'catalog': []}


def tz_minutes(text):
    m = re.fullmatch(r'([+-])(\d{2}):(\d{2})', text)
    if not m:
        raise ValueError(f'timezone must look like +09:00, not {text!r}')
    return (1 if m.group(1) == '+' else -1) * (int(m.group(2)) * 60 + int(m.group(3)))


class Domain:
    def __init__(self, pack):
        pack = dict(pack)
        if 'registry_file' in pack:
            registry = (ROOT / pack['registry_file']).read_text(encoding='utf-8')
            pack['registry'] = json.loads(registry)['merchants']
        for key in ('id', 'title', 'registry'):
            if key not in pack:
                raise ValueError(f'a domain pack needs {key!r}')
        self.pack = {**DEFAULTS, **pack}
        self.id = pack['id']
        if not ID.match(self.id):
            raise ValueError(f'domain id {self.id!r}: lowercase letters, digits and -')
        self.registry = self.pack['registry']
        if not 1 <= len(self.registry) <= 256:
            raise ValueError('a registry has 1 to 256 entries (the vault pays at most 256 payees)')
        for r in self.registry:
            if not (isinstance(r, dict) and ID.match(str(r.get('id', ''))) and r.get('name') and r.get('category')):
                raise ValueError(f'registry entry {r!r}: needs id (lowercase, digits, -), name and category')
        self.ids = [r['id'] for r in self.registry]
        if len(set(self.ids)) != len(self.ids):
            raise ValueError('registry ids must be unique')
        self.by_id = {r['id']: r for r in self.registry}
        self.categories = sorted({r['category'] for r in self.registry})
        self.tz = tz_minutes(self.pack['timezone'])
        self.examples = self.pack.get('examples') or generated_examples(self)
        for e in self.examples:  # an example the language rejects would teach the model wrong
            lang.compile_fill({k: e['fill'][k] for k in lang.ORDER}, self.tz, self.example_now(e))
            if 'form' in e:
                form.compile_form(e['form'], self.tz)
        self._prompt = None

    def example_now(self, e):
        """An example's Now ('Thursday 2026-11-12 15:00') as ms in this domain's time zone."""
        import datetime as dt
        day, clock = re.search(r'(\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2})', e['now']).groups()
        zone = dt.timezone(dt.timedelta(minutes=self.tz))
        return int(dt.datetime.fromisoformat(f'{day} {clock}').replace(tzinfo=zone).timestamp() * 1000)

    @classmethod
    def load(cls, path):
        return cls(json.loads(Path(path).read_text(encoding='utf-8')))

    def __getattr__(self, name):  # the pack's words: domain.currency, domain.unit_ko, …
        if name != 'pack' and name in self.pack:
            return self.pack[name]
        raise AttributeError(name)

    @property
    def prompt(self):
        """The writer's system prompt for this domain (fixed, so the prefix cache serves it)."""
        if self._prompt is None:
            from . import compiler
            self._prompt = compiler.writer_prompt(self), compiler.reader_prompt(self)
        return self._prompt[0]

    @property
    def reader_prompt(self):
        """The reader's system prompt (compiler.py: the second, independent reading)."""
        self.prompt
        return self._prompt[1]

    def proposal(self, counterparty, amount, fee=0, units=1, item=''):
        """A proposal as the mandate takes it."""
        return {'merchant': str(counterparty), 'category': self.by_id.get(counterparty, {}).get('category', 'unknown'),
                'item': str(item)[:80], 'amount': float(amount), 'fee': float(fee), 'units': int(units)}

    def name_of(self, cid):
        return self.by_id[cid]['name'] if cid in self.by_id else cid

    def category_name(self, c):
        return self.pack['categories_ko'].get(c, c)

    def describe(self):
        return {k: self.pack.get(k) for k in ('id', 'title', 'currency', 'counterparty', 'counterparty_ko', 'units',
                                              'unit_ko', 'timezone', 'registry', 'catalog')}


def generated_examples(d):
    """Examples for a pack that brings none, in its own words: its first payees and categories."""
    a, b = d.registry[0], d.registry[min(1, len(d.registry) - 1)]
    c1, c2 = d.categories[0], d.categories[min(1, len(d.categories) - 1)]
    now = 'Thursday 2026-11-12 15:00'
    return [
        {'now': now, 'words': f"다음 주 월요일부터 수요일까지 {a['name']}나 {b['name']}에서만. 총 12만, 한 번에 4만 이하, 최대 두 번.",
         'fill': {'budget': '12만', 'merchant_ok': f'm == "{a["id"]}" || m == "{b["id"]}"', 'category_ok': '1',
                  'window_ok': 'at >= day_start(next_week(MON)) && at <= day_end(next_week(WED))', 'order_ok': 'total <= 4만',
                  'count_limit': '2', 'assumptions': []},
         'form': {'budget': '12만', 'counterparties': {'only': [a['id'], b['id']]}, 'from': '2026-11-16',
                  'until': '2026-11-18', 'one_purchase': {'at_most': '4만', 'per': 'purchase'}, 'purchases': 2}},
        {'now': now, 'words': f"Only {c1} or {c2}: 30,000 {d.pack['currency']} in total, at most 5,000 per "
                              f"{d.pack['unit']}, only this Saturday between 9 am and 6 pm.",
         'fill': {'budget': '30000', 'merchant_ok': '1', 'category_ok': f'c == "{c1}" || c == "{c2}"',
                  'window_ok': 'at >= day_start(this_week(SAT)) && at <= day_end(this_week(SAT)) && during(at, 9:00, 18:00)',
                  'order_ok': 'total <= 5000 * units', 'count_limit': '1000', 'assumptions': ['6 pm itself is outside the window']},
         'form': {'budget': '30000', 'categories': {'only': [c1, c2]}, 'from': '2026-11-14', 'until': '2026-11-14',
                  'hours': ['9:00', '18:00'], 'one_purchase': {'at_most': '5000', 'per': 'unit'}}},
        {'now': now, 'words': f"주말 오후 2시부터 5시 사이에만 {a['name']}에서, 하나에 8천 이하, 총 4만, 다음 달 말까지.",
         'fill': {'budget': '4만', 'merchant_ok': f'm == "{a["id"]}"', 'category_ok': '1',
                  'window_ok': 'at <= month_end(2026, 12) && weekday(at) >= SAT && during(at, 14:00, 17:00)',
                  'order_ok': 'total <= 8천 * units', 'count_limit': '1000', 'assumptions': ['5 pm itself is outside the window']},
         'form': {'budget': '4만', 'counterparties': {'only': [a['id']]}, 'until': '2026-12-31', 'weekdays': ['SAT', 'SUN'],
                  'hours': ['14:00', '17:00'], 'one_purchase': {'at_most': '8천', 'per': 'unit'}}},
    ]


def load_all(directory=ROOT / 'domains'):
    return {d.id: d for d in (Domain.load(p) for p in sorted(Path(directory).glob('*.json')))}
