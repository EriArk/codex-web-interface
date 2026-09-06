import assert from "node:assert/strict";
import test from "node:test";
import { GuacParser, instruction } from "../apps/hub/dist/remote.js";

test("Guacamole buffers TCP fragments before inserting websocket keepalives", () => {
  const source =
    instruction("blob", "3", "opaque, image; payload") + instruction("name", "Экран 🖥");
  for (let split = 1; split < source.length; split++) {
    const upstream = new GuacParser(),
      browser = new GuacParser(),
      received = [];
    for (const part of upstream.feed(source.slice(0, split)))
      received.push(...browser.feed(instruction(...part)));
    received.push(...browser.feed(instruction("", "ping", "123")));
    for (const part of upstream.feed(source.slice(split)))
      received.push(...browser.feed(instruction(...part)));
    assert.equal(browser.pending, 0);
    assert.deepEqual(
      received.filter((p) => p[0] !== ""),
      [
        ["blob", "3", "opaque, image; payload"],
        ["name", "Экран 🖥"],
      ],
    );
  }
});
test("Guacamole rejects malformed framing without forwarding partial instructions", () => {
  for (const value of ["x.bad;", "9999999.a;", "1.ax", "1.a1.b;"])
    assert.throws(() => new GuacParser().feed(value));
  const p = new GuacParser();
  assert.deepEqual(p.feed("4.blob,1.0,6.ab"), []);
  assert.ok(p.pending > 0);
  assert.deepEqual(p.feed("cdef;"), [["blob", "0", "abcdef"]]);
});
