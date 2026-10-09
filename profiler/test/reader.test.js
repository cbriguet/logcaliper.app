"use strict";
/* reader.test.js: the reader core against the manifest make-files.py writes.

     node test/reader.test.js [dir]

   Plain Node, no dependencies. The files are generated into dir (default: a
   folder under the OS temp dir) when the manifest is missing. Every file is
   run through LCReader.runChunks at four chunk widths and the answers must be
   identical; the manifest counts must match; the residual must be 0 for every
   accepted file; the refusal codes must be right. Then the splitter, sniff
   and decoder edge cases, and the worker protocol under a small shim. */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var vm = require("node:vm");
var cp = require("node:child_process");

var LCReader = require("../reader.js");
var LCMasks = require("../masks.js");
var LCDrain = require("../drain.js");
var LCStamps = require("../stamps.js");
var workerSrc = fs.readFileSync(path.join(__dirname, "..", "worker.js"), "utf8");

var DIR = process.argv[2] || process.env.LC_TEST_DIR || path.join(os.tmpdir(), "logcaliper-profiler-test");
var MANIFEST = path.join(DIR, "manifest.json");
/* The fixtures include a 100 MB file (LC_BIG_MB sets the size, 0 skips it),
   so the suite always runs once at the size a user brings. */
if (!fs.existsSync(MANIFEST)) {
  var gen = cp.spawnSync("python3", [path.join(__dirname, "make-files.py"), DIR, "--size-mb", process.env.LC_BIG_MB || "100"], { stdio: "inherit" });
  if (gen.status !== 0) { console.error("make-files.py failed"); process.exit(1); }
}
var manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
if (fs.existsSync(path.join(DIR, "big.log")) && !manifest.some(function (m) { return m.name === "big.log"; })) {
  console.error("big.log is in " + DIR + " but not in its manifest: regenerate with make-files.py --size-mb");
  process.exit(1);
}

var MiB = 1024 * 1024;
var SIZES = [1, 7, 4096, 8 * MiB];
var BIG_SIZES = [4096, 64 * 1024, 8 * MiB];   // one byte at a time over 100 MB is a hundred million calls

function bytesOf(name) {
  var b = fs.readFileSync(path.join(DIR, name));
  return new Uint8Array(b.buffer, b.byteOffset, b.length);   // plain view, as a browser would hand it over
}

function chunk(bytes, size) {
  var out = [], off;
  for (off = 0; off < bytes.length; off += size) out.push(bytes.subarray(off, Math.min(off + size, bytes.length)));
  return out;
}

function utf8(s) { return new Uint8Array(Buffer.from(s, "utf8")); }

/* Every line a splitter emits, decoded, with its byteLength and CR flag. */
function split(chunks) {
  var sp = LCReader.createSplitter(), out = [];
  var onLine = function (lb, bl, cr) { out.push({ text: LCReader.decodeLine(lb), len: lb.length, byteLength: bl, hadCR: cr }); };
  chunks.forEach(function (c) { sp.push(c, onLine); });
  sp.flush(onLine);
  return out;
}

/* ---- the manifest ---- */

manifest.forEach(function (m) {
  test("manifest: " + m.name, function (t) {
    var bytes = bytesOf(m.name);
    assert.equal(bytes.length, m.bytes, "file size matches the manifest");
    var sizes = m.name === "big.log" ? BIG_SIZES : SIZES;
    var runs = sizes.map(function (size) {
      var t0 = process.hrtime.bigint();
      var r = LCReader.runChunks(chunk(bytes, size), { fileSize: bytes.length });
      r.ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return r;
    });

    if (m.expectRefusal) {
      runs.forEach(function (r, i) {
        assert.ok(r.refused, "refused at chunk " + sizes[i]);
        assert.equal(r.refused.code, m.expectRefusal, "refusal code at chunk " + sizes[i]);
        assert.match(r.refused.message, /\. /, "the message is a sentence with a remedy");
      });
      return;
    }

    runs.forEach(function (r, i) {
      assert.ok(r.result, "accepted at chunk " + sizes[i]);
      assert.deepEqual(r.result, runs[0].result, "identical result at chunk " + sizes[i] + " and " + sizes[0]);
    });
    var r = runs[0].result;
    assert.equal(r.lines, m.lines, "lines");
    assert.equal(r.bytes, m.lineBytes, "bytes of lines");
    assert.equal(r.bytes + r.bomBytes, m.bytes, "bytes of lines plus BOM is the file size");
    assert.equal(r.bytesRead, m.bytes, "bytesRead");
    assert.equal(r.bomBytes, m.bomBytes, "bomBytes");
    assert.equal(r.crlfLines, m.crlfLines, "crlfLines");
    assert.equal(r.emptyLines, m.emptyLines, "emptyLines");
    assert.equal(r.undecodableLines, m.undecodableLines, "undecodableLines");
    assert.equal(r.longestLineBytes, m.longestLineBytes, "longestLineBytes");
    assert.equal(r.overLongLines, m.overLongLines, "overLongLines");
    assert.equal(r.truncatedLines, m.truncatedLines, "truncatedLines");
    assert.equal(r.residual, 0, "residual is zero");

    if (m.name === "big.log") {
      runs.forEach(function (run, i) {
        var s = run.ms / 1000;
        t.diagnostic("big.log at " + sizes[i] + "-byte chunks: " + bytes.length.toLocaleString() + " bytes, " +
          r.lines.toLocaleString() + " lines in " + run.ms.toFixed(0) + " ms = " +
          (bytes.length / 1e6 / s).toFixed(1) + " MB/s, " + Math.round(r.lines / s).toLocaleString() + " lines/s");
      });
    }
  });
});

/* ---- the splitter ---- */

