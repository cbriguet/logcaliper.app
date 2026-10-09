/* drain.js: message templates for the Logcaliper profiler.

   A port of Drain (He et al., 2017) as Drain3 implements it: drain.py in
   logpai/Drain3, MIT, checked line by line against HyperDX's TypeScript port
   of the same file. The algorithm is unchanged. A line is split on
   whitespace; its token count picks the first level of a prefix tree; its
   first tokens pick a leaf, a token with a digit in it taking the wildcard
   branch; the line joins the leaf's most similar cluster when at least 40%
   of the tokens agree, or founds a new one. Where the line and the cluster's
   template disagree, the template gets a wildcard, "<*>". The template of a
   cluster with one line in it is that line, as in Drain3.

   Two things are added for the profiler. A cluster keeps the bytes of the
   lines it holds, so the result can say what each template weighs. And a
   capped model tells its owner what it forgets: the cap works as Drain3's
   LogClusterCache does, least recently used first, where "used" means
   founding a cluster or adding a line to it (a candidate looked at and not
   chosen is not used), and every evicted cluster is handed to onEvict, so
   the worker folds it into an "Other" row rather than losing its lines.

   Differences from drain.py, all deliberate and all small. A token "has
   numbers" when it has an ASCII digit (Python's isdigit also takes other
   scripts' digits). Whitespace is what JavaScript's \s is (Python's split()
   also cuts at the separator controls 0x1C to 0x1F and at NEL, and does not
   cut at U+FEFF). A node's children are a Map, so a token spelt "__proto__"
   or "constructor" is a token like any other. A template is updated in
   place, which comes to the same thing as Drain3's new tuple. clusters()
   lists a capped model in use order, where Drain3's dict keeps insertion
   order; the worker sorts them anyway. The search for a line's cluster
   stops at the first template it matches word for word, since with
   wildcards not counting nothing can beat or out-tie a full match; the
   answer is the same and a repeated line costs one comparison. A line is
   clustered on its first maxTokens words (none by default; the worker sets
   500), the rest standing as one closing "…" token, so a template can never
   weigh more than a long line's head. onEvict is called once the new
   cluster is in place and must not add lines itself.

   Same shape as reader.js: a global for the worker and the page, a guarded
   module.exports for the Node tests, ES5 syntax throughout. */
