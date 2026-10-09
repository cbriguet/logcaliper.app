"use strict";
/* stamps.test.js: every format read to the millisecond, the choice of a
   format over the probe, and the tracker's arithmetic.

     node test/stamps.test.js */

var test = require("node:test");
var assert = require("node:assert/strict");
var S = require("../stamps.js");

var T = Date.UTC(2026, 9, 9, 13, 16, 0, 0);   // 2026-10-09 13:16:00 UTC
var H = 3600000;

function at(text, id, year) { var r = S.read(text, id, year); return r === null ? null : r.t; }

test("ISO 8601: T or space, any fraction, Z or an offset with or without a colon or a space", function () {
  assert.equal(at("2026-10-09T13:16:00Z", "iso8601"), T);
  assert.equal(at("2026-10-09 13:16:00,5 INFO x", "iso8601"), T + 500);
  assert.equal(at("2026-10-09T13:16:00.123456789Z", "iso8601"), T + 123);
  assert.equal(at("2026-10-09T13:16:00+02:00", "iso8601"), T - 2 * H);
  assert.equal(at("2026-10-09T13:16:00.250-0700", "iso8601"), T + 7 * H + 250);
  assert.equal(at("2026-10-09 13:16:00 +0530 x", "iso8601"), T - 5.5 * H);
  assert.equal(at("2026-10-09T13:16:00+99:99", "iso8601"), null, "an offset beyond 14 hours is not one");
  assert.equal(at("2026-10-09T13:16:00+05:60", "iso8601"), null);
  assert.equal(S.read("2026-10-09 13:16:00 +1000ms later", "iso8601").t, T, "+1000ms is not an offset");
  assert.equal(S.read("2026-10-09 13:16:00 +1000ms later", "iso8601").zoned, false);
  assert.equal(at("2026-10-09 13:16:00 -12345", "iso8601"), T, "-12345 is not an offset either");
  assert.equal(at("12026-10-09T13:16:00Z", "iso8601"), null, "a stamp does not start inside a number");
  assert.equal(at("2026-10-09T13:16:00123", "iso8601"), null, "nor run into one");
  assert.equal(at("x2026-10-09T13:16:00Z", "iso8601"), null, "nor start inside a word");
  assert.equal(at("{\"@timestamp\":\"2026-10-09T13:16:00.000Z\",\"m\":1}", "iso8601"), T);
  var r = S.read("2026-10-09T13:16:00Z x", "iso8601");
  assert.equal(r.text, "2026-10-09T13:16:00Z");
  assert.equal(r.zoned, true);
  assert.equal(S.read("2026-10-09T13:16:00 x", "iso8601").zoned, false);
});

test("Common Log Format: the bracketed stamp with its offset", function () {
  assert.equal(at("10.0.0.1 - - [09/Oct/2026:13:16:00 -0700] \"GET / HTTP/1.1\" 200 12", "clf"), T + 7 * H);
  assert.equal(at("[09/oct/2026:13:16:00 +0000]", "clf"), T);
  assert.equal(at("[09/Oct/2026:13:16:00]", "clf"), null, "no offset is not CLF");
  assert.equal(S.read("[09/Oct/2026:13:16:00 -0700]", "clf").text, "09/Oct/2026:13:16:00 -0700", "shown without its brackets");
});

test("syslog: no year is one format, a year after the day or after the time is another", function () {
  assert.equal(at("Oct  9 13:16:00 web-01 sshd[401]: x", "syslog"), Date.UTC(2024, 9, 9, 13, 16, 0));
  assert.equal(at("Oct  9 13:16:00 web-01 sshd[401]: x", "syslog", 2026), T);
  assert.equal(at("Oct 09 2026 13:16:00 host CEF:0|x", "syslog-year"), T);
  assert.equal(at("Oct 09 2026 13:16:00 host CEF:0|x", "syslog"), null, "the year-less pattern wants the time right after the day");
  assert.equal(at("Oct 9 13:16:00 2026 host x", "syslog-year"), T);
  assert.equal(at("Oct 9 13:16:00 2026 host x", "syslog"), Date.UTC(2024, 9, 9, 13, 16, 0), "the year-less pattern ignores a year after the time");
  assert.equal(at("<134>Oct  9 13:16:00 host x", "syslog"), Date.UTC(2024, 9, 9, 13, 16, 0));
  assert.equal(at("Oct  9 13:16:00 8080 host x", "syslog-year"), null, "8080 is not a year");
  assert.equal(at("Oct  9 13:16:00 2001:db8::1 sshd[1]: x", "syslog-year"), null, "an IPv6 host is not a year");
  assert.equal(at("Oct  9 13:16:00 2048 host x", "syslog-year"), Date.UTC(2048, 9, 9, 13, 16, 0), "a host that is four digits reads as a year under the year format only");
  assert.equal(S.read("Oct  9 13:16:00.250 h x", "syslog").t, Date.UTC(2024, 9, 9, 13, 16, 0, 250));
  assert.equal(S.read("Oct  9 13:16:00 h x", "syslog").yearless, true);
  assert.ok(!S.read("Oct 09 2026 13:16:00 h", "syslog-year").yearless);
  assert.equal(S.read("<134>Oct  9 13:16:00 host x", "syslog").text, "Oct  9 13:16:00");
  assert.equal(at("Octo 9 13:16:00", "syslog"), null);
  assert.equal(at("may 9 13:16:00", "syslog"), null, "months are capitalised");
  assert.equal(at("Oct  9 13:16:00abc", "syslog"), null, "a stamp does not run into a word");
});

