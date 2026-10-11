"""SVG art for the home-services template. No photos: every picture is inline SVG that takes its colors
from CSS classes (see assets/style.css: .k ink stroke, .f-paper, .f-cool, .f-hot ...), so a recolor in
content.json "colors" flows into the art too. Text in SVG uses the page font."""
from html import escape as e


def emblem(initials, size=44):
    """Client logo fallback: two-tone shield with initials (top = hot, bottom = cool)."""
    i = e(initials[:2].upper())
    return (f'<svg class="emblem" viewBox="0 0 48 48" width="{size}" height="{size}" aria-hidden="true">'
            '<path class="f-hot" d="M24 2 44 9v13H4V9z"/><path class="f-cool" d="M4 22h40c0 13-8 21-20 24C12 43 4 35 4 22z"/>'
            '<path d="M24 2 44 9v13c0 13-8 21-20 24C12 43 4 35 4 22V9z" fill="none" class="k" stroke-width="2.5"/>'
            f'<text x="24" y="31" text-anchor="middle" class="emblem-t">{i}</text></svg>')


def favicon(initials, hot, cool, ink):
    i = e(initials[:2].upper())
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">'
            f'<path fill="{hot}" d="M24 2 44 9v13H4V9z"/><path fill="{cool}" d="M4 22h40c0 13-8 21-20 24C12 43 4 35 4 22z"/>'
            f'<path d="M24 2 44 9v13c0 13-8 21-20 24C12 43 4 35 4 22V9z" fill="none" stroke="{ink}" stroke-width="2.5"/>'
            f'<text x="24" y="31" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="17" fill="#fff">{i}</text></svg>')


def hero_house(temp='72'):
    """House cross-section: condenser outside, duct in the attic, thermostat, sink + trap, water heater."""
    return f'''<svg class="house" viewBox="0 0 560 470" role="img" aria-labelledby="house-t">
<title id="house-t">Illustration: a house cross-section with an air conditioner, ductwork, thermostat, sink and water heater</title>
<circle class="f-hot-soft" cx="470" cy="78" r="58"/><circle class="f-hot" cx="470" cy="78" r="30"/>
<g class="k" stroke-width="4" stroke-linecap="round"><path d="M470 22v-12M470 146v-12M414 78h-12M538 78h-12M430 38l-8-8M518 126l-8-8M510 38l8-8M422 126l8-8"/></g>
<path class="f-paper2 k" stroke-width="4" stroke-linejoin="round" d="M120 200 300 80l180 120v222H120z"/>
<path class="f-ink" d="M96 206 300 70l204 136-14 20L300 98 110 226z"/>
<rect class="f-cool-soft k" stroke-width="3" x="180" y="168" width="240" height="26" rx="13"/>
<g class="k" stroke-width="3" stroke-linecap="round"><path d="M214 194v20M300 194v20M386 194v20"/></g>
<g class="f-none cool-line" stroke-width="3.5" stroke-linecap="round"><path class="breeze" d="M196 232c12 8 24-8 36 0s24-8 36 0"/><path class="breeze b2" d="M196 252c12 8 24-8 36 0s24-8 36 0"/></g>
<path class="k" stroke-width="4" d="M300 214v208"/>
<rect class="f-white k" stroke-width="3" x="196" y="296" width="70" height="56" rx="10"/>
<text x="231" y="333" text-anchor="middle" class="svg-num">{e(temp)}°</text>
<rect class="f-cool" x="206" y="342" width="50" height="4" rx="2"/>
<rect class="f-ink" x="320" y="300" width="140" height="16" rx="4"/>
<path class="f-none k" stroke-width="5" stroke-linecap="round" d="M372 300v-30c0-12 18-12 18 0"/>
<path class="f-none cool-line" stroke-width="5" stroke-linecap="round" d="M390 316v22c0 18 26 18 26 0v-8M372 316v60h-28v46"/>
<rect class="f-white k" stroke-width="3.5" x="420" y="330" width="46" height="92" rx="12"/>
<path class="f-hot" d="M443 396c-9-6-6-16 0-24 2 8 9 8 9 16s-4 11-9 8z"/>
<path class="f-none hot-line" stroke-width="5" stroke-linecap="round" d="M443 330v-14h-10"/>
<path class="k" stroke-width="5" stroke-linecap="round" d="M20 422h520"/>
<rect class="f-white k" stroke-width="4" x="26" y="330" width="82" height="88" rx="8"/>
<g class="fan"><circle class="f-cool-soft k" stroke-width="3" cx="67" cy="374" r="30"/>
<path class="f-cool" d="M67 374c-4-14 2-24 10-24 2 10-2 18-10 24zM67 374c14-4 24 2 24 10-10 2-18-2-24-10zM67 374c4 14-2 24-10 24-2-10 2-18 10-24zM67 374c-14 4-24-2-24-10 10-2 18 2 24 10z"/>
<circle class="f-ink" cx="67" cy="374" r="5"/></g>
<path class="f-none k" stroke-width="4" stroke-linecap="round" d="M108 352h12"/>
<g class="tag-g"><rect class="f-ink" x="20" y="268" width="96" height="30" rx="15"/><text x="68" y="288" text-anchor="middle" class="svg-tag">AC + HEAT</text></g>
<g class="tag-g"><rect class="f-ink" x="436" y="432" width="104" height="30" rx="15"/><text x="488" y="452" text-anchor="middle" class="svg-tag">PLUMBING</text></g>
</svg>'''


