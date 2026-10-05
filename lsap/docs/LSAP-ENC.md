# Encryption over LSAP

An optional layer on top of [LSAP](LSAP.md). It encrypts a frame's **body** and adds
a MAC over the **whole frame**. LSAP itself is unchanged: sequence numbers, ACKs,
retries and duplicate handling work the same with or without it. It is signalled by
the `ENC` bit (`0x02`) in the flags byte and needs a shared secret on both ends.

* **No secret configured (default):** no ENC flag, no trailer, plaintext. Anyone in
  radio range can read and send frames.
* **Secret configured:** every frame is protected. A receiver with a secret **drops
  any frame without ENC or with a wrong MAC** — gateway ACKs included, so the gateway
  needs the secret too. A receiver without a secret drops ENC frames (it cannot
  verify them).

## Frame

```
 0      1     2     3        4 …                 n-8        n-4         n
+------+-----+-----+--------+-------------------+----------+-----------+
| type | id  | seq | flags  | body (encrypted)  | nonce    | MAC       |
+------+-----+-----+--------+-------------------+----------+-----------+
 \_____ cleartext ________/   \_ AES-128-CTR _/  4 random    4 bytes
                              same length         bytes
```

* The **header** (`type, id, seq, flags`) stays cleartext — a gateway can route and
  match ACKs without the key — but is covered by the MAC.
* The **body** is scrambled in place: same length, no padding.
* The **trailer** adds 8 bytes: a 4-byte random **nonce** (cleartext) and a 4-byte
  **MAC**. It is present even when the body is empty (a bare ACK still carries it, so
  ACKs can't be forged to stop a sender's retries).

## Keys

The secret string is never sent. Both sides derive two keys from it:

```
encKey = HMAC-SHA256(secret, "lsap-enc")[0..16]    (AES-128 key)
macKey = HMAC-SHA256(secret, "lsap-mac")           (32 bytes)
```

## Encrypting

```
IV         = [dir][id][seq][nonce 4 bytes][zeros …]       (16 bytes)
ciphertext = body XOR AES-128-CTR(encKey, IV)
MAC        = HMAC-SHA256(macKey, header ‖ ciphertext ‖ nonce)[0..4]
```

* `dir` is 1 when the `DOWN` flag is set, else 0; the zeroed tail is the big-endian
  AES block counter. `flags` in the header already includes `ENC` when the MAC is
  computed.
* The **nonce** must be fresh random bytes for every frame. `seq` alone cannot serve
  because it wraps every 256 messages, and reusing a keystream would leak the XOR of
  two bodies. A retransmission gets a new nonce.

## Receiving — order matters

1. Parse the header (cleartext).
2. Check the **MAC**; drop the frame on failure.
3. Hand it to LSAP: duplicate/replay check (re-ACK a repeat), ACK matching.
4. **Decrypt** the body and pass it to the application.

The MAC check comes before LSAP's duplicate cache so forged frames cannot fill the
cache with fake `seq`s and make real messages look like duplicates.

## What it does and doesn't give you

* Hides the body (whatever the device puts in it) and rejects any frame that
  was altered — including its cleartext `id`, `seq` and flags — or forged without the
  secret.
* The MAC is 32 bits: it stops accidental and casual forgery, not an attacker with
  unlimited attempts at line rate (each try costs real airtime).
* Replay protection is LSAP's duplicate cache (last 10 `seq`s): a *recorded* frame
  replayed after 10 newer messages, or after a node reboot, is accepted again, and
  the device must bound the damage (design messages to be idempotent and have the device
  enforce its own limits).
* Traffic metadata stays visible: who talks, when, and how long the frames are.
* No clock, counter or stored state is needed on either side.

## Known-answer frame

`secret = "secret"`, `id = 7`, `seq = 42`, flags `DOWN|ACKREQ` (+`ENC`), body
`01 02 01 58 02`, nonce `01 02 03 04`:

```
72 07 2A 0E | BB 94 BD 10 66 | 01 02 03 04 | 95 11 03 E4
  header     |  ciphertext    |    nonce    |    MAC
```

Implementation: [`src/lsap.cpp`](../src/lsap.cpp) (`deriveKeys`, `encode`, `verify`,
`openBody`) on the primitives in [`src/lsap_crypto.cpp`](../src/lsap_crypto.cpp) (mbedtls on
the ESP32), and [`js/lsap.js`](../js/lsap.js) (Node `crypto`). Both test suites check this
frame (the C++ one with OpenSSL).