test("a host that looks like a year on one line of a year-less file is a host", function () {
  var r = tracker(["Oct  9 13:16:00 h a", "Oct  9 13:16:01 2048 a", "Oct  9 13:16:02 2001:db8::1 a"]);
  assert.equal(r.format.id, "syslog");
  assert.equal(r.stamped, 3);
  assert.equal(r.spanSeconds, 2);
  r = tracker(["Oct  9 13:16:00 2026 h a", "Oct  9 13:16:01 2026 h a"]);
  assert.equal(r.format.id, "syslog-year", "when every line carries the year, the year format wins the tie");
  assert.equal(r.first, T);
  assert.equal(r.yearless, false);
});

test("YYYY/MM/DD and DD-Mon-YYYY", function () {
  assert.equal(at("2026/10/09 13:16:00 [error] x", "slash"), T);
  assert.equal(at("2026/10/09T13:16:00.7", "slash"), T + 700);
  assert.equal(at("09-Oct-2026 13:16:00.250 INFO x", "dmy"), T + 250);
  assert.equal(at("09-OCT-2026 13:16:00", "dmy"), T);
});

test("Unix epoch: seconds, milli, micro, nano, a fraction; never part of a longer number", function () {
  var E = 1760000000;
  assert.equal(at("1760000000 start", "epoch"), E * 1000);
  assert.equal(at("ts=1760000000123 x", "epoch"), E * 1000 + 123);
  assert.equal(at("1760000000123456", "epoch"), E * 1000 + 123);
  assert.equal(at("1760000000123456789", "epoch"), E * 1000 + 123);
  assert.equal(at("1760000000.5", "epoch"), E * 1000 + 500);
  assert.equal(at("\"time\":1760000000,", "epoch"), E * 1000);
  assert.equal(S.read("ts=1760000000 x", "epoch").text, "1760000000", "shown without the character before it");
  assert.equal(S.read("{\"time\":1760000000}", "epoch").text, "1760000000");
  assert.equal(at("x11760000000", "epoch"), null);
  assert.equal(at("size=17600000001", "epoch"), null);
  assert.equal(at("1760000000.1.2", "epoch"), null);
  assert.equal(at("1300000000", "epoch"), null, "2011 is before the window");
  assert.equal(at("2300000000", "epoch"), null, "2042 is after it");
});

test("a stamp that is not a date is not a stamp", function () {
  assert.equal(at("2026-13-09 13:16:00", "iso8601"), null);
  assert.equal(at("2026-02-30 13:16:00", "iso8601"), null);
  assert.equal(at("2026-04-31 13:16:00", "iso8601"), null);
  assert.equal(at("2026-10-09 25:16:00", "iso8601"), null);
  assert.equal(at("2026-10-09 13:60:00", "iso8601"), null);
  assert.equal(at("2026-10-09 13:16:60", "iso8601"), T + 59000, "a leap second is held at 59");
  assert.equal(at("Feb 29 13:16:00", "syslog"), Date.UTC(2024, 1, 29, 13, 16, 0), "a year-less 29 February is a date");
  assert.equal(at("Feb 29 2026 13:16:00", "syslog"), null);
});

test("the stamp is read from the first 160 characters only", function () {
  var pad = new Array(200).join("x") + " ";
  assert.equal(at(pad + "2026-10-09T13:16:00Z", "iso8601"), null);
  assert.equal(at(new Array(100).join("x") + " 2026-10-09T13:16:00Z", "iso8601"), T);
});

