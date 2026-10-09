if (typeof LCReader === 'undefined') importScripts('reader.js');
/* worker.js: reads the chosen file in chunks, off the page's thread.

   The page usually builds this worker from a blob that is reader.js and this
   file concatenated, so LCReader is already defined and the first line does
   nothing. When the page has to fall back to new Worker('worker.js'), the
   first line pulls reader.js in by its relative URL. That line is the only
   importScripts in the file. The worker never calls fetch, XMLHttpRequest,
   WebSocket or sendBeacon: the file's bytes come in through File.slice and
   go out as figures through postMessage, and nowhere else. Open the Network
   panel while it runs: nothing goes to any server. A line longer than
   16 MB is counted in full but kept and examined only on its first 16 MB
   (reader.js keeps the worker's memory bounded that way); the result says
   how many such lines there were. The worker posts {type:'ready'} once,
   when its script has run, so the page opens the picker only when there is
   a worker to answer it.

   Protocol. In: {type:'start', file, chunkBytes, runId} and {type:'cancel'}.
   Out: {type:'refused', code, message}, {type:'progress', bytesRead,
   fileSize, lines, elapsedMs} at most every 100 ms and once at the end,
   {type:'done', result}, {type:'cancelled', result} with result.status
   'partial', and {type:'error', message} for anything unexpected. Every
   message out carries the runId of the start it answers, so a page that
   keeps one worker across runs can drop a late answer to an earlier one. The result's shape is
   schemaVersion 1; later steps add fields and rename none. chunkBytes below
   64 KiB is raised to 64 KiB, because the sniff looks that far into the
   first chunk and a narrower one would blind it. A cancelled run reports
   whole lines only: the bytes of a line cut short by the stop are left out
   of bytesRead, so the partial figures still reconcile. */
(function () {
  "use strict";

  var PROGRESS_MS = 100;
  var DEFAULT_CHUNK = 8 * 1024 * 1024;
  var MIN_CHUNK = 65536;        // the sniff reads 64 KiB; a smaller first chunk would blind it
  var running = false, cancelled = false, currentRun = null;

  function now() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  }

  function say(m) { if (m.runId === undefined) m.runId = currentRun; self.postMessage(m); }

  function fail(err) {
    running = false;
    say({ type: "error", message: (err && err.message) ? err.message : String(err) });
  }

  function shape(file, r, ms, status) {
    var s = ms / 1000;
    return {
      schemaVersion: 1,
      status: status,
      file: { name: file.name, size: file.size, bytesRead: r.bytesRead, bomBytes: r.bomBytes },
      totals: {
        lines: r.lines, bytes: r.bytes,
        avgLineBytes: r.lines ? r.contentBytes / r.lines : 0,   // content only, on the same rule as the longest line
        longestLineBytes: r.longestLineBytes
      },
      counters: { empty: r.emptyLines, undecodable: r.undecodableLines, crlf: r.crlfLines, overLong: r.overLongLines, truncated: r.truncatedLines },
      timing: { ms: ms, bytesPerSecond: s > 0 ? r.bytesRead / s : 0, linesPerSecond: s > 0 ? r.lines / s : 0 },
      reconciliation: { residual: r.residual, ok: r.residual === 0 }
    };
  }

  function start(file, chunkBytes, runId) {
    if (running) { say({ type: "error", message: "A file is already being read.", runId: runId }); return; }
    currentRun = runId;
    if (!file || typeof file.slice !== "function") { say({ type: "error", message: "No file arrived with the start message." }); return; }
    running = true;
    cancelled = false;
    if (typeof chunkBytes !== "number" || !(chunkBytes > 0)) chunkBytes = DEFAULT_CHUNK;
    else if (chunkBytes < MIN_CHUNK) chunkBytes = MIN_CHUNK;

    var t0 = now(), lastProgress = -Infinity, off = 0;
    var splitter = LCReader.createSplitter(), stats = LCReader.createStats();
    var onLine = function (lineBytes, byteLength, hadCR, contentLength) { stats.add(lineBytes, byteLength, hadCR, undefined, contentLength); };

    /* Time-based, not line-based: a file of short lines would otherwise
       flood the page with messages, and one of long lines would starve it. */
    function progress(force) {
      var t = now();
      if (!force && t - lastProgress < PROGRESS_MS) return;
      lastProgress = t;
      say({ type: "progress", bytesRead: off, fileSize: file.size, lines: stats.result().lines, elapsedMs: t - t0 });
    }

    function finish(status) {
      if (status === "done") {
        splitter.flush(onLine);
        stats.setBytesRead(off);
      } else {
        // The carried half line is not a line; leave its bytes out of the count.
        stats.setBytesRead(off - splitter.pending());
      }
      progress(true);
      running = false;
      say({ type: status === "done" ? "done" : "cancelled", result: shape(file, stats.result(), now() - t0, status) });
    }

    /* One chunk buffer alive at a time: slice, read, split, drop, repeat.
       The cancel flag is read between chunks, which is as cooperative as a
       worker can be; the page hard-terminates if this never answers. */
    function step(first) {
      // A run that already holds every byte is done, whatever a late cancel says.
      if (!first && off >= file.size) { finish("done"); return; }
      if (cancelled) { finish("partial"); return; }
      file.slice(off, off + chunkBytes).arrayBuffer().then(function (buf) {
        try {
          var bytes = new Uint8Array(buf), n = bytes.length;
          if (n === 0 && off < file.size) {
            /* The file changed under us: slice gave nothing before the end,
               on the first read (rotated while the picker was open) or later. */
            fail(new Error("The file changed while it was being read: it is shorter than it was (" + off.toLocaleString() + " of " + file.size.toLocaleString() + " bytes could be read). Choose it again."));
            return;
          }
          if (first) {
            var s = LCReader.sniff(bytes, file.size);
            if (!s.ok) { running = false; say({ type: "refused", code: s.code, message: s.message }); return; }
            stats.setBom(s.bomBytes);
            bytes = bytes.subarray(s.bomBytes);
          }
          off += n;
          splitter.push(bytes, onLine);
          progress(false);
          step(false);    // the next read is a new task, so a cancel can land between chunks
        } catch (e) { fail(e); }
      }, fail);
    }
    step(true);
  }

  self.onmessage = function (e) {
    var m = e && e.data;
    if (!m) return;
    try {
      if (m.type === "cancel") { cancelled = true; return; }
      if (m.type === "start") { start(m.file, m.chunkBytes, m.runId); return; }
      say({ type: "error", message: "Unknown message type: " + m.type });
    } catch (err) { fail(err); }
  };

  say({ type: "ready" });
})();
