'use strict';
// The gateway-side endpoint (js/link.js) against a small generic peer: retry-until-ACK,
// ACKing and de-duplicating the peer's messages, the encryption layer. Device-agnostic.
const test = require('node:test');
const assert = require('node:assert/strict');
const lsap = require('../../js/lsap');
const { Link } = require('../../js/link');

const T = 0x7A, ID = 3;                       // an arbitrary device type and node id
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const F = lsap.F;

function rig({ key = '', peerKey = key, link = {} } = {}) {
  const sent = [];                            // frames the Link sent (towards the node)
  const got = [];                             // messages the Link delivered upwards
  const l = new Link({ id: ID, type: T, key, send: (b) => sent.push(b), ackTimeoutMs: 30, retries: 2, ackDelayMs: 1, ...link });
  l.on('message', (body, meta) => got.push({ body, meta }));
  const pk = peerKey ? lsap.deriveKeys(peerKey) : null;
  // what the node does: ACK a frame (optionally with a body), or send us something
  const nodeAck = (seq, body) => l.receive(lsap.encode({ type: T, id: ID, seq, flags: F.ACK, body, keys: pk }));
  const nodeSays = (seq, flags, body) => l.receive(lsap.encode({ type: T, id: ID, seq, flags, body, keys: pk }));
  return { l, sent, got, nodeAck, nodeSays };
}
const f = (buf) => lsap.decode(buf);

test('a message is sent with ACKREQ and resolves on the ACK, with a piggybacked body', async () => {
  const r = rig();
  const p = r.l.sendMessage(Buffer.from('0102', 'hex'), 'ctx');
  assert.equal(r.sent.length, 1);
  const fr = f(r.sent[0]);
  assert.equal(fr.type, T); assert.equal(fr.id, ID);
  assert.equal(fr.flags, F.DOWN | F.ACKREQ);
  assert.deepEqual(fr.body, Buffer.from('0102', 'hex'));
  r.nodeAck(fr.seq, Buffer.from('aa', 'hex'));
  const res = await p;
  assert.equal(res.seq, fr.seq); assert.deepEqual(res.response, Buffer.from('aa', 'hex')); assert.equal(res.ctx, 'ctx');
});

test('retries reuse the seq with doubling timeouts, then reject', async () => {
  const r = rig();
  const p = r.l.sendMessage(Buffer.from('01', 'hex'));
  await assert.rejects(p, /not acknowledged after 3 attempts/);
  assert.equal(r.sent.length, 3);
  assert.ok(r.sent.every((b) => b[2] === r.sent[0][2]), 'same seq on every attempt');
});

test('an ACK for another seq, type or node is ignored', async () => {
  const r = rig();
  const p = r.l.sendMessage(Buffer.from('01', 'hex'));
  const seq = f(r.sent[0]).seq;
  r.l.receive(lsap.encode({ type: T, id: ID, seq: (seq + 1) & 0xFF, flags: F.ACK }));
  r.l.receive(lsap.encode({ type: 0x7B, id: ID, seq, flags: F.ACK }));
  r.l.receive(lsap.encode({ type: T, id: ID + 1, seq, flags: F.ACK }));
  r.l.receive(lsap.encode({ type: T, id: ID, seq, flags: F.ACK | F.DOWN }));       // a gateway's own echo
  await wait(5);
  assert.equal(r.l.current.seq, seq, 'still waiting');
  r.nodeAck(seq);
  await p;
});

test('messages go one at a time, in order, each with the next seq', async () => {
  const r = rig();
  const p1 = r.l.sendMessage(Buffer.from('01', 'hex'));
  const p2 = r.l.sendMessage(Buffer.from('02', 'hex'));
  assert.equal(r.sent.length, 1);
  r.nodeAck(f(r.sent[0]).seq); await p1;
  assert.equal(r.sent.length, 2);
  assert.equal(f(r.sent[1]).seq, (f(r.sent[0]).seq + 1) & 0xFF);
  r.nodeAck(f(r.sent[1]).seq); await p2;
});

test('node messages that ask for it are ACKed; repeats are re-ACKed but delivered once', async () => {
  const r = rig();
  r.nodeSays(9, F.ACKREQ, Buffer.from('beef', 'hex'));
  r.nodeSays(9, F.ACKREQ, Buffer.from('beef', 'hex'));                 // our ACK was "lost"
  await wait(10);
  assert.equal(r.got.length, 1);
  assert.deepEqual(r.got[0].body, Buffer.from('beef', 'hex'));
  assert.equal(r.got[0].meta.ackRequested, true);
  assert.equal(r.sent.length, 2, 'ACKed twice');
  for (const b of r.sent) { const a = f(b); assert.equal(a.seq, 9); assert.equal(a.flags, F.DOWN | F.ACK); assert.equal(a.body.length, 0); }
  r.nodeSays(10, F.ACKREQ, Buffer.from('01', 'hex'));                  // a new seq is new
  await wait(10);
  assert.equal(r.got.length, 2);
});

test('fire-and-forget messages are delivered without an ACK', async () => {
  const r = rig();
  r.nodeSays(11, 0, Buffer.from('cafe', 'hex'));
  await wait(10);
  assert.equal(r.got.length, 1);
  assert.equal(r.sent.length, 0);
});

test('with a key: everything is encrypted, and plaintext / wrong-key frames are dropped', async () => {
  const r = rig({ key: 'secret' });
  const p = r.l.sendMessage(Buffer.from('0102', 'hex'));
  const fr = f(r.sent[0]);
  assert.ok(fr.enc && lsap.verify(r.sent[0], fr, lsap.deriveKeys('secret')));
  assert.deepEqual(lsap.openBody(r.sent[0], fr, lsap.deriveKeys('secret')), Buffer.from('0102', 'hex'));
  r.nodeAck(fr.seq); await p;

  r.nodeSays(20, F.ACKREQ, Buffer.from('01', 'hex'));                  // from a peer that has the key: fine
  await wait(10);
  assert.equal(r.got.length, 1);
  const ack = f(r.sent[r.sent.length - 1]);
  assert.ok(ack.enc && (ack.flags & F.ACK), 'our ACK is encrypted too');

  const plain = rig({ key: 'secret', peerKey: '' });                   // peer without the key
  plain.nodeSays(21, F.ACKREQ, Buffer.from('01', 'hex'));
  const wrong = rig({ key: 'secret', peerKey: 'nope!!' });
  wrong.nodeSays(22, F.ACKREQ, Buffer.from('01', 'hex'));
  await wait(10);
  assert.equal(plain.got.length + wrong.got.length, 0);
  assert.equal(plain.sent.length + wrong.sent.length, 0, 'dropped silently: no ACK either');

  const keyless = rig({ key: '', peerKey: 'secret' });                 // an encrypted frame we can't verify
  keyless.nodeSays(23, F.ACKREQ, Buffer.from('01', 'hex'));
  await wait(10);
  assert.equal(keyless.got.length, 0);
});

test('frames of another type or for another node are not ours', async () => {
  const r = rig();
  r.l.receive(lsap.encode({ type: 0x7B, id: ID, seq: 1, flags: F.ACKREQ, body: Buffer.from('01', 'hex') }));
  r.l.receive(lsap.encode({ type: T, id: ID + 1, seq: 1, flags: F.ACKREQ, body: Buffer.from('01', 'hex') }));
  r.l.receive(lsap.encode({ type: T, id: ID, seq: 1, flags: F.DOWN | F.ACKREQ, body: Buffer.from('01', 'hex') }));
  await wait(10);
  assert.equal(r.got.length, 0); assert.equal(r.sent.length, 0);
});
