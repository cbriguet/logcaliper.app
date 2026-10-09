#!/usr/bin/env python3
"""make-sample.py: writes profiler/sample.log, the file the page offers to a
reader who has no log at hand.

    python3 make-sample.py [path]

Twenty minutes of made-up syslog from a small fleet, rsyslog's high-precision
file format (an ISO 8601 stamp with microseconds and an offset, the host, the
program and its pid), about ten thousand lines. The message templates are
weighted so a handful dominate and a long tail is rare, as in a real log;
three Java exceptions add continuation lines that carry no stamp. Standard
library only and seeded, so every run writes the same bytes."""

import os
import random
import sys
from datetime import datetime, timedelta, timezone

SEED = 20261009
START = datetime(2026, 10, 9, 13, 16, 0, tzinfo=timezone(timedelta(hours=-7)))
MINUTES = 20
LINES = 10000

HOSTS = ["web-01", "web-02", "web-03", "api-07", "api-08", "db-primary", "db-replica", "cache-3", "edge-fr-1", "worker-12", "bastion"]
USERS = ["deploy", "root", "backup", "ci", "zoë", "françois", "müller", "sørensen", "akira", "priya"]
PATHS = ["/api/v2/users", "/health", "/static/app.js", "/login", "/api/v2/orders/8841", "/metrics", "/favicon.ico",
         "/api/v2/orders", "/static/main.css", "/api/v2/search?q=invoice", "/admin", "/.env", "/wp-login.php"]
AGENTS = ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Safari/605.1.15",
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0.0.0 Safari/537.36",
          "curl/8.4.0", "kube-probe/1.31", "Go-http-client/1.1", "python-requests/2.32.3"]
REGIONS = ["eu-west-1", "us-east-1", "ap-northeast-1"]
QUEUES = ["orders", "emails", "invoices", "webhooks"]

