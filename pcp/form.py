"""The form: a mandate as slots — the plain way to write one — turned into the six expressions
by code, then compiled and probed like any other mandate.

    {"budget": "30만",
     "counterparties": {"only": ["coupang", "onnuri-pharmacy"]} | {"except": ["olive-young"]} | null,
     "categories": {"only": ["pharmacy"]} | {"except": [...]} | null,
     "from": "2026-10-05" | "2026-10-05 09:00" | null        from the start of that day / that minute
     "until": "2026-10-31" | "2026-10-31 18:00" | null       through that day / until before that minute
     "weekdays": ["MON", "TUE", "WED", "THU", "FRI"] | null,
     "hours": ["18:00", "22:00"] | null                      every day, from the first until before the second
                                                             (["22:00", "2:00"] runs overnight)
     "one_purchase": {"at_most" | "under" | "at_least" | "over": amount, …, "per": "purchase" | "unit"} | null,
     "purchases": 3 | null}

null (or a missing slot) sets no limit. Two uses: the compiler's second, independent reading of
a person's words (a model fills a form without seeing the mandate the other model wrote; code
compares what the two allow), and frontends that build a mandate from fields rather than
expressions.
"""
import re

from . import lang

BOUNDS = {'at_most': '<=', 'under': '<', 'at_least': '>=', 'over': '>'}
WEEKDAYS = ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')
ID = re.compile(r'[a-z0-9][a-z0-9-]{0,39}$')
AMOUNT = re.compile(r'\d[\d_,]*(?:\.\d+)?(?:[억만천백십](?:\d[\d_,]*(?:\.\d+)?)?)*$')
DATE = re.compile(r'(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}):(\d{2}))?$')
CLOCK = re.compile(r'\d{1,2}:\d{2}$')


class FormError(ValueError):
    pass


def amount(value, slot):
    text = str(int(value) if isinstance(value, float) and value.is_integer() else value).replace(',', '').strip()
    if not AMOUNT.match(text):
        raise FormError(f'{slot}: {value!r} is not an amount (write 300000, 30만 or 1만5천)')
    return text


def choose(value, var, slot):
    """{"only": [...]} / {"except": [...]} / null -> an expression over var."""
    if value in (None, 'any', {}):
        return '1'
    if not isinstance(value, dict) or len(value) != 1 or not {'only', 'except'} & set(value):
        raise FormError(f'{slot}: write {{"only": [ids]}}, {{"except": [ids]}} or null')
    kind, ids = next(iter(value.items()))
    if not isinstance(ids, list) or not all(isinstance(x, str) and ID.match(x) for x in ids):
        raise FormError(f'{slot}: {ids!r} is not a list of ids')
    if kind == 'only':
        return ' || '.join(f'{var} == "{x}"' for x in ids) or '0'
    return ' && '.join(f'{var} != "{x}"' for x in ids) or '1'


def moment(value, slot, end):
    m = DATE.match(str(value).strip())
    if not m:
        raise FormError(f'{slot}: {value!r} is not YYYY-MM-DD or YYYY-MM-DD HH:MM')
    y, mo, d, h, mi = (int(x) if x is not None else None for x in m.groups())
    if h is None:
        return f'at <= day_end({y}, {mo}, {d})' if end else f'at >= day_start({y}, {mo}, {d})'
    return f'at < time({y}, {mo}, {d}, {h}, {mi})' if end else f'at >= time({y}, {mo}, {d}, {h}, {mi})'


def to_fill(form):
    """A form -> the six expressions (a fill), or FormError."""
    if not isinstance(form, dict) or 'budget' not in form:
        raise FormError('a form is a JSON object with at least a budget')
    when = []
    if form.get('from'):
        when.append(moment(form['from'], 'from', end=False))
    if form.get('until'):
        when.append(moment(form['until'], 'until', end=True))
    if form.get('weekdays'):
        days = form['weekdays']
        if not isinstance(days, list) or not days or not all(str(x).upper()[:3] in WEEKDAYS for x in days):
            raise FormError(f'weekdays: {days!r} (write ["MON", "FRI"])')
        names = sorted({str(x).upper()[:3] for x in days}, key=WEEKDAYS.index)
        if len(names) < 7:
            when.append('(' + ' || '.join(f'weekday(at) == {x}' for x in names) + ')' if len(names) > 1 else
                        f'weekday(at) == {names[0]}')
    if form.get('hours'):
        hours = form['hours']
        if not (isinstance(hours, list) and len(hours) == 2 and all(CLOCK.match(str(x)) for x in hours)):
            raise FormError(f'hours: {hours!r} (write ["18:00", "22:00"])')
        when.append(f'during(at, {hours[0]}, {hours[1]})')
    order = []
    one = form.get('one_purchase')
    if one:
        if not isinstance(one, dict) or not set(one) & set(BOUNDS) or one.get('per', 'purchase') not in ('purchase', 'unit'):
            raise FormError('one_purchase: {"at_most": amount, "per": "purchase" or "unit"} (or under, at_least, over)')
        scale = ' * units' if one.get('per') == 'unit' else ''
        order = [f'total {BOUNDS[k]} {amount(v, "one_purchase")}{scale}' for k, v in one.items() if k in BOUNDS]
    purchases = form.get('purchases')
    if purchases is not None and (not isinstance(purchases, (int, float)) or purchases < 0 or purchases != int(purchases)):
        raise FormError(f'purchases: {purchases!r} is not a whole number')
    return {'budget': amount(form['budget'], 'budget'),
            'merchant_ok': choose(form.get('counterparties'), 'm', 'counterparties'),
            'category_ok': choose(form.get('categories'), 'c', 'categories'),
            'window_ok': ' && '.join(when) or '1', 'order_ok': ' && '.join(order) or '1',
            'count_limit': str(int(purchases)) if purchases is not None else '1000'}


def compile_form(form, tz=lang.SEOUL):
    """A form -> a module, or FormError / LangError."""
    return lang.compile_fill(to_fill(form), tz)
