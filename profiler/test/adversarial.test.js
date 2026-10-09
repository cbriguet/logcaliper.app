/* Adversarial reader test: attacks the splitter, sniff, stats, decodeLine and
   runChunks against naive references, with random chunkings, straddling
   characters, BOM edges, split CRLF, an 8 MiB line and every refusal code.
   Written by a reviewer against three competing implementations; it stays
   here so a change to reader.js is measured against the same attacks.
   Usage: node profiler/test/adversarial.test.js [repo-root] */
"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");

var dir = process.argv[2] || path.join(__dirname, "..", "..");
var R = require(path.resolve(dir, "profiler", "reader.js"));
var TD = new TextDecoder("utf-8");
var STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// Invalid means the bytes do not decode: a U+FFFD the writer put there is valid UTF-8.
function isBad(b) { try { STRICT.decode(b); return false; } catch (e) { return true; } }
var MiB = 1024 * 1024;

/* ---------- helpers ---------- */
function bytesOf(s) { return new TextEncoder().encode(s); }
function cat() {
  var n = 0, i, out, off = 0;
  for (i = 0; i < arguments.length; i++) n += arguments[i].length;
  out = new Uint8Array(n);
  for (i = 0; i < arguments.length; i++) { out.set(arguments[i], off); off += arguments[i].length; }
  return out;
}
// seeded PRNG (mulberry32)
function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Cut `bytes` at the sorted cut points into subarrays (chunks may be empty if allowEmpty).
function chunkAt(bytes, cuts) {
  var out = [], prev = 0, i;
  for (i = 0; i < cuts.length; i++) { out.push(bytes.subarray(prev, cuts[i])); prev = cuts[i]; }
  out.push(bytes.subarray(prev));
  return out;
}
function randomChunking(bytes, rand, allowEmpty) {
  var n = bytes.length, k = Math.floor(rand() * Math.min(n + 1, 40)), cuts = [], i, c;
  for (i = 0; i < k; i++) { c = Math.floor(rand() * (n + 1)); cuts.push(c); }
  cuts.sort(function (a, b) { return a - b; });
  if (!allowEmpty) {
    var dedup = [];
    for (i = 0; i < cuts.length; i++) if (cuts[i] > 0 && cuts[i] < n && (dedup.length === 0 || dedup[dedup.length - 1] !== cuts[i])) dedup.push(cuts[i]);
    cuts = dedup;
  }
  return chunkAt(bytes, cuts);
}
function fixedChunking(bytes, size) {
  var out = [], i;
  if (bytes.length === 0) return [bytes];
  for (i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, Math.min(bytes.length, i + size)));
  return out;
}
// Naive reference splitter: the spec's semantics written the obvious way.
function refSplit(bytes) {
  var out = [], start = 0, i, seg, hadCR;
  for (i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10) {
      seg = bytes.subarray(start, i);
      hadCR = seg.length > 0 && seg[seg.length - 1] === 13;
      out.push({ content: Array.from(hadCR ? seg.subarray(0, seg.length - 1) : seg), byteLength: i - start + 1, hadCR: hadCR });
      start = i + 1;
    }
  }
  if (start < bytes.length) {
    seg = bytes.subarray(start);
    out.push({ content: Array.from(seg), byteLength: seg.length, hadCR: false });
  }
  return out;
}
function refStats(bytes, bom) {
  var lines = refSplit(bytes.subarray(bom)), s = { lines: 0, bytes: 0, contentBytes: 0, bomBytes: bom, bytesRead: bytes.length,
    crlfLines: 0, emptyLines: 0, undecodableLines: 0, longestLineBytes: 0, overLongLines: 0, truncatedLines: 0, residual: 0 }, i, l, text;
  for (i = 0; i < lines.length; i++) {
    l = lines[i];
    s.lines++; s.bytes += l.byteLength; s.contentBytes += l.content.length;
    if (l.hadCR) s.crlfLines++;
    if (l.content.length === 0) s.emptyLines++;
    if (l.content.length > s.longestLineBytes) s.longestLineBytes = l.content.length;
    if (l.content.length > 64000) s.overLongLines++;
    if (l.content.length > 16000000) s.truncatedLines++;
    if (isBad(new Uint8Array(l.content))) s.undecodableLines++;
  }
  s.residual = s.bytesRead - s.bytes - s.bomBytes;
  return s;
}
// Run the impl's splitter over chunks and collect emitted lines (copying content, since lineBytes is transient).
function runSplitter(chunks) {
  var sp = R.createSplitter(), out = [], i;
  var onLine = function (lb, bl, cr) {
    assert.ok(lb instanceof Uint8Array, "lineBytes is a Uint8Array");
    assert.equal(typeof bl, "number");
    assert.equal(typeof cr, "boolean", "hadCR is a boolean");
    out.push({ content: Array.from(lb), byteLength: bl, hadCR: cr });
  };
  for (i = 0; i < chunks.length; i++) sp.push(chunks[i], onLine);
  sp.flush(onLine);
  return out;
}
// Normalise runChunks output: impl B returns the schema-1 result, A and C the flat stats result.
function flat(res) {
  if (res.refused) return { refused: res.refused };
  var r = res.result;
  if (r && r.totals) {
    return { result: {
      lines: r.totals.lines, bytes: r.totals.bytes, bomBytes: r.file.bomBytes, bytesRead: r.file.bytesRead,
      crlfLines: r.counters.crlf, emptyLines: r.counters.empty, undecodableLines: r.counters.undecodable,
      longestLineBytes: r.totals.longestLineBytes, overLongLines: r.counters.overLong, truncatedLines: r.counters.truncated, residual: r.reconciliation.residual
    } };
  }
  return { result: r };
}
function run(chunks, opts) { return flat(R.runChunks(chunks, opts)); }
function statsOfLines(lines, withText) {
  var st = R.createStats(), i, lb;
  for (i = 0; i < lines.length; i++) {
    lb = lines[i];
    if (withText) st.add(lb, lb.length + 1, false, TD.decode(lb));
    else st.add(lb, lb.length + 1, false);
  }
  return st.result();
}

