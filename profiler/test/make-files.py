#!/usr/bin/env python3
"""make-files.py: writes the profiler's test files and a manifest of the exact
figures the reader must report for each one: {name, bytes (the file size),
lines, lineBytes (the sum of every line's byteLength), crlfLines, emptyLines,
undecodableLines, bomBytes, longestLineBytes, overLongLines, expectRefusal}.

    python3 make-files.py <dir> [--size-mb N]

Standard library only, seeded, so every run writes the same bytes. The
manifest is the oracle for reader.test.js: it is computed here, in Python,
from the same line rules reader.js states in its header (a line ends at LF;
a CR right before the LF is part of the terminator; any other CR is content;
a last line without LF still counts). big.log is written only when
--size-mb is above 0, and its figures are tallied while writing rather than
by re-reading it."""

import argparse
import json
import os
import random

SEED = 20261002

HOSTS = ["web-01", "web-02", "api-07", "db-primary", "cache-3", "edge-fr-1", "worker-12", "bastion"]
PROGS = [("sshd", 400, 65000), ("nginx", 1200, 1300), ("kernel", 0, 0), ("systemd", 1, 1),
         ("postgres", 2000, 32000), ("cron", 500, 60000), ("app", 30000, 31000), ("haproxy", 900, 950)]
USERS = ["deploy", "root", "backup", "ci", "zoë", "françois", "müller", "sørensen", "東京-ops"]
PATHS = ["/api/v2/users", "/health", "/static/app.js", "/login", "/api/v2/orders/8841", "/metrics", "/favicon.ico"]
MONTHS = ["Sep", "Oct"]

TEMPLATES = [
    "Accepted publickey for {user} from {ip} port {port} ssh2: ED25519 SHA256:{hash}",
    "Failed password for invalid user {user} from {ip} port {port} ssh2",
    "Connection closed by {ip} port {port} [preauth]",
    "{ip} - - \"GET {path} HTTP/1.1\" {status} {size} \"-\" \"Mozilla/5.0\"",
    "{ip} - {user} \"POST {path} HTTP/1.1\" {status} {size} \"-\" \"curl/8.4.0\"",
    "TCP: request_sock_TCP: Possible SYN flooding on port {port}. Sending cookies.",
    "Started Session {n} of user {user}.",
    "LOG:  checkpoint complete: wrote {n} buffers ({pct}%); write={ms}.{ms2} s",
    "LOG:  duration: {ms}.{ms2} ms  statement: SELECT * FROM orders WHERE id = {n}",
    "({user}) CMD (/usr/bin/backup --quiet --target /srv/{user})",
    "INFO  order {n} confirmed for {user} in {ms} ms (region eu-west-1, city São Paulo)",
    "WARN  retrying upstream {ip}:{port} after timeout ({ms} ms), attempt {n}",
    "ERROR cache miss storm: {n} misses in {ms} ms, key prefix café:{user}",
    "Server backend/{host} is DOWN, reason: Layer4 timeout, check duration: {ms}ms",
]


def ip(rng):
    return "10.%d.%d.%d" % (rng.randrange(256), rng.randrange(256), rng.randrange(1, 255))


def syslog_line(rng, i):
    prog, lo, hi = rng.choice(PROGS)
    pid = "[%d]" % rng.randint(lo, hi) if hi else ""
    stamp = "%s %2d %02d:%02d:%02d" % (rng.choice(MONTHS), rng.randint(1, 30),
                                        rng.randrange(24), rng.randrange(60), rng.randrange(60))
    body = rng.choice(TEMPLATES).format(
        user=rng.choice(USERS), ip=ip(rng), port=rng.randint(1024, 65535), path=rng.choice(PATHS),
        status=rng.choice([200, 200, 200, 301, 404, 500]), size=rng.randint(80, 90000),
        n=rng.randint(1, 99999), pct=rng.randint(0, 100), ms=rng.randint(0, 9999),
        ms2=rng.randint(0, 999), hash="%016x" % rng.getrandbits(64), host=rng.choice(HOSTS))
    return "%s %s %s%s: %s" % (stamp, rng.choice(HOSTS), prog, pid, body)


def lines(rng, count):
    return [syslog_line(rng, i) for i in range(count)]


def measure(data, bom):
    """The oracle. Splits exactly as reader.js says it does and tallies."""
    body = data[bom:]
    parts = body.split(b"\n")
    last = parts.pop()
    rows = [(p, len(p) + 1, True) for p in parts]
    if last:
        rows.append((last, len(last), False))
    m = dict(lines=0, lineBytes=0, crlfLines=0, emptyLines=0, undecodableLines=0,
             longestLineBytes=0, overLongLines=0, truncatedLines=0)
    for raw, byte_length, terminated in rows:
        had_cr = terminated and raw.endswith(b"\r")
        content = raw[:-1] if had_cr else raw
        m["lines"] += 1
        m["lineBytes"] += byte_length
        if had_cr:
            m["crlfLines"] += 1
        if not content:
            m["emptyLines"] += 1
        if len(content) > m["longestLineBytes"]:
            m["longestLineBytes"] = len(content)
        if len(content) > 64000:   # the reader counts a line over 64 KB, decimal like the site
            m["overLongLines"] += 1
        if len(content) > 16000000:   # past the reader's cap a line is counted, not kept
            m["truncatedLines"] += 1
        try:                        # invalid means the bytes do not decode; a literal U+FFFD is valid
            content.decode("utf-8")
        except UnicodeDecodeError:
            m["undecodableLines"] += 1
    assert m["lineBytes"] + bom == len(data), "the oracle does not reconcile"
    return m


