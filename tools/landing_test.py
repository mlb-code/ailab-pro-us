"""Landing reviews rule test. Stdlib only.

The "What clients say" section renders only with >= 2 approved reviews (consent: true) in site/_content/reviews.json;
the "What a call sounds like" sample strip always renders; no empty "your review here" placeholders, ever.

usage: python3 tools/landing_test.py      exit 0 = all checks pass
"""
import copy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_landing as bl  # noqa: E402

REVIEW = {'name': 'Pat Doe', 'business': 'Doe Heating', 'city': 'Austin, TX', 'text': 'Answers every call.',
          'source_url': 'https://example.com/review/1', 'date': '2026-11-01', 'consent': True, 'rating': 5}
failures = []


def page_with(reviews):
    c = bl.Ctx()
    orig = bl.load
    def patched(p):
        data = orig(p)
        if os.path.basename(p) == 'reviews.json':
            data = copy.deepcopy(data)
            data['reviews'] = reviews
        return data
    bl.load = patched
    try:
        pages, _ = bl.build(c)
    finally:
        bl.load = orig
    return pages


def check(name, cond):
    print(('ok    ' if cond else 'FAIL  ') + name)
    if not cond:
        failures.append(name)


r2 = [REVIEW, dict(REVIEW, name='Lee Roe', source_url='https://example.com/review/2')]
cases = [
    ('0 reviews', [], False),
    ('1 approved review', [REVIEW], False),
    ('2 reviews, one without consent', [REVIEW, dict(r2[1], consent=False)], False),
    ('2 approved reviews', r2, True),
]
for label, reviews, shown in cases:
    pages = page_with(reviews)
    for rel in ('index.html', 'real-estate/index.html'):
        h = pages[rel]
        check(f'{label}: {rel} sample strip present', 'id="sample-calls"' in h and 'rv--sample' in h)
        check(f'{label}: {rel} reviews section {"present" if shown else "absent"}', ('id="reviews"' in h) == shown)
        check(f'{label}: {rel} no review placeholders', 'Your review here' not in h and 'rv--open' not in h)
        if shown:
            check(f'{label}: {rel} both reviews rendered', 'Pat Doe' in h and 'Lee Roe' in h)

try:
    page_with([dict(REVIEW, text='')])
    check('consented review with a missing field stops the build', False)
except SystemExit:
    check('consented review with a missing field stops the build', True)

print(f'landing_test: {len(failures)} failed')
sys.exit(1 if failures else 0)
