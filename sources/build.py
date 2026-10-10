#!/usr/bin/env python3
"""Build the source pages from the app's own catalogue.

    python3 sources/build.py                      # from sources/data/, committed
    python3 sources/build.py --from ../logcaliper  # refresh sources/data/ from the app repo first

One page per measured event size (sources/<slug>/), one per source category
with a typical rate (eps/<slug>/), the index with the whole table and the
CSV (sources/), sitemap.xml with every page in it, and, with --store, the
home page's structured data from Apple's public lookup (rating, version,
dates) and the citations in sources/data/mentions.json. The pages are
written, not served: GitHub Pages has no build step, so this runs by hand
and the output is committed, the way quiz/build-score-pages.py does it.

Why pages at all. What ranks today for "SIEM sizing calculator" is vendor
forms and forum threads asking for a formula; nobody vendor-neutral publishes
measured per-product figures, and the catalogue that has them is inside an
iOS app a search engine cannot read. Each page is one long-tail query: the
product's log size, the category's event rate, a worked day and year, a
small calculator, the profiler for measuring your own sample, and the app.

The data is the app's: datasources.json verbatim (name, category, average
event size in bytes, measured from more than ten million log events) and
the typical-rate table from AppDelegate.m (category, average and burst
events per second per device, and the one sentence that says what drives
the figure), parsed out of the Objective-C by --from so the site and the
app cannot drift. The sizes are measured; the rates are informed estimates,
and every page says which is which.
"""
import argparse
import csv
import datetime
import html
import json
import math
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "sources" / "data"
SITE = "https://logcaliper.app"
YEAR = 2026
APP_ID = "381096276"
DAY = 86400
PROFILER_PUBLISHED = "2026-10-09"   # b4b20d7, the commit that put /profiler/ live


# ------------------------------------------------------------------ data

def refresh(app_repo):
    """Copy datasources.json and parse the typical-rate table out of
    AppDelegate.m, so the only hand-kept thing here is nothing."""
    app = pathlib.Path(app_repo)
    src = json.loads((app / "Logcaliper" / "datasources.json").read_text())
    for row in src:
        row["name"], row["category"] = row["name"].strip(), row["category"].strip()
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "datasources.json").write_text(json.dumps(src, indent=1, ensure_ascii=False) + "\n")
    text = (app / "Logcaliper" / "AppDelegate.m").read_text()
    rows = re.findall(r'typicalMessageRate addObject:\[\[NSMutableDictionary alloc\] initWithObjectsAndKeys:'
                      r'@"([^"]+)", @"category", @"(\d+)", @"average",\s*@"(\d+)", @"burst", @"([^"]+)", @"driver"', text)
    rates = [{"category": c, "average": int(a), "burst": int(b), "driver": d} for c, a, b, d in rows]
    assert len(rates) >= 10, "the rate table did not parse; the Objective-C shape changed"
    (DATA / "rates.json").write_text(json.dumps(rates, indent=1, ensure_ascii=False) + "\n")
    print(f"refreshed: {len(src)} sources, {len(rates)} rates from {app}")


def load():
    sources = json.loads((DATA / "datasources.json").read_text())
    for row in sources:
        row["name"], row["category"] = row["name"].strip(), row["category"].strip()
    rates = {r["category"].strip(): r for r in json.loads((DATA / "rates.json").read_text())}
    units = json.loads((ROOT / "quiz" / "units.json").read_text())["units"]
    return sources, rates, units


# ------------------------------------------------------------------ words and numbers

def slug(s):
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


def esc(s):
    return html.escape(str(s), quote=True)


def num(n):
    return f"{int(round(n)):,}"


def size(b):
    """Decimal units, two or three figures, the way the app prints them."""
    for unit, k in (("PB", 1e15), ("TB", 1e12), ("GB", 1e9), ("MB", 1e6), ("kB", 1e3)):
        if b >= k:
            v = b / k
            if v >= 999.5 and unit != "PB":
                continue                      # 999.6 GB is "1 TB", not "1000 GB"
            return f"{v:.0f} {unit}" if v >= 100 else f"{v:.1f} {unit}".replace(".0 ", " ")
    return f"{round(b)} B"


def compare(bytes_, units):
    """One sentence placing a volume against something from the quiz's
    catalogue: the unit whose multiple is closest to a small whole number."""
    best = None
    for u in units:
        r = bytes_ / u["bytes"]
        if r < 0.85:
            continue
        score = abs(math.log10(r))        # nearest to "about one"
        if best is None or score < best[0]:
            best = (score, r, u)
    if best is None:
        return ""
    _, r, u = best
    label = u["label"]
    for art in ("A ", "An ", "The "):
        if label.startswith(art):
            label = art.lower() + label[len(art):]
            break
    if r < 1.5:
        return f"about the size of {label}"
    return f"about {num(r) if r < 20 else num(round(r, -1))} times {label}"