test("choose: the format with the most hits, a fifth of the lines at least, the earlier on a tie", function () {
  var iso = [], ep = [], i;
  for (i = 0; i < 10; i++) { iso.push("2026-10-09T13:16:0" + i + "Z x"); ep.push("176000000" + i + " x"); }
  assert.equal(S.choose(iso), "iso8601");
  assert.equal(S.choose(ep), "epoch");
  assert.equal(S.choose(iso.slice(0, 3).concat(ep)), "epoch");
  assert.equal(S.choose(["plain", "plain", "plain", "plain", "plain", "plain", "plain", "plain", "plain", "2026-10-09T13:16:00Z"]), null, "one in ten is under the share");
  assert.equal(S.choose(["plain", "plain", "plain", "plain", "plain", "plain", "plain", "plain", "2026-10-09T13:16:00Z", "2026-10-09T13:16:01Z"]), "iso8601", "two in ten is the share");
  assert.equal(S.choose(["2026-10-09T13:16:00Z ts=1760000000"]), "iso8601", "the same hits: the earlier format");
  assert.equal(S.choose([]), null);
  assert.equal(S.choose(["nothing here"]), null);
});

function tracker(lines) {
  var t = S.createTracker();
  lines.forEach(function (l) { t.add(l); });
  return t.result();
}

test("tracker: ten lines a second apart, two continuation lines", function () {
  var lines = [], i;
  for (i = 0; i < 10; i++) {
    lines.push("2026-10-09T13:16:0" + i + ".000Z host app: line " + i);
    if (i === 3 || i === 7) lines.push("    at com.example.Thing.run(Thing.java:42)");
  }
  var r = tracker(lines);
  assert.equal(r.format.id, "iso8601");
  assert.equal(r.format.name, "ISO 8601");
  assert.equal(r.lines, 12);
  assert.equal(r.stamped, 10);
  assert.equal(r.unstamped, 2);
  assert.equal(r.spanSeconds, 9);
  assert.equal(r.perSecond, 10 / 9);
  assert.equal(r.first, T);
  assert.equal(r.last, T + 9000);
  assert.equal(r.firstText, "2026-10-09T13:16:00.000Z");
  assert.equal(r.lastText, "2026-10-09T13:16:09.000Z");
  assert.equal(r.zoned, true);
  assert.equal(r.yearless, false);
  assert.equal(r.backwards, 0);
});

test("tracker: no format, every line unstamped, no rate", function () {
  var r = tracker(["one", "two", "three"]);
  assert.equal(r.format, null);
  assert.equal(r.lines, 3);
  assert.equal(r.stamped, 0);
  assert.equal(r.unstamped, 3);
  assert.equal(r.spanSeconds, null);
  assert.equal(r.perSecond, null);
  assert.equal(r.first, null);
  assert.equal(r.firstText, "");
});

test("tracker: a single stamp, or a span under a second, gives no rate", function () {
  var r = tracker(["2026-10-09T13:16:00Z x"]);
  assert.equal(r.stamped, 1);
  assert.equal(r.spanSeconds, 0);
  assert.equal(r.perSecond, null);
  r = tracker(["2026-10-09T13:16:00.100Z", "2026-10-09T13:16:00.900Z"]);
  assert.equal(r.spanSeconds, 0.8);
  assert.equal(r.perSecond, null);
  r = tracker(["2026-10-09T13:16:00.000Z", "2026-10-09T13:16:01.000Z"]);
  assert.equal(r.perSecond, 2);
});

test("tracker: the span is from the earliest to the latest, and lines out of order are counted", function () {
  var r = tracker(["2026-10-09T13:16:05Z", "2026-10-09T13:16:00Z", "2026-10-09T13:16:10Z", "2026-10-09T13:16:09.5Z"]);
  assert.equal(r.spanSeconds, 10);
  assert.equal(r.backwards, 1, "half a second back is jitter; five seconds back is counted");
  assert.equal(r.firstText, "2026-10-09T13:16:05Z");
  assert.equal(r.lastText, "2026-10-09T13:16:09.5Z");
});

