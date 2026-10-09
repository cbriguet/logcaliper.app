/* masks.js: what is masked before a line goes to Drain.

   Drain clusters by the words that stay the same. A line in which most
   words are a stamp, a host, a pid, an address and a request id has few
   that do, and Drain, which wants 40% of them to agree, founds a cluster
   for nearly every such line. Drain3 answers this with a masker run before
   the tree, and so does this one: the parts that are variable by nature
   are replaced with a named mask, so they count as agreement rather than
   as difference, and the template says what was there.

     <mac>   a hardware address
     <ts>    a timestamp in one of the formats stamps.js reads, or a bare
             time of day
     <uuid>  8-4-4-4-12 hex
     <ip>    an IPv4 address (a port after it is a number of its own)
     <hex>   0x and digits, or at least eight hex digits with a letter and
             a digit among them: a hash, a request id, a container id
     <num>   an integer, a decimal or a dotted version standing on its
             own: not "v2", not "3940ms", not "x86_64", which Drain can
             still wildcard

   The order is the order above: a hardware address before its pairs can
   be a time of day, a stamp before its digits can be numbers, an address
   before its octets can be. A word runs over letters, digits, the
   underscore and anything beyond ASCII, so "request_id=" is a boundary,
   "x86_64" is one word and so is "café5".
   Paths are not masked:
   Drain wildcards a varying path on its own, and a constant path is the
   most informative word in a line. Same shape as reader.js: a global, a
   guarded module.exports, ES5 throughout. */
var LCMasks = (function () {
  "use strict";

  var MON = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  var B = "(^|[\\x00-\\x2F\\x3A-\\x40\\x5B-\\x5E\\x60\\x7B-\\x7F])";   // a boundary that is kept: ASCII that is not a letter, a digit or _
  var E = "(?=[\\x00-\\x2F\\x3A-\\x40\\x5B-\\x5E\\x60\\x7B-\\x7F]|$)"; // a boundary that is not consumed

  var MASKS = [
    { name: "mac", re: new RegExp(B + "([0-9a-f]{2}(?::[0-9a-f]{2}){5})" + E, "gi") },
    { name: "ts", re: new RegExp(B + "(" +
        "\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?: ?(?:Z|z|[+-]\\d{2}:?\\d{2}))?" +     // ISO 8601
        "|\\d{2}/" + MON + "/\\d{4}:\\d{2}:\\d{2}:\\d{2} [+-]\\d{4}" +                                   // Common Log Format, inside its brackets
        "|" + MON + " {1,2}\\d{1,2}(?: (?:19|20)\\d{2})? \\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?: (?:19|20)\\d{2}" + E + ")?" +   // syslog
        "|\\d{4}/\\d{2}/\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?" +                                   // YYYY/MM/DD
        "|\\d{2}-" + MON + "-\\d{4}[ T]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?" +                              // DD-Mon-YYYY
        "|\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?" +                                                            // a time of day
        ")" + E, "g") },
    { name: "uuid", re: new RegExp(B + "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})" + E, "gi") },
    { name: "ip", re: new RegExp(B + "(\\d{1,3}(?:\\.\\d{1,3}){3})" + E, "g") },
    { name: "hex", re: new RegExp(B + "(0x[0-9a-f]+|(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\\d)[0-9a-f]{8,})" + E, "gi") },
    { name: "num", re: new RegExp(B + "([-+]?\\d+(?:\\.\\d+)*)" + E, "g") }
  ];

  MASKS.forEach(function (m) { m.token = "<" + m.name + ">"; m.to = "$1<" + m.name + ">"; });

  /* A line with no digit has nothing to mask: every mask has one. */
  function mask(text) {
    var i;
    if (!/\d/.test(text)) return text;
    for (i = 0; i < MASKS.length; i++) text = text.replace(MASKS[i].re, MASKS[i].to);
    return text;
  }

  return {
    mask: mask,
    names: MASKS.map(function (m) { return m.name; }),
    tokens: MASKS.map(function (m) { return m.token; })
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LCMasks;