# The categories as they read in a sentence: acronyms and product names keep
# their case, the rest goes lower, and plurals become singular because every
# sentence talks about one source of the kind.
CAT_TEXT = {"Firewall": "firewall", "Router": "router", "IDS/IPS": "IDS/IPS", "Servers": "server", "Proxy": "proxy",
            "Database": "database", "AD/Domain controller": "domain controller", "Windows servers": "Windows server",
            "Windows workstation": "Windows workstation", "Linux/Unix host": "Linux or Unix host", "Network switch": "network switch",
            "Managed endpoint": "managed endpoint", "Network flows": "network flow", "Application": "application",
            "Distributed system": "distributed system", "SIEM": "SIEM", "Mobile OS": "mobile OS"}


def cat_text(cat):
    return CAT_TEXT.get(cat, cat.lower())


def a_cat(cat):
    """'a firewall source', 'an application source', 'an IDS/IPS source'."""
    t = cat_text(cat)
    return ("an " if t[0].lower() in "aeio" else "a ") + t


def A_cat(cat):
    t = a_cat(cat)
    return t[0].upper() + t[1:]


def eps_phrase(rate):
    return f"{num(rate['average'])} events per second per device, bursting to {num(rate['burst'])}"


# ------------------------------------------------------------------ the page

CSS = """
:root { --navy:#334F71; --navy-deep:#22374e; --accent:#0b6f9e; --bg:#fff; --bg-alt:#f4f6f9; --surface:#fff;
  --text:#16242f; --text-dim:#566373; --rule:#dfe4ea; --field:#767f8a; --maxw:760px;
  --pad:clamp(1.25rem,4vw,2.5rem); --radius:14px;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace; }
@media (prefers-color-scheme: dark) { :root { --bg:#10181f; --bg-alt:#16222c; --surface:#1a2731; --text:#e7edf3;
  --text-dim:#9aa9b8; --rule:#2a3a48; --field:#6b7a88; --accent:#1fa2e8; } }
*,*::before,*::after { box-sizing:border-box; } html { -webkit-text-size-adjust:100%; }
body { margin:0; font-family:var(--font); font-size:17px; line-height:1.6; color:var(--text); background:var(--bg); -webkit-font-smoothing:antialiased; }
img { max-width:100%; height:auto; display:block; } a { color:var(--accent); text-underline-offset:2px; }
h1,h2 { line-height:1.2; letter-spacing:-.02em; margin:0 0 .5em; font-weight:650; }
h1 { font-size:clamp(1.6rem,4.6vw,2.3rem); } h2 { font-size:1.25rem; margin-top:2.25rem; }
p { margin:0 0 1.1em; } :focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.wrap { max-width:var(--maxw); margin-inline:auto; padding-left:max(var(--pad),env(safe-area-inset-left,0px)); padding-right:max(var(--pad),env(safe-area-inset-right,0px)); }
.skip { position:absolute; left:-9999px; top:0; z-index:100; background:var(--navy); color:#fff; padding:.75rem 1.25rem; border-radius:0 0 8px 0; } .skip:focus { left:0; }
.nav { border-bottom:1px solid var(--rule); padding-top:env(safe-area-inset-top,0px); }
.nav .wrap { display:flex; align-items:center; gap:1rem; min-height:58px; }
.brand { display:flex; align-items:center; gap:.55rem; font-weight:650; color:var(--text); text-decoration:none; letter-spacing:-.02em; }
.brand img { width:26px; height:26px; border-radius:6px; }
.nav ul { display:flex; gap:1rem; list-style:none; margin:0 0 0 auto; padding:0; font-size:.9375rem; }
.nav ul a { color:var(--text-dim); text-decoration:none; } .nav ul a:hover, .nav ul a[aria-current] { color:var(--text); }
main { padding-block:clamp(2rem,6vw,3.5rem); }
.count { font:600 .8125rem/1 var(--mono); letter-spacing:.06em; color:var(--text-dim); text-transform:uppercase; margin-bottom:.75rem; }
.lede { font-size:1.0625rem; color:var(--text-dim); max-width:60ch; }
.stats { display:flex; flex-wrap:wrap; gap:1.75rem 2.5rem; margin:1.75rem 0 .5rem; }
.stat .v { font-size:1.75rem; font-weight:650; letter-spacing:-.03em; line-height:1; font-variant-numeric:tabular-nums; }
.stat .k { color:var(--text-dim); font-size:.8125rem; margin-top:.35rem; }
.table-wrap { overflow-x:auto; margin-top:1rem; border:1px solid var(--rule); border-radius:var(--radius); background:var(--surface); }
table { border-collapse:collapse; width:100%; font-size:.9375rem; }
caption { text-align:left; padding:.9rem 1.1rem; color:var(--text-dim); font-size:.875rem; border-bottom:1px solid var(--rule); }
th,td { text-align:left; padding:.6rem 1.1rem; border-bottom:1px solid var(--rule); white-space:nowrap; } tr:last-child td { border-bottom:0; }
th { font-weight:600; font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; color:var(--text-dim); }
td.num, th.num { font-family:var(--mono); text-align:right; font-variant-numeric:tabular-nums; } td.cat { color:var(--text-dim); }
.calc { background:var(--bg-alt); border:1px solid var(--rule); border-radius:var(--radius); padding:1.25rem; margin-top:1rem; }
.calc .fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1rem; }
.calc label { display:block; font-size:.8125rem; color:var(--text-dim); }
.calc input { width:100%; margin-top:.3rem; font:inherit; font-variant-numeric:tabular-nums; padding:.5rem .6rem; border:1px solid var(--field); border-radius:8px; background:var(--surface); color:var(--text); }
.calc .out { display:flex; flex-wrap:wrap; gap:1.5rem 2.5rem; margin-top:1.25rem; }
.calc .out .v { font-size:1.6rem; font-weight:650; letter-spacing:-.03em; line-height:1; font-variant-numeric:tabular-nums; }
.calc .out .k { color:var(--text-dim); font-size:.8125rem; margin-top:.3rem; }
.note { font-size:.875rem; color:var(--text-dim); margin-top:1rem; }
.plug { margin-top:2.5rem; padding:1.35rem; background:var(--bg-alt); border:1px solid var(--rule); border-radius:var(--radius); font-size:.9688rem; }
.plug p { margin:0 0 .5rem; } .plug p:last-child { margin:0; }
.more { list-style:none; margin:0; padding:0; } .more li { padding:.45rem 0; border-bottom:1px solid var(--rule); display:flex; justify-content:space-between; gap:1rem; }
.more li:last-child { border-bottom:0; } .more .num { font-family:var(--mono); color:var(--text-dim); font-variant-numeric:tabular-nums; }
footer { border-top:1px solid var(--rule); padding-block:2rem; padding-bottom:calc(2rem + env(safe-area-inset-bottom,0px)); color:var(--text-dim); font-size:.875rem; }
footer p { margin:0 0 .5rem; max-width:70ch; }
"""