test("a line inside a chunk is a view on the chunk, not a copy", function () {
  var chunkBytes = utf8("ab\ncd\r\n\nxyz");
  var sp = LCReader.createSplitter(), seen = [];
  sp.push(chunkBytes, function (lb, bl, cr) {
    assert.equal(lb.buffer, chunkBytes.buffer, "same ArrayBuffer");
    seen.push({ off: lb.byteOffset - chunkBytes.byteOffset, len: lb.length, bl: bl, cr: cr });
  });
  assert.deepEqual(seen, [
    { off: 0, len: 2, bl: 3, cr: false },   // "ab\n"
    { off: 3, len: 2, bl: 4, cr: true },    // "cd\r\n": the CR is in byteLength, not the bytes
    { off: 7, len: 0, bl: 1, cr: false }    // "\n": the empty line
  ]);
  sp.flush(function (lb, bl, cr) {
    assert.equal(LCReader.decodeLine(lb), "xyz");
    assert.equal(bl, 3);
    assert.equal(cr, false);
  });
});

test("a line crossing a boundary is assembled from the carried tail", function () {
  var a = utf8("first\nsec"), b = utf8("ond\nthi"), c = utf8("rd");
  var out = split([a, b, c]);
  assert.deepEqual(out.map(function (l) { return l.text; }), ["first", "second", "third"]);
  assert.deepEqual(out.map(function (l) { return l.byteLength; }), [6, 7, 5]);
});

test("CRLF split between chunks, bare CR, final CR", function () {
  var out = split([utf8("ab\r"), utf8("\ncd\n")]);
  assert.deepEqual(out, [
    { text: "ab", len: 2, byteLength: 4, hadCR: true },
    { text: "cd", len: 2, byteLength: 3, hadCR: false }
  ]);
  out = split([utf8("a\rb\n")]);
  assert.deepEqual(out, [{ text: "a\rb", len: 3, byteLength: 4, hadCR: false }], "a bare CR is content");
  out = split([utf8("abc\r")]);
  assert.deepEqual(out, [{ text: "abc\r", len: 4, byteLength: 4, hadCR: false }], "a final CR with no LF is content");
  out = split([utf8("\r\n\r\r\n")]);
  assert.deepEqual(out, [
    { text: "", len: 0, byteLength: 2, hadCR: true },
    { text: "\r", len: 1, byteLength: 3, hadCR: true }
  ]);
  assert.deepEqual(split([utf8("\n\n")]).map(function (l) { return l.byteLength; }), [1, 1]);
  assert.deepEqual(split([new Uint8Array(0)]), [], "an empty chunk emits nothing");
});

test("a 3-byte UTF-8 character straddling a chunk boundary decodes whole", function () {
  var bytes = utf8("ab€c\nx€\n");    // the euro sign is E2 82 AC
  assert.equal(bytes.length, 12);
  for (var cut = 1; cut < bytes.length; cut++) {
    var out = split([bytes.subarray(0, cut), bytes.subarray(cut)]);
    assert.deepEqual(out.map(function (l) { return l.text; }), ["ab€c", "x€"], "cut at " + cut);
  }
  for (var size = 1; size <= bytes.length; size++) {
    var r = LCReader.runChunks(chunk(bytes, size)).result;
    assert.equal(r.undecodableLines, 0, "no U+FFFD at chunk " + size);
    assert.equal(r.lines, 2);
    assert.equal(r.residual, 0);
  }
  var bad = new Uint8Array([0x61, 0xFF, 0x62]);
  assert.equal(LCReader.decodeLine(bad), "a�b", "an invalid byte becomes U+FFFD, non-fatal");
  var truncated = new Uint8Array([0x61, 0xE2, 0x82]);
  assert.ok(LCReader.decodeLine(truncated).indexOf("�") >= 0, "a truncated sequence is undecodable");
});

test("a long line arriving one byte at a time stays linear", function () {
  var line = new Uint8Array(200000);
  line.fill(0x78);
  var sp = LCReader.createSplitter(), got = null;
  var t0 = Date.now();
  for (var i = 0; i < line.length; i++) sp.push(line.subarray(i, i + 1), function () { assert.fail("no line yet"); });
  sp.push(utf8("\n"), function (lb, bl) { got = { len: lb.length, bl: bl }; });
  assert.deepEqual(got, { len: 200000, bl: 200001 });
  assert.ok(Date.now() - t0 < 2000, "200k single-byte pushes finished in under two seconds");
});

/* ---- stats ---- */

test("stats count what step 1 reports", function () {
  var st = LCReader.createStats();
  st.setBom(3);
  st.add(utf8("hello"), 6, false);
  st.add(new Uint8Array(0), 2, true);
  st.add(new Uint8Array([0x61, 0xFF]), 3, false);
  assert.equal(LCReader.OVER_LONG_BYTES, 64000, "a line over 64 KB, decimal, is over-long");
  var big = new Uint8Array(64001); big.fill(0x61);
  st.add(big, 64002, false);
  st.add(utf8("given text"), 11, false, "given \uFFFD text");   // the caller's text shows a U+FFFD, but the bytes are clean: not counted
  st.add(new Uint8Array([0x62, 0xC0, 0x80]), 4, false, "b\uFFFD\uFFFD");   // the caller's text agrees with bad bytes: counted
  st.setBytesRead(3 + 6 + 2 + 3 + 64002 + 11 + 4);
  assert.deepEqual(st.result(), {
    lines: 6, bytes: 64028, contentBytes: 5 + 0 + 2 + 64001 + 10 + 3, bomBytes: 3, bytesRead: 64031, crlfLines: 1, emptyLines: 1,
    undecodableLines: 2, longestLineBytes: 64001, overLongLines: 1, truncatedLines: 0, residual: 0
  });
  st.setBytesRead(64038);
  assert.equal(st.result().residual, 7, "a residual shows up when bytes go missing");
});