/* ---------- API surface ---------- */
test("API: the five spec'd names exist, runChunks returns {refused}|{result}", function () {
  ["sniff", "createSplitter", "createStats", "decodeLine", "runChunks"].forEach(function (k) {
    assert.equal(typeof R[k], "function", k);
  });
  var sp = R.createSplitter();
  assert.equal(typeof sp.push, "function"); assert.equal(typeof sp.flush, "function");
  var st = R.createStats();
  ["add", "setBom", "setBytesRead", "result"].forEach(function (k) { assert.equal(typeof st[k], "function", "stats." + k); });
  var r = st.result();
  ["lines", "bytes", "contentBytes", "bomBytes", "bytesRead", "crlfLines", "emptyLines", "undecodableLines", "longestLineBytes", "overLongLines", "truncatedLines", "residual"]
    .forEach(function (k) { assert.ok(k in r, "stats.result()." + k); });
  var raw = R.runChunks([bytesOf("a\n")]);
  assert.ok(raw.result && !raw.refused);
  // Record (not assert) whether runChunks returns the flat stats shape the manifest fields name.
  console.log("  [info] runChunks result shape: " + (raw.result.totals ? "schema-1 nested (totals/counters)" : "flat stats"));
  raw = R.runChunks([new Uint8Array(0)]);
  assert.ok(raw.refused && raw.refused.code === "empty");
});

/* ---------- property test: random bytes, random CR/LF, 30 random chunkings ---------- */
test("property: splitter equals naive reference under 30 random chunkings (500 inputs, full byte range)", function () {
  var rand = rng(20261002), round, bytes, n, i, ref, k, chunks, got, pLF, pCR, b;
  for (round = 0; round < 500; round++) {
    n = Math.floor(rand() * 400);
    pLF = rand() * 0.35; pCR = rand() * 0.35;
    bytes = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      b = rand();
      if (b < pLF) bytes[i] = 10;
      else if (b < pLF + pCR) bytes[i] = 13;
      else if (b < pLF + pCR + 0.1 && i + 1 < n) { bytes[i] = 13; bytes[i + 1] = 10; i++; }   // explicit CRLF pairs
      else bytes[i] = Math.floor(rand() * 256);
    }
    ref = refSplit(bytes);
    // byte lengths must sum to the input
    var sum = 0; for (i = 0; i < ref.length; i++) sum += ref[i].byteLength;
    assert.equal(sum, n);
    for (k = 0; k < 30; k++) {
      chunks = randomChunking(bytes, rand, k % 5 === 4);  // every fifth chunking may hold empty chunks
      got = runSplitter(chunks);
      assert.deepEqual(got, ref, "round " + round + " chunking " + k + " sizes " + chunks.map(function (c) { return c.length; }).join(","));
    }
  }
});

test("property: runChunks equals a reference stats under 30 random chunkings (text-ish alphabet, 300 inputs)", function () {
  var rand = rng(777), round, n, i, bytes, b, ref, k, chunks, got, r0;
  var alphabet = [];
  for (i = 0x20; i < 0x7F; i++) alphabet.push([i]);
  alphabet.push([9]);
  alphabet.push([0xC3, 0xA9], [0xE2, 0x82, 0xAC], [0xF0, 0x9F, 0x98, 0x80], [0xEF, 0xBF, 0xBD], [0xFF], [0xC0, 0x80], [0xE2, 0x82], [0xED, 0xA0, 0x80], [0x80]);
  for (round = 0; round < 300; round++) {
    n = Math.floor(rand() * 300);
    var parts = [], len = 0;
    while (len < n) {
      b = rand();
      if (b < 0.08) { parts.push([10]); len++; }
      else if (b < 0.12) { parts.push([13, 10]); len += 2; }
      else if (b < 0.14) { parts.push([13]); len++; }
      else { var a = alphabet[Math.floor(rand() * alphabet.length)]; parts.push(a); len += a.length; }
    }
    bytes = new Uint8Array(len);
    var off = 0;
    for (i = 0; i < parts.length; i++) { bytes.set(parts[i], off); off += parts[i].length; }
    if (rand() < 0.15) bytes = cat(new Uint8Array([0xEF, 0xBB, 0xBF]), bytes);
    var bom = (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) ? 3 : 0;
    if (bytes.length === 0) continue;
    ref = refStats(bytes, bom);
    r0 = run([bytes]);
    assert.ok(r0.result, "accepted as one chunk (round " + round + "): " + JSON.stringify(r0.refused));
    assert.deepEqual(r0.result, ref, "one-chunk result equals reference, round " + round);
    for (k = 0; k < 30; k++) {
      chunks = randomChunking(bytes, rand, k % 7 === 6);
      got = run(chunks);
      assert.deepEqual(got, r0, "round " + round + " chunking " + k + " sizes " + chunks.map(function (c) { return c.length; }).join(","));
    }
  }
});

