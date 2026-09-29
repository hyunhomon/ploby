"""The mandate language: six one-line expressions, parsed, type-checked and bounded before
they run, then compiled once to Python closures and evaluated deterministically.

    budget                  a number
    merchant_ok(m)          m: text, the counterparty's id
    category_ok(c)          c: text, its category (from the registry, never from the agent)
    window_ok(at)           at: a time (ms since 1970, UTC)
    order_ok(total, units)  one purchase's total (fees included) and how many it is for
    count_limit             a number

Written the way people say it, so the model copies instead of computing:

    amounts       300000 · 300_000 · 30만 · 1만5천 · 1.5만 · 2억   (천 10^3, 만 10^4, 억 10^8)
    times of day  18:00                  (minutes since midnight: 1080)
    weekdays      MON TUE WED THU FRI SAT SUN   (1 … 7)
    dates         day_start(y, m, d)     00:00 of that day
                  day_end(y, m, d)       the last moment of that day
                  month_end(y, m)        the last moment of that month
                  time(y, m, d, h, mi)   that minute
    named days    this_week(THU)         Thursday of the week the mandate was issued in (weeks start Monday)
                  next_week(MON)         Monday of the week after
                  coming(FRI)            the first Friday from the day it was issued on
                  — a day, for day_start(day) and day_end(day): day_end(this_week(THU))
    of a time     during(at, 18:00, 22:00)   every day from 18:00 until before 22:00 (22:00, 2:00 runs overnight)
                  clock(at)              its time of day, to compare with 18:00
                  weekday(at)            MON … SUN
    arithmetic    + - * / %   min(a, b)  max(a, b)  floor(a)
    logic         == != < <= > >=   && || !   ( )   if c { a } else { b }
    text          "coupang" (only compares)

Dates and clocks are in the mandate's time zone (`tz`, minutes east of UTC; Seoul is 540). Named
days count from `issued`, the minute the mandate was issued, which is part of the mandate: the
same mandate always names the same days, and the readback shows which.
Comparisons and logic give 1 or 0; nonzero is true; there is no true keyword. `&&` and
`||` evaluate both sides. A date that does not exist (November 31) is refused when the
mandate is compiled; any other failure while a predicate runs (a division by zero, a result
that is not finite) makes it false: the proposal is refused.

A compiled mandate is canonical JSON — version, tz, issued, the source lines and their syntax
trees — and its sha256 is the mandate hash. Nothing in it can loop or call out: an entry is
at most 2,000 characters, 400 nodes and 32 levels deep.

Version 1 mandates (no tz; kst(), kst_minute(), kst_weekday() with 0 = Sunday) load and
evaluate exactly as before, so old logs replay.
"""
import hashlib
import json
import math
import operator
import re

ENTRIES = {  # name -> its parameters and their types (TYPES)
    'budget': {}, 'merchant_ok': {'m': 't'}, 'category_ok': {'c': 't'}, 'window_ok': {'at': 'time'},
    'order_ok': {'total': 'n', 'units': 'n'}, 'count_limit': {},
}
TYPES = {'n': 'a number', 't': 'text', 'time': 'a moment (at, day_end(…), time(…))',
         'day': 'a named day (this_week(THU))'}
SIGNATURES = {  # function -> [(its arguments' types)], its result's type
    'time': ([('n',) * 5], 'time'), 'day_start': ([('day',), ('n',) * 3], 'time'),
    'day_end': ([('day',), ('n',) * 3], 'time'), 'month_end': ([('n', 'n')], 'time'),
    'clock': ([('time',)], 'n'), 'weekday': ([('time',)], 'n'), 'during': ([('time', 'n', 'n')], 'n'),
    'this_week': ([('n',)], 'day'), 'next_week': ([('n',)], 'day'), 'coming': ([('n',)], 'day'),
    'min': ([('n', 'n'), ('time', 'time')], None), 'max': ([('n', 'n'), ('time', 'time')], None),
    'floor': ([('n',)], 'n'), 'kst': ([('n',) * 5], 'time'), 'kst_minute': ([('time',)], 'n'),
    'kst_weekday': ([('time',)], 'n'),
}
ORDER = tuple(ENTRIES)
FUNCTIONS = {'time': (5,), 'day_start': (1, 3), 'day_end': (1, 3), 'month_end': (2,), 'clock': (1,), 'weekday': (1,),
             'during': (3,),
             'this_week': (1,), 'next_week': (1,), 'coming': (1,), 'min': (2,), 'max': (2,), 'floor': (1,),
             'kst': (5,), 'kst_minute': (1,), 'kst_weekday': (1,)}  # the last three: version 1, fixed to Seoul