# (program, pid low, pid high, template, weight)
TEMPLATES = [
    ("nginx", 1200, 1210, '{ip} - - "GET {path} HTTP/1.1" {status} {size} "-" "{agent}"', 220),
    ("nginx", 1200, 1210, '{ip} - {user} "POST {path} HTTP/1.1" {status} {size} "-" "{agent}"', 60),
    ("nginx", 1200, 1210, 'upstream timed out (110: Connection timed out) while reading response header from upstream, client: {ip}, server: app.example.com, request: "GET {path} HTTP/1.1", upstream: "http://10.0.{n3}.{n3}:8080{path}"', 6),
    ("haproxy", 900, 950, '{ip}:{port} [{n5}] http-in app/{host} {ms}/0/{ms2}/{ms2}/{ms} {status} {size} - - ---- {n3}/{n3}/{n2}/{n2}/0 0/0 "GET {path} HTTP/1.1"', 120),
    ("haproxy", 900, 950, 'Server app/{host} is DOWN, reason: Layer4 timeout, check duration: {ms}ms. {n2} active and 0 backup servers left. 0 sessions active, 0 requeued, 0 remaining in queue.', 2),
    ("haproxy", 900, 950, 'Server app/{host} is UP, reason: Layer7 check passed, code: 200, check duration: {ms2}ms. {n2} active and 0 backup servers online. 0 sessions requeued, 0 total in queue.', 2),
    ("sshd", 400, 65000, 'Accepted publickey for {user} from {ip} port {port} ssh2: ED25519 SHA256:{hash}', 40),
    ("sshd", 400, 65000, 'Failed password for invalid user {user} from {ip} port {port} ssh2', 35),
    ("sshd", 400, 65000, 'Invalid user {user} from {ip} port {port}', 30),
    ("sshd", 400, 65000, 'Connection closed by {ip} port {port} [preauth]', 45),
    ("sshd", 400, 65000, 'Received disconnect from {ip} port {port}:11: Bye Bye [preauth]', 25),
    ("sshd", 400, 65000, 'pam_unix(sshd:session): session opened for user {user}(uid={n4}) by (uid=0)', 20),
    ("sshd", 400, 65000, 'pam_unix(sshd:session): session closed for user {user}', 20),
    ("systemd", 1, 1, 'Started Session {n5} of User {user}.', 30),
    ("systemd", 1, 1, 'session-{n5}.scope: Deactivated successfully.', 28),
    ("systemd", 1, 1, 'Starting Cleanup of Temporary Directories...', 3),
    ("systemd", 1, 1, 'Finished Cleanup of Temporary Directories.', 3),
    ("systemd", 1, 1, 'logrotate.service: Deactivated successfully.', 2),
    ("kernel", 0, 0, '[{n5}.{n6}] TCP: request_sock_TCP: Possible SYN flooding on port {port}. Sending cookies.  Check SNMP counters.', 4),
    ("kernel", 0, 0, '[{n5}.{n6}] IN=eth0 OUT= MAC=02:42:ac:11:00:02:02:42:c0:a8:00:01:08:00 SRC={ip} DST=10.0.{n3}.{n3} LEN={n2} TOS=0x00 PREC=0x00 TTL={n2} ID={n5} DF PROTO=TCP SPT={port} DPT={port} WINDOW={n5} RES=0x00 SYN URGP=0', 50),
    ("kernel", 0, 0, '[{n5}.{n6}] oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/system.slice/app.service,task=java,pid={n5},uid={n4}', 1),
    ("postgres", 2000, 32000, 'LOG:  checkpoint complete: wrote {n4} buffers ({pct}%); 0 WAL file(s) added, 0 removed, {n2} recycled; write={ms}.{ms2} s, sync=0.{ms2} s, total={ms}.{ms2} s', 6),
    ("postgres", 2000, 32000, 'LOG:  duration: {ms}.{ms2} ms  statement: SELECT * FROM orders WHERE customer_id = {n5} ORDER BY created_at DESC LIMIT 50', 40),
    ("postgres", 2000, 32000, 'LOG:  duration: {ms}.{ms2} ms  execute <unnamed>: UPDATE sessions SET last_seen = now() WHERE id = $1', 30),
    ("postgres", 2000, 32000, 'ERROR:  deadlock detected', 1),
    ("postgres", 2000, 32000, 'LOG:  automatic vacuum of table "app.public.events": index scans: 1, pages: 0 removed, {n5} remain, {n4} scanned ({pct}% of total)', 4),
    ("cron", 500, 60000, '({user}) CMD (/usr/bin/backup --quiet --target /srv/{user})', 12),
    ("cron", 500, 60000, '({user}) CMD (/usr/lib/sysstat/sa1 1 1)', 10),
    ("app", 30000, 31000, 'INFO  order {n5} confirmed for {user} in {ms} ms (region {region}, queue {queue})', 90),
    ("app", 30000, 31000, 'INFO  request_id={hash} method=GET path={path} status={status} duration={ms}ms', 160),
    ("app", 30000, 31000, 'WARN  retrying upstream {ip}:{port} after timeout ({ms} ms), attempt {n1} of 3', 14),
    ("app", 30000, 31000, 'WARN  slow query ({ms} ms): SELECT count(*) FROM events WHERE created_at > now() - interval \'{n2} minutes\'', 10),
    ("app", 30000, 31000, 'ERROR cache miss storm: {n4} misses in {ms} ms, key prefix session:{user}', 3),
    ("app", 30000, 31000, 'ERROR payment declined for order {n5}: card_declined (code {n2}), customer notified', 5),
    ("app", 30000, 31000, 'INFO  worker {n2} picked job {hash} from queue {queue}', 70),
    ("app", 30000, 31000, 'INFO  worker {n2} finished job {hash} in {ms} ms', 70),
    ("app", 30000, 31000, 'DEBUG cache hit ratio {pct}% over the last minute ({n5} lookups)', 20),
    ("app", 30000, 31000, 'INFO  health check ok: db {ms2} ms, cache {ms2} ms, queue depth {n2}', 40),
    ("dockerd", 700, 700, 'time="{iso}" level=info msg="Container {hash} exited with code 0"', 8),
    ("dockerd", 700, 700, 'time="{iso}" level=warning msg="Health check for container {hash} error: context deadline exceeded"', 3),
    ("kubelet", 800, 800, 'I1009 {hms}.{n6}    {n4} kubelet.go:{n4}] "Pod is terminating, skipping pod status update" pod="default/api-{hash}"', 6),
    ("kubelet", 800, 800, 'E1009 {hms}.{n6}    {n4} pod_workers.go:{n4}] "Error syncing pod, skipping" err="failed to \\"StartContainer\\" for \\"api\\" with CrashLoopBackOff" pod="default/api-{hash}"', 2),
    ("ntpd", 300, 300, 'kernel reports TIME_ERROR: 0x41: Clock Unsynchronized', 1),
    ("sudo", 0, 0, '{user} : TTY=pts/0 ; PWD=/home/{user} ; USER=root ; COMMAND=/usr/bin/systemctl restart app.service', 3),
    ("audit", 0, 0, 'type=USER_LOGIN msg=audit({epoch}.{ms2}:{n5}): pid={n5} uid=0 auid={n4} ses={n3} msg=\'op=login id={n4} exe="/usr/sbin/sshd" hostname=? addr={ip} terminal=/dev/pts/0 res=success\'', 15),
]