ICONS = {
    'ac': '<path d="M24 4v40M7 14l34 20M41 14 7 34"/><path d="M19 7l5 5 5-5M19 41l5-5 5 5M6 20l7-1-2-7M42 28l-7 1 2 7M42 20l-7-1 2-7M6 28l7 1-2 7"/>',
    'heat': '<path d="M24 44c-9 0-15-6-15-14 0-9 8-13 9-24 6 4 9 9 9 15 2-2 3-5 3-8 5 4 9 10 9 17 0 8-6 14-15 14z"/><path d="M24 44c-4 0-7-3-7-7 0-5 5-7 6-12 4 3 8 6 8 12 0 4-3 7-7 7z"/>',
    'plumb': '<path d="M6 14h14v8h14c4 0 8 4 8 8v12h-8V32c0-1-1-2-2-2H20v4H6z"/><path d="M13 14V8M10 8h6"/>',
    'water': '<rect x="12" y="4" width="24" height="40" rx="8"/><path d="M24 34c-4-2-3-8 0-11 1 3 4 4 4 7s-2 5-4 4z"/><path d="M12 14h24"/>',
    'drain': '<circle cx="24" cy="24" r="18"/><path d="M24 24c0-5 6-5 6 0s-5 9-10 9-11-5-11-11 6-13 15-13"/>',
    'plan': '<rect x="9" y="7" width="30" height="37" rx="5"/><path d="M18 7V4h12v3M16 22l4 4 8-8M16 34h16"/>',
    'phone': '<path d="M14 6h7l3 9-4 3a24 24 0 0 0 10 10l3-4 9 3v7c0 3-2 5-5 5C21 39 9 27 9 11c0-3 2-5 5-5z"/>',
    'text': '<path d="M6 10c0-2 2-4 4-4h28c2 0 4 2 4 4v20c0 2-2 4-4 4H20l-9 8v-8h-1c-2 0-4-2-4-4z"/><path d="M14 18h20M14 25h13"/>',
    'shield': '<path d="M24 4 40 10v12c0 11-7 18-16 22C15 40 8 33 8 22V10z"/><path d="M17 24l5 5 10-10"/>',
    'badge': '<circle cx="24" cy="19" r="13"/><path d="M17 30l-4 14 11-5 11 5-4-14"/><path d="M19 19l4 4 7-7"/>',
    'tag': '<path d="M6 8v14l20 20 16-16L22 6H8z"/><circle cx="15" cy="15" r="3"/>',
    'clock': '<circle cx="24" cy="24" r="19"/><path d="M24 12v13l8 5"/>',
    'pin': '<path d="M24 44S10 30 10 19a14 14 0 0 1 28 0c0 11-14 25-14 25z"/><circle cx="24" cy="19" r="5"/>',
    'card': '<rect x="4" y="10" width="40" height="28" rx="5"/><path d="M4 18h40M10 30h10"/>',
    'arrow': '<path d="M8 24h30M28 14l10 10-10 10"/>',
    'star': '<path d="M24 4l6 13 14 1-11 9 4 14-13-8-13 8 4-14L4 18l14-1z"/>',
    'mail': '<rect x="5" y="10" width="38" height="28" rx="4"/><path d="M5 13l19 13 19-13"/>',
}


def icon(name, cls='ic'):
    return f'<svg class="{cls}" viewBox="0 0 48 48" aria-hidden="true">{ICONS[name]}</svg>'


STARS = '<span class="stars" aria-hidden="true">' + ''.join(
    '<svg viewBox="0 0 48 48"><path d="M24 4l6 13 14 1-11 9 4 14-13-8-13 8 4-14L4 18l14-1z"/></svg>' for _ in range(5)) + '</span>'