NAMED_DAYS = ('this_week', 'next_week', 'coming')
CONSTANTS = {'MON': 1, 'TUE': 2, 'WED': 3, 'THU': 4, 'FRI': 5, 'SAT': 6, 'SUN': 7}
MAX_CHARS, MAX_NODES, MAX_DEPTH = 2000, 400, 32
VERSION = 2
SEOUL = 540


class LangError(ValueError):
    def __init__(self, entry, message):
        super().__init__(f'{entry}: {message}')
        self.entry, self.message = entry, message


class Fault(Exception):
    """A predicate that failed while it ran: it answers false."""


# -- reading the source

TOKEN = re.compile(r'''\s*(?:
    (?P<clock>\d{1,2}:\d{2})
  | (?P<num>\d[\d_]*(?:\.\d+)?(?:[억만천백십](?:\d[\d_]*(?:\.\d+)?)?)*)
  | (?P<text>"(?:[^"\\]|\\.)*")
  | (?P<name>[A-Za-z_][A-Za-z_0-9]*)
  | (?P<op>==|!=|<=|>=|&&|\|\||[-+*/%<>!(){},])
)''', re.X)
SMALL_UNITS = {'천': 1000, '백': 100, '십': 10}
BIG_UNITS = {'억': 10 ** 8, '만': 10 ** 4}


def number(src):
    """300_000 -> 300000; 30만 -> 300000; 1만5천 -> 15000; 1천만 -> 10000000; 2억3천만 -> 230000000."""
    s = src.replace('_', '')
    if re.fullmatch(r'\d+(?:\.\d+)?', s):
        return float(s)
    total = group = 0.0
    for digits, unit in re.findall(r'(\d+(?:\.\d+)?)?([억만천백십]?)', s):
        if not digits and not unit:
            continue
        n = float(digits) if digits else 1.0
        if unit in SMALL_UNITS:
            group += n * SMALL_UNITS[unit]
        elif unit in BIG_UNITS:
            total += (group + (n if digits else 0.0)) * BIG_UNITS[unit]
            group = 0.0
        else:
            group += n
    return total + group


def tokens(src, entry):
    out, i = [], 0
    src = src.strip()
    while i < len(src):
        m = TOKEN.match(src, i)
        if not m or m.end() == i:
            raise LangError(entry, f'unexpected character {src[i]!r} at {i}')
        kind = m.lastgroup
        value = m.group(kind)
        if kind == 'clock':
            h, mi = map(int, value.split(':'))
            if h > 24 or mi > 59 or (h == 24 and mi):
                raise LangError(entry, f'{value} is not a time of day')
            out.append(('num', float(h * 60 + mi)))
        elif kind == 'num':
            out.append(('num', number(value)))
        elif kind == 'text':
            out.append(('text', json.loads(value)))
        else:
            out.append((kind, value))
        i = m.end()
    return out


