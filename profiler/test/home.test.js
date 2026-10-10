// home.test.js: the home page quotes the profiler's own output on its
// sample (three template rows in #profiler, and the figures in the hero
// picture's description and in both share cards' descriptions). This runs
// the profiler's reader, masks, Drain and stamps on sample.log the way
// worker.js does, formats each figure the way the profiler page formats it,
// and fails if any of those texts says something else. It also pins what
// the redesign promised to keep: the GoatCounter event names the Grafana
// panels count, one App Store badge, unmodified, and no Mac claim.
//
//   node profiler/test/home.test.js
const fs = require("fs"), path = require("path");
const P = path.join(__dirname, "..");
const SITE = path.join(P, "..");
const home = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
const prof = fs.readFileSync(path.join(P, "index.html"), "utf8");
const LCReader = require(path.join(P, "reader.js")), LCMasks = require(path.join(P, "masks.js"));
const LCDrain = require(path.join(P, "drain.js")), LCStamps = require(path.join(P, "stamps.js"));
let fails = 0;
const ok = (cond, what) => { console.log((cond ? "ok   " : "FAIL ") + what); if (!cond) fails++; };

// worker.js, start() and onLine, on the whole file at once
const bytes = new Uint8Array(fs.readFileSync(path.join(P, "sample.log")));
const splitter = LCReader.createSplitter(), stats = LCReader.createStats(), stamps = LCStamps.createTracker();
const drain = LCDrain.createDrain({ maxClusters: 4000, maxTokens: 500 });
const onLine = (lb, bl, cr, cl) => {
  const full = cl > lb.length ? cl : lb.length;
  if (full === 0) { stats.add(lb, bl, cr, "", cl); return; }
  const text = LCReader.decodeLine(lb);
  stats.add(lb, bl, cr, text, cl); stamps.add(text);
  if (full > LCReader.OVER_LONG_BYTES) return;
  drain.add(LCMasks.mask(text), full);
};
const sniff = LCReader.sniff(bytes, bytes.length); stats.setBom(sniff.bomBytes);
splitter.push(bytes.subarray(sniff.bomBytes), onLine); splitter.flush(onLine); stats.setBytesRead(bytes.length);
const t = stats.result(), time = stamps.result();
const rows = drain.clusters().sort((a, b) => b.size - a.size || b.bytes - a.bytes || a.id - b.id);

// the profiler page's own formatting: num(), shareText(), rateText(), human()
const num = n => Math.round(n).toLocaleString("en-US");
const share = (a, b) => b ? 100 * a / b : 0;
const shareText = (a, b) => { const p = share(a, b); if (p > 0 && p < 0.05) return "<0.1%"; return (p >= 99.95 && a !== b ? "99.9" : (p >= 99 || p < 10) ? p.toFixed(1) : p.toFixed(0)) + "%"; };
const rateText = x => x < 1 ? x.toFixed(2) : x < 10 ? x.toFixed(1) : num(x);
const human = b => { const u = ["B", "KB", "MB", "GB"]; let n = 0; while (b >= 1000 && n < u.length - 1) { b /= 1000; n++; } let s = b >= 100 ? b.toFixed(0) : b >= 10 ? b.toFixed(1) : b.toFixed(2); if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, ""); return s + " " + u[n]; };
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plain = html => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const avg = (t.contentBytes / t.lines).toFixed(1);

// the three template rows, cell by cell
const body = (home.match(/<tbody id="sample-templates">([\s\S]*?)<\/tbody>/) || [])[1] || "";
const trs = [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => plain(c[1])));
ok(trs.length === 3, "the home page shows three template rows: " + trs.length);
rows.slice(0, 3).forEach((c, i) => {
  const want = [num(c.size), esc(drain.template(c)), shareText(c.size, t.lines), num(c.bytes / c.size)];
  ok(JSON.stringify(trs[i]) === JSON.stringify(want), `row ${i + 1}: ${want.join(" | ")}`);
});
ok(new RegExp(`<p class="tpl-note">The three largest of the sample's ${rows.length} templates`).test(home), `the sentence above the table says ${rows.length} templates`);

// the figures quoted in words
const figures = { lines: num(t.lines), size: human(t.bytes), avg: avg, eps: rateText(time.perSecond), templates: String(rows.length), longest: num(t.longestLineBytes) };
const heroAlt = (home.match(/<img src="images\/profiler\/hero-light\.webp"[^>]*alt="([^"]*)"/) || [])[1] || "";
ok(heroAlt === `The profiler's result for its 1.5 MB sample log: ${figures.lines} lines, ${figures.size}, an average line of ${figures.avg} bytes, ${figures.eps} events per second, ${figures.templates} templates and a longest line of ${figures.longest} bytes.`,
  "the hero picture's description matches the profiler: " + JSON.stringify(figures));
