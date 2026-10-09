"use strict";
/* drain.test.js: the Drain port against Drain3's own tests, then against
   Drain3 itself on the profiler's fixtures.

     node test/drain.test.js [dir]

   The first part is tests/test_drain.py from logpai/Drain3 (MIT), carried
   over with its strings and expectations unchanged. The second feeds every
   accepted fixture in dir (default: the folder reader.test.js uses) to this
   port and to Drain3 through drain-oracle.py, with and without a cluster
   cap, and the two sets of (template, size) must be identical, eviction
   order included. The oracle needs uv (https://docs.astral.sh/uv/); when it
   is not installed those tests are skipped and say so. */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var cp = require("node:child_process");

var LCDrain = require("../drain.js");
var LCReader = require("../reader.js");

var DIR = process.argv[2] || process.env.LC_TEST_DIR || path.join(os.tmpdir(), "logcaliper-profiler-test");

/* The Python tests feed str.splitlines() of a triple-quoted string: the
   first line is empty and the last is indentation only, and Drain3 takes
   both (an empty cluster of size 2 is why its totals say 8 for six lines).
   The entries are fed as Python feeds them; the expectations are compared
   trimmed, as the Python compares them. */
function lines(s) { return s.split("\n"); }
function trimmed(a) { return a.map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; }); }

function run(model, entries) {
  var out = entries.map(function (e) { return model.template(model.add(e).cluster); });
  return trimmed(out);
}

/* ---- tests/test_drain.py ---- */

test("drain3: add_shorter_than_depth_message", function () {
  var m = LCDrain.createDrain({ depth: 4 });
  assert.equal(m.add("hello").change, "cluster_created");
  assert.equal(m.add("hello").change, "none");
  assert.equal(m.add("otherword").change, "cluster_created");
  assert.equal(m.count(), 2);
});

var SSH = lines("\n\
  Dec 10 07:07:38 LabSZ sshd[24206]: input_userauth_request: invalid user test9 [preauth]\n\
  Dec 10 07:08:28 LabSZ sshd[24208]: input_userauth_request: invalid user webmaster [preauth]\n\
  Dec 10 09:12:32 LabSZ sshd[24490]: Failed password for invalid user ftpuser from 0.0.0.0 port 62891 ssh2\n\
  Dec 10 09:12:35 LabSZ sshd[24492]: Failed password for invalid user pi from 0.0.0.0 port 49289 ssh2\n\
  Dec 10 09:12:44 LabSZ sshd[24501]: Failed password for invalid user ftpuser from 0.0.0.0 port 60836 ssh2\n\
  Dec 10 07:28:03 LabSZ sshd[24245]: input_userauth_request: invalid user pgadmin [preauth]\n");

test("drain3: add_log_message", function () {
  var m = LCDrain.createDrain();
  assert.deepEqual(run(m, SSH), trimmed(lines("\n\
    Dec 10 07:07:38 LabSZ sshd[24206]: input_userauth_request: invalid user test9 [preauth]\n\
    Dec 10 <*> LabSZ <*> input_userauth_request: invalid user <*> [preauth]\n\
    Dec 10 09:12:32 LabSZ sshd[24490]: Failed password for invalid user ftpuser from 0.0.0.0 port 62891 ssh2\n\
    Dec 10 <*> LabSZ <*> Failed password for invalid user <*> from 0.0.0.0 port <*> ssh2\n\
    Dec 10 <*> LabSZ <*> Failed password for invalid user <*> from 0.0.0.0 port <*> ssh2\n\
    Dec 10 <*> LabSZ <*> input_userauth_request: invalid user <*> [preauth]\n")));
  assert.equal(m.totalSize(), 8);
});