class Parser:
    LEVELS = [('||',), ('&&',), ('==', '!=', '<', '<=', '>', '>='), ('+', '-'), ('*', '/', '%')]

    def __init__(self, entry, src):
        if len(src) > MAX_CHARS:
            raise LangError(entry, f'longer than {MAX_CHARS} characters')
        if re.search(r'[\n\r;#]', src):
            raise LangError(entry, 'must be one expression on one line (no newline, ; or #)')
        self.entry, self.t, self.i, self.nodes = entry, tokens(src, entry), 0, 0

    def fail(self, message):
        raise LangError(self.entry, message)

    def peek(self, *ops):
        return self.i < len(self.t) and self.t[self.i][0] in ('op', 'name') and self.t[self.i][1] in ops

    def take(self, op):
        if not self.peek(op):
            self.fail(f'expected {op!r}, found {self.t[self.i][1] if self.i < len(self.t) else "the end"!r}')
        self.i += 1

    def node(self, *parts):
        self.nodes += 1
        if self.nodes > MAX_NODES:
            self.fail(f'more than {MAX_NODES} nodes')
        return list(parts)

    def parse(self):
        if not self.t:
            self.fail('empty')
        tree = self.expr(0)
        if self.i != len(self.t):
            self.fail(f'unexpected {self.t[self.i][1]!r} after the expression')
        return tree

    def expr(self, depth):
        if depth > MAX_DEPTH:
            self.fail(f'nested deeper than {MAX_DEPTH}')
        return self.binary(depth, 0)

    def binary(self, depth, level):
        if level == len(self.LEVELS):
            return self.unary(depth)
        left = self.binary(depth, level + 1)
        while self.peek(*self.LEVELS[level]):
            op = self.t[self.i][1]
            self.i += 1
            left = self.node(op, left, self.binary(depth + 1, level + 1))
            if level == 2 and self.peek(*self.LEVELS[2]):
                self.fail('comparisons do not chain: use && between them')
        return left

    def unary(self, depth):
        if self.peek('-', '!'):
            op = self.t[self.i][1]
            self.i += 1
            return self.node('neg' if op == '-' else '!', self.unary(depth + 1))
        return self.primary(depth)

    def primary(self, depth):
        if self.i >= len(self.t):
            self.fail('the expression ends too early')
        kind, value = self.t[self.i]
        if kind in ('num', 'text'):
            self.i += 1
            return self.node(kind, value)
        if kind == 'op' and value == '(':
            self.i += 1
            inner = self.expr(depth + 1)
            self.take(')')
            return inner
        if kind == 'name' and value == 'if':
            self.i += 1
            cond = self.expr(depth + 1)
            self.take('{')
            a = self.expr(depth + 1)
            self.take('}')
            self.take('else')
            if self.peek('if'):
                b = self.primary(depth + 1)
            else:
                self.take('{')
                b = self.expr(depth + 1)
                self.take('}')
            return self.node('if', cond, a, b)
        if kind == 'name' and value in ('true', 'false'):
            self.fail(f'there is no {value} keyword: use 1 or 0')
        if kind == 'name' and value in CONSTANTS:
            self.i += 1
            return self.node('num', float(CONSTANTS[value]))
        if kind == 'name':
            self.i += 1
            if not self.peek('('):
                return self.node('var', value)
            if value not in FUNCTIONS:
                self.fail(f'no function {value!r} (have {", ".join(FUNCTIONS)})')
            self.take('(')
            args = [] if self.peek(')') else [self.expr(depth + 1)]
            while self.peek(','):
                self.i += 1
                args.append(self.expr(depth + 1))
            self.take(')')
            if len(args) not in FUNCTIONS[value]:
                counts = ' or '.join(map(str, FUNCTIONS[value]))
                self.fail(f'{value} takes {counts} arguments, not {len(args)}')
            return self.node('call', value, *args)
        self.fail(f'unexpected {value!r}')


def hint(call):
    """How to fix the mistakes models make with these functions."""
    name, args = call[1], call[2:]
    first = args[0] if args else None
    if name in ('during', 'clock', 'weekday') and first and first[0] == 'call' and first[1] in ('clock', 'kst_minute'):
        return f'. Pass the moment itself: {name}(at, …), not {name}({first[1]}(at), …)'
    if name in ('day_start', 'day_end') and first and first[0] == 'call' and first[1] in (
            'month_end', 'day_end', 'day_start', 'time'):
        return f'. {first[1]}(…) is already a moment: compare at with it directly (at <= {first[1]}(…))'
    return ''


