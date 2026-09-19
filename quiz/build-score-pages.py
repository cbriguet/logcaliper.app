#!/usr/bin/env python3
"""Generate the per-score share pages: quiz/s/0/ .. quiz/s/10/

Why these exist: LinkedIn's share endpoint ignores prefilled text and renders
whatever Open Graph card the shared URL carries. Open Graph is read by crawlers
before any JavaScript runs, so /quiz/?score=7 cannot change the preview. Eleven
static pages can — each with its own og:image showing the score — and it still
works on plain static hosting.

The page a human lands on is not a redirect. It says what the sharer scored and
offers to let them try, which converts better than a bounce and is honest about
where they are.

Run from the repo root:  uv run --with pillow python quiz/build-score-pages.py
"""
from PIL import Image, ImageDraw, ImageFont
import pathlib, html

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "quiz" / "s"
IMGS = OUT / "og"
TOTAL = 10

NAVY, INK = (51, 79, 113), (22, 36, 47)
DIM = (160, 190, 216)


def font(px, bold=True):
    p = "/System/Library/Fonts/HelveticaNeue.ttc"
    if pathlib.Path(p).exists():
        try:
            return ImageFont.truetype(p, px, index=1 if bold else 7)
        except Exception:
            pass
    return ImageFont.load_default(px)


def centred(d, box, text, f, fill):
    x0, y0, x1, y1 = box
    l, t, r, b = d.textbbox((0, 0), text, font=f)
    d.text((x0 + (x1 - x0 - (r - l)) / 2 - l, y0 + (y1 - y0 - (b - t)) / 2 - t),
           text, font=f, fill=fill)


def og_image(score, path):
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), NAVY)
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=tuple(int(NAVY[i] + (INK[i] - NAVY[i]) * t) for i in range(3)))

    mark = Image.open(ROOT / "images" / "brand" / "logo-512.png").convert("RGB").resize((52, 52), Image.LANCZOS)
    m = Image.new("L", mark.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, 52, 52], radius=11, fill=255)
    img.paste(mark, (72, 64), m)
    d.text((140, 72), "Logcaliper", font=font(34), fill=DIM)

    # the score, which is the whole point of the image
    centred(d, (0, 150, W, 420), f"{score} / {TOTAL}", font(190), "white")
    centred(d, (0, 420, W, 490), "on the data size quiz", font(40, bold=False), DIM)

    # the ten squares, so the shape of the run is visible at a glance
    sq, gap = 46, 12
    total_w = TOTAL * sq + (TOTAL - 1) * gap
    x = (W - total_w) // 2
    for n in range(TOTAL):
        col = (78, 201, 138) if n < score else (198, 76, 68)
        d.rounded_rectangle([x, 516, x + sq, 516 + sq], radius=8, fill=col)
        x += sq + gap

    img.save(path, optimize=True)


def quiz_og_image(path):
    """The card for the quiz itself.

    It used to inherit the site-wide image, which reads "Size your log
    deployment before you buy it — Free on the App Store". Under a headline
    asking how good your sense of data size is, that turned every share of
    the quiz into an advert for the app, saying something the page does not.
    Same visual family as the score cards above, so a shared quiz and a shared
    result look like siblings.
    """
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), NAVY)
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=tuple(int(NAVY[i] + (INK[i] - NAVY[i]) * t) for i in range(3)))

    mark = Image.open(ROOT / "images" / "brand" / "logo-512.png").convert("RGB").resize((52, 52), Image.LANCZOS)
    m = Image.new("L", mark.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, 52, 52], radius=11, fill=255)
    img.paste(mark, (72, 64), m)
    d.text((140, 72), "Logcaliper", font=font(34), fill=DIM)

    centred(d, (0, 150, W, 250), "How good is your", font(86), "white")
    centred(d, (0, 250, W, 350), "sense of data size?", font(86), "white")
    centred(d, (0, 372, W, 432), "Ten questions. One minute.", font(40, bold=False), DIM)

    # A plausible run rather than a perfect one: the point is that people miss some.
    pattern = [1, 1, 0, 1, 1, 1, 0, 1, 0, 1]
    sq, gap = 46, 12
    total_w = TOTAL * sq + (TOTAL - 1) * gap
    x = (W - total_w) // 2
    for hit in pattern:
        col = (78, 201, 138) if hit else (198, 76, 68)
        d.rounded_rectangle([x, 500, x + sq, 500 + sq], radius=8, fill=col)
        x += sq + gap

    img.save(path, optimize=True)


PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">

<title>{score} out of {total} on the data size quiz — Logcaliper</title>
<meta name="description" content="{blurb} Ten questions on whether you can tell which of two things holds more data.">
<!-- One canonical quiz; these eleven pages are share cards, not content. -->
<link rel="canonical" href="https://logcaliper.app/quiz/">
<meta name="robots" content="noindex, follow">

<meta property="og:type" content="website">
<meta property="og:url" content="https://logcaliper.app/quiz/s/{score}/">
<meta property="og:site_name" content="Logcaliper">
<meta property="og:title" content="{score}/{total} on the data size quiz">
<meta property="og:description" content="{blurb} Can you do better?">
<meta property="og:image" content="https://logcaliper.app/quiz/s/og/{score}.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="A score of {score} out of {total} on the Logcaliper data size quiz.">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{score}/{total} on the data size quiz">
<meta name="twitter:description" content="{blurb} Can you do better?">
<meta name="twitter:image" content="https://logcaliper.app/quiz/s/og/{score}.png">
<meta name="twitter:creator" content="@cbriguet">

