// make-shots.mjs: the site's product pictures, made from the pages themselves.
//
//   node images/shots/make-shots.mjs [--only name,name] [--keep]
//
// Serves the repository on 127.0.0.1, starts headless Chrome, and drives it
// over the DevTools protocol: it opens the profiler, runs the made-up sample
// (profiler/sample.log, never a real log, so no real host or user ends up in
// a picture), waits for the result, and captures the parts listed in SHOTS
// below at two or three times the CSS size, in the dark and the light scheme.
// The ones marked publish go to images/profiler/ as WebP, where the home page
// shows them; every capture also goes to images/shots/work/ as PNG (ignored
// by git), for posts and slides. Then it renders the 1200 x 630 share cards
// from the HTML templates beside this file, which use those captures. Run it
// after a change to the profiler's result card or to a template, and look at
// the pictures before committing.
//
// No dependency: Node 22 or later (fetch and WebSocket are built in) and
// Google Chrome at its usual place, or at CHROME=/path/to/chrome.

import { createServer } from "node:http";
import { readFile, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = normalize(join(HERE, "..", ".."));
const OUT = join(ROOT, "images", "profiler");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;

/* What is captured from the profiler's result, each in both schemes.
   from/to name elements of the page (an id, "row:N" for a template row, or
   "css:" and a selector); the clip runs from the top of the first to the
   bottom of the second, across the content column, with a margin of 24 px
   unless top or bottom says otherwise. rows is how many template rows are
   left in the table (the rest are removed from the page before the
   capture, so the picture is the table's real top). hide names elements
   taken out of the flow first. At 600 px the tiles fall three, three and
   two, and nothing overflows a tile; at 720 to 860 Throughput would. */
const SHOTS = [
  { name: "hero", width: 600, from: "resultEyebrow", to: "css:#result > .card", top: 16, hide: ["estimator", "templates"], publish: true },
  { name: "hero-phone", width: 390, scale: 3, from: "resultEyebrow", to: "css:#result .stats", top: 16, publish: true },
  { name: "result", width: 1180, from: "resultEyebrow", to: "row:6", rows: 6, hide: ["estimator"] },
  { name: "figures", width: 1180, from: "resultEyebrow", to: "recon" },
  { name: "templates", width: 1180, from: "tplCaption", to: "row:8", rows: 8 },
  { name: "estimate", width: 1180, from: "estimator", to: "estimator" },
  { name: "phone", width: 390, from: "resultEyebrow", to: "recon", scale: 3 },
];

/* The share cards: template file, output file. images/og.png stays as it
   is: the source and category pages share it. */
const CARDS = [
  { src: "og-home.html", out: join(ROOT, "images", "og-home.png") },
  { src: "og-profiler.html", out: join(ROOT, "images", "profiler-og.png") },
];

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".log": "text/plain; charset=utf-8",
  ".json": "application/json", ".ico": "image/x-icon" };

function serve() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p.endsWith("/")) p += "index.html";
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise(ok => server.listen(0, "127.0.0.1", () => ok(server)));
}

async function chrome() {
  if (!existsSync(CHROME)) throw new Error("Chrome not found at " + CHROME + "; set CHROME=");
  const dir = await mkdtemp(join(tmpdir(), "lc-shots-"));
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + dir, "--no-first-run",
    "--no-default-browser-check", "--hide-scrollbars", "--disable-gpu", "--font-render-hinting=none", "about:blank"], { stdio: "ignore" });
  const portFile = join(dir, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  return { proc, dir, port };
}

function sleep(ms) { return new Promise(ok => setTimeout(ok, ms)); }

/* One page target and a promise per command. */
async function open(port) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0; const pending = new Map(); const waiters = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.no(new Error(m.error.message)) : p.ok(m.result); return; }
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].method === m.method) { waiters[i].ok(m.params); waiters.splice(i, 1); }
  };
  const send = (method, params = {}) => new Promise((ok, no) => { const n = ++id; pending.set(n, { ok, no }); ws.send(JSON.stringify({ id: n, method, params })); });
  const once = method => new Promise(ok => waiters.push({ method, ok }));
  const evaluate = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, what, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await evaluate(expr)) return; await sleep(100); }
    throw new Error("timed out waiting for " + what);
  };
  await send("Page.enable"); await send("Runtime.enable");
  return { ws, send, once, evaluate, until };
}

async function goto(page, url) {
  const loaded = page.once("Page.loadEventFired");
  await page.send("Page.navigate", { url });
  await loaded;
}