/* ---------- multibyte straddling ---------- */
test("a 3-byte and a 4-byte UTF-8 character straddling chunk edges decode whole, at every cut and every chunk size", function () {
  var src = bytesOf("ab€c\nx😀y\n€😀"), i, got, cut, sizes;
  var expected = ["ab€c", "x😀y", "€😀"];
  function check(chunks, label) {
    var lines = runSplitter(chunks);
    assert.equal(lines.length, 3, label);
    for (var j = 0; j < 3; j++) assert.equal(R.decodeLine(new Uint8Array(lines[j].content)), expected[j], label + " line " + j);
    var r = run(chunks, { sniffBytes: 1 << 20 });
    assert.equal(r.result.undecodableLines, 0, label + " undecodable");
    assert.equal(r.result.lines, 3, label);
    assert.equal(r.result.residual, 0, label);
  }
  for (cut = 1; cut < src.length; cut++) check([src.subarray(0, cut), src.subarray(cut)], "cut at " + cut);
  for (sizes = 1; sizes <= src.length + 1; sizes++) check(fixedChunking(src, sizes), "chunk size " + sizes);
  // every pair of cuts
  for (i = 1; i < src.length; i++) for (cut = i + 1; cut < src.length; cut++) check(chunkAt(src, [i, cut]), "cuts " + i + "," + cut);
});

/* ---------- BOM edge cases ---------- */
test("BOM then immediately LF; BOM alone; BOM then CRLF; BOM split across 1-byte chunks", function () {
  var f = new Uint8Array([0xEF, 0xBB, 0xBF, 0x0A]);
  var s = R.sniff(f, 4);
  assert.deepEqual(s, { ok: true, bomBytes: 3 });
  var r = run([f]).result;
  assert.equal(r.bomBytes, 3); assert.equal(r.lines, 1); assert.equal(r.emptyLines, 1);
  assert.equal(r.bytes, 1); assert.equal(r.bytesRead, 4); assert.equal(r.residual, 0);
  assert.deepEqual(run(fixedChunking(f, 1)).result, r, "1-byte chunks");
  assert.deepEqual(run(fixedChunking(f, 2)).result, r, "2-byte chunks");
  assert.deepEqual(run(fixedChunking(f, 3)).result, r, "3-byte chunks");

  var crlf = new Uint8Array([0xEF, 0xBB, 0xBF, 0x0D, 0x0A]);
  r = run([crlf]).result;
  assert.equal(r.bomBytes, 3); assert.equal(r.lines, 1); assert.equal(r.emptyLines, 1); assert.equal(r.crlfLines, 1);
  assert.equal(r.bytes, 2); assert.equal(r.residual, 0);
  assert.deepEqual(run(fixedChunking(crlf, 1)).result, r);

  var only = new Uint8Array([0xEF, 0xBB, 0xBF]);
  var ro = run([only]);
  assert.ok(ro.refused && ro.refused.code === "empty", "a BOM-only file is refused as empty: it holds no line");
  assert.deepEqual(run(fixedChunking(only, 1)), ro);

  // a BOM followed by text, and a second EF BB BF inside the file is content, not a BOM
  var two = cat(only, bytesOf("a\n"), only, bytesOf("b\n"));
  r = run([two]).result;
  assert.equal(r.bomBytes, 3); assert.equal(r.lines, 2); assert.equal(r.bytes, two.length - 3); assert.equal(r.residual, 0);
  assert.equal(r.longestLineBytes, 4, "the inner EF BB BF stays in the line's bytes");
  assert.equal(r.undecodableLines, 0);
});

/* ---------- tiny files ---------- */
test("a file that is only '\\n'", function () {
  var f = new Uint8Array([10]);
  assert.deepEqual(R.sniff(f, 1), { ok: true, bomBytes: 0 });
  var r = run([f]).result;
  assert.deepEqual(r, { lines: 1, bytes: 1, contentBytes: 0, bomBytes: 0, bytesRead: 1, crlfLines: 0, emptyLines: 1, undecodableLines: 0, longestLineBytes: 0, overLongLines: 0, truncatedLines: 0, residual: 0 });
  var lines = runSplitter([f]);
  assert.deepEqual(lines, [{ content: [], byteLength: 1, hadCR: false }]);
});

test("a file that is only '\\r' (a bare CR is content, not a terminator)", function () {
  var f = new Uint8Array([13]);
  assert.deepEqual(R.sniff(f, 1), { ok: true, bomBytes: 0 });
  var r = run([f]).result;
  assert.deepEqual(r, { lines: 1, bytes: 1, contentBytes: 1, bomBytes: 0, bytesRead: 1, crlfLines: 0, emptyLines: 0, undecodableLines: 0, longestLineBytes: 1, overLongLines: 0, truncatedLines: 0, residual: 0 });
  var lines = runSplitter([f]);
  assert.deepEqual(lines, [{ content: [13], byteLength: 1, hadCR: false }]);
  // '\r\n' alone is one empty CRLF line; '\r\r\n' is a line whose content is one CR
  assert.deepEqual(runSplitter([new Uint8Array([13, 10])]), [{ content: [], byteLength: 2, hadCR: true }]);
  assert.deepEqual(runSplitter([new Uint8Array([13, 13, 10])]), [{ content: [13], byteLength: 3, hadCR: true }]);
  // 'a\r' at EOF: CR is content
  assert.deepEqual(runSplitter([bytesOf("a\r")]), [{ content: [97, 13], byteLength: 2, hadCR: false }]);
  // 'a\rb\n': CR mid-line is content
  assert.deepEqual(runSplitter([bytesOf("a\rb\n")]), [{ content: [97, 13, 98], byteLength: 4, hadCR: false }]);
});