GOATCOUNTER = """<script>
(function () {
  var GC_CODE = "logcaliper";           // https://logcaliper.goatcounter.com
  if (GC_CODE === "GC" + "_CODE") return;
  var s = document.createElement("script");
  s.async = true;
  s.src = "https://gc.zgo.at/count.js";
  s.setAttribute("data-goatcounter", "https://" + GC_CODE + ".goatcounter.com/count");
  document.head.appendChild(s);
})();
</script>"""

CALC_JS = """<script>
(function () {
  var f = document.getElementById('calc'); if (!f) return;
  var q = function (id) { return document.getElementById(id); };
  function fmt(b) {
    var u = [['PB',1e15],['TB',1e12],['GB',1e9],['MB',1e6],['kB',1e3]];
    for (var i = 0; i < u.length; i++) if (b >= u[i][1]) { var v = b / u[i][1]; if (v >= 999.5 && i > 0) continue; return (v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\\.0$/, '')) + ' ' + u[i][0]; }
    return Math.round(b) + ' B';
  }
  function run() {
    var devices = +q('devices').value || 0, eps = +q('eps').value || 0, bytes = +q('bytes').value || 0, days = +q('days').value || 0;
    var perDay = devices * eps * bytes * 86400;
    q('outDay').textContent = fmt(perDay);
    q('outRet').textContent = fmt(perDay * days);
    q('outEps').textContent = Math.round(devices * eps).toLocaleString('en-US');
  }
  f.addEventListener('input', run); run();
})();
</script>"""


def page(*, title, description, path, body, nav_current=None, jsonld=None):
    nav = "".join(
        f'<li><a href="{href}"{" aria-current=\"page\"" if key == nav_current else ""}>{label}</a></li>'
        for key, href, label in (("profiler", "/profiler/", "Profiler"), ("sources", "/sources/", "Sources"), ("fun", "/fun/", "Fun")))
    ld = f'\n<script type="application/ld+json">\n{json.dumps(jsonld, indent=1, ensure_ascii=False)}\n</script>' if jsonld else ""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-itunes-app" content="app-id={APP_ID}">

<title>{esc(title)} — Logcaliper</title>
<meta name="description" content="{esc(description)}">
<link rel="canonical" href="{SITE}{path}">

<meta property="og:type" content="article">
<meta property="og:url" content="{SITE}{path}">
<meta property="og:site_name" content="Logcaliper">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:image" content="{SITE}/images/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(title)}">
<meta name="twitter:description" content="{esc(description)}">
<meta name="twitter:image" content="{SITE}/images/og.png">
<meta name="twitter:creator" content="@cbriguet">

<meta name="theme-color" content="#334F71">
<link rel="icon" type="image/png" sizes="32x32" href="/images/brand/favicon-32.png">
<link rel="icon" type="image/png" sizes="64x64" href="/images/brand/favicon-64.png">
<link rel="apple-touch-icon" href="/images/brand/apple-touch-icon.png">
{ld}
{GOATCOUNTER}