<meta name="theme-color" content="#334F71">
<link rel="icon" type="image/png" sizes="32x32" href="../../../images/brand/favicon-32.png">
<link rel="apple-touch-icon" href="../../../images/brand/apple-touch-icon.png">

<script>
(function () {{
  var GC_CODE = "logcaliper";
  if (GC_CODE === "GC" + "_CODE") return;
  var s = document.createElement("script");
  s.async = true;
  s.src = "https://gc.zgo.at/count.js";
  s.setAttribute("data-goatcounter", "https://" + GC_CODE + ".goatcounter.com/count");
  document.head.appendChild(s);
}})();
</script>

<style>
:root {{
  --navy: #334F71; --navy-deep: #22374e; --navy-ink: #16242f; --accent: #0b6f9e;
  --bg: #ffffff; --bg-alt: #f4f6f9; --text: #16242f; --text-dim: #566373; --rule: #dfe4ea;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}}
@media (prefers-color-scheme: dark) {{
  :root {{ --bg:#10181f; --bg-alt:#16222c; --text:#e7edf3; --text-dim:#9aa9b8; --rule:#2a3a48; --accent:#1fa2e8; }}
}}
*,*::before,*::after {{ box-sizing: border-box; }}
body {{ margin:0; font-family:var(--font); font-size:17px; line-height:1.6; color:var(--text);
        background:var(--bg); -webkit-font-smoothing:antialiased;
        min-height:100vh; display:flex; flex-direction:column; align-items:center;
        justify-content:center; text-align:center;
        padding: max(1.5rem, env(safe-area-inset-top,0px)) max(1.5rem, env(safe-area-inset-left,0px))
                 max(1.5rem, env(safe-area-inset-bottom,0px)) max(1.5rem, env(safe-area-inset-right,0px)); }}
img {{ max-width:100%; height:auto; display:block; }}
a {{ color: var(--accent); }}
.brand {{ display:flex; align-items:center; gap:.55rem; font-weight:650; color:var(--text);
          text-decoration:none; letter-spacing:-.02em; margin-bottom:2rem; }}
.brand img {{ width:26px; height:26px; border-radius:6px; }}
.count {{ font:600 .8125rem/1 var(--mono); letter-spacing:.06em; color:var(--text-dim);
          text-transform:uppercase; margin:0 0 .5rem; }}
.score {{ font-size:clamp(3rem,14vw,4.5rem); font-weight:700; letter-spacing:-.04em; line-height:1; margin:0; }}
.score .of {{ font-size:.4em; color:var(--text-dim); font-weight:500; letter-spacing:0; }}
.grid {{ font-size:1.375rem; letter-spacing:.1em; margin:1.25rem 0 0; }}
p.lede {{ color:var(--text-dim); max-width:34ch; margin:1rem auto 0; }}
.go {{ display:inline-block; font:inherit; font-weight:600; text-decoration:none;
       background:var(--navy); color:#fff; border-radius:9px; padding:.85rem 2rem; margin-top:1.75rem; }}
@media (prefers-color-scheme: dark) {{ .go {{ background:var(--accent); color:#06141d; }} }}
footer {{ margin-top:2.5rem; font-size:.875rem; color:var(--text-dim); }}
</style>
</head>
<body>

<a class="brand" href="/"><img src="../../../images/brand/favicon-64.png" alt="">Logcaliper</a>

<p class="count">They scored</p>
<p class="score">{score}<span class="of"> / {total}</span></p>
<p class="grid" aria-hidden="true">{grid}</p>
<p class="lede">{blurb}</p>

<a class="go" href="/quiz/" data-goatcounter-click="score-page-play-{score}">Take the quiz</a>

<footer><a href="/">What Logcaliper is</a></footer>

</body>
</html>
"""

BLURBS = {
    0:  "Nobody gets a zero by accident — these gaps are genuinely hard to feel.",
    1:  "One out of ten. Data volume is not something most people have a sense of.",
    2:  "Two out of ten. The magnitudes are further apart than they look.",
    3:  "Three out of ten. Most of these gaps are wider than they feel.",
    4:  "Four out of ten. Somewhere between a guess and a feel for it.",
    5:  "Half of them. The gaps are wider than they look.",
    6:  "Six out of ten. The order of magnitude is starting to land.",
    7:  "Seven out of ten. The order of magnitude is mostly there.",
    8:  "Eight out of ten. A solid sense of scale.",
    9:  "Nine out of ten. A real feel for these magnitudes.",
    10: "Ten out of ten. A genuine feel for data volume, which is rare.",
}

if __name__ == "__main__":
    IMGS.mkdir(parents=True, exist_ok=True)
    for score in range(TOTAL + 1):
        d = OUT / str(score)
        d.mkdir(parents=True, exist_ok=True)
        og_image(score, IMGS / f"{score}.png")
        grid = "\U0001F7E9" * score + "\U0001F7E5" * (TOTAL - score)
        (d / "index.html").write_text(PAGE.format(
            score=score, total=TOTAL, grid=grid, blurb=html.escape(BLURBS[score])))
    quiz_og_image(ROOT / "images" / "quiz-og.png")
    print(f"built {TOTAL + 1} score pages in {OUT} and {TOTAL + 1} images in {IMGS}")
    print(f"built the quiz card at {ROOT / 'images' / 'quiz-og.png'}")
