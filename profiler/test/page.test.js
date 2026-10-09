// Static fidelity checks on profiler/index.html against the site's own pages:
// head order, the exact CSP, the tokens, the chrome, the privacy line, no
// analytics, no external resource, ES5 only. Run: node profiler/test/page.test.js
const fs = require("fs"), path = require("path");
const P = path.join(__dirname, "..");
const SITE = path.join(__dirname, "..", "..");
const page = fs.readFileSync(path.join(P, "index.html"), "utf8");
const home = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
const quiz = fs.readFileSync(path.join(SITE, "quiz", "index.html"), "utf8");
let fails = 0;
const ok = (cond, what) => { console.log((cond ? "ok   " : "FAIL ") + what); if (!cond) fails++; };

// head order: charset, viewport, then the CSP before anything else
const head = page.slice(page.indexOf("<head>"), page.indexOf("</head>"));
const tags = [...head.matchAll(/<(meta|link|title|script|style)\b[^>]*>/g)].map(m => m[0]);
ok(/charset="utf-8"/.test(tags[0]), "first head tag is charset");
ok(/name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/.test(tags[1]), "second is the viewport");
ok(/http-equiv="Content-Security-Policy"/.test(tags[2]), "third is the CSP, before anything that loads");
const csp = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'";
ok(tags[2].includes(`content="${csp}"`), "CSP content is exactly as specified");
ok(/<title>Profile a log file — Logcaliper<\/title>/.test(head), "title");
ok(/rel="canonical" href="https:\/\/logcaliper\.app\/profiler\/"/.test(head), "canonical");
ok(/og:image" content="https:\/\/logcaliper\.app\/images\/profiler-og\.png"/.test(head) && /og:image:width" content="1200"/.test(head) && /og:image:height" content="630"/.test(head), "og:image 1200x630");
ok(/twitter:creator" content="@cbriguet"/.test(head), "twitter:creator");
ok(/theme-color" content="#334F71"/.test(head), "theme-color");
ok(/\.\.\/images\/brand\/favicon-32\.png/.test(head) && /\.\.\/images\/brand\/favicon-64\.png/.test(head) && /\.\.\/images\/brand\/apple-touch-icon\.png/.test(head), "favicons via ../images/brand/");
ok(!/goatcounter|gc\.zgo\.at/i.test(page), "no GoatCounter");
ok(!/ld\+json/.test(page), "no JSON-LD");
ok(!/name="robots"/.test(page), "no robots meta");

// external URLs: only the canonical/og/twitter metas may carry one
const urls = [...page.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map(m => m[0]);
const allowed = ["https://logcaliper.app/profiler/", "https://logcaliper.app/images/profiler-og.png"];
ok(urls.every(u => allowed.includes(u)), "external URLs only in meta tags: " + [...new Set(urls)].join(", "));
ok(!/<script[^>]*src=/.test(page) && !/<link[^>]*stylesheet/.test(page), "no external script or stylesheet");

// tokens identical to the home page
const tok = (src, block) => Object.fromEntries([...src.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const rootOf = src => { const i = src.indexOf(":root {"); return src.slice(i, src.indexOf("}", i)); };
const darkOf = src => { const i = src.indexOf("@media (prefers-color-scheme: dark) {\n  :root {"); return src.slice(i, src.indexOf("}", i)); };
const hr = tok(rootOf(home)), pr = tok(rootOf(page)), hd = tok(darkOf(home)), pd = tok(darkOf(page)), qr = tok(rootOf(quiz)), qd = tok(darkOf(quiz));
for (const k of Object.keys(hr)) ok(pr[k] === hr[k], `token --${k} matches the home page (${pr[k]})`);
for (const k of Object.keys(hd)) ok(pd[k] === hd[k], `dark token --${k} matches the home page (${pd[k]})`);
for (const k of ["right", "wrong", "field"]) ok(pr[k] === qr[k] && pd[k] === qd[k], `--${k} matches the quiz page`);
ok(pr.maxw === "1080px", "--maxw is 1080px");

// copied rule blocks present
for (const sel of [".skip {", ".skip:focus", ".nav {", ".brand {", ".wrap {", "footer {", ".table-wrap {", "td.num {", "[hidden] { display: none !important; }", "button.go, .go", ".mini {", ".stats {", ".stat .v {", ".stat .k {"]) {
  ok(page.includes(sel) || (sel === "button.go, .go" && page.includes(".go {")), `style block present: ${sel}`);
}
ok(/\.fill \{[^}]*transition: width/.test(page) && /prefers-reduced-motion: reduce\) \{ \.fill \{ transition: none; \}/.test(page), "progress transition honours reduced motion");
ok(/font-variant-numeric: tabular-nums/.test(page.match(/\.stat \.v \{[^}]*\}/)[0]) && /var\(--mono\)/.test(page.match(/\.stat \.v \{[^}]*\}/)[0]), "tile numbers are mono, tabular");

// body
ok(/<a class="skip" href="#main">Skip to content<\/a>/.test(page), "skip link");
ok(/<nav class="nav">\s*<div class="wrap">\s*<a class="brand" href="\/"><img src="\.\.\/images\/brand\/favicon-64\.png" alt=""[^>]*>Logcaliper<\/a>\s*<a class="app" href="\/">← logcaliper\.app<\/a>/.test(page), "nav in the quiz pattern");
ok(/<main id="main" tabindex="-1">\s*<div class="wrap">/.test(page), "main#main[tabindex=-1] > .wrap");
ok(/<h1>Profile a log file<\/h1>/.test(page), "h1");
const privacy = "Your browser reads the file here. Nothing about it is sent anywhere: this page is static, has no analytics and no upload. Open the Network panel while it runs: nothing goes to any server.";
ok(page.includes(">" + privacy + "<"), "privacy line verbatim and alone in its element");
ok(/<label class="go[^"]*"[^>]*>.*<input type="file" id="file" class="vh"/.test(page), "label.go wraps the visually hidden file input");
ok(page.includes("Files of 50 to 500 MB are the normal case."), "size note");
ok(/<footer>\s*<div class="wrap">Nothing leaves your browser\. &copy; 2026 Christophe Briguet<\/div>\s*<\/footer>/.test(page), "footer exact");
ok(/aria-live="polite"/.test(page), "aria-live region");
ok(/role="progressbar"/.test(page), "progressbar role");
for (const id of ["empty", "running", "refused", "error", "result"]) ok(new RegExp(`<section id="${id}"`).test(page), `state section #${id}`);
ok(/<p class="how">/.test(page), "how this works");
const how = page.match(/<p class="how">([\s\S]*?)<span id="howFallback"/)[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
ok(how.split(/(?<=\.)\s/).length === 4, "how-it-works is the lead-in plus three sentences: " + how.split(/(?<=\.)\s/).length);
ok(!/!/.test(page.replace(/<script>[\s\S]*<\/script>/, "").replace(/<style>[\s\S]*<\/style>/, "").replace(/!DOCTYPE/, "").replace(/<!--[\s\S]*?-->/g, "")), "no exclamation marks in the copy");

// the inline script
const script = page.match(/<script>\n([\s\S]*?)<\/script>/)[1];
const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
ok(!/=>|\blet\b|\bconst\b|`|\bclass\b|\basync\b|\bawait\b|^\s*(import|export)\b|\bfor\s*\(\s*(var\s+)?\w+\s+of\b/m.test(code), "inline script is ES5");
ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(code), "no innerHTML");
ok(!/localStorage|sessionStorage/.test(code), "no storage");
ok(/new Blob\(\[/.test(script) && /URL\.createObjectURL/.test(script) && /new Worker\("worker\.js"\)/.test(script), "blob worker with URL fallback");
ok(/fetch\("reader\.js"(, opts)?\)/.test(script) && /fetch\("worker\.js"(, opts)?\)/.test(script), "fetches only its own two scripts");
ok((code.match(/fetch\(/g) || []).length === 2, "exactly two fetch calls");
ok(/500/.test(code) && /terminate\(\)/.test(code), "hard-terminate after 500 ms");
ok(/function human\(b\)/.test(script) && /\["B", "KB", "MB", "GB", "TB", "PB", "EB"\]/.test(script), "human() from the quiz");
console.log(fails ? `\n${fails} check(s) failed` : "\nall page checks passed");
process.exit(fails ? 1 : 0);