EXCEPTION = [
    'ERROR unhandled exception in worker {n2} while processing job {hash}',
    'java.lang.NullPointerException: Cannot invoke "com.example.billing.Invoice.getTotal()" because "invoice" is null',
    '\tat com.example.billing.InvoiceService.charge(InvoiceService.java:{n3})',
    '\tat com.example.billing.InvoiceService.process(InvoiceService.java:{n2})',
    '\tat com.example.jobs.Worker.run(Worker.java:{n3})',
    '\tat java.base/java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1136)',
    '\tat java.base/java.util.concurrent.ThreadPoolExecutor$Worker.run(ThreadPoolExecutor.java:635)',
    '\tat java.base/java.lang.Thread.run(Thread.java:840)',
]


def ip(rng):
    return "%d.%d.%d.%d" % (rng.choice([10, 172, 192, 203, 45, 91]), rng.randrange(256), rng.randrange(256), rng.randrange(1, 255))


def fill(rng, template, when):
    return template.format(
        user=rng.choice(USERS), ip=ip(rng), port=rng.randint(1024, 65535), path=rng.choice(PATHS),
        status=rng.choice([200, 200, 200, 200, 200, 204, 301, 302, 401, 404, 404, 500, 502]),
        size=rng.randint(80, 90000), agent=rng.choice(AGENTS), host=rng.choice(HOSTS),
        region=rng.choice(REGIONS), queue=rng.choice(QUEUES),
        n1=rng.randint(1, 3), n2=rng.randint(10, 99), n3=rng.randint(100, 999), n4=rng.randint(1000, 9999),
        n5=rng.randint(10000, 99999), n6="%06d" % rng.randrange(1000000), pct=rng.randint(0, 100),
        ms=rng.randint(0, 9999), ms2=rng.randint(0, 999), hash="%016x" % rng.getrandbits(64),
        iso=when.strftime("%Y-%m-%dT%H:%M:%S.") + "%06d" % when.microsecond + when.strftime("%z")[:3] + ":" + when.strftime("%z")[3:],
        hms=when.strftime("%H:%M:%S"), epoch=int(when.timestamp()))


def stamp(when):
    z = when.strftime("%z")
    return when.strftime("%Y-%m-%dT%H:%M:%S.") + "%06d" % when.microsecond + z[:3] + ":" + z[3:]


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "sample.log")
    rng = random.Random(SEED)
    weights = [t[4] for t in TEMPLATES]
    span = MINUTES * 60.0
    # Arrival times: uniform over the window, sorted, so the rate is steady
    # and the span is the window; three exceptions at fixed points.
    times = sorted(rng.uniform(0, span) for _ in range(LINES))
    exceptions = {int(LINES * 0.31), int(LINES * 0.58), int(LINES * 0.9)}
    out = []
    for i, t in enumerate(times):
        when = START + timedelta(seconds=t)
        prog, lo, hi, template, _ = rng.choices(TEMPLATES, weights)[0]
        pid = "[%d]" % rng.randint(lo, hi) if hi else ""
        host = rng.choice(HOSTS)
        if i in exceptions:
            head = fill(rng, EXCEPTION[0], when)
            out.append("%s %s app[30007]: %s" % (stamp(when), host, head))
            for frame in EXCEPTION[1:]:
                out.append(fill(rng, frame, when))
            continue
        out.append("%s %s %s%s: %s" % (stamp(when), host, prog, pid, fill(rng, template, when)))
    data = ("\n".join(out) + "\n").encode("utf-8")
    with open(path, "wb") as f:
        f.write(data)
    print("%s: %s lines, %s bytes, %s to %s" % (path, format(len(out), ","), format(len(data), ","), stamp(START), stamp(START + timedelta(seconds=times[-1]))))


if __name__ == "__main__":
    main()
