'use strict';
// lsap.js — the LSAP library for Node: frame codec + the optional "Encryption over LSAP"
// layer. Device-agnostic. Home: github.com/davidfoliveira/esp32-pzlibs (lsap/js), used as the
// "lsap" npm package (main: js/index.js) — never copied. The C++ counterpart is lsap/src/
// lsap.{h,cpp}. Specs: lsap/docs (LSAP.md, LSAP-ENC.md). Multi-byte fields are little-endian.
const crypto = require('crypto');

const LSAP_VERSION = '1.1.0';
const HDR_LEN = 4;
const NONCE_LEN = 4;
const MAC_LEN = 4;
const SEC_LEN = NONCE_LEN + MAC_LEN;

// Device types carry the device family in the high nibble; a frame is LSAP only if its first
// byte is in this family (lets a gateway tell LSAP from other protocols on the same radio).
const DEVICE_FAMILY = 0x7;
const isLsapType = (type) => (type >> 4) === DEVICE_FAMILY;

const F = Object.freeze({ ACK: 0x01, ENC: 0x02, DOWN: 0x04, ACKREQ: 0x08 });

// Working keys from the configured secret (never sent over the air).
function deriveKeys(secret) {
  const s = Buffer.from(String(secret), 'utf8');
  return {
    enc: crypto.createHmac('sha256', s).update('lsap-enc').digest().subarray(0, 16),
    mac: crypto.createHmac('sha256', s).update('lsap-mac').digest(),
  };
}

// CTR IV: [dir][id][seq][nonce 4 bytes][zeros...] (16 bytes)
function makeIv(flags, id, seq, nonce) {
  const iv = Buffer.alloc(16);
  iv[0] = (flags & F.DOWN) ? 1 : 0;
  iv[1] = id;
  iv[2] = seq;
  nonce.copy(iv, 3, 0, NONCE_LEN);
  return iv;
}

function ctr(keys, iv, data) {
  const c = crypto.createCipheriv('aes-128-ctr', keys.enc, iv);
  return Buffer.concat([c.update(data), c.final()]);
}

function mac4(keys, data) {
  return crypto.createHmac('sha256', keys.mac).update(data).digest().subarray(0, MAC_LEN);
}

// Build a frame. With `keys` the body is encrypted and the nonce + MAC trailer added.
function encode({ type, id, seq, flags = 0, body = Buffer.alloc(0), keys = null, nonce = null }) {
  if (!keys) return Buffer.concat([Buffer.from([type, id, seq, flags & ~F.ENC]), body]);
  flags |= F.ENC;
  nonce = nonce || crypto.randomBytes(NONCE_LEN);
  const head = Buffer.from([type, id, seq, flags]);
  const pre = Buffer.concat([head, ctr(keys, makeIv(flags, id, seq, nonce), body), nonce]);
  return Buffer.concat([pre, mac4(keys, pre)]);
}

// Parse the framing (not the MAC). The device type is not checked: the caller decides which
// types it handles. Returns null for anything shorter than a header.
function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HDR_LEN) return null;
  const flags = buf[3];
  const enc = (flags & F.ENC) !== 0;
  const tail = enc ? SEC_LEN : 0;
  if (buf.length < HDR_LEN + tail) return null;
  const bodyLen = buf.length - HDR_LEN - tail;
  return {
    type: buf[0], id: buf[1], seq: buf[2], flags, enc,
    body: buf.subarray(HDR_LEN, HDR_LEN + bodyLen),
    nonceOff: enc ? HDR_LEN + bodyLen : 0,
    macOff: enc ? HDR_LEN + bodyLen + NONCE_LEN : 0,
  };
}

function verify(buf, f, keys) {
  if (!f.enc) return false;
  return crypto.timingSafeEqual(mac4(keys, buf.subarray(0, f.macOff)), buf.subarray(f.macOff, f.macOff + MAC_LEN));
}

// Plain copy of the body, decrypted when the frame is ENC (verify first!).
function openBody(buf, f, keys) {
  if (!f.enc) return Buffer.from(f.body);
  return ctr(keys, makeIv(f.flags, f.id, f.seq, buf.subarray(f.nonceOff, f.nonceOff + NONCE_LEN)), f.body);
}

module.exports = { LSAP_VERSION, DEVICE_FAMILY, isLsapType, F, HDR_LEN, NONCE_LEN, MAC_LEN, SEC_LEN, deriveKeys, encode, decode, verify, openBody };