test("CRLF split across a chunk edge: CR ends one chunk, LF starts the next -> byteLength 2, hadCR true", function () {
  var lines = runSplitter([new Uint8Array([13]), new Uint8Array([10])]);
  assert.deepEqual(lines, [{ content: [], byteLength: 2, hadCR: true }]);
  lines = runSplitter([bytesOf("ab\r"), bytesOf("\ncd\r"), bytesOf("\n")]);
  assert.deepEqual(lines, [{ content: [97, 98], byteLength: 4, hadCR: true }, { content: [99, 100], byteLength: 4, hadCR: true }]);
  // CR at the end of chunk 1, then an empty chunk, then LF
  lines = runSplitter([bytesOf("x\r"), new Uint8Array(0), bytesOf("\n")]);
  assert.deepEqual(lines, [{ content: [120], byteLength: 3, hadCR: true }]);
  // CR at the end of chunk 1, next chunk starts with a non-LF: CR is content
  lines = runSplitter([bytesOf("x\r"), bytesOf("y\n")]);
  assert.deepEqual(lines, [{ content: [120, 13, 121], byteLength: 4, hadCR: false }]);
  // the carried line ends in CR, then LF arrives alone (carry path CR detection)
  lines = runSplitter([bytesOf("abc"), bytesOf("def\r"), bytesOf("\n"), bytesOf("g\n")]);
  assert.deepEqual(lines, [{ content: Array.from(bytesOf("abcdef")), byteLength: 8, hadCR: true }, { content: [103], byteLength: 2, hadCR: false }]);
  var r = run([bytesOf("ab\r"), bytesOf("\ncd\r"), bytesOf("\n")]).result;
  assert.equal(r.crlfLines, 2); assert.equal(r.bytes, 8); assert.equal(r.residual, 0);
});

/* ---------- the 8 MiB + 1 byte line ---------- */
test("an 8 MiB + 1 byte line: splitter assembles it across 8 MiB chunks; stats count it over-long; sniff refuses it when first", function () {
  var LONG = 8 * MiB + 1;
  var long = new Uint8Array(LONG); long.fill(0x78);
  // (a) preceded by a short line so the sniff passes: accepted, longest = LONG, overLong 1
  var file = cat(bytesOf("a\n"), long, bytesOf("\n"), bytesOf("b\n"));
  var chunks = fixedChunking(file, 8 * MiB);
  assert.equal(chunks.length, 2);
  var seen = [];
  var sp = R.createSplitter();
  var onLine = function (lb, bl, cr) { seen.push([lb.length, bl, cr, lb.length > 10 ? (lb[0] === 0x78 && lb[lb.length - 1] === 0x78) : Array.from(lb)]); };
  for (var i = 0; i < chunks.length; i++) sp.push(chunks[i], onLine);
  sp.flush(onLine);
  assert.deepEqual(seen, [[1, 2, false, [97]], [LONG, LONG + 1, false, true], [1, 2, false, [98]]]);
  var r = run(chunks).result;
  assert.equal(r.lines, 3); assert.equal(r.longestLineBytes, LONG); assert.equal(r.overLongLines, 1);
  assert.equal(r.bytes, file.length); assert.equal(r.residual, 0); assert.equal(r.undecodableLines, 0);
  assert.deepEqual(run(fixedChunking(file, 3 * MiB)).result, r, "3 MiB chunks give the same answer");
  // (b) the long line first: the first 8 MiB hold no LF and the file is bigger -> no-newline
  var file2 = cat(long, bytesOf("\n"), bytesOf("b\n"));
  var ref = run(fixedChunking(file2, 8 * MiB));
  assert.ok(ref.refused, "refused");
  assert.equal(ref.refused.code, "no-newline");
  var s = R.sniff(file2.subarray(0, 8 * MiB), file2.length);
  assert.equal(s.ok, false); assert.equal(s.code, "no-newline");
  // (c) an 8 MiB - 1 line + LF: the LF is the last byte of the first chunk -> accepted
  var file3 = cat(long.subarray(0, 8 * MiB - 1), bytesOf("\n"), bytesOf("b\n"));
  var r3 = run(fixedChunking(file3, 8 * MiB));
  assert.ok(r3.result, "accepted: " + JSON.stringify(r3.refused));
  assert.equal(r3.result.lines, 2); assert.equal(r3.result.longestLineBytes, 8 * MiB - 1); assert.equal(r3.result.overLongLines, 1); assert.equal(r3.result.residual, 0);
  // (d) a CRLF long line
  var file4 = cat(bytesOf("a\n"), long, bytesOf("\r\n"));
  var r4 = run(fixedChunking(file4, 8 * MiB)).result;
  assert.equal(r4.lines, 2); assert.equal(r4.crlfLines, 1); assert.equal(r4.longestLineBytes, LONG); assert.equal(r4.bytes, file4.length); assert.equal(r4.residual, 0);
});

test("a 200 KB line arriving one byte at a time is linear (under 500 ms) and exact", function () {
  var N = 200000, i, lines, t0 = Date.now();
  var sp = R.createSplitter(), one = new Uint8Array([0x61]);
  var got = [];
  var onLine = function (lb, bl, cr) { got.push([lb.length, bl, cr]); };
  for (i = 0; i < N; i++) sp.push(one, onLine);
  sp.push(new Uint8Array([10]), onLine);
  sp.flush(onLine);
  var dt = Date.now() - t0;
  assert.deepEqual(got, [[N, N + 1, false]]);
  assert.ok(dt < 500, "took " + dt + " ms");
  console.log("  [info] 200,000 one-byte pushes: " + dt + " ms");
});

