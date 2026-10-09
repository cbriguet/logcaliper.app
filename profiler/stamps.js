/* stamps.js: the time a log sample covers, read off its lines.

   A rate needs a span. The tracker looks at the first 200 non-empty lines
   for a timestamp in one of seven common formats, keeps the format that
   stamps the most of them (a fifth at least), and then reads every line
   with that one format only: a log has one writer and one clock, and
   trying seven patterns on a million lines is seven times the work for
   nothing. A line the format does not stamp is counted, not read: a stack
   trace's continuation lines, a wrapped message, a blank-ish header.

   The formats, in the order of preference a tie falls to:
     ISO 8601       2026-10-09T13:16:00.123Z, 2026-10-09 13:16:00,123 +02:00
     Common Log     [09/Oct/2026:13:16:00 -0700]
     syslog, year   Oct 09 2026 13:16:00, Oct  9 13:16:00 2026
     syslog         Oct  9 13:16:00 (no year)
     YYYY/MM/DD     2026/10/09 13:16:00
     DD-Mon-YYYY    09-Oct-2026 13:16:00
     Unix epoch     1760000000, 1760000000123, 1760000000.123, up to nanoseconds
   A stamp is read from the first 160 characters of the line, wherever it
   sits, so a syslog priority, a bracket or a JSON key before it is no
   obstacle, and never from inside a longer run of letters or digits. An
   offset is applied when the stamp carries one, so a file that changes
   offset mid-way still measures right; a stamp without one is taken as it
   is written, since every line is on the same clock. syslog's year, when
   there is one, is its own format, chosen on the probe like the others, so
   a host that happens to look like a year ("2048", "2001:db8::1") on one
   line of a year-less file is a host.

   syslog's classic stamp has no year. Its lines are placed in 2024, a leap
   year, so a 29 February is a date; the span is unaffected. A file that
   runs from one December into the next January is continued into the next
   year: a stamp that lands more than two days before the previous one, or
   more than half a year after it, is read in the years either side as
   well, and the reading kept is the nearest that is at most two days back
   and half a year forward, failing that the smallest step forward, since a
   log is written in order; so a line a few seconds out of order at New
   Year is not a year out, and a January-to-September file is not read as
   September-to-January.

   The result: the format, how many lines carried a stamp and how many did
   not, the first and last stamps as written, the span between the
   earliest and the latest, and the stamped lines per second over it. No
   rate is given for a span under a second or a single stamp. Same shape as
   reader.js: a global, a guarded module.exports, ES5 throughout. */
