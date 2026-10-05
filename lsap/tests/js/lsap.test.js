'use strict';
// The LSAP library (src/lsap.js): framing and the optional encryption layer. Device-agnostic.
const test = require('node:test');
const assert = require('node:assert/strict');
const lsap = require('../../js/lsap');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const keys = lsap.deriveKeys('secret');
const BODY = hex('01 02 01 58 02');          // arbitrary example bytes
const T = 0x72;

// These frames were produced by the C++ library (src/lsap.cpp); the first one was also
// cross-checked with Python's hmac + `openssl enc -aes-128-ctr`.
test('encrypted frame matches the C++ known-answer frame', () => {
  const frame = lsap.encode({ type: T, id: 7, seq: 42, flags: lsap.F.DOWN | lsap.F.ACKREQ, body: BODY, keys, nonce: hex('01020304') });
  assert.equal(frame.toString('hex'), '72072a0ebb94bd106601020304951103e4');
  const f = lsap.decode(frame);
  assert.ok(f.enc && lsap.verify(frame, f, keys));
  assert.deepEqual(lsap.openBody(frame, f, keys), BODY);
});

test('plain frames are header + body', () => {
  const frame = lsap.encode({ type: T, id: 7, seq: 42, flags: lsap.F.DOWN | lsap.F.ACKREQ, body: BODY });
  assert.equal(frame.toString('hex'), '72072a0c0102015802');
});

test('an ACK is just the header; encrypted it is header + nonce + MAC (C++ frames)', () => {
  assert.equal(lsap.encode({ type: T, id: 7, seq: 42, flags: lsap.F.ACK }).toString('hex'), '72072a01');
  const enc = lsap.encode({ type: T, id: 7, seq: 9, flags: lsap.F.DOWN | lsap.F.ACK, keys, nonce: hex('55667788') });
  assert.equal(enc.toString('hex'), '7207090755667788030bb332');
});

test('an encrypted ACK carrying a body matches the C++ frame', () => {
  const body = hex('82 2A 01 00 02 00 00 00');
  const frame = lsap.encode({ type: T, id: 7, seq: 42, flags: lsap.F.ACK, body, keys, nonce: hex('A1B2C3D4') });
  assert.equal(frame.toString('hex'), '72072a031bf8a1983bfae35ea1b2c3d48624654e');
  const f = lsap.decode(frame);
  assert.ok(lsap.verify(frame, f, keys));
  assert.deepEqual(lsap.openBody(frame, f, keys), body);
});

test('any altered byte of an encrypted frame fails the MAC; a wrong key too', () => {
  const frame = lsap.encode({ type: T, id: 7, seq: 42, flags: lsap.F.DOWN | lsap.F.ACKREQ, body: BODY, keys });
  for (let i = 0; i < frame.length; i++) for (let b = 0; b < 8; b++) {
    const t = Buffer.from(frame); t[i] ^= 1 << b;
    const f = lsap.decode(t);
    if (!f || !f.enc) continue;                       // mangled ENC flag: rejected earlier
    assert.equal(lsap.verify(t, f, keys), false, `byte ${i} bit ${b}`);
  }
  assert.equal(lsap.verify(frame, lsap.decode(frame), lsap.deriveKeys('wrong!')), false);
});

test('direction and nonce change the keystream', () => {
  const a = lsap.encode({ type: T, id: 7, seq: 42, flags: lsap.F.DOWN, body: BODY, keys, nonce: hex('01020304') });
  const b = lsap.encode({ type: T, id: 7, seq: 42, flags: lsap.F.DOWN, body: BODY, keys, nonce: hex('09090909') });
  const c = lsap.encode({ type: T, id: 7, seq: 42, flags: 0, body: BODY, keys, nonce: hex('01020304') });
  assert.notDeepEqual(a.subarray(4, 9), b.subarray(4, 9));
  assert.notDeepEqual(a.subarray(4, 9), c.subarray(4, 9));
});

test('LSAP does not care about the device type; it rejects only what is not a frame', () => {
  assert.equal(lsap.decode(hex('71 07 01 00 00')).type, 0x71);      // another device's frame still parses
  assert.equal(lsap.decode(hex('9A 07 01 00')).type, 0x9a);
  assert.equal(lsap.decode(hex('72 07 01')), null);                  // shorter than a header
  assert.equal(lsap.decode(hex('72 07 01 02 00 00')), null);         // ENC but no room for the trailer
});

test('the library is versioned', () => {
  assert.match(lsap.LSAP_VERSION, /^\d+\.\d+\.\d+$/);
});