/* ---------- invalid UTF-8 counting ---------- */
test("invalid UTF-8 counting: hand-made cases equal TextDecoder, with and without text", function () {
  var cases = [
    { b: bytesOf("plain ascii"), bad: false },
    { b: bytesOf("€"), bad: false },
    { b: bytesOf("😀"), bad: false },
    { b: bytesOf("é"), bad: false },
    { b: new Uint8Array([0x61, 0xFF, 0x62]), bad: true },            // stray FF
    { b: new Uint8Array([0x61, 0xE2, 0x82]), bad: true },            // truncated 3-byte at EOL
    { b: new Uint8Array([0xC0, 0x80]), bad: true },                  // overlong 2-byte
    { b: new Uint8Array([0xED, 0xA0, 0x80]), bad: true },            // surrogate
    { b: new Uint8Array([0xF5, 0x80, 0x80, 0x80]), bad: true },      // lead > F4
    { b: new Uint8Array([0xEF, 0xBF, 0xBD]), bad: false },           // a literal U+FFFD is valid UTF-8: the writer put it there
    { b: new Uint8Array([0xE0, 0x80, 0x80]), bad: true },            // overlong 3-byte
    { b: new Uint8Array([0xF0, 0x80, 0x80, 0x80]), bad: true },      // overlong 4-byte
    { b: new Uint8Array([0xF4, 0x90, 0x80, 0x80]), bad: true },      // > U+10FFFF
    { b: new Uint8Array([0x61, 0xC2]), bad: true },                  // truncated 2-byte at EOL
    { b: new Uint8Array([0x80]), bad: true },                        // lone continuation
    { b: new Uint8Array([0xE2, 0x82, 0x41]), bad: true },            // 3-byte broken by ASCII
    { b: new Uint8Array([0xF0, 0x9F, 0x98]), bad: true },            // truncated 4-byte
    { b: new Uint8Array([0xEF, 0xBB, 0xBF, 0x61]), bad: false },     // leading BOM inside a line: valid
    { b: new Uint8Array([0xC2, 0x80]), bad: false },                 // U+0080 valid
    { b: new Uint8Array([0xDF, 0xBF]), bad: false },
    { b: new Uint8Array([0xE0, 0xA0, 0x80]), bad: false },
    { b: new Uint8Array([0xED, 0x9F, 0xBF]), bad: false },
    { b: new Uint8Array([0xF0, 0x90, 0x80, 0x80]), bad: false },
    { b: new Uint8Array([0xF4, 0x8F, 0xBF, 0xBF]), bad: false },
    { b: new Uint8Array([0xEF, 0xBF, 0xBE]), bad: false },           // U+FFFE valid
    { b: new Uint8Array([0xEF, 0xBF, 0xBC]), bad: false },           // U+FFFC valid
  ];
  var expected = 0, i, st1 = R.createStats(), st2 = R.createStats();
  for (i = 0; i < cases.length; i++) {
    var td = isBad(cases[i].b);
    assert.equal(td, cases[i].bad, "my own expectation agrees with TextDecoder, case " + i);
    if (td) expected++;
    st1.add(cases[i].b, cases[i].b.length + 1, false);
    st2.add(cases[i].b, cases[i].b.length + 1, false, TD.decode(cases[i].b));
    var one = R.createStats(); one.add(cases[i].b, cases[i].b.length + 1, false);
    assert.equal(one.result().undecodableLines, td ? 1 : 0, "case " + i + " bytes " + Array.from(cases[i].b).map(function (x) { return x.toString(16); }).join(" "));
  }
  assert.equal(st1.result().undecodableLines, expected, "byte path");
  assert.equal(st2.result().undecodableLines, expected, "text path");
  // through the whole pipeline, as a file
  var parts = [];
  for (i = 0; i < cases.length; i++) { parts.push(cases[i].b); parts.push(new Uint8Array([10])); }
  var file = cat.apply(null, parts);
  var r = run([file]).result;
  assert.equal(r.undecodableLines, expected);
  assert.deepEqual(run(fixedChunking(file, 1)).result, r);
  assert.deepEqual(run(fixedChunking(file, 2)).result, r);
  assert.deepEqual(run(fixedChunking(file, 3)).result, r);
});

test("invalid UTF-8 counting: 30,000 random short byte strings equal TextDecoder (byte path and text path)", function () {
  var rand = rng(4242), i, j, n, b, td, st, k;
  for (i = 0; i < 30000; i++) {
    n = 1 + Math.floor(rand() * 14);
    b = new Uint8Array(n);
    for (j = 0; j < n; j++) {
      var r = rand();
      if (r < 0.45) b[j] = 0x80 + Math.floor(rand() * 128);
      else if (r < 0.55) b[j] = [0xC2, 0xDF, 0xE0, 0xED, 0xEF, 0xF0, 0xF4, 0xBF, 0xBD, 0x80, 0x9F, 0xA0, 0x8F, 0x90, 0xC0, 0xC1, 0xF5, 0xFF][Math.floor(rand() * 18)];
      else b[j] = Math.floor(rand() * 128);
      if (b[j] === 10) b[j] = 32;
    }
    td = isBad(b) ? 1 : 0;
    st = R.createStats(); st.add(b, n + 1, false);
    assert.equal(st.result().undecodableLines, td, "byte path, bytes " + Array.from(b).map(function (x) { return x.toString(16); }).join(" "));
    st = R.createStats(); st.add(b, n + 1, false, TD.decode(b));
    assert.equal(st.result().undecodableLines, td, "text path");
    // the same bytes at an odd offset inside a bigger buffer (alignment paths)
    k = 1 + Math.floor(rand() * 7);
    var big = new Uint8Array(n + k + 5); big.set(b, k);
    st = R.createStats(); st.add(big.subarray(k, k + n), n + 1, false);
    assert.equal(st.result().undecodableLines, td, "byte path at offset " + k);
  }
});

