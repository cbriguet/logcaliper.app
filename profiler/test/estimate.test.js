"use strict";
/* estimate.test.js: the Storage tab's arithmetic against worked examples.

     node test/estimate.test.js

   The examples are the app's own: the home page's hero caption (5,000
   messages per second at 500 bytes is 216 GB a day) and the formula in
   StorageViewController.m with the app's default settings (compression
   1:8, replication 3, 25% intermediate, nodes of three 2,048 GB disks,
   three nodes at least). */

var test = require("node:test");
var assert = require("node:assert/strict");
var E = require("../estimate.js");

function close(a, b, what) { assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-12, what + ": " + a + " vs " + b); }

test("the hero caption: 5,000 events per second at 500 bytes is 216 GB a day", function () {
  var s = E.storage({ eventsPerSecond: 5000, bytesPerEvent: 500, days: 1 });
  assert.equal(s.perDay, 216e9);
  assert.equal(s.raw, 216e9);
  assert.equal(s.stored, 216e9);
  assert.equal(E.scale(s.perDay).text, "216 GB");
});

test("a year of 1,000 events per second at 500 bytes, then the app's switches one by one", function () {
  var s = E.storage({ eventsPerSecond: 1000, bytesPerEvent: 500, days: 365 });
  assert.equal(s.raw, 15768e9);
  assert.equal(s.stored, 15768e9);
  assert.equal(s.intermediate, 0);
  assert.equal(E.scale(s.stored).text, "15.8 TB");

  s = E.storage({ eventsPerSecond: 1000, bytesPerEvent: 500, days: 365, compression: 8 });
  assert.equal(s.stored, 1971e9);
  assert.equal(s.raw, 15768e9, "raw is before compression");
  assert.equal(E.scale(s.stored).text, "1.97 TB");

  s = E.storage({ eventsPerSecond: 1000, bytesPerEvent: 500, days: 365, compression: 8, replication: 3, intermediate: 0.25 });
  close(s.stored, 7884e9, "stored");
  close(s.intermediate, 1971e9, "a quarter of the disk");
  assert.equal(E.nodes(s.stored, 3, 2048), 3, "two nodes would do; three is the floor");
  assert.equal(E.nodes(100e12, 3, 2048), 17, "ceil(100 / 6.144)");
  assert.equal(E.nodes(6.144e12, 3, 2048), 3);
  assert.equal(E.nodes(6.144e12 + 1, 3, 2048), 3);
  assert.equal(E.nodes(6 * 6.144e12 + 1, 3, 2048), 7, "a cluster 0.0001 nodes short is a cluster that runs out of disk");
});

test("the retention slider, one for one, with its notes", function () {
  assert.equal(E.RETENTION.length, 20);
  assert.deepEqual(E.RETENTION.map(function (r) { return r.days; }),
    [1, 2, 3, 4, 5, 6, 7, 14, 30, 60, 90, 182.5, 365, 730, 1095, 1460, 1825, 2190, 2555, 2920]);
  assert.equal(E.retention(365).label, "1 year");
  assert.equal(E.retention(365).note, "PCI DSS 10.5.1: 12 months kept");
  assert.equal(E.retention(90).note, "PCI DSS 10.5.1: 3 months online");
  assert.equal(E.retention(2555).note, "NERC CIP");
  assert.equal(E.retention(2920).note, "HIPAA");
  assert.equal(E.retention(182.5).label, "6 months");
  assert.equal(E.retention(30).note, undefined);
  assert.equal(E.retention(100), null);
  var s = E.storage({ eventsPerSecond: 1, bytesPerEvent: 1, days: 182.5 });
  assert.equal(s.raw, 182.5 * 86400, "six months of 730 hours");
});

test("scale: the app's two ladders, three significant figures at most, the unit stepped at 1000", function () {
  assert.equal(E.scale(0).text, "0 B");
  assert.equal(E.scale(999).text, "999 B");
  assert.equal(E.scale(1000).text, "1 KB");
  assert.equal(E.scale(999950).text, "1 MB");
  assert.equal(E.scale(43.2e9).text, "43.2 GB");
  assert.equal(E.scale(1.5e18).text, "1.5 EB");
  assert.equal(E.scale(5e21).text, "5000 EB", "the ladder ends at EB, as the app's does");
  assert.equal(E.scale(1024, true).text, "1 KiB");
  assert.equal(E.scale(1048576, true).text, "1 MiB");
  assert.equal(E.scale(15768e9, true).text, "14.3 TiB");
  assert.equal(E.scale(NaN).text, "0 B");
  assert.equal(E.scale(-5).text, "0 B");
  assert.equal(E.scale(1500).unit, "KB");
  close(E.scale(1500).value, 1.5, "value is unrounded");
});

test("inputs that are missing, zero, negative or not numbers fall back as the app's switches do", function () {
  var s = E.storage({});
  assert.equal(s.raw, 0);
  assert.equal(s.stored, 0);
  assert.equal(s.perDay, 0);
  s = E.storage({ eventsPerSecond: "100", bytesPerEvent: "200", days: "1", compression: -3, replication: "x", intermediate: 1.5 });
  assert.equal(s.raw, 100 * 200 * 86400);
  assert.equal(s.stored, s.raw, "a bad ratio, factor or share is 1, 1 and none");
  s = E.storage({ eventsPerSecond: 100, bytesPerEvent: 200, days: 1, intermediate: 0.25 });
  close(s.stored, s.raw / 0.75, "intermediate alone");
  assert.equal(E.nodes(1e12, 0, 2048), null);
  assert.equal(E.nodes(-1, 3, 2048), null);
});
