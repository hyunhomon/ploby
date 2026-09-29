"""Readback: what a compiled mandate actually allows, found by asking its predicates
thousands of questions — never by asking the model that wrote it.

From the answers: the counterparties and categories allowed; the time windows (a 30-minute
grid over 180 days, refined to the minute at each edge), and from them the daily hours and
weekdays; the largest single purchase for 1, 2, 3, 4, 5 and 10 units (a 1,000 grid, refined
to 1) and whether every smaller total is allowed too; the budget and the count.

The same facts become the sentences a person approves, the check against their words, and
the vault grant — so what is approved, what is checked and what the chain enforces are one
thing.
"""
import datetime as dt

MINUTE, HALF_HOUR, DAY = 60000, 1800000, 86400000
UNITS = (1, 2, 3, 4, 5, 10)
UNLISTED = '(unlisted)'  # a counterparty not in the registry (no registry id has parentheses)
WEEKDAYS_KO = '월화수목금토일'
WEEKDAYS_EN = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')


def facts(mandate, domain, now_ms, days=180):
    """What the mandate allows, as data."""
    merchants = {m: mandate.ok('merchant_ok', m) for m in domain.ids + [UNLISTED]}
    categories = {c: mandate.ok('category_ok', c) for c in domain.categories + ['unknown']}
    effective = {m: merchants[m] and categories[domain.by_id[m]['category']] for m in domain.ids}
    effective[UNLISTED] = merchants[UNLISTED] and categories['unknown']
    order, steady = order_limits(mandate)
    return {'budget': mandate.budget, 'count': mandate.count_limit, 'merchants': merchants,
            'categories': categories, 'effective': effective, 'intervals': windows(mandate, now_ms, days),
            'order': order, 'order_steady': steady, 'order_cap': order_cap(mandate), 'now': now_ms,
            'horizon': now_ms + days * DAY, 'tz': mandate.tz}


def windows(mandate, start, days):
    """The allowed spans, [(first allowed minute, last allowed minute — None if still open at the horizon)]."""
    def ok(t):
        return mandate.ok('window_ok', float(t))
    grid = [start + i * HALF_HOUR for i in range(days * 48 + 1)]
    marks = [ok(t) for t in grid]
    points = list(zip(grid, marks))
    for i in range(1, len(grid)):
        if marks[i] != marks[i - 1]:  # an edge in this half hour: find its minute
            points += [(t, ok(t)) for t in range(grid[i - 1] + MINUTE, grid[i], MINUTE)]
    points.sort()
    spans, begin, previous = [], None, None
    for t, allowed in points:
        if allowed and begin is None:
            begin = t
        elif not allowed and begin is not None:
            spans.append((begin, previous))
            begin = None
        previous = t
    if begin is not None:
        spans.append((begin, None))
    return spans


def order_cap(mandate):
    """How far one purchase's total is probed: past the budget, within reason."""
    return int(min(max(mandate.budget * 1.5, 100000), 5000000))


def order_limits(mandate):
    """For each unit count, the totals one purchase may have: {'min', 'max'} (max None when no limit
    shows below the probe cap), or None when no total is allowed; and whether every total between
    min and max is allowed too."""
    cap = order_cap(mandate)
    limits, steady = {}, True
    for u in UNITS:
        def ok(t):
            return mandate.ok('order_ok', float(t), float(u))
        allowed = [i for i, t in enumerate(range(0, cap + 1, 1000)) if ok(t)]
        if not allowed:
            limits[u] = None
            continue
        lo, hi = allowed[0], allowed[-1]
        low = 0 if lo == 0 else (lo - 1) * 1000 + min(k for k in range(1, 1001) if ok((lo - 1) * 1000 + k))
        high = None if hi == cap // 1000 else hi * 1000 + max(k for k in range(1001) if ok(hi * 1000 + k))
        limits[u] = {'min': low, 'max': high}
        steady = steady and allowed == list(range(lo, hi + 1))
    return limits, steady


def window_parts(a, b):
    """Which part of 'when' two mandates differ on: the start, the end, the weekdays, the hours."""
    out = []
    sa, sb = a['intervals'], b['intervals']
    if (sa[0][0] if sa else None) != (sb[0][0] if sb else None) and daily(a)[0] is None and daily(b)[0] is None:
        out.append('start')
    if (sa[-1][1] if sa else None) != (sb[-1][1] if sb else None):
        out.append('end')
    (ha, da), (hb, db) = daily(a), daily(b)
    if da != db:
        out.append('weekdays')
    if ha != hb:
        out.append('hours')
    return out or ['dates']