test("invalid UTF-8 inside long lines (word-scan paths): high byte at every position of a 70-byte line, at every offset", function () {
  var n, pos, off, buf, line, st, td;
  for (n = 16; n <= 70; n += 9) for (off = 0; off < 8; off++) for (pos = 0; pos < n; pos++) {
    buf = new Uint8Array(n + 16); buf.fill(0x61);
    line = buf.subarray(off, off + n);
    line[pos] = 0xFF;
    st = R.createStats(); st.add(line, n + 1, false);
    assert.equal(st.result().undecodableLines, 1, "FF at " + pos + " of " + n + " at offset " + off);
    line[pos] = 0xC3; if (pos + 1 < n) line[pos + 1] = 0xA9;
    td = isBad(line) ? 1 : 0;
    st = R.createStats(); st.add(line, n + 1, false);
    assert.equal(st.result().undecodableLines, td, "C3 A9 at " + pos + " of " + n + " at offset " + off);
  }
});

/* ---------- decodeLine ---------- */
test("decodeLine: shared decoder, non-fatal, whole lines", function () {
  assert.equal(R.decodeLine(bytesOf("héllo € 😀")), "héllo € 😀");
  assert.equal(R.decodeLine(new Uint8Array([0x61, 0xFF, 0x62])), "a�b");
  assert.equal(R.decodeLine(new Uint8Array(0)), "");
  var withBom = R.decodeLine(new Uint8Array([0xEF, 0xBB, 0xBF, 0x61]));
  console.log("  [info] decodeLine keeps a leading U+FEFF inside a line: " + (withBom === "﻿a") + " (ignoreBOM " + (withBom === "﻿a" ? "true" : "false/default") + ")");
  // decoding twice in a row must not carry state between lines (no stream mode leak)
  R.decodeLine(new Uint8Array([0xE2, 0x82]));
  assert.equal(R.decodeLine(new Uint8Array([0xAC])), "�", "no streaming state leaks between calls");
  assert.equal(R.decodeLine(bytesOf("ok")), "ok");
});

/* ---------- refusal codes ---------- */
test("sniff: every refusal code, precedence, boundaries, and what must be accepted", function () {
  function code(bytes, size) { var s = R.sniff(bytes, size === undefined ? bytes.length : size); return s.ok ? "ok" : s.code; }
  function msg(bytes, size) { return R.sniff(bytes, size === undefined ? bytes.length : size).message; }
  var codes = {};
  // empty
  assert.equal(code(new Uint8Array(0), 0), "empty"); codes.empty = msg(new Uint8Array(0), 0);
  // utf16 both orders
  assert.equal(code(new Uint8Array([0xFF, 0xFE, 0x61, 0x00, 0x0A, 0x00])), "utf16"); codes.utf16 = msg(new Uint8Array([0xFF, 0xFE, 0x61, 0x00]));
  assert.equal(code(new Uint8Array([0xFE, 0xFF, 0x00, 0x61, 0x00, 0x0A])), "utf16");
  // gzip
  assert.equal(code(new Uint8Array([0x1F, 0x8B, 0x08, 0x00, 0x0A])), "gzip"); codes.gzip = msg(new Uint8Array([0x1F, 0x8B, 0x08]));
  // zip
  assert.equal(code(new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0x0A, 0x61])), "zip"); codes.zip = msg(new Uint8Array([0x50, 0x4B, 0x03, 0x04]));
  // 'PK' without 03 04 is text (e.g. a log line starting with PK)
  assert.equal(code(bytesOf("PK\x05\x06 is the end-of-central-directory magic, but two control bytes in a long text line is text\n")), "ok");
  assert.equal(code(bytesOf("PKZIP line\n")), "ok");
  // binary: NUL in the first 8 KiB
  var nul = bytesOf("good text line\n"); nul = cat(nul, new Uint8Array([0]), bytesOf("\nmore\n"));
  assert.equal(code(nul), "binary"); codes.binary = msg(nul);
  // NUL at byte 8191 is binary, at byte 8192 it is one control byte among many: accepted
  var big = new Uint8Array(20000); big.fill(0x61); for (var i = 99; i < 20000; i += 100) big[i] = 10;
  var b1 = new Uint8Array(big); b1[8191] = 0; assert.equal(code(b1), "binary", "NUL at 8191");
  var b2 = new Uint8Array(big); b2[8192] = 0; assert.equal(code(b2), "ok", "NUL at 8192 is past the 8 KiB window");
  // binary: more than 10% control bytes in the first 64 KiB, no NUL
  var ctl = new Uint8Array(65536); ctl.fill(0x61); for (i = 0; i < 65536; i += 9) ctl[i] = 0x01; ctl[65535] = 10;  // 7282/65536 = 11.1%
  assert.equal(code(ctl), "binary", "11% control bytes");
  // exactly 10% is not 'more than 10%': accepted
  var ten = new Uint8Array(1000); ten.fill(0x61); for (i = 0; i < 100; i++) ten[i * 10] = 0x01; ten[999] = 10;
  assert.equal(code(ten), "ok", "exactly 10% control is accepted");
  var eleven = new Uint8Array(1000); eleven.fill(0x61); for (i = 0; i < 101; i++) eleven[i * 9] = 0x01; eleven[999] = 10;
  assert.equal(code(eleven), "binary", "10.1% control is refused");
  // 0x7F counts as non-printable
  var del = new Uint8Array(100); del.fill(0x7F); del[99] = 10; assert.equal(code(del), "binary", "DEL counts");
  // high bytes do not count
  var hi = new Uint8Array(100); hi.fill(0xE9); hi[99] = 10; assert.equal(code(hi), "ok", "bytes >= 0x80 are text");
  // tab, CR, LF do not count
  var ws = new Uint8Array(100); for (i = 0; i < 100; i++) ws[i] = [9, 13, 10][i % 3]; assert.equal(code(ws), "ok");
  // ESC: the spec counts it as control; record what each impl does
  var esc = new Uint8Array(100); esc.fill(0x61); for (i = 0; i < 20; i++) esc[i * 5] = 0x1B; esc[99] = 10;
  console.log("  [info] 20% ESC bytes (ANSI colours): " + code(esc) + "  (spec-literal: binary; pragmatic: ok)");
  // the ratio uses the window actually present: a 10-byte file with 2 control bytes is 20% -> binary
  assert.equal(code(new Uint8Array([1, 1, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 10])), "binary");
  // no-newline: fileSize > bytes.length and no LF
  var line = new Uint8Array(1000); line.fill(0x61);
  assert.equal(code(line, 5000), "no-newline"); codes["no-newline"] = msg(line, 5000);
  assert.equal(code(line, 1000), "ok", "small file without newline is one line");
  assert.equal(code(line), "ok", "fileSize omitted means the whole file");
  var lineLF = new Uint8Array(line); lineLF[500] = 10; assert.equal(code(lineLF, 5000), "ok", "a LF anywhere in the chunk is enough");
  var crOnly = new Uint8Array(1000); crOnly.fill(13); assert.equal(code(crOnly, 5000), "no-newline", "CR-only big file has no line break");
  assert.equal(code(crOnly, 1000), "ok", "CR-only small file is one line");
  // precedence: utf16 before binary (UTF-16 is full of NULs), gzip before binary
  assert.equal(code(cat(new Uint8Array([0xFF, 0xFE]), new Uint8Array(100))), "utf16");
  assert.equal(code(cat(new Uint8Array([0x1F, 0x8B]), new Uint8Array(100))), "gzip");
  // empty beats everything
  assert.equal(code(new Uint8Array(0), 0), "empty");
  // BOM reported, and a BOM file with no newline but larger than the chunk is no-newline
  assert.deepEqual(R.sniff(new Uint8Array([0xEF, 0xBB, 0xBF, 0x61, 0x0A]), 5), { ok: true, bomBytes: 3 });
  assert.equal(code(new Uint8Array([0xEF, 0xBB, 0xBF, 0x61]), 4), "ok");
  assert.equal(code(new Uint8Array([0xEF, 0xBB, 0xBF, 0x61]), 40), "no-newline");
  // UTF-16 without a mark: NULs -> binary
  assert.equal(code(new Uint8Array([0x61, 0, 0x62, 0, 0x0A, 0])), "binary");
  // every message is a plain sentence: ends with a period, has a remedy verb
  Object.keys(codes).forEach(function (k) {
    var m = codes[k];
    assert.equal(typeof m, "string", k);
    assert.ok(/\.$/.test(m.trim()), k + " ends with a period: " + m);
    assert.ok(m.indexOf("!") < 0, k + " has no exclamation mark");
    assert.ok(/(convert|try again|choose|pick|split|decompress|uncompress|unzip|gunzip|export)/i.test(m), k + " names a remedy: " + m);
  });
  assert.deepEqual(Object.keys(codes).sort(), ["binary", "empty", "gzip", "no-newline", "utf16", "zip"]);
  // runChunks path reports the same codes
  assert.equal(run([new Uint8Array(0)]).refused.code, "empty");
  assert.equal(run([new Uint8Array([0xFF, 0xFE, 0x61, 0x00])]).refused.code, "utf16");
  assert.equal(run([new Uint8Array([0x1F, 0x8B, 0x08])]).refused.code, "gzip");
  assert.equal(run([new Uint8Array([0x50, 0x4B, 0x03, 0x04])]).refused.code, "zip");
  assert.equal(run([nul]).refused.code, "binary");
  assert.equal(run(fixedChunking(nul, 1)).refused.code, "binary", "binary at chunk size 1 (sniff sees the stream, not the chunk)");
  assert.equal(run([ctl]).refused.code, "binary");
  assert.equal(run([line, line], { sniffBytes: 1000 }).refused.code, "no-newline");
  assert.ok(run([line]).result, "small single line accepted through runChunks");
});