async function shoot(page, base, shot, scheme) {
  const scale = shot.scale || 2;
  await page.send("Emulation.setDeviceMetricsOverride", { width: shot.width, height: 1000, deviceScaleFactor: scale, mobile: shot.width < 600 });
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }] });
  await goto(page, base + "/profiler/");
  await page.until(`document.getElementById("pickText").textContent === "Choose a log file" && !document.getElementById("file").disabled`, "the reader");
  await page.evaluate(`document.getElementById("sample").click()`);
  await page.until(`!document.getElementById("result").hidden && /sample\\.log/.test(document.getElementById("resultHead").textContent)`, "the result", 60000);
  /* The figures that change from run to run (the time the read took and
     its throughput) are set to a typical run's, so the picture does not
     change with every regeneration. */
  const rect = await page.evaluate(`(function () {
    var shot = ${JSON.stringify(shot)};
    var el = function (id) { return document.getElementById(id); };
    el("vTime").textContent = "54 ms";
    el("vRate").textContent = "27.4 MB/s";
    var c = el("counters"); if (c) c.textContent = c.textContent.replace(/Read at [\\d,]+ lines per second\\./, "Read at 185,918 lines per second.");
    (shot.hide || []).forEach(function (id) { el(id).style.display = "none"; });
    document.querySelector("nav").style.display = "none";
    Array.prototype.forEach.call(document.querySelectorAll("#result .actions, #result .plug"), function (n) { n.style.visibility = "hidden"; });
    var body = el("tplBody");
    if (shot.rows) while (body.children.length > shot.rows) body.removeChild(body.lastChild);
    /* A row ends the picture at the table's own border, one pixel under it. */
    var pick = function (name) {
      if (name.indexOf("row:") === 0) return body.children[+name.slice(4) - 1];
      if (name.indexOf("css:") === 0) return document.querySelector(name.slice(4));
      return el(name);
    };
    var a = pick(shot.from).getBoundingClientRect(), b = pick(shot.to).getBoundingClientRect();
    if (shot.to.indexOf("row:") === 0) b = { bottom: b.bottom + 1 };
    var wrap = document.querySelector("main .wrap").getBoundingClientRect();
    var cs = getComputedStyle(document.querySelector("main .wrap"));
    var m = 24, left = wrap.left + parseFloat(cs.paddingLeft) - m, right = wrap.right - parseFloat(cs.paddingRight) + m;
    var mt = shot.top || m, mb = shot.bottom || m;
    return { x: Math.max(0, left + scrollX), y: Math.max(0, a.top + scrollY - mt), width: Math.min(innerWidth, right) - Math.max(0, left), height: b.bottom - a.top + mt + mb };
  })()`);
  const png = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
    clip: { x: rect.x, y: rect.y, width: Math.round(rect.width), height: Math.round(rect.height), scale: 1 } });
  const name = `${shot.name}-${scheme}`;
  await writeFile(join(HERE, "work", name + ".png"), Buffer.from(png.data, "base64"));   // for posts and slides; not published
  if (shot.publish) {
    const r = await page.send("Page.captureScreenshot", { format: "webp", quality: 90, captureBeyondViewport: true,
      clip: { x: rect.x, y: rect.y, width: Math.round(rect.width), height: Math.round(rect.height), scale: 1 } });
    await writeFile(join(OUT, name + ".webp"), Buffer.from(r.data, "base64"));
  }
  console.log(`${name}${shot.publish ? ".webp" : ".png (work)"}  ${Math.round(rect.width)} x ${Math.round(rect.height)} CSS px at ${scale}x`);
}

async function card(page, base, c) {
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await goto(page, base + "/images/shots/" + c.src);
  await page.evaluate(`Promise.all(Array.prototype.map.call(document.images, function (i) { return i.complete ? 0 : new Promise(function (ok) { i.onload = i.onerror = ok; }); })).then(function () { return document.fonts ? document.fonts.ready : 0; })`);
  const r = await page.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 } });
  await writeFile(c.out, Buffer.from(r.data, "base64"));
  console.log(c.out.replace(ROOT + "/", "") + "  1200 x 630");
}

const server = await serve();
const base = "http://127.0.0.1:" + server.address().port;
const ch = await chrome();
try {
  await mkdir(OUT, { recursive: true });
  await mkdir(join(HERE, "work"), { recursive: true });
  const page = await open(ch.port);
  for (const shot of SHOTS) {
    if (only && !only.includes(shot.name)) continue;
    for (const scheme of ["dark", "light"]) await shoot(page, base, shot, scheme);
  }
  for (const c of CARDS) {
    if (only && !only.includes(c.src.replace(".html", ""))) continue;
    if (existsSync(join(HERE, c.src))) await card(page, base, c);
  }
  page.ws.close();
} finally {
  const exited = new Promise(ok => ch.proc.once("exit", ok));
  ch.proc.kill();
  await Promise.race([exited, sleep(5000)]);
  server.close();
  if (!args.includes("--keep")) await rm(ch.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