test("drain3: add_log_message_sim_75", function () {
  var m = LCDrain.createDrain({ depth: 4, simTh: 0.75, maxChildren: 100 });
  assert.deepEqual(run(m, SSH), trimmed(lines("\n\
    Dec 10 07:07:38 LabSZ sshd[24206]: input_userauth_request: invalid user test9 [preauth]\n\
    Dec 10 07:08:28 LabSZ sshd[24208]: input_userauth_request: invalid user webmaster [preauth]\n\
    Dec 10 09:12:32 LabSZ sshd[24490]: Failed password for invalid user ftpuser from 0.0.0.0 port 62891 ssh2\n\
    Dec 10 <*> LabSZ <*> Failed password for invalid user <*> from 0.0.0.0 port <*> ssh2\n\
    Dec 10 <*> LabSZ <*> Failed password for invalid user <*> from 0.0.0.0 port <*> ssh2\n\
    Dec 10 07:28:03 LabSZ sshd[24245]: input_userauth_request: invalid user pgadmin [preauth]\n")));
  assert.equal(m.totalSize(), 8);
});

test("drain3: max_clusters", function () {
  var m = LCDrain.createDrain({ maxClusters: 1 });
  assert.deepEqual(run(m, ["A format 1", "A format 2", "B format 1", "B format 2", "A format 3"]),
    ["A format 1", "A format <*>", "B format 1", "B format <*>", "A format 3"]);
  assert.equal(m.totalSize(), 1);
});

test("drain3: max_clusters_lru_multiple_leaf_nodes", function () {
  var m = LCDrain.createDrain({ maxClusters: 2, depth: 4, paramStr: "*" });
  assert.deepEqual(run(m, ["A A A", "A A B", "B A A", "B A B", "C A A", "C A B", "B A A", "A A A"]),
    ["A A A", "A A *", "B A A", "B A *", "C A A", "C A *", "B A *", "A A A"]);
  assert.equal(m.totalSize(), 4);
});

test("drain3: max_clusters_lru_single_leaf_node", function () {
  var m = LCDrain.createDrain({ maxClusters: 2, depth: 4, paramStr: "*" });
  assert.deepEqual(run(m, ["A A A", "A A B", "A B A", "A B B", "A C A", "A C B", "A B A", "A A A"]),
    ["A A A", "A A *", "A B A", "A B *", "A C A", "A C *", "A B *", "A A A"]);
});

test("drain3: match_only", function () {
  var m = LCDrain.createDrain();
  m.add("aa aa aa"); m.add("aa aa bb"); m.add("aa aa cc"); m.add("xx yy zz");
  assert.equal(m.match("aa aa tt").id, 1);
  assert.equal(m.match("xx yy zz").id, 2);
  assert.equal(m.match("xx yy rr"), null);
  assert.equal(m.match("nothing"), null);
  assert.equal(m.match("aa aa tt", "fallback").id, 1);
  assert.equal(m.match("aa aa tt", "always").id, 1);
  assert.throws(function () { m.match("x", "sometimes"); });
});

/* ---- what the port adds ---- */

test("bytes follow the lines into their cluster; evicted clusters are handed over with both", function () {
  var gone = [];
  var m = LCDrain.createDrain({ maxClusters: 2, onEvict: function (c) { gone.push({ template: m.template(c), size: c.size, bytes: c.bytes }); } });
  m.add("A A A", 10); m.add("A A B", 11);   // cluster 1: 2 lines, 21 bytes
  m.add("B A A", 5);                        // cluster 2
  m.add("C A A", 7);                        // evicts cluster 1, the least recently used
  assert.deepEqual(gone, [{ template: "A A <*>", size: 2, bytes: 21 }]);
  assert.equal(m.evicted(), 1);
  assert.equal(m.count(), 2);
  var total = 0;
  m.clusters().forEach(function (c) { total += c.bytes; });
  assert.equal(total, 12);
});

test("a touch makes a cluster most recently used; a candidate not chosen is not touched", function () {
  var m = LCDrain.createDrain({ maxClusters: 2 });
  m.add("A A A");        // 1
  m.add("B B B");        // 2; order 1, 2
  m.add("A A C");        // joins 1; order 2, 1
  m.add("C C C");        // 3 evicts 2
  assert.deepEqual(m.clusters().map(function (c) { return c.id; }), [1, 3]);
});

test("the empty line is its own cluster, with the token count zero", function () {
  var m = LCDrain.createDrain();
  assert.equal(m.add("").change, "cluster_created");
  assert.equal(m.add("   ").change, "none");
  assert.equal(m.template(m.clusters()[0]), "");
  assert.equal(m.add("x").change, "cluster_created");
  assert.equal(m.count(), 2);
});