# pin positions for up to 8 service-area labels (illustrative layout, not geography)
_PINS = [(240, 170), (168, 150), (198, 222), (300, 268), (128, 262), (82, 140), (280, 110), (360, 188)]


def area_map(cities, hub):
    pins = ''
    for (x, y), c in zip(_PINS, cities[:8]):
        main = c == hub
        r = 9 if main else 6
        pins += (f'<g><circle class="{"f-hot" if main else "f-ink"}" cx="{x}" cy="{y}" r="{r}"/>'
                 f'<text x="{x + 12}" y="{y + 4}" class="svg-map{" svg-map-b" if main else ""}">{e(c)}</text></g>')
    return f'''<svg class="area-map" viewBox="0 0 480 340" role="img" aria-labelledby="map-t">
<title id="map-t">Illustrative service-area map around {e(hub)}. Not to scale.</title>
<rect class="f-paper2" width="480" height="340" rx="18"/>
<path class="f-none cool-soft-line" stroke-width="22" stroke-linecap="round" d="M-10 300c70-30 90-90 160-80s110 40 170 10 90-80 170-90"/>
<circle class="f-none k-faint" stroke-width="10" cx="240" cy="180" r="70"/>
<circle class="f-none k-faint" stroke-width="7" cx="240" cy="180" r="138"/>
<path class="f-none k-faint" stroke-width="6" d="M240 0v340M0 180h480M60 30l360 300M420 30 60 330"/>
<circle class="f-hot-soft" cx="240" cy="180" r="150" opacity=".35"/>
{pins}
<text x="466" y="326" text-anchor="end" class="svg-cap">Illustrative map · not to scale</text>
</svg>'''


def og_html(name, tagline, phone, line, hub, fonts_css, colors, demo=False):
    """1200x630 share card, screenshotted by build.py --og."""
    c = colors
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><link href="{fonts_css}" rel="stylesheet">
<style>html,body{{margin:0;width:1200px;height:630px;overflow:hidden}}
body{{background:{c["ink"]};color:#fff;font-family:Archivo,Arial,sans-serif;position:relative}}
.k{{stroke:{c["ink"]};fill:none}} .f-ink{{fill:{c["ink"]}}} .f-hot{{fill:{c["hot"]}}} .f-cool{{fill:{c["cool"]}}}
.f-paper2{{fill:{c["paper2"]}}} .f-white{{fill:#fff}} .f-hot-soft{{fill:{c["hot_soft"]}}} .f-cool-soft{{fill:{c["cool_soft"]}}}
.f-none{{fill:none}} .cool-line{{stroke:{c["cool"]}}} .hot-line{{stroke:{c["hot"]}}} .fan,.breeze{{}}
.svg-num{{font:900 26px Archivo;fill:{c["ink"]}}} .svg-tag{{font:800 13px Archivo;fill:#fff;letter-spacing:.08em}}
.wrap{{position:absolute;left:64px;top:64px;width:560px}}
.stripe{{position:absolute;left:0;right:0;bottom:0;height:18px;background:linear-gradient(90deg,{c["hot"]} 50%,{c["cool"]} 50%)}}
h1{{font-size:62px;line-height:1;margin:22px 0 18px;font-weight:900;font-stretch:112%;letter-spacing:-.02em}}
p{{font-size:30px;margin:0;color:{c["paper"]};opacity:.9}}
.ph{{display:inline-block;margin-top:38px;background:{c["hot"]};color:#fff;font-size:44px;font-weight:900;padding:14px 26px;border-radius:14px;font-stretch:110%}}
.ln{{margin-top:22px;font-size:19px;letter-spacing:.06em;text-transform:uppercase;opacity:.8}}
.dm{{position:absolute;right:36px;bottom:40px;font-size:18px;letter-spacing:.1em;text-transform:uppercase;background:#fff;color:#000;padding:6px 14px;border-radius:999px;font-weight:800}}
.art{{position:absolute;right:36px;top:64px;width:470px;background:{c["paper"]};border-radius:28px;padding:16px}}
.art svg{{width:100%;height:auto;display:block}}</style></head>
<body><div class="wrap"><p style="font-size:24px;letter-spacing:.1em;text-transform:uppercase;color:{c["hot_soft"]}">{e(hub)}</p>
<h1>{e(name)}</h1><p>{e(tagline)}</p><div class="ph">{e(phone)}</div><div class="ln">{e(line)}</div></div>
<div class="art">{hero_house()}</div><div class="stripe"></div>{'<div class="dm">Demo business</div>' if demo else ''}</body></html>'''
