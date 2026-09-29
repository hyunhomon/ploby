"""Words -> a mandate, with Kiln: two independent readings, compared by what they do.

    writer   writes the six expressions of the mandate language (expressive).
    reader   fills a form with the same words (form.py: plain slots), never seeing the writer's work.
    code     builds both, probes both (readback.py) and compares what they allow, fact by fact.

The two run at once, with reasoning off (about 3 s). Code also checks each on its own: a
mandate that can pay nothing at all, or that names a counterparty the words never name (a
misread name), is wrong whatever the other reading says. When the two allow the same things
and code finds nothing, that is the mandate. Otherwise each reads the words again with
reasoning on, told only which parts disagree and what code found in its own answer — never the
other's answer, so an agreement stays two independent readings — and they are compared again.
What still differs goes to the person as two readbacks to choose from. No model judges another
model's output; code compares behaviour.

The model never decides a purchase, and never does arithmetic: amounts, hours and dates are
written the way the words say them (30만, 22:00, day_end(2026, 10, 2)) and the language works
them out. The person approves the readback — what the code will do — not the model's text.
"""
import concurrent.futures as cf
import datetime as dt
import json
import re

from . import form as forms
from . import kiln, lang, readback, stages as routing
WEEKS = ('this week', 'next week', 'the week after', 'three weeks on')
EN, KO = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'), '월화수목금토일'

DATES = {
    'writer': '- A day the words name by its weekday is written by name, never looked up: "이번 주 X요일", "this X" is '
              'this_week(X); "다음 주 X요일", "next week\'s X" is next_week(X); a bare weekday ("금요일까지") is coming(X). '
              'A day the words give as a date is written as that date.',
    'reader': '- Dates and weekdays come from the calendar given with Now: find the line with that weekday and week and '
              'copy its date; never count days yourself. "이번 주 X요일", "this X" is the X marked this week; "다음 주 '
              'X요일", "next week\'s X" the X marked next week. A bare weekday ("금요일까지") is the first one from today on.',
}
READING_RULES = """- "up to", "at most", "까지", "이하", "넘지 않게", "넘으면 안 돼" mean at most (<=). "under", "less than", "미만" mean under (<). "at least", "이상" mean at least (>=). "above", "more than", "초과" mean over (>).
{dates}
- An end ("until", "through", "by", "까지") includes that whole day. "이번 달 말", "end of this month" is the last day of Now's month; "다음 달 말" of the month after (both are in the calendar).
- Hours that hold every day ("저녁 6시부터 밤 10시", "between 2 pm and 5 pm", "9 to 6"): from the first until before the second. 오후, 저녁 and 밤 N시 are N + 12 (밤 10시 is 22:00).
- A limit per person or per item ("1인당", "권당", "개당", "per person", "each") scales with units. A limit per purchase ("건당", "한 번에", "1회", "per order", "any single order") does not.
- The number of purchases is limited only when the words give one; never derive it from the budget.
- The other side (m) is who is paid. Categories limit only when the words name a kind of place or party to deal with ("약국에서만", "GPU 클라우드에서만", "convenience stores"); what is bought or sold ("GPU", "간식", "books") is never a category limit.
- When the person sells, the same limits bound their sales: m is the buyer, a purchase's total is what one sale brings in, the budget the most all sales may add up to.
- Only what the person said: anything not mentioned is not limited. Do not add limits of your own.
- The examples show the notation only. Their words, dates and amounts are not this person's: take every value from these words and this calendar."""