/* ---------- zero-copy ---------- */
test("zero-copy: a line inside a chunk is a view on the chunk's buffer at the right offset; a crossing line is not a view on either chunk", function () {
  // chunks carved from a bigger buffer at a non-zero offset, to catch byteOffset mistakes
  var backing = new Uint8Array(200);
  var text = bytesOf("first\nsecond\r\nthi");
  backing.set(text, 17);
  var c1 = backing.subarray(17, 17 + text.length);
  var c2 = bytesOf("rd\nfourth\n");
  var c3 = bytesOf("tail-no-newline");
  var sp = R.createSplitter(), seen = [], cur;
  var onLine = function (lb, bl, cr) { seen.push({ lb: lb, bl: bl, cr: cr, chunk: cur }); };
  cur = c1; sp.push(c1, onLine);
  var c1Lines = seen.slice();
  assert.equal(c1Lines.length, 2);
  assert.strictEqual(c1Lines[0].lb.buffer, c1.buffer, "line 1 shares the chunk's ArrayBuffer");
  assert.equal(c1Lines[0].lb.byteOffset, c1.byteOffset + 0, "line 1 offset");
  assert.equal(c1Lines[0].lb.length, 5);
  assert.strictEqual(c1Lines[1].lb.buffer, c1.buffer, "line 2 (CRLF, CR stripped) shares the chunk's ArrayBuffer");
  assert.equal(c1Lines[1].lb.byteOffset, c1.byteOffset + 6, "line 2 offset");
  assert.equal(c1Lines[1].lb.length, 6); assert.equal(c1Lines[1].bl, 8); assert.equal(c1Lines[1].cr, true);
  cur = c2; sp.push(c2, onLine);
  assert.equal(seen.length, 4);
  var crossing = seen[2];
  assert.equal(TD.decode(crossing.lb), "third"); assert.equal(crossing.bl, 6);
  assert.notStrictEqual(crossing.lb.buffer, c1.buffer, "crossing line is not pinned to chunk 1");
  assert.notStrictEqual(crossing.lb.buffer, c2.buffer, "crossing line is not a view on chunk 2");
  var after = seen[3];
  assert.strictEqual(after.lb.buffer, c2.buffer, "the line after a crossing is zero-copy again");
  assert.equal(after.lb.byteOffset, c2.byteOffset + 3);
  assert.equal(TD.decode(after.lb), "fourth");
  cur = c3; sp.push(c3, onLine);
  assert.equal(seen.length, 4, "no LF: nothing emitted yet");
  sp.flush(onLine);
  assert.equal(seen.length, 5);
  assert.equal(TD.decode(seen[4].lb), "tail-no-newline"); assert.equal(seen[4].bl, 15); assert.equal(seen[4].cr, false);
  // a bulk check: a 64 KiB chunk of 500 lines, every line a view on the chunk
  var lines = [], i;
  for (i = 0; i < 500; i++) lines.push("line number " + i + (i % 3 ? "\n" : "\r\n"));
  var chunk = bytesOf(lines.join(""));
  var hold = new Uint8Array(chunk.length + 64); hold.set(chunk, 33); chunk = hold.subarray(33, 33 + chunk.length);
  var sp2 = R.createSplitter(), count = 0, pos = 0;
  sp2.push(chunk, function (lb, bl, cr) {
    assert.strictEqual(lb.buffer, chunk.buffer, "line " + count);
    assert.equal(lb.byteOffset, chunk.byteOffset + pos, "line " + count + " offset");
    pos += bl; count++;
  });
  assert.equal(count, 500); assert.equal(pos, chunk.length);
  // the allocation claim: after the carry has grown once, boundaries allocate nothing new (observed via buffer identity of crossing lines)
  var sp3 = R.createSplitter(), bufs = [];
  var ch = [bytesOf("abc"), bytesOf("def\nghi"), bytesOf("jkl\nmno"), bytesOf("pqr\n")];
  for (i = 0; i < ch.length; i++) sp3.push(ch[i], function (lb) { bufs.push(lb.buffer); });
  assert.equal(bufs.length, 3);
  assert.strictEqual(bufs[0], bufs[1], "the carry buffer is reused across boundaries");
  assert.strictEqual(bufs[1], bufs[2]);
});