def check_types(entry, tree, params):
    """The type of tree ('n', 't', 'time' or 'day'), or LangError. Moments, named days and numbers
    do not mix: day_end(month_end(…)) or during(clock(at), …) is refused here, not run."""
    op = tree[0]
    if op == 'num':
        return 'n'
    if op == 'text':
        return 't'
    if op == 'var':
        if tree[1] not in params:
            allowed = ', '.join(params) or 'none (a constant)'
            raise LangError(entry, f'unknown name {tree[1]!r}; this entry can use: {allowed}')
        return params[tree[1]]
    if op == 'call':
        got = tuple(check_types(entry, arg, params) for arg in tree[2:])
        accepts, result = SIGNATURES[tree[1]]
        if got not in accepts:
            want = ' or '.join('(' + ', '.join(TYPES[t] for t in a) + ')' for a in accepts)
            raise LangError(entry, f"{tree[1]} takes {want}, not ({', '.join(TYPES[t] for t in got)}){hint(tree)}")
        return result or got[0]
    if op == 'if':
        if check_types(entry, tree[1], params) != 'n':
            raise LangError(entry, 'an if condition must be a condition (a comparison)')
        a, b = check_types(entry, tree[2], params), check_types(entry, tree[3], params)
        if a != b:
            raise LangError(entry, 'both branches of an if must have the same type')
        return a
    if op in ('neg', '!'):
        if check_types(entry, tree[1], params) != 'n':
            raise LangError(entry, f'{op} takes a number or a condition')
        return 'n'
    a, b = check_types(entry, tree[1], params), check_types(entry, tree[2], params)
    if op in ('==', '!=', '<', '<=', '>', '>='):
        if a != b:
            raise LangError(entry, f'{op} compares like with like — two numbers, two texts or two moments — '
                                   f'not {TYPES[a]} and {TYPES[b]}')
        if a == 'day':
            raise LangError(entry, 'a named day is not compared: use day_start(…) or day_end(…) of it')
        return 'n'
    if op in ('+', '-') and 'time' in (a, b):  # a moment ± milliseconds, or the time between two moments
        if (a, b) == ('time', 'time'):
            if op == '-':
                return 'n'
        elif b == 'n' or (op == '+' and a == 'n'):
            return 'time'
    if a != 'n' or b != 'n':
        raise LangError(entry, f'{op} takes numbers, not {TYPES[a]} and {TYPES[b]}')
    return 'n'


# -- the calendar

MINUTE, DAY = 60000, 86400000


def days_from_civil(y, m, d):
    """Days since 1970-01-01 of a date in the proleptic Gregorian calendar (linear in d)."""
    y -= m <= 2
    era = math.floor(y / 400)
    yoe = y - era * 400
    doy = math.floor((153 * (m - 3 if m > 2 else m + 9) + 2) / 5) + d - 1
    return era * 146097 + yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy - 719468