/* ---- sniff ---- */

test("sniff codes and the BOM", function () {
  var s = LCReader.sniff;
  assert.equal(s(new Uint8Array(0), 0).code, "empty");
  assert.equal(s(new Uint8Array([0xFF, 0xFE, 0x41, 0x00]), 4).code, "utf16");
  assert.equal(s(new Uint8Array([0xFE, 0xFF, 0x00, 0x41]), 4).code, "utf16");
  assert.equal(s(new Uint8Array([0x1F, 0x8B, 0x08, 0x00]), 4).code, "gzip");
  assert.equal(s(new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0x14]), 5).code, "zip");
  assert.equal(s(utf8("abc\u0000def\n"), 8).code, "binary", "a NUL in the first 8 KiB");
  var ctl = new Uint8Array(1000); ctl.fill(0x61); for (var i = 0; i < 150; i++) ctl[i] = 0x01; ctl[999] = 10;
  assert.equal(s(ctl, 1000).code, "binary", "15% control bytes");
  // ANSI colour sequences (ESC then "[") are text even at one every six bytes; bare ESC bytes are control codes.
  var esc = new Uint8Array(1000); esc.fill(0x61); for (i = 0; i < 900; i += 6) { esc[i] = 0x1B; esc[i + 1] = 0x5B; } esc[999] = 10;
  assert.deepEqual(s(esc, 1000), { ok: true, bomBytes: 0 }, "ANSI escapes are text");
  var bare = new Uint8Array(1000); bare.fill(0x61); for (i = 0; i < 150; i++) bare[i] = 0x1B; bare[999] = 10;
  assert.equal(s(bare, 1000).code, "binary", "15% bare ESC bytes are control codes");
  assert.equal(s(utf8("one long line with no break"), 1000000).code, "no-newline", "a first chunk without LF in a bigger file");
  assert.deepEqual(s(utf8("one short line"), 14), { ok: true, bomBytes: 0 }, "a small file with no newline is one line");
  assert.deepEqual(s(new Uint8Array([0xEF, 0xBB, 0xBF, 0x61, 0x0A]), 5), { ok: true, bomBytes: 3 });
  assert.deepEqual(s(utf8("héllo wörld\n"), 15), { ok: true, bomBytes: 0 }, "UTF-8 above 0x80 is text");
  ["empty", "utf16", "gzip", "zip", "binary", "no-newline"].forEach(function (code) {
    var r = [s(new Uint8Array(0), 0), s(new Uint8Array([0xFF, 0xFE]), 2), s(new Uint8Array([0x1F, 0x8B]), 2),
             s(new Uint8Array([0x50, 0x4B, 3, 4]), 4), s(new Uint8Array([0]), 1), s(utf8("x"), 2)]
      .filter(function (x) { return x.code === code; })[0];
    assert.ok(r && /^[A-Z].*\.$/.test(r.message), code + " message is a sentence");
  });
});

test("runChunks sniffs the same head whatever the chunking", function () {
  var bom = new Uint8Array([0xEF, 0xBB, 0xBF, 0x61, 0x0A, 0x62, 0x0A]);
  for (var size = 1; size <= bom.length; size++) {
    var r = LCReader.runChunks(chunk(bom, size)).result;
    assert.equal(r.bomBytes, 3, "BOM seen at chunk " + size);
    assert.equal(r.lines, 2);
    assert.equal(r.residual, 0);
  }
  assert.equal(LCReader.runChunks([]).refused.code, "empty");
  var long = new Uint8Array(100); long.fill(0x61);
  assert.equal(LCReader.runChunks(chunk(long, 10), { sniffBytes: 50 }).refused.code, "no-newline");
  assert.equal(LCReader.runChunks(chunk(long, 10)).result.lines, 1, "the whole file is the head when it is small");
});

/* ---- the worker, under a shim ---- */

function fakeFile(bytes, name, opts) {
  opts = opts || {};
  var file = {
    name: name, size: (opts.size !== undefined) ? opts.size : bytes.length,
    settled: false,    // set once the test is over: later reads never resolve, so a runaway worker goes quiet
    slice: function (a, b) {
      if (opts.onSlice) opts.onSlice(a, b);
      return {
        arrayBuffer: function () {
          if (file.settled) return new Promise(function () {});
          if (opts.failAt !== undefined && a >= opts.failAt) return Promise.reject(new Error("disk unplugged"));
          var end = Math.min(b, bytes.length), out = new Uint8Array(Math.max(0, end - a));
          out.set(bytes.subarray(a, a + out.length));
          return new Promise(function (res) { setTimeout(function () { res(out.buffer); }, opts.delayMs || 0); });
        }
      };
    }
  };
  return file;
}

/* Runs worker.js in a vm context that stands in for the worker global:
   self, postMessage, and an importScripts that must never be reached. */
var WAIT_MS = 10000;   // a worker that stops advancing fails the test instead of hanging the suite

