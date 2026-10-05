'use strict';
// link.js — the gateway side of LSAP for ONE node: sequence numbers, retry-until-ACK
// for the messages we send, ACKing + de-duplicating the messages the node sends, and
// the optional encryption layer. Part of the LSAP library (with lsap.js): device-agnostic,
// github.com/davidfoliveira/esp32-pzlibs (lsap/js). See docs/LSAP.md.
//
// Transport-agnostic: the owner supplies `send(frameBuffer)` (the radio bridge) and
// feeds received frames to receive().
const { EventEmitter } = require('events');
const lsap = require('./lsap');

const SEEN_WINDOW = 10;   // remember the last 10 ACKREQ message seqs (sender never reuses one within 20)

class Link extends EventEmitter {
  constructor({ id, type, key = '', send, ackTimeoutMs = 4000, retries = 3, ackDelayMs = 100, log = () => {} }) {
    super();
    this.id = id;
    this.type = type;                 // the LSAP device type of the node we talk to
    this.keys = key ? lsap.deriveKeys(key) : null;
    this.send = send;
    this.ackTimeoutMs = ackTimeoutMs;
    this.retries = retries;
    this.ackDelayMs = ackDelayMs;
    this.log = log;
    this.seq = Math.floor(Math.random() * 256);   // start anywhere; it only has to differ between nearby messages
    this.queue = [];
    this.current = null;
    this.seen = [];
  }

  // Send a message and resolve once the node ACKs it (stop-and-wait, one at a time).
  // Resolves { seq, response } — `response` is a piggybacked body (Buffer) or null.
  // Rejects after the retries are used up. `ctx` is handed back untouched.
  sendMessage(body, ctx = null) {
    return new Promise((resolve, reject) => {
      this.queue.push({ body, ctx, resolve, reject });
      this._pump();
    });
  }

  _nextSeq() { this.seq = (this.seq + 1) & 0xFF; return this.seq; }

  _pump() {
    if (this.current || this.queue.length === 0) return;
    const item = this.queue.shift();
    item.seq = this._nextSeq();
    item.attempts = 0;
    this.current = item;
    this._transmit();
  }

  _transmit() {
    const it = this.current;
    it.attempts++;
    // A retransmission reuses the seq; a fresh nonce is drawn when encrypting.
    this.send(lsap.encode({ type: this.type, id: this.id, seq: it.seq, flags: lsap.F.DOWN | lsap.F.ACKREQ, body: it.body, keys: this.keys }));
    const wait = this.ackTimeoutMs * 2 ** (it.attempts - 1) + Math.random() * this.ackTimeoutMs * 0.1;
    it.timer = setTimeout(() => this._timeout(), wait);
  }

  _timeout() {
    const it = this.current;
    if (!it) return;
    if (it.attempts <= this.retries) {
      this.log(`node ${this.id}: message seq=${it.seq} not ACKed — retry ${it.attempts}/${this.retries}`);
      this._transmit();
    } else {
      this.current = null;
      it.reject(new Error(`node ${this.id}: message seq=${it.seq} not acknowledged after ${it.attempts} attempts`));
      this._pump();
    }
  }

  _ack(seq) {
    const frame = lsap.encode({ type: this.type, id: this.id, seq, flags: lsap.F.DOWN | lsap.F.ACK, keys: this.keys });
    setTimeout(() => this.send(frame), this.ackDelayMs);   // give the node time to switch to RX
  }

  stop() {
    if (this.current && this.current.timer) clearTimeout(this.current.timer);
    this.current = null;
    this.queue = [];
  }

  // A frame from the radio. `meta` = { rssi, snr } when the bridge reports them.
  receive(buf, meta = {}) {
    const f = lsap.decode(buf);
    if (!f || f.type !== this.type || f.id !== this.id) return;   // not ours
    if (f.flags & lsap.F.DOWN) return;                      // our own echo / another gateway
    if (this.keys) {
      if (!f.enc) { this.log(`node ${this.id}: dropped a frame that isn't encrypted (a key is set)`); return; }
      if (!lsap.verify(buf, f, this.keys)) { this.log(`node ${this.id}: dropped a frame with a bad MAC`); return; }
    } else if (f.enc) {
      this.log(`node ${this.id}: dropped an encrypted frame (no key configured)`);
      return;
    }
    const body = lsap.openBody(buf, f, this.keys);

    if (f.flags & lsap.F.ACK) {                             // an ACK of what we sent
      const it = this.current;
      if (it && f.seq === it.seq) {
        clearTimeout(it.timer);
        this.current = null;
        it.resolve({ seq: it.seq, response: body.length ? body : null, ctx: it.ctx });
        this._pump();
      }
      return;
    }

    if (f.flags & lsap.F.ACKREQ) {
      this._ack(f.seq);                                     // always ACK, even a duplicate
      if (this.seen.includes(f.seq)) {                      // a repeat: ACKed again, not processed again
        this.log(`node ${this.id}: duplicate seq=${f.seq} — re-ACKed, discarded`);
        return;
      }
      this.seen.push(f.seq);
      if (this.seen.length > SEEN_WINDOW) this.seen.shift();
    }
    this.emit('message', body, { ...meta, seq: f.seq, ackRequested: (f.flags & lsap.F.ACKREQ) !== 0 });
  }
}

module.exports = { Link };