def differences(a, b):
    """Where two mandates' facts differ (two compilations of the same words)."""
    out = [k for k in ('budget', 'count', 'effective') if a[k] != b[k]]
    if a['order'] != b['order'] or a['order_steady'] != b['order_steady']:
        out.append('order')
    if a['intervals'] != b['intervals']:
        out.append('window')
    return out


def dead(f):
    """What makes a mandate unable to pay anything at all — never what the person meant.
    [(part, why)], empty for a mandate that can pay something."""
    out = []
    if f['budget'] <= 0:
        out.append(('budget', 'the total is 0'))
    if not any(f['effective'].values()):
        out.append(('effective', 'no counterparty can be paid: the ones allowed and the categories allowed exclude each other'))
    if not f['intervals']:
        out.append(('window', 'no time is allowed'))
    if all(v is None or v['max'] == 0 for v in f['order'].values()):
        out.append(('order', 'no amount is allowed for one purchase'))
    return out


def unnamed(f, domain, words):
    """Counterparties a mandate picks out by name that the words never name — the shape of a name
    misread ("쿠팡이랑" read as 쿠팡이츠). [(part, why)]. A list the words name in full is as they
    said, whatever its size: every one allowed named (an allow-list), or every one excluded named
    (an exclusion list). Only when neither holds, the unnamed ones on the side nearer a pick by name
    (fewer unnamed, then fewer in all) — so a reread is told of the misread, not of the rest."""
    text = words.lower()

    def named(cid):  # by its id, name or alias — or by its category ("GPU 클라우드에서만")
        r = domain.by_id[cid]
        names = [cid, r['name'], *r.get('aliases', []), r['category'], domain.category_name(r['category'])]
        return any(n.lower() in text for n in names)
    allowed = [m for m in domain.ids if f['merchants'][m]]
    excluded = [m for m in domain.ids if not f['merchants'][m]]
    sides = [([m for m in side if not named(m)], side) for side in (allowed, excluded)]
    if not all(missing for missing, _ in sides):
        return []
    picked = min(sides, key=lambda s: (len(s[0]), len(s[1])))[0]
    return [('effective', f"{m} ({domain.name_of(m)}) is {'allowed' if f['merchants'][m] else 'excluded'} by name, "
                          'but the words never name it') for m in picked]


# -- sentences

def zone(tz):
    return dt.timezone(dt.timedelta(minutes=tz))


def local(ms, tz):
    return dt.datetime.fromtimestamp(ms / 1000, zone(tz))


def daily(f):
    """(hours, weekdays) that hold on every whole day inside the window: hours as
    [('18:00', '21:59')] (last allowed minute), None when the whole day or when they vary;
    weekdays as ISO numbers (1 Monday), None when every weekday is allowed."""
    spans, tz = f['intervals'], f['tz']
    if not spans:
        return None, None
    first = local(spans[0][0], tz).date() + dt.timedelta(days=1)
    last = local(spans[-1][1] if spans[-1][1] is not None else f['horizon'], tz).date() - dt.timedelta(days=1)
    patterns, seen, on = set(), set(), set()
    day = first
    while day <= last:
        lo = int(dt.datetime.combine(day, dt.time(), zone(tz)).timestamp() * 1000)
        hi = lo + DAY - MINUTE
        cuts = tuple((max(s, lo), min(hi if e is None else e, hi)) for s, e in spans if s <= hi and (e is None or e >= lo))
        seen.add(day.isoweekday())
        if cuts:
            on.add(day.isoweekday())
            patterns.add(tuple((local(a, tz).strftime('%H:%M'), local(b, tz).strftime('%H:%M')) for a, b in cuts))
        day += dt.timedelta(days=1)
    hours = next(iter(patterns)) if len(patterns) == 1 else None
    if hours == (('00:00', '23:59'),):
        hours = None
    return hours, (sorted(on) if seen - on else None)


def korean_won(n):
    """300000 -> 30만 원 · 15000 -> 1만 5천 원 · 12345 -> 1만 2,345원 · 3500 -> 3,500원."""
    n = int(round(n))
    if n == 0:
        return '0원'
    eok, rest = divmod(n, 10 ** 8)
    man, rest = divmod(rest, 10 ** 4)
    parts = [f'{eok:,}억'] * bool(eok) + [f'{man:,}만'] * bool(man)
    if rest:
        parts.append(f'{rest // 1000}천' if rest % 1000 == 0 else f'{rest:,}')
    return ' '.join(parts) + ('원' if rest % 1000 else ' 원')