def days_in_month(y, m):
    return days_from_civil(y + m // 12, m % 12 + 1, 1) - days_from_civil(y, m, 1)


def calendar(tz, issued=None):
    """The date and clock functions for a time zone (minutes east of UTC); named days count from
    issued (ms), the minute the mandate was issued."""
    offset = tz * MINUTE

    def whole(*xs):
        if any(x != int(x) for x in xs):
            raise Fault('dates and times are whole numbers')

    def date_ok(y, m, d):
        whole(y, m, d)
        if not (1 <= m <= 12 and 1 <= d <= days_in_month(int(y), int(m)) and 1 <= y <= 9999):
            raise Fault(f'there is no date {y:.0f}-{m:.0f}-{d:.0f}')

    def local(y, m, d, h=0, mi=0):
        return float((days_from_civil(int(y), int(m), int(d)) * 1440 + h * 60 + mi) * MINUTE - offset)

    def time_(y, m, d, h, mi):
        date_ok(y, m, d)
        whole(h, mi)
        if not (0 <= h <= 23 and 0 <= mi <= 59):
            raise Fault(f'there is no time {h:.0f}:{mi:02.0f}')
        return local(y, m, d, h, mi)

    def day_start(*ymd):
        if len(ymd) == 1:  # a named day: days since 1970
            return float(ymd[0] * DAY - offset)
        date_ok(*ymd)
        return local(*ymd)

    def day_end(*ymd):
        if len(ymd) == 1:
            return float((ymd[0] + 1) * DAY - offset - 1)
        y, m, d = ymd
        date_ok(y, m, d)
        return local(y, m, d + 1) - 1  # the day count is linear in d: the 31st + 1 is the next month's 1st

    def today():
        if issued is None:
            raise Fault('this_week, next_week and coming need the time the mandate is issued')
        return math.floor((issued + offset) / DAY)

    def named(day):
        whole(day)
        if not 1 <= day <= 7:
            raise Fault('a named day is MON … SUN')
        return int(day)

    def this_week(day):
        t = today()
        return float(t - (t + 3) % 7 + named(day) - 1)  # Monday of this week, then the day

    def next_week(day):
        return this_week(day) + 7

    def coming(day):
        t = today()
        return float(t + (named(day) - 1 - (t + 3) % 7) % 7)

    def month_end(y, m):
        date_ok(y, m, 1)
        return local(y + m // 12, m % 12 + 1, 1) - 1

    def clock(at):
        return float(math.floor(((at + offset) % DAY) / MINUTE))

    def weekday(at):
        return float((math.floor((at + offset) / DAY) + 3) % 7 + 1)  # 1970-01-01 was a Thursday

    def during(at, start, end):
        c = clock(at)
        inside = start <= c < end if start <= end else (c >= start or c < end)  # 22:00 to 2:00 crosses midnight
        return 1.0 if inside else 0.0

    return {'time': time_, 'day_start': day_start, 'day_end': day_end, 'month_end': month_end,
            'clock': clock, 'weekday': weekday, 'during': during, 'this_week': this_week, 'next_week': next_week, 'coming': coming,
            'min': min, 'max': max, 'floor': math.floor,
            'kst': kst, 'kst_minute': kst_minute, 'kst_weekday': kst_weekday}


def kst(y, mo, d, h, mi):
    """Version 1: Seoul time to ms, no checks."""
    return float(((days_from_civil(y, mo, d) * 24 + h - 9) * 60 + mi) * MINUTE)


def kst_minute(at):
    return float(math.floor(((at + 32400000) % DAY) / MINUTE))


def kst_weekday(at):
    return float((math.floor((at + 32400000) / DAY) + 4) % 7)


# -- running it

COMPARE = {'==': operator.eq, '!=': operator.ne, '<': operator.lt, '<=': operator.le, '>': operator.gt,
           '>=': operator.ge}
ARITH = {'+': operator.add, '-': operator.sub, '*': operator.mul, '/': operator.truediv, '%': operator.mod}


def finite(value):
    if not math.isfinite(value):
        raise Fault('not finite')
    return float(value)


def fold(tree, calls):
    """Calls whose arguments are all numbers are worked out once, here (a date is a number)."""
    if tree[0] in ('num', 'text', 'var'):
        return tree
    head = tree[:2] if tree[0] == 'call' else tree[:1]
    kids = [fold(t, calls) for t in tree[len(head):]]
    if tree[0] == 'call' and all(k[0] == 'num' for k in kids):
        try:
            return ['num', finite(calls[tree[1]](*[k[1] for k in kids]))]
        except (Fault, ArithmeticError, ValueError):
            pass  # left to fail each time it runs: the predicate is false
    return head + kids


def closure(tree, params, calls):
    """A syntax tree -> a function of the entry's arguments (a tuple, in `params` order)."""
    op = tree[0]
    if op in ('num', 'text'):
        value = tree[1]
        return lambda a: value
    if op == 'var':
        i = params.index(tree[1])
        return lambda a: a[i]
    if op == 'call':
        f = calls[tree[1]]
        args = [closure(t, params, calls) for t in tree[2:]]
        if len(args) == 1:
            x, = args
            return lambda a: finite(f(x(a)))
        return lambda a: finite(f(*[x(a) for x in args]))
    if op == 'if':
        c, x, y = (closure(t, params, calls) for t in tree[1:])
        return lambda a: x(a) if c(a) != 0 else y(a)
    if op == 'neg':
        x = closure(tree[1], params, calls)
        return lambda a: -x(a)
    if op == '!':
        x = closure(tree[1], params, calls)
        return lambda a: 1.0 if x(a) == 0 else 0.0
    x, y = closure(tree[1], params, calls), closure(tree[2], params, calls)
    if op == '&&':
        return lambda a: 1.0 if (x(a) != 0) & (y(a) != 0) else 0.0  # both sides, always
    if op == '||':
        return lambda a: 1.0 if (x(a) != 0) | (y(a) != 0) else 0.0
    if op in COMPARE:
        f = COMPARE[op]
        return lambda a: 1.0 if f(x(a), y(a)) else 0.0
    f = ARITH[op]  # / and % by zero raise ZeroDivisionError: a fault
    return lambda a: finite(f(x(a), y(a)))


class Mandate:
    """A compiled mandate, ready to answer: its predicates as functions, its constants, its hash."""

    def __init__(self, module):
        self.module = module
        self.version = module.get('version', 1)
        self.tz = module.get('tz', SEOUL)
        self.source = module['source']
        self.hash = digest(module)
        self.issued = module.get('issued')
        calls = calendar(self.tz, self.issued)
        self.fn = {e: closure(fold(module['trees'][e], calls), list(ENTRIES[e]), calls) for e in ORDER}
        self.budget = self.fn['budget'](())
        self.count_limit = self.fn['count_limit'](())

    def ok(self, entry, *args):
        """A predicate's answer; one that fails while it runs is false."""
        try:
            return self.fn[entry](args) != 0
        except (Fault, ArithmeticError, ValueError, TypeError):
            return False


def digest(module):
    return hashlib.sha256(canonical(module)).hexdigest()


def canonical(module):
    return json.dumps(module, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def _check_dates(entry, tree, calls):
    """A date written in the mandate must exist: say so now, not by refusing every purchase later."""
    if tree[0] == 'call' and tree[1] in ('time', 'day_start', 'day_end', 'month_end', *NAMED_DAYS):
        try:
            fold(tree, calls)
            args = [fold(t, calls) for t in tree[2:]]
            if all(a[0] == 'num' for a in args):
                calls[tree[1]](*[a[1] for a in args])
        except Fault as e:
            raise LangError(entry, f'{tree[1]}: {e}') from None
    for t in tree[1:]:
        if isinstance(t, list):
            _check_dates(entry, t, calls)


def compile_fill(fill, tz=SEOUL, issued=None):
    """The six entries -> a module (canonical, hashable), or LangError on the first problem.
    issued: the minute (ms) the mandate is issued, which named days count from."""
    issued = None if issued is None else int(issued - issued % MINUTE)
    calls = calendar(tz, issued)
    trees = {}
    for entry in ORDER:
        if entry not in fill:
            raise LangError(entry, 'missing')
        tree = Parser(entry, str(fill[entry])).parse()
        kind = check_types(entry, tree, ENTRIES[entry])
        if kind != 'n':
            raise LangError(entry, f'must be a number or a condition, not {TYPES[kind]}')
        _check_dates(entry, tree, calls)
        trees[entry] = tree
    module = {'version': VERSION, 'tz': tz, 'source': {e: str(fill[e]).strip() for e in ORDER}, 'trees': trees}
    if issued is not None:
        module['issued'] = issued
    for entry in ('budget', 'count_limit'):
        try:
            value = closure(trees[entry], [], calls)(())
        except (Fault, ArithmeticError) as e:
            raise LangError(entry, str(e) or 'cannot be worked out') from None
        if value < 0:
            raise LangError(entry, 'must not be negative')
    return module