<style>{CSS}</style>
</head>
<body>

<a class="skip" href="#main">Skip to content</a>

<nav class="nav">
  <div class="wrap">
    <a class="brand" href="/"><img src="/images/brand/favicon-64.png" alt="" width="26" height="26">Logcaliper</a>
    <ul>{nav}</ul>
  </div>
</nav>

<main id="main" tabindex="-1">
  <div class="wrap">
{body}
  </div>
</main>

<footer>
  <div class="wrap">
    <p>Event sizes are averages measured from more than ten million log events, the figures Logcaliper ships. Typical rates are informed estimates, not measurements, and each page says what drives them. Decimal units: 1 GB is 1,000,000,000 bytes.</p>
    <p>&copy; {YEAR} Christophe Briguet · <a href="/sources/">All sources</a> · <a href="/profiler/">Profiler</a> · <a href="https://apps.apple.com/us/app/logcaliper/id{APP_ID}?ct=sources-footer&amp;mt=8" data-goatcounter-click="appstore-from-sources-footer">The app</a> · <a href="/privacy/">Privacy</a></p>
  </div>
</footer>
{CALC_JS}
</body>
</html>
"""


def calculator(devices, eps, bytes_, days, *, bytes_label="Bytes per event"):
    per_day = devices * eps * bytes_ * DAY
    return f"""<form class="calc" id="calc" onsubmit="return false">
  <div class="fields">
    <label>Devices<input id="devices" type="number" min="0" step="1" value="{devices}" inputmode="numeric"></label>
    <label>Events per second, per device<input id="eps" type="number" min="0" step="1" value="{eps}" inputmode="numeric"></label>
    <label>{bytes_label}<input id="bytes" type="number" min="0" step="1" value="{bytes_}" inputmode="numeric"></label>
    <label>Retention, days<input id="days" type="number" min="0" step="1" value="{days}" inputmode="numeric"></label>
  </div>
  <div class="out">
    <div><div class="v" id="outEps">{num(devices * eps)}</div><div class="k">events per second</div></div>
    <div><div class="v" id="outDay">{size(per_day)}</div><div class="k">per day</div></div>
    <div><div class="v" id="outRet">{size(per_day * days)}</div><div class="k">at retention</div></div>
  </div>
</form>
<p class="note">Raw bytes, before compression, indexing overhead and replication.</p>"""


def plug(ct):
    return f"""<div class="plug">
  <p><a href="https://apps.apple.com/us/app/logcaliper/id{APP_ID}?ct={ct}&amp;mt=8" data-goatcounter-click="appstore-from-{ct}">Logcaliper</a>, free on iOS, has these sizes and rates built in and sizes a whole list of sources at retention: storage, cluster capacity, nodes.</p>
</div>"""


def profiler_para(what, rate=None, measured=True):
    """The one paragraph that differs by page: what moves this figure, in
    the category's own words, then the profiler."""
    if not measured:
        why = f"There is no measured size for {esc(what)} yet."
    elif rate:
        why = f"The figure above is an average; yours will differ, and for {esc(what)} what moves it most is this: {esc(rate['driver'])}."
    else:
        why = "The figure above is an average; yours will differ with the format and the fields you keep."
    return f"""<h2>Measure a sample of your own</h2>
<p>{why} The <a href="/profiler/">profiler</a> reads a sample from {esc(what)} in your browser, line by line, one event per line, and reports the bytes per line to set against it. Nothing is uploaded.</p>"""


# ------------------------------------------------------------------ the three kinds of page

