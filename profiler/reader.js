/* reader.js: the pure core of the Logcaliper profiler.

   Nothing in here touches the DOM, the network or the worker API. The same
   file is loaded three ways: by worker.js through importScripts (or inlined
   into the worker blob by the page), by the Node tests through require, and
   later by a test page as a plain script. That is why it defines a global and
   ends with a guarded module.exports.

   Line semantics, written down once so the tests and the manifest agree:
   a line ends at LF. If the byte before the LF is CR, the line is CRLF and
   the CR is part of the terminator, not the content. A CR anywhere else is
   content: a bare CR is not a line break here, because treating it as one
   would make the count depend on which terminator the writer used. The last
   line may have no terminator at all; it still counts as a line, and a CR at
   the very end of the file is content, since no LF follows it.
   "Line bytes" below always means the content without its terminator. */
var LCReader = (function () {
  "use strict";

  var OVER_LONG = 64000;                   // decimal like every unit on the site: a line over 64 KB is counted
  var SNIFF = 8 * 1024 * 1024;             // the worker's chunk; runChunks sniffs the same width
  var utf8 = null, strict = null;

  /* One decoder, created on first use so a page that never profiles pays
     nothing. Non-fatal: an invalid byte becomes U+FFFD and is counted, rather
     than stopping the run. Decoding a whole line at a time is always safe,
     because LF is a single byte (0x0A) in UTF-8 and can never be part of a
     multi-byte sequence, so a line boundary is always a sequence boundary. A
     character that straddles two file chunks is reassembled by the splitter
     before the line reaches the decoder. ignoreBOM keeps the bytes honest: a
     stray U+FEFF inside the file stays in the text instead of vanishing. */
  function decodeLine(lineBytes) {
    if (utf8 === null) utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
    return utf8.decode(lineBytes);
  }

  /* A replacement character in the decoded text is either a bad byte or a
     U+FFFD the writer put there itself (a log sanitised upstream). Only a
     strict decode tells the two apart, and only lines that show one pay. */
  function decodesCleanly(lineBytes, truncated) {
    /* A line cut at the cap may end inside a multi-byte character; a
       streaming decode holds that tail instead of refusing it. */
    if (truncated) {
      try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(lineBytes, { stream: true }); return true; }
      catch (e) { return false; }
    }
    if (strict === null) strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    try { strict.decode(lineBytes); return true; } catch (e) { return false; }
  }

  function refuse(code, message) { return { ok: false, code: code, message: message }; }

  /* Decimal and rounded like the page's own human(), so the refusal below
     names the width the progress line would have shown: "8.39 MB". */
  function roughSize(n) {
    var u = ["B", "KB", "MB", "GB"], k = 0;
    while (n >= 1000 && k < u.length - 1) { n /= 1000; k++; }
    var s = n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
    if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
    return s + " " + u[k];
  }

  /* Looks at the first chunk and decides whether the file is something this
     tool can read. Every refusal says what the file is and what to do about
     it, because a refusal with no remedy is just a dead end. The order
     matters: a UTF-16 file is full of NUL bytes and a gzip header has control
     bytes, so the specific checks run before the generic binary test. */
  function sniff(bytes, fileSize) {
    if (typeof fileSize !== "number") fileSize = bytes.length;
    var n = bytes.length, i, b;
    if (fileSize === 0 || n === 0) {
      return refuse("empty", "This file is empty. Choose a log file that has at least one line in it.");
    }
    if (n >= 2 && ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF))) {
      return refuse("utf16", "This file is UTF-16. Convert it to UTF-8 (iconv -f UTF-16 -t UTF-8) and try again.");
    }
    if (n >= 2 && bytes[0] === 0x1F && bytes[1] === 0x8B) {
      return refuse("gzip", "This file is gzip-compressed. Decompress it first (gunzip, or gzip -d) and choose the file it contains.");
    }
    if (n >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) {
      return refuse("zip", "This file is a zip archive. Unzip it first and choose one log file from inside it.");
    }
    var lim = Math.min(n, 8192);
    for (i = 0; i < lim; i++) {
      if (bytes[i] === 0) {
        return refuse("binary", "This file looks binary: it has NUL bytes, which never appear in a text log. " +
          "If it is UTF-16 without a byte-order mark, convert it (iconv -f UTF-16LE -t UTF-8); otherwise choose a plain-text log file.");
      }
    }
    /* Printable ASCII, tab, CR, LF and anything from 0x80 up (UTF-8) are
       text. So is ESC when it opens an ANSI control sequence (ESC followed by
       "["): a log coloured by its writer is still a text log, and a heavily
       coloured one can carry an escape every ten bytes. A bare ESC counts as
       a control byte like any other. */
    lim = Math.min(n, 65536);
    var odd = 0;
    for (i = 0; i < lim; i++) {
      b = bytes[i];
      if (b < 0x20) {
        if (b === 27) { if (!(i + 1 < n && bytes[i + 1] === 0x5B)) odd++; }
        else if (b !== 9 && b !== 10 && b !== 13) odd++;
      } else if (b === 0x7F) odd++;
    }
    if (odd * 10 > lim) {
      return refuse("binary", "This file looks binary: more than a tenth of its bytes are control codes that never appear in a text log. Choose a plain-text log file.");
    }
    var bom = (n >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) ? 3 : 0;
    if (fileSize === bom) {
      return refuse("empty", "This file is empty. Choose a log file that has at least one line in it.");
    }
    /* A small file with no newline is one line, and that is fine. A large one
       whose first chunk has no newline is a single line longer than the chunk,
       which no line-based tool can do anything useful with. */
    if (fileSize > n && bytes.indexOf(10) < 0) {
      return refuse("no-newline", "The first " + roughSize(n) + " of this file hold no line break. Logcaliper reads one line per event, " +
        "so a file that is one long line (a JSON array, say) cannot be profiled. Split it into lines, or choose a line-based log.");
    }
    return { ok: true, bomBytes: bom };
  }

  /* Splits a stream of chunks into lines without copying what it does not
     have to. A line that sits inside one chunk is handed out as a subarray of
     that chunk: a view, not a copy. Only a line that crosses a chunk boundary
     is assembled, in a buffer the splitter keeps and grows by doubling, so a
     100 KB line arriving one byte at a time costs O(n), not O(n squared).
     Either way the bytes handed to onLine are only valid until onLine
     returns: the chunk is released and the carry buffer is reused. Decode or
     copy before keeping anything.

     onLine(lineBytes, byteLength, hadCR, contentLength): lineBytes is the
     content without its terminator; byteLength is what the line occupies in
     the file, terminator included, so the sum over all lines reconciles
     against the bytes read; contentLength is the content's true length. The
     two lengths differ only for a line longer than CAP: past that the
     splitter keeps the first CAP bytes and counts the rest, so one enormous
     line (a minified JSON array, a base64 dump) cannot grow the worker's
     memory without bound. Such a line is measured on what was kept. */
  function createSplitter() {
    var tail = null, tailLen = 0;
    var KEEP = 1048576;      // a carry buffer grown past this by one huge line is dropped after use
    var CAP = 16000000;      // decimal like every unit on the site: past 16 MB a crossing line is counted, not kept
    var over = 0;            // bytes of the current line beyond CAP, counted only
    var lastByte = -1;       // the last byte seen of a line in counting mode, for the CR test

    function carry(rest) {
      var need = tailLen + rest.length;
      if (over > 0 || need > CAP) {
        var room = over > 0 ? 0 : CAP - tailLen;
        if (room > 0) { grow(CAP); tail.set(rest.subarray(0, room), tailLen); tailLen = CAP; }
        over += rest.length - room;
        if (rest.length > 0) lastByte = rest[rest.length - 1];
        return;
      }
      grow(need);
      tail.set(rest, tailLen);
      tailLen = need;
    }

    function grow(need) {
      if (tail === null || tail.length < need) {
        var grown = new Uint8Array(Math.max(need, tail === null ? 0 : Math.min(tail.length * 2, CAP)));
        if (tailLen > 0) grown.set(tail.subarray(0, tailLen));
        tail = grown;
      }
    }

    function emit(lineBytes, byteLength, onLine) {
      var n = lineBytes.length;
      var hadCR = n > 0 && lineBytes[n - 1] === 13;
      if (hadCR) lineBytes = lineBytes.subarray(0, n - 1);
      onLine(lineBytes, byteLength, hadCR, lineBytes.length);
    }

    /* The carried line is complete: hand it out and release the carry. A line
       in counting mode is handed out as its kept prefix with its true length;
       its CR, if any, is the last byte seen, which was counted, not kept. */
    function emitCarried(terminated, onLine) {
      var kept = tail.subarray(0, tailLen), total = tailLen + over, hadCR;
      if (over > 0) {
        hadCR = terminated && lastByte === 13;
        tailLen = 0; over = 0; lastByte = -1;
        onLine(kept, total + (terminated ? 1 : 0), hadCR, total - (hadCR ? 1 : 0));
      } else {
        tailLen = 0;
        if (terminated) emit(kept, kept.length + 1, onLine);
        else onLine(kept, kept.length, false, kept.length);   // no LF follows, so a final CR is content
      }
      /* One pathological line must not pin its buffer for the rest of the
         file: past a megabyte the buffer goes and the next crossing line
         gets a fresh one of its own size. */
      if (tail.length > KEEP) tail = null;
    }

    function push(chunk, onLine) {
      var start = 0, n = chunk.length, i;
      /* indexOf on a typed array is a native scan, far faster than a byte
         loop in script, and LF is the only byte that matters here. */
      while (start < n) {
        i = chunk.indexOf(10, start);
        if (i < 0) break;
        if (tailLen > 0 || over > 0) {
          carry(chunk.subarray(start, i));
          emitCarried(true, onLine);
        } else {
          emit(chunk.subarray(start, i), i - start + 1, onLine);
        }
        start = i + 1;
      }
      if (start < n) carry(chunk.subarray(start));
    }

    function flush(onLine) {
      if (tailLen === 0 && over === 0) return;
      emitCarried(false, onLine);
    }

    /* How many bytes are carried, waiting for their LF, kept or counted. A
       run that stops early subtracts this from the bytes read, so its figures
       describe whole lines only and still reconcile. */
    function pending() { return tailLen + over; }

    return { push: push, flush: flush, pending: pending, CAP_BYTES: CAP };
  }

  /* Counts what step 1 reports. The residual is the proof: bytes read, less
     the BOM, less the sum of every line's byteLength, must come to zero, or a
     byte went missing between the file and the figures. */
  function createStats() {
    var lines = 0, bytes = 0, content = 0, bom = 0, read = 0;
    var crlf = 0, empty = 0, undecodable = 0, longest = 0, overLong = 0, truncated = 0;

    return {
      /* text is optional. When the caller has not decoded the line, only a
         line with a byte at or above 0x80 can decode to U+FFFD, so pure ASCII
         lines (most of any log) skip the decoder entirely. contentLength is
         optional too: it exceeds lineBytes.length only for a line the
         splitter cut at its cap, which is then measured on what was kept. */
      add: function (lineBytes, byteLength, hadCR, text, contentLength) {
        var n = lineBytes.length, i;
        var full = (typeof contentLength === "number" && contentLength > n) ? contentLength : n;
        lines++;
        bytes += byteLength;      // terminator included: this is what reconciles against the file
        content += full;          // terminator excluded: this is what an average line is measured on
        if (hadCR) crlf++;
        if (full > n) truncated++;
        if (full === 0) { empty++; return; }
        if (full > longest) longest = full;
        if (full > OVER_LONG) overLong++;
        if (n === 0) return;
        if (typeof text !== "string") {
          for (i = 0; i < n; i++) if (lineBytes[i] >= 0x80) break;
          if (i === n) return;
          text = decodeLine(lineBytes);
        }
        if (text.indexOf("\uFFFD") >= 0 && !decodesCleanly(lineBytes, full > n)) undecodable++;
      },
      setBom: function (n) { bom = n; },
      setBytesRead: function (n) { read = n; },
      result: function () {
        return {
          lines: lines, bytes: bytes, contentBytes: content, bomBytes: bom, bytesRead: read,
          crlfLines: crlf, emptyLines: empty, undecodableLines: undecodable,
          longestLineBytes: longest, overLongLines: overLong, truncatedLines: truncated,
          residual: read - bytes - bom
        };
      }
    };
  }

  /* The sniff needs to see the same width the worker sees, whatever the test
     chunking is, or a one-byte chunking would refuse every file for having no
     newline in its first byte. The head is the first chunk when that is wide
     enough, and otherwise a copy assembled from the leading chunks. */
  function headOf(chunks, want) {
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks[0].length >= want) return chunks[0].subarray(0, want);
    var out = new Uint8Array(want), got = 0, i, c, take;
    for (i = 0; i < chunks.length && got < want; i++) {
      c = chunks[i];
      take = Math.min(c.length, want - got);
      out.set(c.subarray(0, take), got);
      got += take;
    }
    return out;
  }

  /* The whole pipeline over an array of chunks, for tests: the same bytes cut
     at different widths must give the same answer. opts.fileSize stands in
     for File.size and defaults to the bytes given; opts.sniffBytes defaults
     to the worker's chunk width. */
  function runChunks(chunks, opts) {
    opts = opts || {};
    var total = 0, i, c, k;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var fileSize = typeof opts.fileSize === "number" ? opts.fileSize : total;
    var s = sniff(headOf(chunks, Math.min(opts.sniffBytes || SNIFF, total)), fileSize);
    if (!s.ok) return { refused: s };

    var splitter = createSplitter(), stats = createStats();
    var onLine = function (lineBytes, byteLength, hadCR, contentLength) { stats.add(lineBytes, byteLength, hadCR, undefined, contentLength); };
    var skip = s.bomBytes, read = 0;
    stats.setBom(s.bomBytes);
    for (i = 0; i < chunks.length; i++) {
      c = chunks[i];
      read += c.length;
      if (skip > 0) { k = Math.min(skip, c.length); c = c.subarray(k); skip -= k; }
      splitter.push(c, onLine);
    }
    splitter.flush(onLine);
    stats.setBytesRead(read);
    return { result: stats.result() };
  }

  return {
    sniff: sniff,
    createSplitter: createSplitter,
    createStats: createStats,
    decodeLine: decodeLine,
    runChunks: runChunks,
    OVER_LONG_BYTES: OVER_LONG,
    CAP_BYTES: 16000000,
    SNIFF_BYTES: SNIFF
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LCReader;