test("tokens: trimmed, split on runs of whitespace, extra delimiters become spaces", function () {
  var m = LCDrain.createDrain({ extraDelimiters: ["_", "="] });
  assert.deepEqual(m.tokensOf("  a\tb  c d  "), ["a", "b", "c", "d"]);
  assert.deepEqual(m.tokensOf("key=value under_score"), ["key", "value", "under", "score"]);
  assert.deepEqual(m.tokensOf("_a b_"), ["a", "b"], "a delimiter at either end leaves no empty token, as in drain.py");
  assert.deepEqual(m.tokensOf(""), []);
  assert.deepEqual(m.tokensOf("_"), []);
  assert.ok(LCDrain.hasNumbers("sshd[24206]:") && !LCDrain.hasNumbers("sshd") && !LCDrain.hasNumbers(""));
});

test("tokens that are object property names are tokens", function () {
  var m = LCDrain.createDrain();
  ["__proto__ x y", "constructor x y", "hasOwnProperty x y", "__proto__ x z", "toString a b", "valueOf a b"].forEach(function (l) { m.add(l); });
  var t = m.clusters().map(function (c) { return m.template(c); });
  assert.deepEqual(t, ["__proto__ x <*>", "constructor x y", "hasOwnProperty x y", "toString a b", "valueOf a b"]);
});

test("maxChildren: the last slot of a node goes to the wildcard, and later tokens share it", function () {
  var m = LCDrain.createDrain({ maxChildren: 3 });
  m.add("a x y"); m.add("b x y");   // two children of the count-3 node
  m.add("c x y");                   // third would fill it: the wildcard is made instead
  m.add("d x y");                   // follows the wildcard
  var t = m.clusters().map(function (c) { return m.template(c); });
  assert.deepEqual(t, ["a x y", "b x y", "<*> x y"]);
});

test("numeric tokens take the wildcard branch, so two pids share a leaf", function () {
  var m = LCDrain.createDrain();
  m.add("sshd[100]: Accepted publickey for root");
  m.add("sshd[200]: Accepted publickey for deploy");
  assert.equal(m.count(), 1);
  assert.equal(m.template(m.clusters()[0]), "<*> Accepted publickey for <*>");
});

test("maxTokens: a long line is clustered on its first words, the rest standing as one closing token", function () {
  var m = LCDrain.createDrain({ maxTokens: 5 }), i, words = [];
  for (i = 0; i < 20; i++) words.push("w" + i);
  assert.deepEqual(m.tokensOf(words.join(" ")), ["w0", "w1", "w2", "w3", "w4", "\u2026"]);
  assert.deepEqual(m.tokensOf("a b c d e"), ["a", "b", "c", "d", "e"]);
  m.add(words.join(" ")); m.add(words.slice(0, 12).join(" ") + " x y z");
  assert.equal(m.count(), 1, "two long lines with the same head share a cluster");
  assert.equal(m.template(m.clusters()[0]), "w0 w1 w2 w3 w4 \u2026");
  var n = LCDrain.createDrain();
  assert.equal(n.tokensOf(words.join(" ")).length, 20, "no cap by default");
});

test("onEvict is called once the new cluster is in place, and a re-entrant add does not loop", function () {
  var seen = [], m;
  m = LCDrain.createDrain({ maxClusters: 1, onEvict: function (c) { seen.push({ gone: m.template(c), live: m.count(), has: m.clusters().length }); m.add("x y"); } });
  m.add("a b"); m.add("c d");
  assert.deepEqual(seen.map(function (s) { return s.gone; }), ["a b", "c d"], "the callback's own add evicts in turn, once");
  assert.ok(seen.every(function (s) { return s.live === 1 && s.has === 1; }), "the model is whole inside the callback");
  assert.equal(m.count(), 1);
});

test("bytes given as a string are added as a number", function () {
  var m = LCDrain.createDrain();
  m.add("a b", "7"); m.add("a b", "7");
  assert.equal(m.clusters()[0].bytes, 14);
});

test("options are checked", function () {
  assert.throws(function () { LCDrain.createDrain({ depth: 2 }); });
  assert.throws(function () { LCDrain.createDrain({ maxChildren: 0 }); });
});

