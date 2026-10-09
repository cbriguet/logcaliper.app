# The Logcaliper profiler

A log file, read in the browser, comes back as the figures a SIEM or log
platform is sized on: how many lines and how long they run, the message
templates behind them, the events per second over the time the sample
covers, and what a year of it takes to keep. Live at
[logcaliper.app/profiler/](https://logcaliper.app/profiler/).

Nothing leaves the browser. The page is static, has no analytics and no
upload; its Content Security Policy allows no connection but to its own
origin, and the worker that reads the file never calls `fetch`. Open the
Network panel while it runs: nothing goes to any server. The one request
the page makes after load is the sample, on request, and that is a GET of a
static file from this site before the run starts.

## The pieces

| File | What it does |
|---|---|
| `index.html` | The page: the picker, the progress bar, the result card, the estimator, the template table, the downloads. Builds the worker from the scripts below as one blob, so it runs under the page's own policy. |
| `worker.js` | Reads the file in 8 MB chunks off the page's thread, decodes each line once and feeds it to the three measurers; posts progress every 100 ms and the result at the end. |
| `reader.js` | Lines and bytes. A line ends at LF; a CR before it is terminator; the last line needs none. Every line's bytes are counted, terminator included, so the total reconciles against the file's size. Refuses UTF-16, gzip, zip, binary and single-line files with a remedy for each. |
| `masks.js` | What is masked before clustering: timestamps, hardware addresses, UUIDs, IPv4 addresses, hex ids and numbers, each with a named mask, so a template says what was there. |
| `drain.js` | Drain (He et al., 2017), a port of Drain3's `drain.py` checked against HyperDX's TypeScript port: a prefix tree keyed on the token count and the first tokens, a 40% similarity threshold, wildcards where lines differ. Keeps 4,000 templates; past that the least recently used is folded into an Other row rather than lost. |
| `stamps.js` | The time the sample covers. Picks a timestamp format on the first 200 lines (ISO 8601, Common Log Format, syslog, YYYY/MM/DD, DD-Mon-YYYY, Unix epoch), reads every line with it, and gives the stamped lines per second over the span from the earliest to the latest. |
| `estimate.js` | The arithmetic of the app's Storage tab: events per second × bytes per event × retention, with compression, replication and a cluster's intermediate share, and the node count. |
| `sample.log` | Twenty minutes of made-up syslog from a small fleet, for a reader with no log at hand. Written by `test/make-sample.py`. |

Every script is ES5 with Promises, for Safari 16.4 and up, and defines one
global with a guarded `module.exports`, so the same file runs in the
worker, in the page and under Node's test runner.

## The tests

Plain Node, no dependencies, from the repository root:

```
node profiler/test/reader.test.js profiler/test/files
node profiler/test/adversarial.test.js
node profiler/test/masks.test.js
node profiler/test/drain.test.js profiler/test/files
node profiler/test/stamps.test.js
node profiler/test/estimate.test.js
node profiler/test/page.test.js
```

`make-files.py` writes the fixtures and a manifest of the exact figures
each must report, computed in Python from the same line rules; the reader
suite runs every fixture at four chunk widths and the answers must be
identical. `drain.test.js` carries Drain3's own tests over unchanged, then
runs Drain3 itself on the fixtures through `drain-oracle.py` (with `uv`)
and compares cluster by cluster, with and without the cap. `page.test.js`
pins the page's chrome, policy and copy, and refuses any URL that is not
one of its own metas.

## What a result holds

`schemaVersion` 1, since the first release: `file`, `totals` (lines,
bytes, average and longest line), `counters` (empty, invalid UTF-8, CRLF,
over 64 KB, over 16 MB), `timing`, `reconciliation`; since the second,
`templates` (every live cluster with its lines and bytes, the Other row,
the cap and the eviction count) and `time` (the format, the stamped and
unstamped lines, the first and last stamps as written, the span and the
rate). The JSON download is this object as it is.