WRITER = """You turn a person's spending instructions for {agent} into a mandate: six one-line expressions in a small, checked language. A program runs them on every purchase the agent proposes; a purchase is paid only if all six allow it. You never decide purchases yourself.

The six entries (amounts are {currency} and always include {fees}):
- budget: the most the agent may spend in total.
- merchant_ok(m): true when {counterparty} id m may be paid.
- category_ok(c): true when category c may be paid.
- window_ok(at): true when a purchase at time `at` is allowed.
- order_ok(total, units): true when one purchase of `total` ({fees} included) for `units` {units} is allowed.
- count_limit: the most purchases allowed (1000 when the words give no number).

The language. Write values the way the words give them; the language works out the numbers, you never compute them.
- Amounts: 300000, 300_000, 30만, 1만5천, 1.5만, 8천, 2억. Hangul numerals become digits with their unit: 칠만 is 7만, 만오천 is 1만5천. No currency or 원.
- Hours: during(at, 18:00, 22:00) is true every day from 18:00 until before 22:00 (during(at, 22:00, 2:00) runs overnight). clock(at) is the time of day of `at`, for anything else.
- Dates ({timezone_name}): day_start(y, m, d) is 00:00 of that day, day_end(y, m, d) is its last moment, month_end(y, m) is the last moment of that month, time(y, m, d, h, mi) is one minute. An end date: at <= day_end(...); a start: at >= day_start(...).
- Named days: this_week(THU) is Thursday of this week (weeks start on Monday), next_week(MON) is Monday of next week, coming(FRI) is the first Friday from today on. They are days for day_start and day_end: at <= day_end(this_week(THU)).
- Weekdays: weekday(at) is MON TUE WED THU FRI SAT SUN, in that order: weekdays are weekday(at) <= FRI, weekends weekday(at) >= SAT.
- Per unit: total <= limit * units. Per purchase: total <= limit.
- Operators: + - * / %, == != < <= > >=, && || !, parentheses, "text" in double quotes, if c {{ a }} else {{ b }}. 1 means always true (there is no true keyword). One line per entry: no newlines, no ; and no #.

{counterparties} (use these ids exactly; the categories are {categories}):
{registry}

Reading the words:
{rules}

Reply with one JSON object and nothing else:
{{"budget": "...", "merchant_ok": "...", "category_ok": "...", "window_ok": "...", "order_ok": "...", "count_limit": "...", "assumptions": ["each choice the words left open"]}}"""

READER = """You read a person's spending instructions for {agent} and fill in a form with every limit the words set, and nothing else. A program compares your form with a mandate written separately from the same words before the person approves it, so read carefully and on your own.

Amounts are {currency} and include {fees}. Write them the way the words give them: 300000, 30만, 1만5천, 8천 (hangul numerals as digits with their unit: 칠만 is 7만, 만오천 is 1만5천).

The form (null where the words set no limit):
{{"budget": the total, e.g. "30만",
 "counterparties": {{"only": [ids]}} or {{"except": [ids]}} or null ({counterparties_lower} the words name, by id),
 "categories": {{"only": [...]}} or {{"except": [...]}} or null (categories the words name),
 "from": "YYYY-MM-DD" (from the start of that day) or "YYYY-MM-DD HH:MM" or null,
 "until": "YYYY-MM-DD" (through the end of that day) or "YYYY-MM-DD HH:MM" (until before that minute) or null,
 "weekdays": e.g. ["MON", "TUE", "WED", "THU", "FRI"] or null,
 "hours": ["18:00", "22:00"] (every day, from the first until before the second) or null,
 "one_purchase": {{"at_most": amount, "per": "purchase"}} or null — also "under", "at_least", "over"; "per": "unit" when the limit is per person or item,
 "purchases": the most purchases allowed, or null}}

{counterparties} (ids; the categories are {categories}):
{registry}

Reading the words:
{rules}

Reply with the JSON form only."""


# -- what the model is shown

