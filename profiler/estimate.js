/* estimate.js: the Storage tab of the Logcaliper app, as arithmetic.

   The app (StorageViewController.m, doCalculationStorage) sizes storage as

     bytes = events per second × bytes per event × days × 86,400
             × replication ÷ compression

   and, when the data sits on a cluster that keeps a share of its disk for
   intermediate files, divides by what is left: the Info screen promises
   "approximately 25% of the disk", so the data has to fit in the other
   75%. Nodes are the requirement over one node's disks, rounded up, three
   at least. Units are the app's ladders, decimal by default (a kilobyte is
   1,000 bytes, like every number on this site) and binary on request. The
   retention steps and their notes are the app's slider, one for one.

   The profiler's estimator calls storage() with the rate and the average
   line the profile found; the app does the same sum over a list of
   sources. Same shape as reader.js: a global for the page, a guarded
   module.exports for the Node tests, ES5 throughout. */
var LCEstimate = (function () {
  "use strict";

  var DAY = 86400;
  var RETENTION = [
    { days: 1, label: "1 day" }, { days: 2, label: "2 days" }, { days: 3, label: "3 days" },
    { days: 4, label: "4 days" }, { days: 5, label: "5 days" }, { days: 6, label: "6 days" },
    { days: 7, label: "1 week" }, { days: 14, label: "2 weeks" }, { days: 30, label: "30 days" },
    { days: 60, label: "60 days" }, { days: 90, label: "90 days", note: "PCI DSS 10.5.1: 3 months online" },
    { days: 182.5, label: "6 months" },                                   // 6 × 730 h: the app's month
    { days: 365, label: "1 year", note: "PCI DSS 10.5.1: 12 months kept" },
    { days: 730, label: "2 years" }, { days: 1095, label: "3 years" }, { days: 1460, label: "4 years" },
    { days: 1825, label: "5 years" }, { days: 2190, label: "6 years" },
    { days: 2555, label: "7 years", note: "NERC CIP" }, { days: 2920, label: "8 years", note: "HIPAA" }
  ];
  var DECIMAL = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
  var BINARY = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];

  function positive(x, fallback) { x = +x; return x > 0 ? x : fallback; }

  /* p: eventsPerSecond, bytesPerEvent, days; optional compression (8 for
     "1:8"), replication, intermediate (0.25 for 25%), each 1, 1 and 0 when
     left out, as in the app with its switches off. */
  function storage(p) {
    var eps = positive(p.eventsPerSecond, 0), size = positive(p.bytesPerEvent, 0), days = positive(p.days, 0);
    var compression = positive(p.compression, 1), replication = positive(p.replication, 1);
    var intermediate = (+p.intermediate > 0 && +p.intermediate < 1) ? +p.intermediate : 0;
    var raw = eps * size * days * DAY;
    var data = raw * replication / compression;
    var stored = intermediate ? data / (1 - intermediate) : data;
    return {
      perDay: eps * size * DAY,      // before compression and replication
      raw: raw,                      // the retention's worth, as written
      stored: stored,                // what the disks must hold
      intermediate: stored - data,
      days: days
    };
  }

  /* The app's HDD size is in gigabytes of 1,000³ bytes, disks being sold
     that way, whichever unit the answer is printed in. */
  function nodes(bytes, hddNumber, hddCapacityGB) {
    var cap = positive(hddNumber, 0) * positive(hddCapacityGB, 0) * 1e9;
    if (!(cap > 0) || !(bytes >= 0)) return null;
    return Math.max(3, Math.ceil(bytes / cap));
  }

  /* The app prints a whole number and its unit; the page wants a few
     digits. Both come from here: value is unrounded. */
  function scale(bytes, binary) {
    var base = binary ? 1024 : 1000, units = binary ? BINARY : DECIMAL, n = 0, v = bytes;
    if (!(v >= 0)) return { value: 0, unit: units[0], text: "0 " + units[0] };
    while (v >= base && n < units.length - 1) { v /= base; n++; }
    var s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
    if (s === String(base) && n < units.length - 1) { s = "1"; n++; v = 1; }
    return { value: v, unit: units[n], text: s + " " + units[n] };
  }

  function retention(days) {
    var i;
    for (i = 0; i < RETENTION.length; i++) if (RETENTION[i].days === +days) return RETENTION[i];
    return null;
  }

  return { storage: storage, nodes: nodes, scale: scale, retention: retention, RETENTION: RETENTION, DAY: DAY };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LCEstimate;
