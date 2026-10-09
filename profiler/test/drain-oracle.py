#!/usr/bin/env python3
"""drain-oracle.py: Drain3 itself, run over a file the way the worker feeds
its own port, so drain.test.js can compare the two cluster by cluster.

    uv run --with drain3 python -I drain-oracle.py <file> [max_clusters]

Prints JSON: a list of {id, template, size} for every cluster the model
holds at the end, in the model's own order, plus the eviction count. The
line rules are reader.js's (LF ends a line, a CR before it is terminator,
a BOM is skipped) and the worker's (an empty line is not fed; a line over
64,000 bytes is not fed; bytes are decoded as UTF-8 with replacement)."""

import json
import sys

from drain3.drain import Drain

OVER_LONG = 64000


def main():
    path = sys.argv[1]
    max_clusters = int(sys.argv[2]) if len(sys.argv) > 2 else None
    with open(path, "rb") as f:
        data = f.read()
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    parts = data.split(b"\n")
    if parts and parts[-1] == b"":
        parts.pop()
    model = Drain(depth=4, sim_th=0.4, max_children=100, max_clusters=max_clusters)
    fed = 0
    for raw in parts:
        if raw.endswith(b"\r"):
            raw = raw[:-1]
        if not raw or len(raw) > OVER_LONG:
            continue
        model.add_log_message(raw.decode("utf-8", errors="replace"))
        fed += 1
    clusters = [{"id": c.cluster_id, "template": c.get_template(), "size": c.size}
                for c in model.id_to_cluster.values()]
    json.dump({"fed": fed, "created": model.clusters_counter, "clusters": clusters}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