def calendar(day, weeks=4):
    """Today and the next weeks, a day per line with the week it is in, then the month ends."""
    monday = day - dt.timedelta(days=day.weekday())
    rows = []
    for n in range((day - monday).days, 7 * weeks):
        d = monday + dt.timedelta(days=n)
        label = 'today' if d == day else 'tomorrow' if d == day + dt.timedelta(days=1) else WEEKS[n // 7]
        rows.append(f'{d.isoformat()} {EN[d.weekday()]}({KO[d.weekday()]}) {label}')
    this_end = (day.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)
    next_end = (this_end + dt.timedelta(days=32)).replace(day=1) - dt.timedelta(days=1)
    rows.append(f'this month ends {this_end.isoformat()}, next month ends {next_end.isoformat()}')
    return '\n'.join(rows)


def now_text(ms, tz):
    return readback.local(ms, tz).strftime('%A %Y-%m-%d %H:%M')


def request(domain, words, now, weeks=4):
    """The user message: Now, the calendar, the words. now is 'Weekday YYYY-MM-DD HH:MM'."""
    day = dt.date.fromisoformat(now.split()[1])
    return (f'Now: {now} ({domain.timezone_name}).\nCalendar (weeks start on Monday):\n{calendar(day, weeks)}\n'
            f'Words: {words}')


def _prompt(template, domain, answer_key):
    registry = '\n'.join(f"- {r['id']} ({', '.join([r['name'], *r.get('aliases', [])])}): category {r['category']}"
                         for r in domain.registry)
    head = template.format(agent=domain.agent, currency=domain.currency, fees=domain.fees,
                           counterparty=domain.counterparty, counterparties=domain.counterparties,
                           counterparties_lower=domain.counterparties.lower(), units=domain.units,
                           timezone_name=domain.timezone_name, categories=', '.join(domain.categories),
                           registry=registry, rules=READING_RULES.replace('{dates}', DATES['writer' if template is WRITER else 'reader']))
    shown = []
    for e in domain.examples:
        if answer_key not in e:
            continue
        answer = e[answer_key]
        if answer_key == 'fill':
            answer = {k: answer[k] for k in (*lang.ORDER, 'assumptions') if k in answer}
        now = re.sub(r'\s*\(.*\)$', '', e['now'])
        shown.append(f"Example.\n{request(domain, e['words'], now, weeks=2)}\n{json.dumps(answer, ensure_ascii=False)}")
    return head + ''.join('\n\n' + s for s in shown)


def writer_prompt(domain):
    return _prompt(WRITER, domain, 'fill')


def reader_prompt(domain):
    return _prompt(READER, domain, 'form')


# -- replies

def parse(text):
    """The first JSON object in a reply, or None."""
    text = (text or '').strip()
    for match in re.finditer(r'\{', text):
        depth = 0
        for end in range(match.start(), len(text)):
            depth += {'{': 1, '}': -1}.get(text[end], 0)
            if depth == 0:
                try:
                    value = json.loads(text[match.start():end + 1])
                except json.JSONDecodeError:
                    break
                if isinstance(value, dict):
                    return value
                break
    return None


def answer_in(reply, keys):
    """The reply's JSON object; now and then qwen3 leaves the content empty and the answer at the
    end of its reasoning, so look there too rather than pay for another call."""
    found = parse(reply['content'])
    if found is None and not reply['content'].strip():
        reasoning = reply.get('reasoning', '')
        found = parse(reasoning.rsplit('</think>', 1)[-1])
        for start in [m.start() for m in re.finditer(r'\{', reasoning)][::-1]:
            if found is not None:
                break
            value = parse(reasoning[start:])
            if value and all(k in value for k in keys):
                found = value
    return found


# -- the two readings

class Reading:
    """One reading of the words, kept as a conversation so it can be asked to read again.
    stage: which model reads and whether it reasons (pcp/stages.py)."""

    def __init__(self, role, domain, words, now, now_ms, sample, stage):
        self.role, self.domain, self.words, self.now_ms, self.sample = role, domain, words, now_ms, sample
        self.stage = 'write' if role == 'writer' else 'read'
        self.model, (suffix, self.params) = stage['model'], kiln.thinking(stage['model'], stage['think'])
        system = domain.prompt if role == 'writer' else domain.reader_prompt
        self.conversation = [{'role': 'system', 'content': system},
                             {'role': 'user', 'content': request(domain, words, now) + suffix}]
        self.calls, self.draft = [], None

    def build(self, answer):
        """The model's answer -> (fill, module), or the problem to send back."""
        if answer is None:
            return None, 'Your reply was not one JSON object. Reply with the JSON object only.'
        try:
            fill = {k: answer.get(k, '') for k in lang.ORDER} if self.role == 'writer' else forms.to_fill(answer)
            return (fill, lang.compile_fill(fill, self.domain.tz, self.now_ms)), None
        except (lang.LangError, forms.FormError) as e:
            return None, f'That was rejected: {e}\nReply with the corrected JSON object only.'

    def problems(self):
        """What code finds wrong with this reading on its own: [(part, why)]."""
        if not self.draft or not self.draft['ok']:
            return []
        return readback.dead(self.draft['facts']) + readback.unnamed(self.draft['facts'], self.domain, self.words)

    def run(self, retries=2, max_tokens=4000):
        """Ask until the answer builds (at most `retries` more times): the draft."""
        for _ in range(retries + 1):
            reply = kiln.chat(self.conversation, self.stage, model=self.model,
                              sample=self.sample, tag=f'{self.role}:{self.domain.id}:{len(self.calls)}',
                              max_tokens=max_tokens, **self.params)
            self.calls.append(reply)
            self.conversation = self.conversation + [{'role': 'assistant', 'content': reply['content']}]
            answer = answer_in(reply, lang.ORDER if self.role == 'writer' else ('budget',))
            built, problem = self.build(answer)
            if built:
                self.draft = draft_of(self.domain, *built, self.now_ms, answer)
                return self.draft
            self.conversation.append({'role': 'user', 'content': problem})
        self.draft = {'ok': False, 'error': f'the {self.role} did not produce a mandate that builds'}
        return self.draft

    def again(self, disputed, stage):
        """Read again — on the reread stage's model, reasoning as it says — told only which parts
        another reading disagrees on, and what code found wrong with this answer itself (it can
        pay nothing; it names someone the words do not)."""
        note = ''.join(f' Tested by code: {why}.' for _, why in self.problems())
        self.stage = 'reread'
        self.model, (suffix, self.params) = stage['model'], kiln.thinking(stage['model'], stage['think'])
        self.conversation.append({'role': 'user', 'content': (
            ('A separate reading of the same words disagrees with yours on: ' + ', '.join(disputed) + '. It may be the '
             'one that is wrong.' if disputed else 'Check your answer.') + note +
            ' Read the words and the calendar again, carefully, and reply with your whole answer as JSON only: '
            'changed where yours misreads the words, the same where it is right.' + suffix)})
        return self.run(retries=1, max_tokens=8000)


def draft_of(domain, fill, module, now_ms, answer):
    mandate = lang.Mandate(module)
    facts = readback.facts(mandate, domain, now_ms)
    return {'ok': True, 'error': None, 'fill': fill, 'answer': answer,
            'assumptions': answer.get('assumptions', []) if isinstance(answer, dict) else [],
            'module': module, 'mandate': mandate, 'hash': mandate.hash, 'facts': facts,
            'readback': readback.text(facts, domain, 'ko')}


PARTS = {'budget': 'the total', 'count': 'the number of purchases', 'effective': 'who may be paid',
         'order': 'the limit for one purchase', 'start': 'the first day allowed', 'end': 'the last day allowed',
         'weekdays': 'which weekdays are allowed', 'hours': 'the hours of the day allowed', 'dates': 'which days are allowed'}


def parts(first):
    """What the two readings disagree on, as precisely as the facts tell — never either one's answer."""
    out = []
    for k in first['differences']:
        out += readback.window_parts(first['draft']['facts'], first['reading']['facts']) if k == 'window' else [k]
    return [PARTS[k] for k in out]


def contrast(a, b):
    """The readback lines that differ: [(label, a's line, b's line)]."""
    def by_label(lines):
        return {line.split(':', 1)[0]: line for line in lines}
    la, lb = by_label(a['readback']), by_label(b['readback'])
    return [(k, la.get(k, ''), lb.get(k, '')) for k in dict.fromkeys([*la, *lb]) if la.get(k) != lb.get(k)]


def compare(writer, reader):
    """Do the two readings allow the same things, and does code find nothing wrong with either
    (a mandate that can pay nothing, a name the words never say)? Only then do they agree —
    even two readings that wrote the same thing are not taken as agreed past a code finding."""
    draft, reading = writer.draft, reader.draft
    if not (draft['ok'] and reading['ok']):
        return {'agree': None, 'differences': [], 'problems': [], 'contrast': [], 'draft': draft, 'reading': reading}
    differences = readback.differences(draft['facts'], reading['facts'])
    problems = list(dict.fromkeys(writer.problems() + reader.problems()))
    return {'agree': not differences and not problems, 'differences': differences, 'problems': problems,
            'contrast': contrast(draft, reading) if differences else [], 'draft': draft, 'reading': reading}


def compile_words(domain, words, now_ms, *, sample=0, again=True, stages=None):
    """Words -> {agree (True / False / None when a reading failed), differences, problems, contrast,
    draft (the writer's mandate), reading (the form's), again (read twice?), rounds, calls, latency_ms}.
    stages: {'write', 'read', 'reread': {'model', 'think'}} (default pcp/stages.py)."""
    stages = {**routing.all_stages(), **(stages or {})}
    now_ms -= now_ms % 60000  # whole minutes, so a window's edges read as the minutes the words said
    now = now_text(now_ms, domain.tz)
    writer = Reading('writer', domain, words, now, now_ms, sample, stages['write'])
    reader = Reading('reader', domain, words, now, now_ms, sample, stages['read'])

    def together(readings, step):
        """Run a step of readings at once; the round's time is the slowest one's."""
        before = [len(r.calls) for r in readings]
        with cf.ThreadPoolExecutor(2) as pool:
            list(pool.map(step, readings))
        return max(sum(c['latency_ms'] for c in r.calls[n:]) for r, n in zip(readings, before))

    rounds = []
    took = together((writer, reader), lambda r: r.run())
    rounds.append({**compare(writer, reader), 'latency_ms': took})
    first = rounds[0]
    if again and first['agree'] is not True:
        # Disagreement or a code finding: both read again. A reading that did not build: it alone.
        redo = (writer, reader) if first['agree'] is False else [r for r in (writer, reader) if not r.draft['ok']]
        disputed = parts(first) if first['agree'] is False and first['differences'] else []
        took = together(redo, lambda r: r.again(disputed, stages['reread']))
        if not writer.draft['ok'] and first['draft']['ok']:  # a second reading that no longer builds: keep the first
            writer.draft = first['draft']
        if not reader.draft['ok'] and first['reading']['ok']:
            reader.draft = first['reading']
        rounds.append({**compare(writer, reader), 'latency_ms': took})
    last = rounds[-1]
    for r in (writer, reader):  # what code finds in each, for the person choosing between them
        if r.draft['ok']:
            r.draft['problems'] = [why for _, why in r.problems()]
    return {'agree': last['agree'], 'differences': last['differences'], 'problems': last['problems'], 'contrast': last['contrast'],
            'draft': writer.draft, 'reading': reader.draft, 'again': len(rounds) > 1, 'rounds': rounds,
            'calls': writer.calls + reader.calls, 'latency_ms': sum(r['latency_ms'] for r in rounds),
            'trace': trace(writer.calls + reader.calls)}


def trace(calls):
    """What each model stage cost in this run: [{stage, model, calls, tokens, cost_usd, seconds}]."""
    out = {}
    for c in calls:
        t = out.setdefault(c.get('stage') or '?', {'stage': c.get('stage') or '?', 'model': c.get('model'), 'calls': 0,
                                                   'tokens': 0, 'cost_usd': 0.0, 'seconds': 0.0})
        t['calls'] += 1
        if not c.get('cached'):
            t['tokens'] += (c['usage'].get('prompt_tokens') or 0) + (c['usage'].get('completion_tokens') or 0)
            t['cost_usd'] += c['usage'].get('cost') or 0
            t['seconds'] += c['latency_ms'] / 1000
    return list(out.values())