var LCStamps = (function () {
  "use strict";

  var PROBE = 200;                 // lines looked at before a format is chosen
  var HEAD = 160;                  // characters of a line a stamp is looked for in
  var SHARE = 0.2;                 // a format must stamp this share of the probed lines
  var YEARLESS = 2024;             // a leap year, for stamps that carry no year
  var HALF_MS = 183 * 86400000;    // a step forward longer than this, in a year-less file, is looked at again
  var SLACK_MS = 2 * 86400000;     // and so is a step back longer than this
  var MONTH = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var MON = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  var B = "(?:^|[^0-9A-Za-z])";   // a stamp starts after something that is not a letter or a digit
  var E = "(?![0-9A-Za-z])";      // and ends before one

  /* Date.UTC rolls a 31 April into May; a stamp that rolled is not a date. */
  function utc(y, mo, d, h, mi, s, ms) {
    if (!(mo >= 0 && mo <= 11 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && s <= 60)) return NaN;
    var t = Date.UTC(y, mo, d, h, mi, Math.min(s, 59), ms);
    return new Date(t).getUTCDate() === d ? t : NaN;
  }

  function month(name) { return MONTH[name.toLowerCase()]; }

  /* Milliseconds from the digits after the point, however many there are. */
  function frac(digits) { return digits ? parseInt((digits + "00").slice(0, 3), 10) : 0; }

  /* An offset beyond 14 hours or with 60 minutes is not one. */
  function offset(sign, hh, mm) {
    if (+hh > 14 || +mm > 59) return NaN;
    return (sign === "-" ? -1 : 1) * ((+hh) * 60 + (+mm)) * 60000;
  }

  var FORMATS = [
    {
      id: "iso8601", name: "ISO 8601",
      re: new RegExp(B + "(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2}):(\\d{2})(?:[.,](\\d+))?(?: ?(Z|z|[+-]\\d{2}:?\\d{2}))?" + E),
      parse: function (m) {
        var t = utc(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], frac(m[7])), z = m[8];
        if (z && z !== "Z" && z !== "z") t -= offset(z.charAt(0), z.substr(1, 2), z.substr(z.length - 2));
        return { t: t, zoned: !!z };
      }
    },
    {
      id: "clf", name: "Common Log Format",
      re: new RegExp("\\[(\\d{2})/" + MON + "/(\\d{4}):(\\d{2}):(\\d{2}):(\\d{2}) ([+-])(\\d{2})(\\d{2})\\]", "i"),
      parse: function (m) {
        return { t: utc(+m[3], month(m[2]), +m[1], +m[4], +m[5], +m[6], 0) - offset(m[7], m[8], m[9]), zoned: true };
      }
    },
    {
      id: "syslog-year", name: "syslog",
      re: new RegExp("(?:^|[\\s<>\\[(])" + MON + " {1,2}(\\d{1,2})(?: ((?:19|20)\\d{2}))? (\\d{2}):(\\d{2}):(\\d{2})(?:[.,](\\d+))?(?: ((?:19|20)\\d{2})(?=\\s|$))?" + E),
      parse: function (m) {
        var y = m[3] ? +m[3] : (m[8] ? +m[8] : NaN);   // one of the two years must be there
        return { t: utc(y, month(m[1]), +m[2], +m[4], +m[5], +m[6], frac(m[7])), zoned: false };
      }
    },
    {
      id: "syslog", name: "syslog",
      re: new RegExp("(?:^|[\\s<>\\[(])" + MON + " {1,2}(\\d{1,2}) (\\d{2}):(\\d{2}):(\\d{2})(?:[.,](\\d+))?" + E),
      parse: function (m, year) {
        return { t: utc(year, month(m[1]), +m[2], +m[3], +m[4], +m[5], frac(m[6])), zoned: false, yearless: true };
      }
    },
    {
      id: "slash", name: "YYYY/MM/DD",
      re: new RegExp(B + "(\\d{4})/(\\d{2})/(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})(?:[.,](\\d+))?" + E),
      parse: function (m) { return { t: utc(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], frac(m[7])), zoned: false }; }
    },
    {
      id: "dmy", name: "DD-Mon-YYYY",
      re: new RegExp(B + "(\\d{2})-" + MON + "-(\\d{4})[ T](\\d{2}):(\\d{2}):(\\d{2})(?:[.,](\\d+))?" + E, "i"),
      parse: function (m) { return { t: utc(+m[3], month(m[2]), +m[1], +m[4], +m[5], +m[6], frac(m[7])), zoned: false }; }
    },
    {
      /* Ten digits from 2014 to 2042, alone or followed by three, six or
         nine more (milli, micro, nano) or by a fraction; never part of a
         longer number. */
      id: "epoch", name: "Unix epoch",
      re: /(?:^|[^\d.])((?:1[4-9]|2[0-2])\d{8})(?:(\d{3}(?:\d{3}){0,2})|[.,](\d{1,9}))?(?![\d.])/,
      parse: function (m) {
        var t = (+m[1]) * 1000;
        if (m[2]) t += frac(m[2]); else if (m[3]) t += frac(m[3]);
        return { t: t, zoned: true };
      }
    }
  ];

  function byId(id) {
    var i;
    for (i = 0; i < FORMATS.length; i++) if (FORMATS[i].id === id) return FORMATS[i];
    return null;
  }

  /* One line against one format: the stamp in milliseconds, or null. year
     is for a stamp that carries none. The text is the stamp as written,
     without the boundary the pattern looked at or CLF's brackets. */
  function read(format, text, year) {
    var head = text.length > HEAD ? text.slice(0, HEAD) : text, m = format.re.exec(head), r;
    if (!m) return null;
    r = format.parse(m, year);
    if (isNaN(r.t)) return null;
    r.text = m[0].replace(/^[^0-9A-Za-z]+/, "").replace(/\]$/, "");
    return r;
  }

  /* The format that stamps the most of these lines, if any stamps enough. */
  function choose(heads) {
    var best = null, bestHits = 0, i, j, hits;
    if (heads.length === 0) return null;
    for (i = 0; i < FORMATS.length; i++) {
      hits = 0;
      for (j = 0; j < heads.length; j++) if (read(FORMATS[i], heads[j], YEARLESS) !== null) hits++;
      if (hits > bestHits) { bestHits = hits; best = FORMATS[i]; }
    }
    return (best && bestHits >= Math.max(1, Math.ceil(heads.length * SHARE))) ? best : null;
  }

  function createTracker() {
    var heads = [], format = null, decided = false;
    var stamped = 0, unstamped = 0, lines = 0, zoned = false, yearless = false;
    var first = null, last = null, min = Infinity, max = -Infinity, firstText = "", lastText = "";
    var prev = null, backwards = 0, bump = 0;

    /* A year-less stamp is read in the current year; when that lands more
       than two days before the previous stamp or more than half a year
       after it, the years either side are read too. The reading kept is
       the nearest one within that window, failing that the smallest step
       forward, failing that the smallest step back; the current year
       follows it. */
    function readYearless(text) {
      var r = read(format, text, YEARLESS + bump), c, i, d, x, best = null, bestCost = Infinity;
      if (r === null || prev === null) return r;
      d = r.t - prev;
      if (d >= -SLACK_MS && d <= HALF_MS) return r;
      c = [{ r: r, b: 0 }];
      x = read(format, text, YEARLESS + bump + 1);
      if (x !== null) c.push({ r: x, b: 1 });
      x = read(format, text, YEARLESS + bump - 1);
      if (x !== null) c.push({ r: x, b: -1 });
      for (i = 0; i < c.length; i++) {
        d = c[i].r.t - prev;
        if (d >= -SLACK_MS && d <= HALF_MS && Math.abs(d) < bestCost) { best = c[i]; bestCost = Math.abs(d); }
      }
      if (best === null) for (i = 0; i < c.length; i++) {
        d = c[i].r.t - prev;
        if (d >= 0 && d < bestCost) { best = c[i]; bestCost = d; }
      }
      if (best === null) for (i = 0; i < c.length; i++) {
        d = prev - c[i].r.t;
        if (d < bestCost) { best = c[i]; bestCost = d; }
      }
      bump += best.b;
      return best.r;
    }

    function take(text) {
      var r = format.yearless ? readYearless(text) : read(format, text, YEARLESS);
      if (r === null) { unstamped++; return; }
      if (r.yearless) yearless = true;
      if (r.zoned) zoned = true;
      if (prev !== null && r.t < prev - 1000) backwards++;
      prev = r.t;
      stamped++;
      if (first === null) { first = r.t; firstText = r.text; }
      last = r.t; lastText = r.text;
      if (r.t < min) min = r.t;
      if (r.t > max) max = r.t;
    }

    function decide() {
      var i;
      decided = true;
      format = choose(heads);
      if (format !== null) {
        format = { id: format.id, name: format.name, re: format.re, parse: format.parse, yearless: format.id === "syslog" };
        for (i = 0; i < heads.length; i++) take(heads[i]);
      } else {
        unstamped += heads.length;
      }
      heads = null;
    }

    /* Every non-empty line, in file order, decoded. */
    function add(text) {
      lines++;
      if (!decided) {
        heads.push(text.length > HEAD ? text.slice(0, HEAD) : text);
        if (heads.length >= PROBE) decide();
        return;
      }
      if (format !== null) take(text); else unstamped++;
    }

    function result() {
      if (!decided) decide();
      var span = stamped > 0 ? (max - min) / 1000 : null;
      return {
        format: format ? { id: format.id, name: format.name } : null,
        lines: lines, stamped: stamped, unstamped: unstamped,
        zoned: zoned, yearless: yearless, backwards: backwards,
        first: first, last: last, firstText: firstText, lastText: lastText,
        spanSeconds: span,
        perSecond: (stamped >= 2 && span >= 1) ? stamped / span : null
      };
    }

    return { add: add, result: result };
  }

  return {
    createTracker: createTracker,
    read: function (text, formatId, year) { var f = byId(formatId); return f ? read(f, text, year === undefined ? YEARLESS : year) : null; },
    choose: function (heads) { var f = choose(heads); return f ? f.id : null; },
    formats: FORMATS.map(function (f) { return { id: f.id, name: f.name }; }),
    PROBE: PROBE, SHARE: SHARE, HEAD: HEAD, YEARLESS: YEARLESS
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LCStamps;