function runWorker(file, chunkBytes, hooks) {
  return new Promise(function (resolve, reject) {
    var posted = [];
    var settle = function (fn, v) { file.settled = true; fn(v); };
    setTimeout(function () { settle(reject, new Error("the worker gave no answer in " + WAIT_MS + " ms")); }, WAIT_MS).unref();
    var ctx = {
      LCReader: LCReader, LCMasks: LCMasks, LCDrain: LCDrain, LCStamps: LCStamps, setTimeout: setTimeout, Promise: Promise, Uint8Array: Uint8Array,
      Date: Date, performance: performance, Math: Math, Error: Error, String: String, console: console,
      importScripts: function () { throw new Error("importScripts was called although LCReader is defined"); },
      /* Through JSON, as structured clone would: plain data, and objects of
         this realm rather than the context's, so deepEqual can compare them. */
      postMessage: function (m) { m = JSON.parse(JSON.stringify(m)); if (m.type === "ready") { posted.ready = (posted.ready || 0) + 1; return; } posted.push(m); if (m.type !== "progress") settle(resolve, posted); }
    };
    ctx.self = ctx;
    posted.ctx = ctx;    // so a test can start a second run on the same worker
    vm.createContext(ctx);
    vm.runInContext(workerSrc, ctx, { filename: "worker.js" });
    if (hooks && hooks.onStart) hooks.onStart(ctx);
    ctx.self.onmessage({ data: { type: "start", file: file, chunkBytes: chunkBytes, runId: (hooks && hooks.runId !== undefined) ? hooks.runId : 42 } });
  });
}