def one_purchase(f, domain, ko, money, limit):
    """The sentence for one purchase: its largest (and smallest) total, per unit when it scales."""
    order, unit = f['order'], (domain.unit_ko if ko else domain.unit)
    head = '한 번에: ' if ko else 'One purchase: '
    if any(v is None for v in order.values()):
        return head + ', '.join(f"{u}{'개' if ko else '×'} → " + ('안 됨' if ko and v is None else 'none' if v is None else
                                f"{money(v['min'])}~{money(v['max']) if v['max'] is not None else ''}")
                                for u, v in order.items())

    def scaled(values):  # the same per unit: 5000·u, or 5000·u − 1 for a strict limit (beyond the probes: unseen)
        one = values[1]
        return bool(one) and all(v is None and one * u > f['order_cap'] or v is not None and (
            v == one * u or v + 1 == (one + 1) * u or v - 1 == (one - 1) * u) for u, v in values.items())

    def least(n):  # 2,501 reads as "over 2,500"
        if (n - 1) % 1000 == 0 and n % 1000:
            return f'{money(n - 1)} 초과' if ko else f'over {money(n - 1)}'
        return f'{money(n)} 이상' if ko else f'at least {money(n)}'

    parts = []
    mins = {u: v['min'] for u, v in order.items()}
    maxes = {u: v['max'] for u, v in order.items()}
    if any(mins.values()):
        if scaled(mins):
            parts.append(f'{unit}당 {least(mins[1])}' if ko else f'{least(mins[1])} per {unit}')
        elif len(set(mins.values())) == 1:
            parts.append(least(mins[1]))
        else:
            parts.append(', '.join(f"{u}{'개' if ko else '×'} ≥ {money(v)}" for u, v in mins.items()))
    if any(v is not None for v in maxes.values()):
        if maxes[1] is not None and scaled(maxes):
            parts.append(f'{unit}당 {limit(maxes[1])}' if ko else f'{limit(maxes[1])} per {unit}')
        elif len(set(maxes.values())) == 1:
            parts.append(f'{limit(maxes[1])} ({domain.fees_ko} 포함)' if ko else f'{limit(maxes[1])} including {domain.fees}')
        else:
            parts.append(', '.join(f"{u}{'개' if ko else '×'} → {money(v) if v is not None else '∞'}" for u, v in maxes.items()))
    if not parts:
        return head + ('제한 없음 (총 한도만 적용)' if ko else 'no limit beyond the total')
    note = '' if f['order_steady'] else (' (주의: 그 사이에도 거절되는 금액이 있습니다)' if ko else ' (note: some totals in between are refused)')
    return head + ', '.join(parts) + note


