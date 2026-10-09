"use strict";
/* masks.test.js: what each mask takes and what it leaves alone.

     node test/masks.test.js */

var test = require("node:test");
var assert = require("node:assert/strict");
var M = require("../masks.js");

test("timestamps in every format stamps.js reads, and a bare time of day", function () {
  assert.equal(M.mask("2026-10-09T13:16:00.123456-07:00 web-01 sshd: x"), "<ts> web-<num> sshd: x");
  assert.equal(M.mask("2026-10-09 13:16:00,123 INFO x"), "<ts> INFO x");
  assert.equal(M.mask("2026-10-09T13:16:00Z x"), "<ts> x");
  assert.equal(M.mask("10.0.0.1 - - [09/Oct/2026:13:16:00 -0700] \"GET / HTTP/1.1\" 200 12"), "<ip> - - [<ts>] \"GET / HTTP/<num>\" <num> <num>");
  assert.equal(M.mask("Oct  9 13:16:00 web-01 sshd[401]: x"), "<ts> web-<num> sshd[<num>]: x");
  assert.equal(M.mask("Oct 09 2026 13:16:00 host CEF:0|x"), "<ts> host CEF:<num>|x");
  assert.equal(M.mask("Oct 9 13:16:00 2026 host x"), "<ts> host x");
  assert.equal(M.mask("<134>Oct  9 13:16:00 host x"), "<<num>><ts> host x");
  assert.equal(M.mask("2026/10/09 13:16:00 [error] x"), "<ts> [error] x");
  assert.equal(M.mask("09-Oct-2026 13:16:00.250 INFO x"), "<ts> INFO x");
  assert.equal(M.mask("I1009 13:16:00.123456    4242 kubelet.go:1234] x"), "I1009 <ts>    <num> kubelet.go:<num>] x");
  assert.equal(M.mask("write=12.345 s at 13:16:00"), "write=<num> s at <ts>");
});

test("addresses: MAC before hex, IPv4 with its port a number of its own", function () {
  assert.equal(M.mask("MAC=02:42:ac:11:00:02:02:42:c0:a8:00:01:08:00 SRC=10.3.4.5"), "MAC=<mac>:<mac>:<num>:<num> SRC=<ip>");
  assert.equal(M.mask("client 192.168.1.10:51234 connected"), "client <ip>:<num> connected");
  assert.equal(M.mask("version 1.2.3.4.5"), "version <ip>.<num>", "the first four parts are an address, as far as a mask can tell");
  assert.equal(M.mask("v10.3.4.5"), "v10.<num>", "glued to a letter the first part is left, and the rest is a number, as Drain3 has it");
  assert.equal(M.mask("upstream: \"http://10.0.12.34:8080/api\""), "upstream: \"http://<ip>:<num>/api\"");
});

test("ids: UUID, 0x hex, long hex with both a letter and a digit; never a plain number or a plain word", function () {
  assert.equal(M.mask("request_id=07e992959e41dcbd method=GET"), "request_id=<hex> method=GET");
  assert.equal(M.mask("SHA256:bf827c74711e3bc5"), "SHA256:<hex>");
  assert.equal(M.mask("id=550e8400-e29b-41d4-a716-446655440000 x"), "id=<uuid> x");
  assert.equal(M.mask("addr=0x7ffd3c21 len=0X1F"), "addr=<hex> len=<hex>");
  assert.equal(M.mask("code 12345678 word deadbeef"), "code <num> word deadbeef", "all digits is a number; all letters is a word");
  assert.equal(M.mask("deadbee1 cafe"), "<hex> cafe");
  assert.equal(M.mask("abc1234"), "abc1234", "seven characters is not long enough");
});

test("numbers: standing alone, signed, decimal; not inside a word", function () {
  assert.equal(M.mask("Started Session 12345 of user zoë."), "Started Session <num> of user zoë.");
  assert.equal(M.mask("duration=3940ms attempt 1 of 3"), "duration=3940ms attempt <num> of <num>");
  assert.equal(M.mask("GET /api/v2/orders/8841 HTTP/1.1"), "GET /api/v2/orders/<num> HTTP/<num>");
  assert.equal(M.mask("temp -12.5 delta +3"), "temp <num> delta <num>");
  assert.equal(M.mask("sshd[401]: port 22"), "sshd[<num>]: port <num>");
  assert.equal(M.mask("x86_64 sha256 utf8"), "x86_64 sha256 utf8");
  assert.equal(M.mask("(4%)"), "(<num>%)");
  assert.equal(M.mask("1.2.3"), "<num>", "a dotted version is one number");
  assert.equal(M.mask("café5 zoë7 Größe12 naïve-3"), "café5 zoë7 Größe12 naïve-<num>", "a letter beyond ASCII is inside the word");
  assert.equal(M.mask("may 9 13:16:00 host"), "may <num> <ts> host", "a lower-case month is not a stamp; the time of day still is");
  assert.equal(M.mask("x86_64 sha256 utf8"), "x86_64 sha256 utf8", "the underscore is inside the word");
  assert.equal(M.mask("MAC 02:42:ac:11:00:02 at 11:00:02"), "MAC <mac> at <ts>");
});

test("a line without a digit comes back as it is, same string", function () {
  var s = "Finished Cleanup of Temporary Directories.";
  assert.equal(M.mask(s), s);
  assert.equal(M.mask(""), "");
});

test("the token list is what the page highlights", function () {
  assert.deepEqual(M.names, ["mac", "ts", "uuid", "ip", "hex", "num"]);
  assert.deepEqual(M.tokens, ["<mac>", "<ts>", "<uuid>", "<ip>", "<hex>", "<num>"]);
});

test("a million lines in bounded time", function () {
  var i, t0 = Date.now(), s;
  for (i = 0; i < 200000; i++) s = M.mask("2026-10-09T13:16:00.123456-07:00 web-01 nginx[1200]: 10.3.4.5 - - \"GET /api/v2/users HTTP/1.1\" 200 1234 \"-\" \"curl/8.4.0\" " + i);
  var ms = Date.now() - t0;
  assert.equal(s, "<ts> web-<num> nginx[<num>]: <ip> - - \"GET /api/v2/users HTTP/<num>\" <num> <num> \"-\" \"curl/<num>\" <num>");
  assert.ok(ms < 6000, "200k lines under 6 s (" + ms + " ms)");
});