def source_page(s, sources, rates, units):
    name, cat, b = s["name"], s["category"], s["averageEventSizeBytes"]
    rate = rates.get(cat)
    path = f"/sources/{slug(name)}/"
    title = f"{name} log size: {num(b)} bytes per event"
    siblings = sorted((x for x in sources if x["category"] == cat and x["name"] != name), key=lambda x: -x["averageEventSizeBytes"])
    if rate:
        day = rate["average"] * b * DAY
        description = (f"The average {name} event is {num(b)} bytes, measured. At the typical {num(rate['average'])} events/s, "
                       f"one device is {size(day)} a day and {size(day * 365)} a year, raw.")
        rate_sentence = (f"{esc(A_cat(cat))} source typically produces {eps_phrase(rate)}: {esc(rate['driver'])}. "
                         f"The rate is an informed estimate; the size is measured.")
        stats = f"""<div class="stats">
  <div class="stat"><div class="v">{num(b)} B</div><div class="k">per event, measured</div></div>
  <div class="stat"><div class="v">{num(rate['average'])}</div><div class="k">events per second, typical</div></div>
  <div class="stat"><div class="v">{size(day)}</div><div class="k">per device per day</div></div>
  <div class="stat"><div class="v">{size(day * 365)}</div><div class="k">per device per year</div></div>
</div>"""
        burst_day = rate["burst"] * b * DAY
        table = f"""<h2>What that comes to</h2>
<p class="note">One device, raw bytes, at the typical rate for {esc(a_cat(cat))} source.</p>
<div class="table-wrap" tabindex="0" role="region" aria-label="Volumes at the typical rate">
<table>
<thead><tr><th scope="col">Period</th><th scope="col" class="num">At {num(rate['average'])} events/s</th><th scope="col" class="num">At the {num(rate['burst'])} events/s burst</th></tr></thead>
<tbody>
<tr><td>An hour</td><td class="num">{size(day / 24)}</td><td class="num">{size(burst_day / 24)}</td></tr>
<tr><td>A day</td><td class="num">{size(day)}</td><td class="num">{size(burst_day)}</td></tr>
<tr><td>90 days</td><td class="num">{size(day * 90)}</td><td class="num">{size(burst_day * 90)}</td></tr>
<tr><td>A year</td><td class="num">{size(day * 365)}</td><td class="num">{size(burst_day * 365)}</td></tr>
</tbody></table></div>
<p style="margin-top:1rem">A day of {esc(name)} logs from one device at the category's typical rate, {size(day)}, is {compare(day, units)}.</p>"""
        calc = calculator(1, rate["average"], b, 90)
    else:
        description = f"The average {name} log event is {num(b)} bytes, measured. Multiply by your event rate for the volume; the page does it for you."
        rate_sentence = f"There is no typical event rate for {esc(a_cat(cat))} source in the catalogue: the rate is yours to give, and the calculator below takes it."
        stats = f"""<div class="stats">
  <div class="stat"><div class="v">{num(b)} B</div><div class="k">per event, measured</div></div>
  <div class="stat"><div class="v">{size(b * DAY)}</div><div class="k">per day at one event a second</div></div>
</div>"""
        table = ""
        calc = calculator(1, 1, b, 90)
    sib = ""
    if siblings:
        sib = f"""<h2>Other {esc(cat_text(cat))} sources</h2>
<ul class="more">{"".join(f'<li><a href="/sources/{slug(x["name"])}/">{esc(x["name"])}</a><span class="num">{num(x["averageEventSizeBytes"])} B</span></li>' for x in siblings)}</ul>"""
    cat_link = f'<p><a href="/eps/{slug(cat)}/">The {esc(cat_text(cat))} category: its typical rate and every source in it →</a></p>' if rate else ""
    cat_label = f'<a href="/eps/{slug(cat)}/" style="color:inherit">{esc(cat)}</a>' if rate else esc(cat)
    body = f"""<p class="count">Measured event size · {cat_label}</p>
<h1>{esc(title)}</h1>
<p class="lede">The average {esc(name)} event is {num(b)} bytes, measured from samples of its logs. {rate_sentence}</p>
{stats}
{table}
<h2>Size your own</h2>
{calc}
{profiler_para(name, rate)}
{sib}
{cat_link}
{plug(f"source-{slug(name)}")}"""
    return path, page(title=title, description=description, path=path, body=body, nav_current="sources")