var LCDrain = (function () {
  "use strict";

  function Node() {
    this.children = new Map();   // token -> Node
    this.clusterIds = [];        // filled at a leaf only
  }

  function hasNumbers(s) {
    var i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c >= 48 && c <= 57) return true;
    }
    return false;
  }

  /* Options and their Drain3 defaults: depth 4, simTh 0.4, maxChildren 100,
     maxClusters none (0 here), paramStr "<*>", parametrizeNumericTokens
     true, extraDelimiters none; onEvict(cluster) is the profiler's own. */
  function createDrain(opts) {
    opts = opts || {};
    var depth = opts.depth === undefined ? 4 : opts.depth;
    var simTh = opts.simTh === undefined ? 0.4 : opts.simTh;
    var maxChildren = opts.maxChildren === undefined ? 100 : opts.maxChildren;
    var maxClusters = (opts.maxClusters === undefined || opts.maxClusters === null) ? 0 : opts.maxClusters;
    var paramStr = opts.paramStr === undefined ? "<*>" : String(opts.paramStr);
    var numeric = opts.parametrizeNumericTokens === undefined ? true : !!opts.parametrizeNumericTokens;
    var delimiters = opts.extraDelimiters || [];
    var onEvict = typeof opts.onEvict === "function" ? opts.onEvict : null;
    var maxTokens = opts.maxTokens > 0 ? Math.floor(opts.maxTokens) : 0;
    if (!(depth >= 3)) throw new Error("depth must be at least 3");
    if (!(maxChildren >= 1)) throw new Error("maxChildren must be at least 1");
    var maxNodeDepth = depth - 2;
    var root = new Node();
    /* id -> cluster. With a cap the Map's own order is the use order, least
       recently used first: a touch deletes and re-sets, an eviction takes
       the first key. Without a cap it is insertion order. */
    var clusters = new Map();
    var counter = 0, evicted = 0, lastParams = 0;

    function peek(id) { return clusters.get(id); }

    function touch(id) {
      if (!maxClusters) return;
      var c = clusters.get(id);
      if (c === undefined) return;
      clusters.delete(id);
      clusters.set(id, c);
    }

    /* cachetools evicts until the new entry fits, then inserts it; the
       stale id stays in its leaf until the leaf next takes a cluster. The
       evicted clusters are returned, to be handed over once the model is
       whole again. */
    function insert(cluster) {
      var oldest, gone = [];
      if (maxClusters) {
        while (clusters.size >= maxClusters) {
          oldest = clusters.keys().next().value;
          gone.push(clusters.get(oldest));
          clusters.delete(oldest);
          evicted++;
        }
      }
      clusters.set(cluster.id, cluster);
      return gone;
    }

    function tokensOf(content) {
      var s = String(content).trim(), i, out;
      for (i = 0; i < delimiters.length; i++) s = s.split(delimiters[i]).join(" ");
      s = s.trim();   // a delimiter at either end would otherwise leave an empty token
      if (s.length === 0) return [];
      out = s.split(/\s+/);
      if (maxTokens && out.length > maxTokens) { out.length = maxTokens; out.push("\u2026"); }
      return out;
    }

    /* The share of the template's tokens the line agrees with; a wildcard
       counts only when includeParams. The wildcard count is left in
       lastParams for the tie-break, as the Python returns it beside. */
    function seqDistance(template, tokens, includeParams) {
      var n = template.length, i, sim = 0, params = 0;
      lastParams = 0;
      if (n === 0) return 1;
      for (i = 0; i < n; i++) {
        if (template[i] === paramStr) { params++; continue; }
        if (template[i] === tokens[i]) sim++;
      }
      if (includeParams) sim += params;
      lastParams = params;
      return sim / n;
    }

    function fastMatch(ids, tokens, th, includeParams) {
      var i, c, sim, best = null, bestSim = -1, bestParams = -1;
      for (i = 0; i < ids.length; i++) {
        c = peek(ids[i]);
        if (c === undefined) continue;   // evicted: the leaf still names it
        sim = seqDistance(c.tokens, tokens, includeParams);
        if (sim > bestSim || (sim === bestSim && lastParams > bestParams)) {
          bestSim = sim; bestParams = lastParams; best = c;
          if (sim === 1 && !includeParams) break;   // word for word, with no wildcard: nothing later can win
        }
      }
      return bestSim >= th ? best : null;
    }

    function treeSearch(tokens, th, includeParams) {
      var n = tokens.length, node = root.children.get(String(n)), i, next, d;
      if (node === undefined) return null;
      if (n === 0) return node.clusterIds.length ? (peek(node.clusterIds[0]) || null) : null;
      d = 1;
      for (i = 0; i < n; i++) {
        if (d >= maxNodeDepth) break;
        if (d === n) break;
        next = node.children.get(tokens[i]);
        if (next === undefined) next = node.children.get(paramStr);
        if (next === undefined) return null;
        node = next;
        d++;
      }
      return fastMatch(node.clusterIds, tokens, th, includeParams);
    }

    function addToTree(cluster) {
      var tokens = cluster.tokens, n = tokens.length, key = String(n);
      var node = root.children.get(key), i, j, t, next, kept, d;
      if (node === undefined) { node = new Node(); root.children.set(key, node); }
      if (n === 0) { node.clusterIds = [cluster.id]; return; }
      d = 1;
      for (i = 0; i < n; i++) {
        t = tokens[i];
        if (d >= maxNodeDepth || d >= n) {
          /* At the leaf. Ids whose clusters were evicted are dropped here,
             and only here, as Drain3 does. */
          kept = [];
          for (j = 0; j < node.clusterIds.length; j++) if (clusters.has(node.clusterIds[j])) kept.push(node.clusterIds[j]);
          kept.push(cluster.id);
          node.clusterIds = kept;
          break;
        }
        next = node.children.get(t);
        if (next === undefined) {
          if (numeric && hasNumbers(t)) {
            next = node.children.get(paramStr);
            if (next === undefined) { next = new Node(); node.children.set(paramStr, next); }
          } else if (node.children.has(paramStr)) {
            if (node.children.size < maxChildren) { next = new Node(); node.children.set(t, next); }
            else next = node.children.get(paramStr);
          } else if (node.children.size + 1 < maxChildren) {
            next = new Node(); node.children.set(t, next);
          } else {
            /* The last free slot goes to the wildcard, and a fuller node
               (which the two branches above make unreachable) would take it. */
            next = node.children.get(paramStr);
            if (next === undefined) { next = new Node(); node.children.set(paramStr, next); }
          }
        }
        node = next;
        d++;
      }
    }

    /* The line joins its cluster or founds one. bytes is what the line
       weighs, content only, as the profiler counts it. */
    function add(content, bytes) {
      var tokens = tokensOf(content), c = treeSearch(tokens, simTh, false), i, changed = false, gone;
      bytes = +bytes > 0 ? +bytes : 0;
      if (c === null) {
        c = { id: ++counter, tokens: tokens, size: 1, bytes: bytes };
        gone = insert(c);
        addToTree(c);
        if (onEvict) for (i = 0; i < gone.length; i++) onEvict(gone[i]);
        return { cluster: c, change: "cluster_created" };
      }
      for (i = 0; i < tokens.length; i++) {
        if (c.tokens[i] !== tokens[i] && c.tokens[i] !== paramStr) { c.tokens[i] = paramStr; changed = true; }
      }
      c.size++;
      c.bytes += bytes;
      touch(c.id);
      return { cluster: c, change: changed ? "cluster_template_changed" : "none" };
    }

    /* Drain3's match(): the cluster a line fits exactly, wildcards counting
       as matches, without changing the model. "never" trusts the tree,
       "fallback" scans every cluster of that token count when the tree finds
       nothing, "always" scans them all. */
    function match(content, strategy) {
      strategy = strategy || "never";
      if (strategy !== "never" && strategy !== "fallback" && strategy !== "always") throw new Error("unknown strategy " + strategy);
      var tokens = tokensOf(content), c;
      function full() {
        var ids = [], first = root.children.get(String(tokens.length));
        if (first === undefined) return null;
        (function collect(node) {
          var i;
          for (i = 0; i < node.clusterIds.length; i++) ids.push(node.clusterIds[i]);
          node.children.forEach(function (child) { collect(child); });
        })(first);
        return fastMatch(ids, tokens, 1, true);
      }
      if (strategy === "always") return full();
      c = treeSearch(tokens, 1, true);
      if (c !== null) return c;
      return strategy === "never" ? null : full();
    }

    function list() {
      var out = [];
      clusters.forEach(function (c) { out.push(c); });
      return out;
    }

    function totalSize() {
      var n = 0;
      clusters.forEach(function (c) { n += c.size; });
      return n;
    }

    return {
      add: add,
      match: match,
      tokensOf: tokensOf,
      template: function (c) { return c.tokens.join(" "); },
      clusters: list,
      count: function () { return clusters.size; },
      evicted: function () { return evicted; },
      totalSize: totalSize,
      paramStr: paramStr
    };
  }

  return { createDrain: createDrain, hasNumbers: hasNumbers };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LCDrain;