/* ---- against Drain3 itself ---- */

/* The worker's own feeding rules, over the whole file. */
function feed(bytes, model) {
  var r = { fed: 0 }, sp = LCReader.createSplitter();
  var bom = (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) ? 3 : 0;
  var onLine = function (lb, bl, cr, full) {
    if (full === 0 || full > LCReader.OVER_LONG_BYTES) return;
    model.add(LCReader.decodeLine(lb), full);
    r.fed++;
  };
  sp.push(bytes.subarray(bom), onLine);
  sp.flush(onLine);
  return r;
}

function oracle(file, cap) {
  var args = ["run", "--with", "drain3", "python", "-I", path.join(__dirname, "drain-oracle.py"), file];
  if (cap) args.push(String(cap));
  var p = cp.spawnSync("uv", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (p.error || p.status !== 0) throw new Error("drain-oracle.py failed: " + (p.error ? p.error.message : p.stderr));
  return JSON.parse(p.stdout);
}

function key(rows) {
  return rows.map(function (c) { return c.size + "\t" + c.template; }).sort();
}

var haveUv = !cp.spawnSync("uv", ["--version"]).error;
var fixtures = ["lf.log", "crlf.log", "bom.log", "nonl.log", "mixed.log", "oneline.log"].filter(function (f) {
  return fs.existsSync(path.join(DIR, f));
});

test("Drain3 oracle: fixtures present and uv installed", { skip: !haveUv ? "uv is not installed: the Drain3 comparison is skipped" : (fixtures.length === 0 ? "no fixtures in " + DIR + ": run reader.test.js first" : false) }, function () {
  assert.ok(fixtures.length > 0);
});

fixtures.forEach(function (name) {
  [0, 40].forEach(function (cap) {
    test("Drain3 oracle: " + name + (cap ? " with a cap of " + cap : ""), { skip: !haveUv }, function () {
      var file = path.join(DIR, name);
      var b = fs.readFileSync(file);
      var bytes = new Uint8Array(b.buffer, b.byteOffset, b.length);
      var evictedRows = [];
      var m = LCDrain.createDrain({ maxClusters: cap || null, onEvict: function (c) { evictedRows.push(c); } });
      var fed = feed(bytes, m).fed;
      var o = oracle(file, cap);
      assert.equal(fed, o.fed, "the same lines were fed");
      assert.equal(m.clusters().length + m.evicted(), o.created, "the same number of clusters founded");
      var mine = m.clusters().map(function (c) { return { template: m.template(c), size: c.size }; });
      assert.deepEqual(key(mine), key(o.clusters), "the same templates with the same sizes");
      /* cachetools lists a capped model's clusters in insertion order and
         this port in use order, so only the set of survivors is compared. */
      var sortIds = function (rows) { return rows.map(function (c) { return c.id; }).sort(function (a, b) { return a - b; }); };
      assert.deepEqual(sortIds(m.clusters()), sortIds(o.clusters), "the same clusters survive");
      var held = 0;
      m.clusters().forEach(function (c) { held += c.size; });
      evictedRows.forEach(function (c) { held += c.size; });
      assert.equal(held, fed, "every line fed is in a live cluster or an evicted one");
    });
  });
});

test("big.log: a hundred megabytes templated in bounded time, every line accounted for", { skip: !fs.existsSync(path.join(DIR, "big.log")) }, function () {
  var b = fs.readFileSync(path.join(DIR, "big.log"));
  var bytes = new Uint8Array(b.buffer, b.byteOffset, b.length);
  var other = 0;
  var m = LCDrain.createDrain({ maxClusters: 4000, onEvict: function (c) { other += c.size; } });
  var t0 = Date.now();
  var fed = feed(bytes, m).fed;
  var ms = Date.now() - t0;
  assert.ok(ms < 30000, "100 MB in under 30 s here (" + ms + " ms)");
  assert.equal(m.totalSize() + other, fed);
  assert.ok(m.count() > 10 && m.count() <= 4000, m.count() + " templates");
  console.log("big.log: " + fed + " lines, " + m.count() + " templates, " + m.evicted() + " evicted, " + ms + " ms");
});
