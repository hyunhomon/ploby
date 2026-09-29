"""The pipeline from the command line (run from the repository root):

  python3 -m pcp compile escrow "가비아에서만 총 5만원, 이번 주 금요일까지"   words -> mandate: both readings, readback, trace
  python3 -m pcp pack domains/new.json      check a domain pack before using it
  python3 -m pcp stages                     which model runs each stage (pipeline.json)
  python3 -m pcp spend                      the Kiln key's spend (free)
"""
import argparse
import datetime as dt
import json
import sys
import time

from . import compiler, domain as domains, form, kiln, lang, readback, stages


def compile_cmd(a):
    d = domains.load_all()[a.domain]
    now = (int(dt.datetime.fromisoformat(a.now).replace(tzinfo=dt.timezone(dt.timedelta(minutes=d.tz))).timestamp()
               * 1000) if a.now else int(time.time() * 1000))
    r = compiler.compile_words(d, a.words, now)
    if a.json:
        keep = ('ok', 'error', 'fill', 'answer', 'hash', 'readback', 'problems', 'module')
        print(json.dumps({'agree': r['agree'], 'differences': r['differences'], 'problems': r['problems'],
                          'writer': {k: r['draft'].get(k) for k in keep}, 'reader': {k: r['reading'].get(k) for k in keep},
                          'trace': r['trace']}, ensure_ascii=False, indent=2, default=str))
        return
    for title, o in (('writer (expressions)', r['draft']), ('reader (form)', r['reading'])):
        print(f'== {title}' + ('' if o['ok'] else f": {o['error']}"))
        if o['ok']:
            for k in lang.ORDER:
                print(f"   {k:12} {o['fill'][k]}")
            print('   readback:')
            for line in o['readback']:
                print(f'     {line}')
            for p in o.get('problems') or []:
                print(f'   code found: {p}')
    verdict = {True: 'AGREE — one mandate', False: 'DIFFER — the person chooses', None: 'a reading failed'}[r['agree']]
    print(f"== {verdict}" + (f": {', '.join(r['differences'])}" if r['differences'] else ''))
    for t in r['trace']:
        print(f"   {t['stage']:7} {t['model']:22} {t['calls']} call(s)  {t['tokens']:>6} tok  ${t['cost_usd']:.5f}  "
              f"{t['seconds']:.1f}s")


def pack_cmd(a):
    d = domains.Domain.load(a.path)  # raises with the reason when the pack is wrong
    print(f'{d.id}: {len(d.registry)} payees, categories {", ".join(d.categories)}, tz {d.timezone} '
          f'({d.timezone_name}), {len(d.catalog)} catalog offers')
    print(f'writer prompt {len(d.prompt):,} chars, reader prompt {len(d.reader_prompt):,} chars, '
          f"{len(d.examples)} examples{' (generated from the registry)' if not d.pack.get('examples') else ''}")
    for e in d.examples:
        now = d.example_now(e)
        fa = readback.facts(lang.Mandate(lang.compile_fill({k: e['fill'][k] for k in lang.ORDER}, d.tz, now)), d, now)
        agree = 'form agrees' if 'form' not in e else (
            'form agrees' if not readback.differences(fa, readback.facts(lang.Mandate(form.compile_form(e['form'], d.tz)),
                                                                         d, now)) else 'FORM DIFFERS')
        print(f"  example ({agree}): {e['words']}")
        for line in readback.text(fa, d, 'ko'):
            print(f'     {line}')


def main():
    p = argparse.ArgumentParser(prog='python3 -m pcp', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('compile', help='words -> mandate')
    c.add_argument('domain')
    c.add_argument('words')
    c.add_argument('--now', help='YYYY-MM-DD HH:MM in the domain time zone (default: now)')
    c.add_argument('--json', action='store_true')
    k = sub.add_parser('pack', help='check a domain pack')
    k.add_argument('path')
    sub.add_parser('stages', help='model routes')
    sub.add_parser('spend', help="the key's spend")
    a = p.parse_args()
    if a.cmd == 'compile':
        compile_cmd(a)
    elif a.cmd == 'pack':
        pack_cmd(a)
    elif a.cmd == 'stages':
        for name, s in stages.all_stages().items():
            print(f"{name:7} {s['model']:22} {'reasoning on' if s['think'] else 'reasoning off'}")
    else:
        print(kiln.spend_report())


if __name__ == '__main__':
    sys.exit(main())
