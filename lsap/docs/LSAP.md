# LSAP — the protocol over LoRa

LSAP is the link-level protocol spoken over LoRa between a **node** (a sensor, a
controller…) and a **gateway**. It is deliberately small and says nothing about *what*
the messages mean:

* **this document** — LSAP itself: frame, flags, sequence numbers, ACKs, retries,
  duplicates, channel access;
* [Encryption over LSAP](LSAP-ENC.md) — an optional layer that protects the body;
* each **device's own document** — what that device puts in the body and which messages
  it answers. That belongs to the device's project, not to this library.

Multi-byte fields are **little-endian**. The reference implementations are
[`src/`](../src) (`lsap.h`, `lsap.cpp`, and `lsap_crypto.cpp` for the ESP32's mbedtls; no
Arduino dependency) and [`js/`](../js) (`lsap.js` codec, `link.js` gateway-side endpoint).
They are checked by [`tests/`](../tests); see the [README](../README.md) for using it.

## Frame

```
 0      1     2     3        4 …
+------+-----+-----+--------+------------------+--------------------------+
| type | id  | seq | flags  | body             | trailer (only if ENC)    |
+------+-----+-----+--------+------------------+--------------------------+
 \________ header, always cleartext _______/  \_ opaque to LSAP _/ (see LSAP-ENC)
```

| Field | Meaning |
|-------|---------|
| `type` | Device type: family nibble + type nibble (by convention family `0x7_`, e.g. `0x71`, `0x72`). Says how to read the body; LSAP itself does not interpret it. A receiver ignores types it doesn't handle. |
| `id` | The **node's** ID, in *both* directions. A gateway→node frame carries the target node's ID, a node→gateway frame the sender's. |
| `seq` | 8-bit message sequence number. |
| `flags` | See below. Reserved bits are sent as 0. |
| `body` | The message, opaque to LSAP. By convention its first byte is an opcode, defined per device type. |
| trailer | Present only when `ENC` is set; defined by Encryption over LSAP. |

### Flags

| Bit | Value | Name | Meaning |
|-----|-------|------|---------|
| 0 | `0x01` | **ACK** | This frame is an acknowledgement: "message *seq* was received". |
| 1 | `0x02` | **ENC** | The body is protected and a trailer follows ([LSAP-ENC](LSAP-ENC.md)). |
| 2 | `0x04` | **DOWN** | Direction: gateway → node. Clear = node → gateway. Needed because `id` is always the node's. |
| 3 | `0x08` | **ACKREQ** | The sender wants this message acknowledged. |

A frame with `flags = 0` is a plain node→gateway message that needs no ACK — what a
simple sensor sends.

## Messages, ACKs and retries

* **Fire-and-forget.** A message without `ACKREQ` is not acknowledged and not
  retried. If it is lost, nothing happens. Sensor readings are like this.
* **Acknowledged.** A message with `ACKREQ` is retransmitted by its sender until a
  *valid ACK* arrives. A valid ACK has `ACK` set, the same `id`, the opposite
  direction, and the `seq` of the outstanding message (and, with ENC, a valid MAC).
  Stray or old ACKs are ignored. **ACKs are never themselves acknowledged.**
* **An ACK means "received", nothing more.** It is a link-layer reply, sent at once,
  and never waits for the message to be processed. It is *not* an application
  response (compare a TCP ACK and an HTTP response).
* **Optional piggyback.** An ACK's body is normally empty. It **may** carry one
  message (opcode first), so an application response that is known immediately can
  ride in the ACK. A receiver ignores an ACK body, or an opcode, it doesn't
  understand. Responses are otherwise ordinary messages and are acknowledged like
  any other.
* **Retry policy** (how many tries, how long between them) belongs to the sender and
  is not fixed by LSAP; a sender should back off and add jitter, and must bound its
  airtime. A device type documents its own defaults.

## Sequence numbers and duplicates

* A sender increments `seq` for every **new message**. A retransmission reuses the
  `seq` of the message it repeats. An ACK echoes the `seq` it acknowledges.
* A sender **must never reuse a `seq` within 20 distinct messages.** A gateway talking
  to several nodes should keep one `seq` counter **per node**.
* A receiver keeps the last **10** `seq`s it handled (RAM only, nothing persistent;
  cleared by a reboot). 10 is below the sender's guarantee of 20, so a new message
  can never collide with a cached `seq`.
* **A duplicate is discarded but re-ACKed.** If a message arrives whose `seq` is in
  that list, the receiver does **not** process it again, but sends the ACK again —
  usually the first ACK was lost. If the ACK carried a piggybacked response, the
  same response is sent again. This also neutralises a replayed capture of a recent
  message.
* **Limits.** A recording replayed after 10 newer messages, or after a reboot, is
  accepted again; without [encryption](LSAP-ENC.md) an attacker can also change the
  `seq` of a plaintext frame. LSAP only stops accidental and lazy replays; what a
  device does to bound the damage is up to the device (see its command document).

## Channel access

* Nodes are always listening unless documented otherwise.
* Before an acknowledged message the sender should check the channel
  (channel-activity detection) and back off while it is busy.
* A receiver waits ~150 ms before an ACK so the other side can switch from TX to RX.
* Senders should respect their region's duty cycle (EU: 1 % on 868.0–868.6 MHz,
  10 % on 869.4–869.65 MHz); a sender should enforce an airtime budget.

## Radio parameters

Both ends must use identical settings. Typical defaults for our devices: 868 MHz, SF11,
500 kHz, coding rate 4/5, sync word `0x14`, CRC on, preamble 12 symbols (a CRC is
required for acknowledged messages). At SF11 / 500 kHz a 25–35 byte frame is about
0.2–0.3 s on air.