test("worker: the first line is the importScripts guard and nothing else touches the network", function () {
  var first = workerSrc.split("\n")[0];
  assert.equal(first, "if (typeof LCReader === 'undefined') importScripts('reader.js', 'masks.js', 'drain.js', 'stamps.js');");
  var code = function (src) { return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); };
  var srcOf = function (name) { return fs.readFileSync(path.join(__dirname, "..", name), "utf8"); };
  var others = ["reader.js", "masks.js", "drain.js", "stamps.js", "estimate.js"].map(srcOf);
  others.map(code).concat([code(workerSrc).split("\n").slice(1).join("\n")]).forEach(function (src) {
    assert.doesNotMatch(src, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|importScripts|EventSource|navigator)\b/);
  });
  var es6 = /=>|\blet\b|\bconst\b|`|\bclass\b|\basync\b|\bawait\b|^\s*(import|export)\b|\bfor\s*\(\s*(var\s+)?\w+\s+of\b/m;
  others.forEach(function (src, i) { assert.doesNotMatch(code(src), es6, ["reader.js", "masks.js", "drain.js", "stamps.js", "estimate.js"][i] + " is ES5"); });
  assert.doesNotMatch(code(workerSrc), es6, "worker.js is ES5");
});

test("worker: done, with progress at the end and a reconciled result", function () {
  var bytes = bytesOf("mixed.log");
  var expect = manifest.filter(function (m) { return m.name === "mixed.log"; })[0];
  return runWorker(fakeFile(bytes, "mixed.log"), 65536).then(function (posted) {
    var progress = posted.filter(function (m) { return m.type === "progress"; });
    var last = posted[posted.length - 1];
    assert.ok(progress.length >= 1, "at least the final progress");
    assert.equal(progress[progress.length - 1].bytesRead, bytes.length, "the final progress is the whole file");
    assert.equal(progress[progress.length - 1].fileSize, bytes.length);
    assert.equal(progress[progress.length - 1].lines, expect.lines);
    assert.ok(typeof progress[0].elapsedMs === "number");
    assert.equal(last.type, "done");
    var r = last.result;
    assert.equal(r.schemaVersion, 1);
    assert.equal(r.status, "done");
    assert.deepEqual(r.file, { name: "mixed.log", size: bytes.length, bytesRead: bytes.length, bomBytes: 0 });
    assert.equal(r.totals.lines, expect.lines);
    assert.equal(r.totals.bytes, expect.bytes);
    assert.equal(r.totals.longestLineBytes, expect.longestLineBytes);
    var contentBytes = LCReader.runChunks([bytes]).result.contentBytes;
    assert.ok(Math.abs(r.totals.avgLineBytes - contentBytes / expect.lines) < 1e-9, "the average is measured on content, like the longest line");
    assert.ok(r.totals.avgLineBytes <= r.totals.longestLineBytes, "so it can never exceed the longest");
    assert.deepEqual(r.counters, { empty: expect.emptyLines, undecodable: expect.undecodableLines, crlf: expect.crlfLines, overLong: expect.overLongLines, truncated: expect.truncatedLines });
    assert.deepEqual(r.reconciliation, { residual: 0, ok: true });
    assert.ok(r.timing.ms >= 0 && r.timing.bytesPerSecond > 0 && r.timing.linesPerSecond > 0);
    assert.ok(typeof progress[progress.length - 1].templates === "number" && progress[progress.length - 1].templates === r.templates.count);

    /* The templates: every line is in a row, in Other, or empty; Other
       holds the lines over 64 KB (mixed.log has three) and their bytes. */
    var tp = r.templates, held = 0, heldBytes = 0;
    assert.equal(tp.cap, 4000);
    assert.equal(tp.evicted, 0);
    assert.equal(tp.count, tp.rows.length);
    tp.rows.forEach(function (row, i) {
      assert.ok(typeof row.template === "string" && row.lines >= 1 && row.bytes >= 0);
      if (i > 0) assert.ok(tp.rows[i - 1].lines >= row.lines, "most lines first");
      held += row.lines; heldBytes += row.bytes;
    });
    assert.equal(tp.other.overLong, expect.overLongLines);
    assert.equal(tp.other.lines, expect.overLongLines);
    assert.equal(held + tp.other.lines + r.counters.empty, r.totals.lines, "every line accounted for");
    assert.equal(heldBytes + tp.other.bytes, Math.round(r.totals.avgLineBytes * r.totals.lines), "every content byte accounted for");
    assert.ok(tp.count >= 14 && tp.count < 200, tp.count + " templates for a file written from 14");

    /* The time: mixed.log is syslog without a year, in random order. */
    var tm = r.time;
    assert.equal(tm.format.id, "syslog");
    assert.equal(tm.yearless, true);
    assert.equal(tm.lines, r.totals.lines - r.counters.empty);
    assert.equal(tm.stamped + tm.unstamped, tm.lines);
    assert.ok(tm.stamped > tm.lines * 0.9, "most lines stamped");
    assert.ok(tm.spanSeconds > 0 && tm.perSecond > 0);
  });
});

test("worker: templates and time are the same whatever the chunking", function () {
  var bytes = bytesOf("mixed.log");
  return Promise.all([4096, 65536, 8 * MiB].map(function (size) {
    return runWorker(fakeFile(bytes, "mixed.log"), size).then(function (posted) { return posted[posted.length - 1].result; });
  })).then(function (results) {
    results.slice(1).forEach(function (r) {
      assert.deepEqual(r.templates, results[0].templates);
      assert.deepEqual(r.time, results[0].time);
    });
  });
});

test("worker: a BOM is stripped and counted", function () {
  var bytes = bytesOf("bom.log");
  return runWorker(fakeFile(bytes, "bom.log"), 65536).then(function (posted) {
    var r = posted[posted.length - 1].result;
    assert.equal(r.file.bomBytes, 3);
    assert.equal(r.totals.bytes + 3, bytes.length);
    assert.deepEqual(r.reconciliation, { residual: 0, ok: true });
  });
});

test("worker: a fast file gets exactly two progress messages, the first chunk's and the final one", function () {
  var bytes = bytesOf("lf.log");
  return runWorker(fakeFile(bytes, "lf.log"), 65536).then(function (posted) {
    var progress = posted.filter(function (m) { return m.type === "progress"; });
    var elapsed = progress[progress.length - 1].elapsedMs;
    assert.ok(elapsed < 100, "the run is over before the throttle would allow a second one (" + elapsed.toFixed(0) + " ms)");
    assert.equal(progress.length, 2, "one after the first chunk, one forced at the end");
    assert.equal(progress[1].bytesRead, bytes.length);
  });
});

test("worker: refused, every code once, the no-newline one judged against the file's size", function () {
  var line = new Uint8Array(70000); line.fill(0x61);   // one 70 KB line, no LF, in a file said to be 5 MB
  var cases = [
    [fakeFile(bytesOf("utf16.log"), "utf16.log"), "utf16", /iconv/],
    [fakeFile(bytesOf("fake.gz"), "fake.gz"), "gzip", /gunzip/],
    [fakeFile(bytesOf("fake.zip"), "fake.zip"), "zip", /Unzip/],
    [fakeFile(bytesOf("binary.bin"), "binary.bin"), "binary", /binary/],
    [fakeFile(new Uint8Array(0), "empty.log"), "empty", /empty/],
    [fakeFile(line, "one.log", { size: 5000000 }), "no-newline", /no line break/]
  ];
  return cases.reduce(function (p, c) {
    return p.then(function () {
      return runWorker(c[0], 65536).then(function (posted) {
        assert.equal(posted.length, 1, c[1] + ": one message");
        assert.equal(posted[0].type, "refused", c[1]);
        assert.equal(posted[0].code, c[1]);
        assert.match(posted[0].message, c[2]);
      });
    });
  }, Promise.resolve());
});

test("worker: cancel between chunks gives a partial, reconciled result", function () {
  var bytes = bytesOf("lf.log"), ctxRef = null;
  var file = fakeFile(bytes, "lf.log", {
    delayMs: 2,
    onSlice: function (a) { if (a > 0 && ctxRef) ctxRef.self.onmessage({ data: { type: "cancel" } }); }
  });
  return runWorker(file, 65536, { onStart: function (ctx) { ctxRef = ctx; } }).then(function (posted) {
    var last = posted[posted.length - 1];
    assert.equal(last.type, "cancelled");
    assert.equal(last.result.status, "partial");
    assert.ok(last.result.file.bytesRead > 0 && last.result.file.bytesRead < bytes.length, "stopped part way");
    assert.deepEqual(last.result.reconciliation, { residual: 0, ok: true }, "the part read still reconciles");
    var br = last.result.file.bytesRead;
    var partial = LCReader.runChunks([bytes.subarray(0, br)]).result;
    assert.equal(bytes[br - 1], 10, "the part read ends on a line feed: no half line is counted");
    assert.equal(last.result.totals.lines, partial.lines, "the figures describe exactly the bytes read");
    assert.equal(last.result.totals.bytes, partial.bytes);
    assert.equal(last.result.totals.longestLineBytes, partial.longestLineBytes);
    assert.deepEqual(last.result.counters, { empty: partial.emptyLines, undecodable: partial.undecodableLines, crlf: partial.crlfLines, overLong: partial.overLongLines, truncated: partial.truncatedLines });
  });
});

test("worker: a failing read is reported, not swallowed", function () {
  var bytes = bytesOf("lf.log");
  return runWorker(fakeFile(bytes, "lf.log", { failAt: 65536 }), 65536).then(function (posted) {
    var last = posted[posted.length - 1];
    assert.equal(last.type, "error");
    assert.match(last.message, /disk unplugged/);
  });
});

test("worker: a bad message type is an error, a small chunk is widened to the 64 KiB floor", function () {
  var widths = [];
  return runWorker(fakeFile(bytesOf("oneline.log"), "oneline.log", { onSlice: function (a, b) { widths.push(b - a); } }), 1).then(function (posted) {
    var last = posted[posted.length - 1];
    assert.equal(last.type, "done", "chunkBytes 1 is widened to the minimum rather than refused as no-newline");
    assert.equal(last.result.totals.lines, 1);
    assert.deepEqual(widths, [65536], "the floor is 64 KiB, as the protocol says, not the 8 MiB default");
    return runWorker(fakeFile(bytesOf("lf.log"), "lf.log", { onSlice: function (a, b) { widths.push(b - a); } }), 4096);
  }).then(function (posted) {
    assert.equal(posted[posted.length - 1].type, "done");
    assert.ok(widths.slice(1).every(function (w) { return w === 65536; }), "4 KiB is raised to 64 KiB too");
  }).then(function () {
    return new Promise(function (resolve) {
      var ctx = { LCReader: LCReader, LCMasks: LCMasks, LCDrain: LCDrain, LCStamps: LCStamps, postMessage: function (m) { if (m.type !== "ready") resolve(m); }, importScripts: function () {} };
      ctx.self = ctx;
      vm.createContext(ctx);
      vm.runInContext(workerSrc, ctx);
      ctx.self.onmessage({ data: { type: "frobnicate" } });
    }).then(function (m) {
      assert.equal(m.type, "error");
      assert.match(m.message, /frobnicate/);
    });
  });
});

/* ---- what the page relies on across runs ---- */

test("pending() counts the carried bytes and flush leaves nothing behind", function () {
  var sp = LCReader.createSplitter(), out = [];
  var onLine = function (lb, bl) { out.push(bl); };
  sp.push(utf8("abc"), onLine);
  assert.equal(sp.pending(), 3);
  sp.push(utf8("de\nfg"), onLine);
  assert.equal(sp.pending(), 2);
  assert.deepEqual(out, [6]);
  sp.flush(onLine);
  assert.equal(sp.pending(), 0);
  assert.deepEqual(out, [6, 2]);
  sp.flush(onLine);
  assert.deepEqual(out, [6, 2], "a second flush emits nothing");
});

test("a replacement character the writer put there is not invalid UTF-8", function () {
  var r = LCReader.runChunks([new Uint8Array([0xEF, 0xBF, 0xBD, 0x0A, 0x61, 0xFF, 0x0A])]).result;
  assert.equal(r.lines, 2);
  assert.equal(r.undecodableLines, 1, "only the line with the bad byte counts");
  var st = LCReader.createStats();
  st.add(new Uint8Array([0xEF, 0xBF, 0xBD]), 4, false, "\uFFFD");   // decoded text given: the bytes still decide
  assert.equal(st.result().undecodableLines, 0);
});

test("worker: every message echoes the runId of the start it answers", function () {
  return runWorker(fakeFile(bytesOf("mixed.log"), "mixed.log"), 65536, { runId: 7 }).then(function (posted) {
    assert.equal(posted.ready, 1, "the worker said it was ready exactly once, when its script ran");
    assert.ok(posted.length >= 2);
    posted.forEach(function (m) { assert.equal(m.runId, 7, m.type + " carries the runId"); });
    return runWorker(fakeFile(bytesOf("utf16.log"), "utf16.log"), 65536, { runId: 8 });
  }).then(function (posted) {
    assert.equal(posted[0].type, "refused");
    assert.equal(posted[0].runId, 8);
  });
});

/* A second start on the worker a previous runWorker left behind. */
function startOn(posted, file, chunkBytes, runId) {
  var ctx = posted.ctx, from = posted.length;
  return new Promise(function (resolve, reject) {
    var settle = function (fn, v) { file.settled = true; fn(v); };
    setTimeout(function () { settle(reject, new Error("the worker gave no answer in " + WAIT_MS + " ms")); }, WAIT_MS).unref();
    ctx.postMessage = function (m) { m = JSON.parse(JSON.stringify(m)); if (m.type === "ready") return; posted.push(m); if (m.type !== "progress") settle(resolve, posted.slice(from)); };
    ctx.self.onmessage({ data: { type: "start", file: file, chunkBytes: chunkBytes, runId: runId } });
  });
}

test("worker: one worker serves run after run: after done, after refused, after cancelled", function () {
  var lf = bytesOf("lf.log"), expect = manifest.filter(function (m) { return m.name === "lf.log"; })[0];
  return runWorker(fakeFile(bytesOf("mixed.log"), "mixed.log"), 65536, { runId: 1 }).then(function (posted) {
    assert.equal(posted[posted.length - 1].type, "done");
    return startOn(posted, fakeFile(lf, "lf.log"), 65536, 2).then(function (second) {
      var last = second[second.length - 1];
      assert.equal(last.type, "done", "a second run on the same worker completes");
      assert.equal(last.runId, 2);
      assert.equal(last.result.totals.lines, expect.lines);
      return startOn(posted, fakeFile(bytesOf("fake.gz"), "fake.gz"), 65536, 3);
    }).then(function (third) {
      assert.equal(third[0].type, "refused");
      assert.equal(third[0].runId, 3);
      return startOn(posted, fakeFile(lf, "lf.log"), 65536, 4);
    }).then(function (fourth) {
      var last = fourth[fourth.length - 1];
      assert.equal(last.type, "done", "a run after a refusal completes");
      assert.equal(last.result.totals.lines, expect.lines);
    });
  }).then(function () {
    var ctxRef = null;
    var file = fakeFile(lf, "lf.log", { delayMs: 2, onSlice: function (a) { if (a > 0 && ctxRef) ctxRef.self.onmessage({ data: { type: "cancel" } }); } });
    return runWorker(file, 65536, { runId: 5, onStart: function (ctx) { ctxRef = ctx; } }).then(function (posted) {
      assert.equal(posted[posted.length - 1].type, "cancelled");
      assert.equal(posted.ready, 1, "no second ready after a cancel");
      return startOn(posted, fakeFile(lf, "lf.log"), 65536, 6);
    }).then(function (next) {
      var last = next[next.length - 1];
      assert.equal(last.type, "done", "a run after a cancel completes, the cancel flag reset");
      assert.equal(last.result.status, "done");
      assert.equal(last.result.totals.lines, expect.lines);
    });
  });
});

test("worker: a second start while a run is in flight is refused with the intruder's id and the first run completes", function () {
  var lf = bytesOf("lf.log"), expect = manifest.filter(function (m) { return m.name === "lf.log"; })[0];
  var intruder = null;
  return runWorker(fakeFile(lf, "lf.log", { delayMs: 3 }), 65536, { runId: 11, onStart: function (ctx) {
    var original = ctx.postMessage;
    ctx.postMessage = function (m) { m = JSON.parse(JSON.stringify(m)); if (m.type === "error" && m.runId === 12) { intruder = m; return; } original(m); };
    // a tick later, so the real start (sent right after this hook) is the one in flight
    setTimeout(function () { ctx.self.onmessage({ data: { type: "start", file: fakeFile(lf, "again.log"), chunkBytes: 65536, runId: 12 } }); }, 0);
  } }).then(function (posted) {
    assert.ok(intruder && /already being read/.test(intruder.message), "the intruder was answered with an error carrying its own id");
    var last = posted[posted.length - 1];
    assert.equal(last.type, "done"); assert.equal(last.runId, 11);
    assert.equal(last.result.totals.lines, expect.lines, "the first run was untouched");
  });
});

test("worker: a file that shrank under the reader is an error, on the first read or later", function () {
  var bytes = bytesOf("lf.log");
  return runWorker(fakeFile(bytes, "lf.log", { size: 300000 }), 65536).then(function (posted) {
    var last = posted[posted.length - 1];
    assert.equal(last.type, "error");
    assert.match(last.message, /shorter than it was/);
    assert.equal(last.runId, 42);
    return runWorker(fakeFile(new Uint8Array(0), "gone.log", { size: 5000 }), 65536);
  }).then(function (posted) {
    assert.equal(posted[0].type, "error", "nothing on the first read of a non-empty file is the same error, not an empty refusal");
    assert.match(posted[0].message, /shorter than it was/);
  });
});

test("worker: progress keeps arriving, about every 100 ms, on a slow file", function () {
  var lf = bytesOf("lf.log"), bytes = new Uint8Array(lf.length * 5), i;
  for (i = 0; i < 5; i++) bytes.set(lf, i * lf.length);
  // 1.1 MB at 64 KiB a chunk is 17 reads; 30 ms each spans half a second
  return runWorker(fakeFile(bytes, "lf5.log", { delayMs: 30 }), 65536).then(function (posted) {
    var progress = posted.filter(function (m) { return m.type === "progress"; });
    assert.ok(progress.length >= 4, progress.length + " progress messages over the run");
    for (var k = 1; k < progress.length; k++) {
      var gap = progress[k].elapsedMs - progress[k - 1].elapsedMs;
      if (k < progress.length - 1) assert.ok(gap >= 99, "no two closer than 100 ms (" + gap.toFixed(1) + ")");
      assert.ok(gap <= 400, "none further apart than a few chunks (" + gap.toFixed(1) + ")");
    }
    assert.equal(posted[posted.length - 1].type, "done");
  });
});

test("worker: a cancel that lands during the last read is a finished run", function () {
  var bytes = bytesOf("nonl.log"), ctxRef = null;
  var expect = manifest.filter(function (m) { return m.name === "nonl.log"; })[0];
  // one 64 KiB chunk holds the whole 55 KB file, so the cancel lands while that read is pending
  var file = fakeFile(bytes, "nonl.log", { delayMs: 5, onSlice: function () { if (ctxRef) ctxRef.self.onmessage({ data: { type: "cancel" } }); } });
  return runWorker(file, 65536, { onStart: function (ctx) { ctxRef = ctx; } }).then(function (posted) {
    var last = posted[posted.length - 1];
    assert.equal(last.type, "done", "every byte was read, so the run is done, final line included");
    assert.equal(last.result.totals.lines, expect.lines);
    assert.equal(last.result.file.bytesRead, bytes.length);
  });
});

test("a line past the 16 MiB cap is counted in full, kept only on its first 16 MiB, and the memory stays bounded", function () {
  var CAP = LCReader.CAP_BYTES, EIGHT = 8 * MiB;
  assert.equal(CAP, 16000000, "16 MB, decimal like the rest of the site");
  // 20 MiB of "x" ending in CRLF, between two short lines, fed in the worker's 8 MiB chunks
  var huge = new Uint8Array(20 * MiB + 2); huge.fill(0x78); huge[huge.length - 2] = 13; huge[huge.length - 1] = 10;
  var file = new Uint8Array(4 + huge.length + 3);
  file.set(utf8("ab\r\n"), 0); file.set(huge, 4); file.set(utf8("cd\n"), 4 + huge.length);
  var seen = [], sp = LCReader.createSplitter(), largestHanded = 0, pendingAtPeak = 0;
  var onLine = function (lb, bl, cr, full) { seen.push({ kept: lb.length, bl: bl, cr: cr, full: full }); if (lb.length > largestHanded) largestHanded = lb.length; };
  chunk(file, EIGHT).forEach(function (c) { sp.push(c, onLine); });
  sp.flush(onLine);
  // at 1 MiB chunks the line crosses twenty boundaries, so pending() is seen past the cap mid-line
  var sp2 = LCReader.createSplitter(), noop = function () {};
  chunk(file, MiB).forEach(function (c) { sp2.push(c, noop); if (sp2.pending() > pendingAtPeak) pendingAtPeak = sp2.pending(); });
  assert.deepEqual(seen.map(function (l) { return [l.kept, l.bl, l.cr, l.full]; }), [
    [2, 4, true, 2], [CAP, 20 * MiB + 2, true, 20 * MiB], [2, 3, false, 2]
  ], "the huge line reports its true length, its CR and its full byteLength, but hands out the capped prefix");
  assert.equal(largestHanded, CAP, "nothing larger than the cap is ever handed out");
  assert.ok(pendingAtPeak > CAP, "pending() counts the bytes beyond the cap too: " + pendingAtPeak);
  var r = LCReader.runChunks(chunk(file, EIGHT)).result;
  assert.equal(r.lines, 3); assert.equal(r.longestLineBytes, 20 * MiB); assert.equal(r.overLongLines, 1);
  assert.equal(r.truncatedLines, 1); assert.equal(r.crlfLines, 2); assert.equal(r.residual, 0);
  assert.equal(r.bytes, file.length);
  // the same line last, with no terminator, through flush
  var tail = new Uint8Array(4 + 20 * MiB); tail.set(utf8("ab\r\n"), 0); tail.fill(0x78, 4);
  var r2 = LCReader.runChunks(chunk(tail, EIGHT)).result;
  assert.equal(r2.lines, 2); assert.equal(r2.longestLineBytes, 20 * MiB); assert.equal(r2.truncatedLines, 1);
  assert.equal(r2.residual, 0); assert.equal(r2.bytes, tail.length);
  // and at 1 MiB chunks the figures are the same
  assert.deepEqual(LCReader.runChunks(chunk(file, MiB)).result, r, "identical whatever the chunking");
  // a capped final line ending in a bare CR: the CR is content, since no LF follows
  var cr = new Uint8Array(4 + CAP + 10); cr.set(utf8("ab\r\n"), 0); cr.fill(0x78, 4); cr[cr.length - 1] = 13;
  var r3 = LCReader.runChunks(chunk(cr, EIGHT)).result;
  assert.equal(r3.crlfLines, 1); assert.equal(r3.longestLineBytes, CAP + 10); assert.equal(r3.truncatedLines, 1); assert.equal(r3.residual, 0);
  // a capped line of valid two-byte characters, cut mid-character at the cap, is not invalid UTF-8
  var acc = new Uint8Array(3 + 1 + 2 * 8400000 + 1); acc.set(utf8("ab\n"), 0); acc[3] = 0x61;
  for (var k = 4; k < acc.length - 1; k += 2) { acc[k] = 0xC3; acc[k + 1] = 0xA9; }
  acc[acc.length - 1] = 10;
  var r4 = LCReader.runChunks(chunk(acc, EIGHT)).result;
  assert.equal(r4.truncatedLines, 1, "cut at the cap");
  assert.equal(r4.undecodableLines, 0, "every byte of it decodes, so it is not counted invalid");
  var bad = new Uint8Array(3 + 2 + CAP + 10 + 1); bad.set(utf8("ab\n"), 0); bad[3] = 0x61; bad[4] = 0xFF; bad.fill(0x78, 5); bad[bad.length - 1] = 10;
  var r5 = LCReader.runChunks(chunk(bad, EIGHT)).result;
  assert.equal(r5.truncatedLines, 1); assert.equal(r5.undecodableLines, 1, "a bad byte inside the kept part of a capped line still counts");
  // after a line past 1 MiB the carry buffer is released: the next crossing line gets a small one
  var sp3 = LCReader.createSplitter(), handed = [];
  var grab = function (lb) { handed.push(lb.buffer.byteLength); };
  var two = new Uint8Array(2 * MiB); two.fill(0x78);
  sp3.push(two, grab); sp3.push(utf8("y\n"), grab);
  sp3.push(utf8("ab"), grab); sp3.push(utf8("c\n"), grab);
  assert.ok(handed[0] >= 2 * MiB, "the long line came from the grown buffer");
  assert.ok(handed[1] < MiB, "the short crossing line after it did not: the grown buffer was dropped (" + handed[1] + " bytes)");
});

test("worker: a line past the cap goes through the worker with its true length and a truncated count", function () {
  var CAP = LCReader.CAP_BYTES;
  var huge = new Uint8Array(20 * MiB + 2); huge.fill(0x78); huge[huge.length - 2] = 13; huge[huge.length - 1] = 10;
  var file = new Uint8Array(4 + huge.length + 3);
  file.set(utf8("ab\r\n"), 0); file.set(huge, 4); file.set(utf8("cd\n"), 4 + huge.length);
  return runWorker(fakeFile(file, "huge.log"), 8 * MiB).then(function (posted) {
    var last = posted[posted.length - 1];
    assert.equal(last.type, "done");
    assert.equal(last.result.totals.lines, 3);
    assert.equal(last.result.totals.longestLineBytes, 20 * MiB, "the true length, well past the cap of " + CAP);
    assert.deepEqual(last.result.counters, { empty: 0, undecodable: 0, crlf: 2, overLong: 1, truncated: 1 });
    assert.deepEqual(last.result.reconciliation, { residual: 0, ok: true });
  });
});

test("worker: the throttle is time-based: a chunk slower than 100 ms always gets its own progress message", function () {
  var lf = bytesOf("lf.log"), bytes = new Uint8Array(lf.length * 3), i;
  for (i = 0; i < 3; i++) bytes.set(lf, i * lf.length);
  var chunks = Math.ceil(bytes.length / 65536);   // 11 reads of 64 KiB, 130 ms each
  return runWorker(fakeFile(bytes, "lf3.log", { delayMs: 130 }), 65536).then(function (posted) {
    var progress = posted.filter(function (m) { return m.type === "progress"; });
    assert.ok(progress.length >= chunks, progress.length + " progress messages for " + chunks + " slow chunks: one per chunk at least");
    for (var k = 1; k < progress.length; k++) assert.ok(progress[k].bytesRead >= progress[k - 1].bytesRead, "bytesRead never goes back");
    assert.equal(progress[progress.length - 1].bytesRead, bytes.length);
  });
});