def category_page(cat, rate, sources, units):
    members = sorted((s for s in sources if s["category"] == cat), key=lambda s: -s["averageEventSizeBytes"])
    path = f"/eps/{slug(cat)}/"
    title = f"{cat} log rate: {num(rate['average'])} events/s per device"
    sizes = sorted(s["averageEventSizeBytes"] for s in members)
    n = len(sizes)
    median = (sizes[n // 2] if n % 2 else (sizes[n // 2 - 1] + sizes[n // 2]) / 2) if sizes else 0
    day = rate["average"] * median * DAY if median else 0
    description = (f"{A_cat(cat)} source typically sends {num(rate['average'])} events per second per device and bursts to "
                   f"{num(rate['burst'])}: {rate['driver']}.")
    stats = f"""<div class="stats">
  <div class="stat"><div class="v">{num(rate['average'])}</div><div class="k">events per second, typical</div></div>
  <div class="stat"><div class="v">{num(rate['burst'])}</div><div class="k">at the burst</div></div>
  {f'<div class="stat"><div class="v">{num(median)} B</div><div class="k">median event size, {len(members)} source{"s" if len(members) != 1 else ""}</div></div>' if median else ''}
  {f'<div class="stat"><div class="v">{size(day)}</div><div class="k">per device per day</div></div>' if day else ''}
</div>"""
    if members:
        rows = "".join(f'<tr><td><a href="/sources/{slug(s["name"])}/">{esc(s["name"])}</a></td><td class="num">{num(s["averageEventSizeBytes"])}</td>'
                       f'<td class="num">{size(rate["average"] * s["averageEventSizeBytes"] * DAY)}</td><td class="num">{size(rate["average"] * s["averageEventSizeBytes"] * DAY * 365)}</td></tr>' for s in members)
        table = f"""<h2>Measured sources in this category</h2>
<p class="note">Average bytes per event, measured, and one device's volume at the typical {num(rate['average'])} events per second.</p>
<div class="table-wrap" tabindex="0" role="region" aria-label="Sources in this category">
<table>
<thead><tr><th scope="col">Source</th><th scope="col" class="num">Bytes per event</th><th scope="col" class="num">A day</th><th scope="col" class="num">A year</th></tr></thead>
<tbody>{rows}</tbody></table></div>"""
        comp = f'<p style="margin-top:1rem">At the median size, a day from one device, {size(day)}, is {compare(day, units)}.</p>'
    else:
        table = f"<h2>Measured sources in this category</h2><p>None yet: no {esc(cat_text(cat))} has a measured event size in the catalogue, so the calculator below starts from a placeholder of 500 bytes. Put in your own.</p>"
        comp = ""
    body = f"""<p class="count">Typical event rate · category</p>
<h1>{esc(title)}</h1>
<p class="lede">{esc(A_cat(cat))} source typically produces {eps_phrase(rate)}: {esc(rate['driver'])}. The rate is an informed estimate, a starting point for a sizing, not a measurement{"; the event sizes below are measured" if members else ""}.</p>
{stats}
{table}
{comp}
<h2>Size a fleet</h2>
{calculator(10, rate['average'], int(round(median)) or 500, 90, bytes_label="Bytes per event" + (" (the median here)" if median else " (a placeholder)"))}
{profiler_para(cat_text(cat) + " logs", rate, measured=bool(members))}
{plug(f"eps-{slug(cat)}")}"""
    return path, page(title=title, description=description, path=path, body=body, nav_current="sources")


def index_page(sources, rates, units):
    path = "/sources/"
    title = f"Measured log event sizes, {YEAR}: 39 sources"
    description = ("Measured average event sizes for 39 log sources and typical events per second for 16 categories, "
                   "with what drives each. Free under CC BY, with a CSV.")
    ordered = sorted(sources, key=lambda s: -s["averageEventSizeBytes"])
    rows = ""
    for s in ordered:
        r = rates.get(s["category"])
        day = size(r["average"] * s["averageEventSizeBytes"] * DAY) if r else "—"
        rows += (f'<tr><td><a href="/sources/{slug(s["name"])}/">{esc(s["name"])}</a></td>'
                 f'<td class="cat">{f"<a href=\"/eps/{slug(s[chr(99)+chr(97)+chr(116)+chr(101)+chr(103)+chr(111)+chr(114)+chr(121)])}/\" style=\"color:inherit\">" if r else ""}{esc(s["category"])}{"</a>" if r else ""}</td>'
                 f'<td class="num">{num(s["averageEventSizeBytes"])}</td><td class="num">{day}</td></tr>')
    rrows = "".join(f'<tr><td><a href="/eps/{slug(c)}/">{esc(c)}</a></td><td class="num">{num(r["average"])}</td><td class="num">{num(r["burst"])}</td><td style="white-space:normal">{esc(r["driver"])}</td></tr>'
                    for c, r in sorted(rates.items(), key=lambda kv: -kv[1]["average"]))
    jsonld = {
        "@context": "https://schema.org", "@type": "Dataset",
        "name": f"Logcaliper measured log event sizes {YEAR}",
        "description": description, "url": SITE + path,
        "license": "https://creativecommons.org/licenses/by/4.0/",
        "creator": {"@type": "Person", "name": "Christophe Briguet", "url": SITE},
        "keywords": ["log size", "event size", "SIEM sizing", "events per second", "log volume"],
        "distribution": [{"@type": "DataDownload", "encodingFormat": "text/csv", "contentUrl": f"{SITE}/sources/logcaliper-event-sizes-{YEAR}.csv"}],
    }
    body = f"""<p class="count">The catalogue</p>
<h1>Measured log event sizes, {YEAR}</h1>
<p class="lede">The 39 average event sizes Logcaliper ships, measured from more than ten million log events, and the typical event rates for 16 source categories. The sizes are measured; the rates are informed estimates, and every page says what drives them. Each source has its own page with a worked day and year, a calculator, and the profiler for measuring your own sample.</p>
<p>Take the data: <a href="/sources/logcaliper-event-sizes-{YEAR}.csv" data-goatcounter-click="sources-csv">the CSV</a>, under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>, which asks for a link back to this page. Every row carries its page's address.</p>
<p class="note">Average bytes per event, measured; and one device's day at the category's typical rate, raw.</p>
<div class="table-wrap" tabindex="0" role="region" aria-label="All measured event sizes">
<table>
<thead><tr><th scope="col">Source</th><th scope="col">Category</th><th scope="col" class="num">Bytes per event</th><th scope="col" class="num">A day, per device</th></tr></thead>
<tbody>{rows}</tbody></table></div>
<h2>Typical event rates, by category</h2>
<p class="note">Events per second per device: the typical figure, the burst, and what decides it. Estimates, not measurements.</p>
<div class="table-wrap" tabindex="0" role="region" aria-label="Typical rates by category">
<table>
<thead><tr><th scope="col">Category</th><th scope="col" class="num">Typical</th><th scope="col" class="num">Burst</th><th scope="col">What drives it</th></tr></thead>
<tbody>{rrows}</tbody></table></div>
<h2>How the sizes were measured</h2>
<p>Each figure is the average byte length of the events in log samples of that product, as a collector receives them, more than ten million events in all; some figures are rounded. An average is a starting point: the audit level and which fields are kept move it by a factor of two or more either way, which is what the profiler is for. The rates are what one device of the kind usually produces, with the condition that moves the figure most named beside it; they are the figure Logcaliper starts a sizing from.</p>
<h2>Measure a sample of your own</h2>
<p>The <a href="/profiler/">profiler</a> reads a sample log in your browser, line by line, and reports the bytes per line to set against these averages. Nothing is uploaded.</p>
{plug("sources-index")}"""
    return path, page(title=title, description=description, path=path, body=body, nav_current="sources", jsonld=jsonld)


def write_csv(sources, rates):
    out = ROOT / "sources" / f"logcaliper-event-sizes-{YEAR}.csv"
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["source", "category", "avg_event_size_bytes", "typical_eps_per_device", "burst_eps_per_device", "rate_driver", "page", "license"])
        for s in sorted(sources, key=lambda s: s["name"].lower()):
            r = rates.get(s["category"], {})
            w.writerow([s["name"], s["category"], s["averageEventSizeBytes"], r.get("average", ""), r.get("burst", ""), r.get("driver", ""),
                        f"{SITE}/sources/{slug(s['name'])}/", "CC BY 4.0, Logcaliper, https://logcaliper.app/sources/"])
    return out


def write_sitemap(paths):
    """The fixed pages carry no date (the generator does not touch them);
    the generated ones carry the day their inputs last changed, from git."""
    import subprocess
    try:
        stamp = subprocess.run(["git", "-C", str(ROOT), "log", "-1", "--format=%cs", "--",
                                "sources/data/datasources.json", "sources/data/rates.json", "quiz/units.json", "sources/build.py"],
                               capture_output=True, text=True, timeout=10).stdout.strip() or datetime.date.today().isoformat()
    except Exception:
        stamp = datetime.date.today().isoformat()
    fixed = ["/", "/quiz/", "/threshold/", "/profiler/", "/fun/", "/privacy/"]
    urls = "".join(f"  <url><loc>{SITE}{p}</loc></url>\n" for p in fixed)
    urls += "".join(f"  <url><loc>{SITE}{p}</loc><lastmod>{stamp}</lastmod></url>\n" for p in paths)
    (ROOT / "sitemap.xml").write_text(f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}</urlset>\n')


MENTIONS_FILE = ROOT / "sources" / "data" / "mentions.json"


def store_facts():
    """The listing's own figures from Apple's public lookup, for the home
    page's structured data: rating, count, version, dates, size. Kept in
    sources/data/store.json so the page can be rebuilt without the network."""
    import urllib.request
    url = f"https://itunes.apple.com/lookup?country=us&id={APP_ID}"
    with urllib.request.urlopen(url, timeout=30) as r:
        res = json.load(r)["results"][0]
    facts = {"version": res["version"], "rating": res.get("averageUserRating"), "ratingCount": res.get("userRatingCount"),
             "released": res["releaseDate"][:10], "updated": res["currentVersionReleaseDate"][:10],
             "fileSizeBytes": int(res.get("fileSizeBytes", 0)), "minimumOs": res.get("minimumOsVersion")}
    (DATA / "store.json").write_text(json.dumps(facts, indent=1) + "\n")
    return facts


def last_change(path):
    """The date of the last commit that touched path, or None outside a git checkout."""
    try:
        out = subprocess.run(["git", "log", "-1", "--format=%cs", "--", path], cwd=ROOT,
                             capture_output=True, text=True, timeout=10).stdout.strip()
        return out or None
    except (OSError, subprocess.SubprocessError):
        return None


def home_jsonld():
    """Rewrite the home page's JSON-LD from sources/data/store.json and
    sources/data/mentions.json: one graph of the site, its author, and the
    two tools the home page presents as equals, the profiler and the app.
    Google's software-app result wants name, operating system, category, an
    offer and an aggregate rating; the rating and the citations describe
    the App Store listing, so they sit on the app and never on the profiler,
    whose node has none (Search Console will list it as not eligible for a
    rich result, which is right). The rest is what a careful reader of the
    markup would expect to find true."""
    facts = json.loads((DATA / "store.json").read_text())
    mentions = json.loads(MENTIONS_FILE.read_text()) if MENTIONS_FILE.exists() else []
    author = {"@id": SITE + "/#author"}
    ld = {
        "@type": "MobileApplication",
        "@id": SITE + "/#app",
        "name": "Logcaliper",
        "operatingSystem": f"iOS {facts['minimumOs']} or later",
        "applicationCategory": "UtilitiesApplication",
        "url": SITE + "/",
        "downloadUrl": f"https://apps.apple.com/us/app/logcaliper/id{APP_ID}",
        "description": ("A calculator for log management and SIEM capacity planning: converts data sizes and rates, "
                        "estimates volume, storage and cluster size from a list of sources, and compares data sizes."),
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "image": SITE + "/images/brand/logo-512.png",
        "screenshot": SITE + "/images/app/convert.png",
        "softwareVersion": facts["version"],
        "datePublished": facts["released"],
        "dateModified": facts["updated"],
        "fileSize": f"{facts['fileSizeBytes'] / 1e6:.1f} MB",
        "author": author,
    }
    if facts.get("rating") and facts.get("ratingCount"):
        ld["aggregateRating"] = {"@type": "AggregateRating", "ratingValue": facts["rating"], "ratingCount": facts["ratingCount"],
                                 "bestRating": 5, "worstRating": 1}
    if mentions:
        ld["citation"] = [{"@type": "CreativeWork", "name": m["title"], "url": m["url"], "author": m.get("author", "")} for m in mentions if m.get("url")]
    app = ld
    profiler = {
        "@type": "WebApplication",
        "@id": SITE + "/#profiler",
        "name": "Logcaliper Profiler",
        "url": SITE + "/profiler/",
        "applicationCategory": "DeveloperApplication",
        "operatingSystem": "Any",
        "browserRequirements": "Requires JavaScript and Web Workers. Safari 16.4 or later, or a current Chrome, Edge or Firefox.",
        "description": ("Reads a log sample in the browser, with nothing uploaded, and reports its lines and bytes reconciled to the byte, "
                        "the average bytes per event, the message templates (Drain, after masking timestamps, addresses, ids and numbers), "
                        "the events per second over the time its timestamps cover, and what a year of it takes to keep."),
        "featureList": [
            "Lines and bytes reconciled to the byte against the size of the file",
            "Average and longest line in bytes",
            "Message templates by Drain, after masking timestamps, IPv4 and MAC addresses, UUIDs, hex ids and numbers",
            "Events per second over the time the timestamps cover, in six timestamp formats",
            "Storage for a day and for a chosen retention and compression",
            "JSON and CSV downloads",
            "Nothing uploaded: no analytics, and a Content Security Policy that allows no outside connection",
        ],
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "isAccessibleForFree": True,
        "image": SITE + "/images/profiler-og.png",
        "screenshot": SITE + "/images/profiler/hero-light.webp",
        "datePublished": PROFILER_PUBLISHED,
        "author": author,
    }
    modified = last_change("profiler/")
    if modified:
        profiler["dateModified"] = modified
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "WebSite", "@id": SITE + "/#website", "name": "Logcaliper", "url": SITE + "/", "publisher": author},
        {"@type": "Person", "@id": SITE + "/#author", "name": "Christophe Briguet", "url": SITE + "/",
         "sameAs": ["https://x.com/cbriguet", "https://www.linkedin.com/in/cbriguet/"]},
        profiler,
        app,
    ]}
    page = ROOT / "index.html"
    s = page.read_text()
    start = s.index('<script type="application/ld+json">')
    end = s.index("</script>", start) + len("</script>")
    s = s[:start] + '<script type="application/ld+json">\n' + json.dumps(ld, indent=2, ensure_ascii=False) + "\n</script>" + s[end:]
    page.write_text(s)
    return ld


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="app_repo", help="path to the app repo, to refresh sources/data/ first")
    ap.add_argument("--store", action="store_true", help="also ask Apple's public lookup for the listing's rating, version and dates")
    args = ap.parse_args()
    if args.app_repo:
        refresh(args.app_repo)
    if args.store:
        f = store_facts()
        print(f"store: version {f['version']}, rating {f['rating']} from {f['ratingCount']}, updated {f['updated']}")
    if (DATA / "store.json").exists():
        nodes = home_jsonld()["@graph"]
        print(f"home page: structured data rebuilt ({len(nodes)} nodes" + (", the app's with citations" if "citation" in nodes[-1] else "") + ")")
    sources, rates, units = load()
    paths = []
    for s in sources:
        path, html_ = source_page(s, sources, rates, units)
        out = ROOT / path.strip("/") / "index.html"; out.parent.mkdir(parents=True, exist_ok=True); out.write_text(html_); paths.append(path)
    for cat, rate in rates.items():
        path, html_ = category_page(cat, rate, sources, units)
        out = ROOT / path.strip("/") / "index.html"; out.parent.mkdir(parents=True, exist_ok=True); out.write_text(html_); paths.append(path)
    path, html_ = index_page(sources, rates, units)
    (ROOT / "sources" / "index.html").write_text(html_)
    csv_path = write_csv(sources, rates)
    write_sitemap(["/sources/"] + sorted(paths))
    print(f"built {len(sources)} source pages, {len(rates)} category pages, the index, {csv_path.name}, and sitemap.xml with {len(paths) + 6} URLs")


if __name__ == "__main__":
    main()