def text(f, domain, lang='ko'):
    """The readback people approve: plain sentences, from the facts alone."""
    ko = lang == 'ko'
    tz = f['tz']

    def money(n):
        return korean_won(n) if ko and domain.currency == 'KRW' else f'{n:,.0f} {domain.currency}'

    def limit(n):  # 19,999 reads as "under 20,000"
        if (n + 1) % 1000 == 0 and n % 1000:
            return f'{money(n + 1)} 미만' if ko else f'under {money(n + 1)}'
        return f'{money(n)}까지' if ko else f'up to {money(n)}'

    def when(ms):
        t = local(ms, tz)
        return (f"{t:%Y-%m-%d}({WEEKDAYS_KO[t.weekday()]}) {t:%H:%M}" if ko
                else f"{WEEKDAYS_EN[t.weekday()]} {t:%Y-%m-%d %H:%M}")

    def weekdays(days):
        names = WEEKDAYS_KO if ko else WEEKDAYS_EN
        if len(days) > 2 and days == list(range(days[0], days[-1] + 1)):
            return f'{names[days[0] - 1]}~{names[days[-1] - 1]}' if ko else f'{names[days[0] - 1]} to {names[days[-1] - 1]}'
        return ', '.join(names[d - 1] for d in days)

    def until(hhmm):  # the last allowed minute -> the minute it stops
        h, m = map(int, hhmm.split(':'))
        m += 1
        stop = f'{h + m // 60:02d}:{m % 60:02d}'
        return ('자정' if ko else 'midnight') if stop == '24:00' else stop

    lines = [f"총 한도: {money(f['budget'])} ({domain.fees_ko} 포함) — 모두 합쳐 이보다 많이 결제되지 않습니다." if ko else
             f"Total: {money(f['budget'])} including {domain.fees} — altogether, no more than this is paid."]

    # who can be paid
    label = domain.counterparty_ko if ko else domain.counterparties
    yes = [m for m in domain.ids if f['merchants'][m]]
    no = [m for m in domain.ids if not f['merchants'][m]]
    unlisted = f['merchants'][UNLISTED]
    def names(ids):
        return ', '.join(domain.name_of(m) if ko or domain.name_of(m).lower() == m else f'{domain.name_of(m)} ({m})'
                         for m in ids)
    if not no:
        who = (('제한 없음 (목록에 없는 곳 포함)' if unlisted else '목록에 있는 곳 모두 (목록에 없는 곳은 안 됨)') if ko else
               ('any, including unlisted ones' if unlisted else 'any listed one (unlisted ones refused)'))
    elif not yes:
        who = ('목록에 없는 곳만' if unlisted else '없음 — 결제할 수 있는 곳이 없습니다') if ko else \
              ('only unlisted ones' if unlisted else 'none — nothing can be paid')
    elif len(yes) <= len(no) or not unlisted:  # an allow-list (nothing unlisted) reads as the ones allowed
        who = (f'{names(yes)}만' + (' (목록에 없는 곳도 허용)' if unlisted else '')) if ko else \
              (f'only {names(yes)}' + (' (and unlisted ones)' if unlisted else ''))
    else:
        who = (f'{names(no)}만 빼고 모두' + (' (목록에 없는 곳 포함)' if unlisted else ' (목록에 없는 곳은 안 됨)')) if ko else \
              (f'all but {names(no)}' + (' (unlisted ones too)' if unlisted else ' (unlisted ones refused)'))
    lines.append(f'{label}: {who}')
    allowed_c = [c for c in domain.categories if f['categories'][c]]
    if len(allowed_c) < len(domain.categories):
        shown = ', '.join(domain.category_name(c) if ko else c for c in allowed_c)
        lines.append((f'분야: {shown}만' if allowed_c else '분야: 없음') if ko else
                     (f'Categories: only {shown}' if allowed_c else 'Categories: none'))

    # when
    spans = f['intervals']
    if not spans:
        lines.append('기간: 허용되는 때가 없습니다 — 아무것도 결제되지 않습니다' if ko else 'When: never — nothing can be paid')
    else:
        begin, end = spans[0][0], spans[-1][1]
        hours, days = daily(f)
        if hours:  # the hours say when in the day: the period is days
            def day(ms):
                t = local(ms, tz)
                return f"{t:%Y-%m-%d}({WEEKDAYS_KO[t.weekday()]})" if ko else f"{WEEKDAYS_EN[t.weekday()]} {t:%Y-%m-%d}"
            today = local(begin, tz).date() == local(f['now'], tz).date()
            start = ('지금' if ko else 'now') if today else day(begin)
            last = day(end) if end is not None else None
        else:
            start = ('지금' if ko else 'now') if begin <= f['now'] else when(begin)
            last = when(end) if end is not None else None
        if ko:
            lines.append(f'기간: {start}부터 {last}까지' if last else f'기간: {start}부터, 끝나는 날 없음')
        else:
            lines.append(f'When: from {start} until {last}' if last else f'When: from {start}, no end date')
        if days:
            lines.append(f'요일: {weekdays(days)}만' if ko else f'Days: {weekdays(days)} only')
        if hours:
            span = ', '.join(f'{a}부터 {until(b)} 전까지' if ko else f'{a} to {until(b)}' for a, b in hours)
            lines.append(f'시간: 매일 {span}' if ko else f'Hours: every day {span}')
        elif len(spans) > 1 and not days:
            shown = '; '.join(f'{when(a)}~{when(b) if b is not None else ""}' for a, b in spans[:6])
            lines.append(('허용 구간: ' if ko else 'Allowed: ') + shown + (' …' if len(spans) > 6 else ''))
        if tz != 540:
            lines.append(f"(시간은 {domain.timezone_name} 기준)" if ko else f"(times in {domain.timezone_name})")

    # one purchase
    lines.append(one_purchase(f, domain, ko, money, limit))

    count = f['count']
    lines.append((f'횟수: 최대 {count:.0f}번' if count < 1000 else '횟수: 제한 없음') if ko else
                 (f'Purchases: at most {count:.0f}' if count < 1000 else 'Purchases: no limit'))
    return lines