/* ---------- stats semantics ---------- */
test("stats: longest/over-long on content; empty CRLF line counts empty and crlf; residual arithmetic; setBom/setBytesRead", function () {
  var st = R.createStats();
  st.add(new Uint8Array(0), 2, true);               // "\r\n"
  st.add(bytesOf("abc"), 4, false);                 // "abc\n"
  var big = new Uint8Array(64000); big.fill(0x61); st.add(big, 64002, true);        // exactly 64 KB: not over
  var bigger = new Uint8Array(64001); bigger.fill(0x61); st.add(bigger, 64002, false); // 64 KB + 1 byte: over
  st.add(new Uint8Array([0xFF]), 1, false);         // last line, no LF, invalid
  st.setBom(3); st.setBytesRead(3 + 2 + 4 + 64002 + 64002 + 1);
  var r = st.result();
  assert.equal(r.lines, 5); assert.equal(r.bytes, 2 + 4 + 64002 + 64002 + 1);
  assert.equal(r.crlfLines, 2); assert.equal(r.emptyLines, 1); assert.equal(r.undecodableLines, 1);
  assert.equal(r.longestLineBytes, 64001); assert.equal(r.overLongLines, 1);
  assert.equal(r.bomBytes, 3); assert.equal(r.residual, 0);
  st.setBytesRead(r.bytesRead + 7);
  assert.equal(st.result().residual, 7, "a missing 7 bytes shows as residual 7");
  // text path and byte path agree on undecodable for the same lines
  var a = statsOfLines([bytesOf("ok"), new Uint8Array([0xFF]), bytesOf("€")], false);
  var b = statsOfLines([bytesOf("ok"), new Uint8Array([0xFF]), bytesOf("€")], true);
  assert.deepEqual(a, b);
  assert.equal(a.undecodableLines, 1);
});

test("runChunks: results identical at chunk sizes 1, 2, 3, 5, 7, 64, 4096, 8 MiB on a mixed 300 KB file", function () {
  var rand = rng(99), parts = [], i, n;
  for (i = 0; i < 2500; i++) {
    n = Math.floor(rand() * 200);
    var s = "", j;
    for (j = 0; j < n; j++) s += String.fromCharCode(0x20 + Math.floor(rand() * 95));
    if (i % 17 === 0) s += "€ café 😀";
    parts.push(bytesOf(s));
    if (i % 13 === 0) parts.push(new Uint8Array([0xFF, 0xFE]));
    if (i % 29 === 0) parts.push(new Uint8Array([13]));
    parts.push(i % 4 === 0 ? bytesOf("\r\n") : bytesOf("\n"));
  }
  var longLine = new Uint8Array(100000); longLine.fill(0x7A); parts.push(longLine); parts.push(bytesOf("\n"));
  parts.push(bytesOf("\n\n\r\n"));
  parts.push(bytesOf("last line no newline\r"));
  var file = cat.apply(null, [new Uint8Array([0xEF, 0xBB, 0xBF])].concat(parts));
  var ref = refStats(file, 3);
  var base = run([file]).result;
  assert.deepEqual(base, ref);
  [1, 2, 3, 5, 7, 64, 4096, 8 * MiB].forEach(function (size) {
    assert.deepEqual(run(fixedChunking(file, size)).result, base, "chunk size " + size);
  });
  assert.equal(base.residual, 0);
  assert.ok(base.overLongLines === 1 && base.longestLineBytes === 100000);
});