def entry(name, data, bom=0, refusal=None):
    e = dict(name=name, bytes=len(data), bomBytes=bom, expectRefusal=refusal)
    if refusal is None:
        e.update(measure(data, bom))
    else:
        for k in ("lines", "lineBytes", "crlfLines", "emptyLines", "undecodableLines", "longestLineBytes", "overLongLines", "truncatedLines"):
            e[k] = None
    return e


def write_big(path, size_bytes, rng):
    """A pool of distinct lines, cycled with a sequence number, so writing a
    hundred megabytes from Python takes seconds rather than minutes."""
    pool = [l.encode("utf-8") for l in lines(rng, 20000)]
    n = len(pool)
    m = dict(lines=0, lineBytes=0, crlfLines=0, emptyLines=0, undecodableLines=0,
             longestLineBytes=0, overLongLines=0, truncatedLines=0)
    with open(path, "wb") as f:
        i = 0
        while m["lineBytes"] < size_bytes:
            line = pool[i % n] + b" seq=" + str(i).encode("ascii")
            f.write(line + b"\n")
            m["lines"] += 1
            m["lineBytes"] += len(line) + 1
            if len(line) > m["longestLineBytes"]:
                m["longestLineBytes"] = len(line)
            i += 1
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--size-mb", type=int, default=0, help="size of big.log in MB (decimal); 0 skips it")
    args = ap.parse_args()
    os.makedirs(args.dir, exist_ok=True)
    rng = random.Random(SEED)
    manifest = []

    def put(name, data, bom=0, refusal=None):
        with open(os.path.join(args.dir, name), "wb") as f:
            f.write(data)
        manifest.append(entry(name, data, bom, refusal))

    # Plain LF, with multibyte UTF-8 in the lines that name a user or a city.
    put("lf.log", ("\n".join(lines(rng, 2000)) + "\n").encode("utf-8"))

    put("crlf.log", ("\r\n".join(lines(rng, 1500)) + "\r\n").encode("utf-8"))

    bom = b"\xef\xbb\xbf"
    put("bom.log", bom + ("\n".join(lines(rng, 800)) + "\n").encode("utf-8"), bom=3)

    put("nonl.log", "\n".join(lines(rng, 500)).encode("utf-8"))

    # Everything awkward in one file. The terminators are chosen per line, a
    # few lines are empty under each terminator, one line is 100 KB, one has
    # a byte that is not UTF-8, one has a bare CR in the middle, one is just a
    # CR (an empty CRLF line, by the rules above) and one is CR followed by
    # CRLF, whose content is a single CR.
    rows = []
    for i, l in enumerate(lines(rng, 1200)):
        rows.append(l.encode("utf-8") + (b"\r\n" if rng.random() < 0.4 else b"\n"))
        if i % 97 == 0:
            rows.append(b"\n")
        if i % 131 == 0:
            rows.append(b"\r\n")
    rows.insert(300, b"x" * 100000 + b"\n")
    rows.insert(500, b"Oct  2 09:00:00 web-01 app[30001]: bad byte here \xff and a truncated one \xe2\x82\n")
    rows.insert(700, b"Oct  2 09:00:01 web-01 app[30001]: progress 10%\r 20%\r 30% done\n")
    rows.insert(800, b"\r\n")
    # The over-long boundary, decimal: 64,000 bytes is not over, 64,001 is;
    # and a replacement character the writer put there, which is valid UTF-8.
    rows.insert(900, b"y" * 64000 + b"\n")
    rows.insert(901, b"z" * 64001 + b"\r\n")
    rows.insert(902, "Oct  2 09:00:02 web-01 app[30001]: name sanitised upstream: j\ufffdrgen\n".encode("utf-8"))
    rows.insert(900, b"\r\r\n")
    put("mixed.log", b"".join(rows))

    text = "\n".join(lines(rng, 200)) + "\n"
    put("utf16.log", b"\xff\xfe" + text.encode("utf-16-le"), refusal="utf16")

    put("fake.gz", b"\x1f\x8b\x08\x00" + bytes(rng.getrandbits(8) for _ in range(2000)), refusal="gzip")
    put("fake.zip", b"PK\x03\x04" + bytes(rng.getrandbits(8) for _ in range(2000)), refusal="zip")

    raw = bytearray(rng.getrandbits(8) for _ in range(16384))
    raw[100] = 0      # a NUL inside the first 8 KiB, whatever the dice said
    put("binary.bin", bytes(raw), refusal="binary")

    put("empty.log", b"", refusal="empty")

    one = "Oct  2 09:00:00 web-01 sshd[401]: single line, no newline"
    one = one.encode("utf-8")[:50]
    assert len(one) == 50 and b"\n" not in one
    put("oneline.log", one)

    if args.size_mb > 0:
        path = os.path.join(args.dir, "big.log")
        m = write_big(path, args.size_mb * 1000000, rng)
        e = dict(name="big.log", bytes=m["lineBytes"], bomBytes=0, expectRefusal=None)
        e.update(m)
        manifest.append(e)

    with open(os.path.join(args.dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)
        f.write("\n")
    for e in manifest:
        print("%-12s %12s bytes  %s" % (e["name"], format(e["bytes"], ","),
              ("refuse: " + e["expectRefusal"]) if e["expectRefusal"] else "%d lines" % e["lines"]))


if __name__ == "__main__":
    main()