const homeCard = (home.match(/<meta property="og:image:alt" content="([^"]*)"/) || [])[1] || "";
ok(homeCard.includes(`${figures.avg} bytes a line and ${figures.eps} events per second`), "the home share card's description quotes the same average and rate");
const profCard = (prof.match(/<meta property="og:image:alt" content="([^"]*)"/) || [])[1] || "";
ok(profCard.includes(`${figures.lines} lines, an average line of ${figures.avg} bytes, ${figures.eps} events per second and ${figures.templates} templates`), "the profiler share card's description quotes the same figures");
ok(human(t.bytes) === "1.48 MB" && Math.round(t.bytes / 1e5) / 10 === 1.5, "the sample is the 1.5 MB the links promise (" + human(t.bytes) + ")");

// the pictures the page points at exist
for (const m of home.matchAll(/(?:src|srcset)="(images\/[^"]+)"/g)) ok(fs.existsSync(path.join(SITE, m[1])), "picture on disk: " + m[1]);
for (const m of home.matchAll(/content="https:\/\/logcaliper\.app\/(images\/[^"]+)"/g)) ok(fs.existsSync(path.join(SITE, m[1])), "share card on disk: " + m[1]);

// what the redesign kept
for (const ev of ["appstore-hero", "appstore-footer", "profiler-from-hero", "profiler-from-nav", "profiler-from-card", "sources-from-nav", "fun-from-nav",
  "sources-from-table", "sources-from-section", "threshold-from-card", "quiz-from-card", "mention-ibm", "mention-splunk"]) {
  ok(home.includes(`data-goatcounter-click="${ev}"`), "event kept: " + ev);
}
const badges = home.match(/tools\.applemediaservices\.com\/api\/badges\/download-on-the-app-store\/black\/en-us\?size=250x83&releaseDate=1279065600/g) || [];
ok(badges.length === 1, "one App Store badge, Apple's own image: " + badges.length);
ok(!/\bMac\b|macOS|Apple silicon/.test(plain(home.replace(/<head>[\s\S]*<\/head>/, ""))), "no Mac claim on the page");
ok(/<meta name="apple-itunes-app" content="app-id=381096276">/.test(home), "the Smart App Banner");
ok((home.match(/<script\b/g) || []).length === 2, "two scripts only: the structured data and the GoatCounter loader");
ok((home.match(/href="\/profiler\/#run-sample"/g) || []).length === 2 && /var sampleOnArrival = location\.hash === "#run-sample";/.test(prof) && !/id="run-sample"/.test(prof), "the home page's two sample links land on a profiler that runs it, on a hash that names no element");

// the catalogue's own figures, from the app's datasources.json as the site keeps it
const cat = JSON.parse(fs.readFileSync(path.join(SITE, "sources", "data", "datasources.json"), "utf8"));
const stat = k => (home.match(new RegExp(`<div class="v">([^<]+)</div><div class="k">${k}</div>`)) || [])[1];
ok(stat("sources built in") === String(cat.length), "sources built in: " + cat.length);
ok(stat("categories") === String(new Set(cat.map(s => s.category)).size), "categories: " + new Set(cat.map(s => s.category)).size);
const byName = Object.fromEntries(cat.map(s => [s.name, s]));
const srcRows = [...((home.match(/<section id="sources"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || "").matchAll(/<tr><td>([^<]+)<\/td><td class="cat">([^<]+)<\/td><td class="num">([^<]+)<\/td><\/tr>/g)];
ok(srcRows.length >= 10, "the catalogue sample has rows: " + srcRows.length);
srcRows.forEach(m => {
  const s = byName[m[1]];
  ok(s && s.category === m[2] && num(s.averageEventSizeBytes) === m[3], `catalogue row ${m[1]} | ${m[2]} | ${m[3]}`);
});
const ld = JSON.parse((home.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1] || "{}");
const types = (ld["@graph"] || []).map(n => n["@type"]);
ok(JSON.stringify(types) === JSON.stringify(["WebSite", "Person", "WebApplication", "MobileApplication"]), "structured data: " + types.join(", "));
ok(ld["@graph"] && !ld["@graph"][2].aggregateRating && ld["@graph"][3].aggregateRating !== undefined, "the App Store rating sits on the app, never on the profiler");

console.log(fails ? `\n${fails} check(s) failed` : "\nthe home page quotes the sample as the profiler reads it");
process.exit(fails ? 1 : 0);