test("tracker: a year-less file running from December into January", function () {
  var r = tracker(["Dec 31 23:59:59 h x", "Jan  1 00:00:01 h y", "Jan  1 00:00:03 h z"]);
  assert.equal(r.format.id, "syslog");
  assert.equal(r.yearless, true);
  assert.equal(r.zoned, false);
  assert.equal(r.spanSeconds, 4);
  assert.equal(r.backwards, 0);
  assert.equal(r.perSecond, 0.75);
  r = tracker(["Dec 31 23:59:59 h", "Jan  1 00:00:01 h", "Dec 31 23:59:58 h", "Jan  1 00:00:03 h"]);
  assert.equal(r.spanSeconds, 5, "a line a few seconds out of order at New Year is not a year out");
  assert.equal(r.backwards, 1);
  r = tracker(["Jan  1 00:00:00 h", "Dec 31 23:59:59 h", "Jan  1 00:00:01 h"]);
  assert.equal(r.spanSeconds, 2, "nor is a line from the year before");
  r = tracker(["Jan  1 00:00:00 h", "Sep  1 00:00:00 h", "Dec 31 00:00:00 h"]);
  assert.equal(r.spanSeconds, 365 * 86400, "a January-to-December file is read forward, not as a September of the year before");
  r = tracker(["Mar  1 12:00:00 h", "Sep  1 12:00:00 h", "Mar  1 12:00:00 h"]);
  assert.equal(r.spanSeconds, 365 * 86400, "a March after a September is the next March");
  r = tracker(["Dec 31 23:59:59 h", "Dec 30 23:59:59 h", "Jan  1 00:00:00 h"]);
  assert.equal(r.spanSeconds, 86400 + 1, "a file written newest first is read forward at the turn of the year: a log is taken to be in order (a known limit)");
});

test("tracker: the format is chosen on the first 200 lines and applied to the rest", function () {
  var lines = [], i;
  for (i = 0; i < 199; i++) lines.push("plain line " + i);
  lines.push("2026-10-09T13:16:00Z x");   // one stamped line in two hundred: under the share
  for (i = 0; i < 500; i++) lines.push("2026-10-09T13:16:0" + (i % 10) + "Z later");
  var r = tracker(lines);
  assert.equal(r.format, null, "decided on the probe, not on what came after");
  assert.equal(r.unstamped, 700);

  lines = [];
  for (i = 0; i < 150; i++) lines.push("2026-10-09T13:16:00Z x");
  for (i = 0; i < 50; i++) lines.push("plain");
  for (i = 0; i < 300; i++) lines.push("2026-10-09T13:16:0" + (i % 10) + "Z later");
  for (i = 0; i < 20; i++) lines.push("plain again");
  r = tracker(lines);
  assert.equal(r.format.id, "iso8601");
  assert.equal(r.stamped, 450);
  assert.equal(r.unstamped, 70);
  assert.equal(r.lines, 520);
});

test("tracker: fewer lines than the probe are decided at the end", function () {
  var r = tracker(["Oct  9 13:16:00 h a", "Oct  9 13:16:02 h b"]);
  assert.equal(r.format.id, "syslog");
  assert.equal(r.spanSeconds, 2);
  assert.equal(r.perSecond, 1);
});

test("tracker: the result can be asked twice and does not move", function () {
  var t = S.createTracker();
  t.add("2026-10-09T13:16:00Z"); t.add("2026-10-09T13:16:05Z");
  var a = t.result(), b = t.result();
  assert.deepEqual(a, b);
});

test("reading is fast enough for a million lines", function () {
  var t = S.createTracker(), i, t0 = Date.now();
  for (i = 0; i < 300000; i++) t.add("2026-10-09T13:" + ((i / 1000) % 60 < 10 ? "0" : "") + Math.floor((i / 1000) % 60) + ":00.000Z web-01 nginx[1200]: 10.3.4.5 - - \"GET /api/v2/users HTTP/1.1\" 200 1234");
  var r = t.result(), ms = Date.now() - t0;
  assert.equal(r.stamped, 300000);
  assert.ok(ms < 5000, "300k lines under 5 s (" + ms + " ms)");
});

test("the format list is what the page names", function () {
  assert.deepEqual(S.formats.map(function (f) { return f.id; }), ["iso8601", "clf", "syslog-year", "syslog", "slash", "dmy", "epoch"]);
  assert.deepEqual(S.formats.map(function (f) { return f.name; }), ["ISO 8601", "Common Log Format", "syslog", "syslog", "YYYY/MM/DD", "DD-Mon-YYYY", "Unix epoch"]);
  assert.equal(S.read("x", "nope"), null);
  assert.equal(S.PROBE, 200);
});
