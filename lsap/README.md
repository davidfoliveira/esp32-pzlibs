# LSAP

**LSAP** is a small protocol over LoRa between *nodes* (sensors, controllers…) and a *gateway*:
a four-byte header, sequence numbers, ACKs with retries, duplicate handling, and an optional
encryption layer (**LSAP-ENC**: AES-128-CTR body + a MAC over the whole frame; the header stays
readable). It is device-agnostic: it never looks inside a message body — what a device puts there is
defined by that device's own project.

Current version: **1.0.0** (`LSAP_VERSION` in `cpp/lsap.h` and `js/lsap.js` — keep them in step).

## Boundaries

| Layer | Where it lives |
|-------|----------------|
| LSAP — frame, flags, `seq`, ACK/ACKREQ, retries, duplicates ([docs/LSAP.md](docs/LSAP.md)) | this library |
| Encryption over LSAP ([docs/LSAP-ENC.md](docs/LSAP-ENC.md)) | this library |
| What a device sends in the body, and which messages it answers | **the device's own project** |
| A gateway's bridging to MQTT/serial/…, a node's radio handling | **the project using the library** |

The library has no radio, no Arduino and no MQTT dependency, so it is tested on a host.

## Contents

```
cpp/lsap.h, lsap.cpp      frame codec, encryption/MAC layer, duplicate cache (SeenCache)
cpp/lsap_crypto.cpp       HMAC-SHA256 + AES-128-CTR on the ESP32 (mbedtls) — the one platform file
js/lsap.js                the same codec + encryption layer for Node.js
js/link.js                gateway-side endpoint for one node: seq, retry-until-ACK, ACKing, dedupe
docs/                     the protocol specifications
tests/                    C++ and Node tests (with known-answer frames cross-checked between both)
```

## Using it — copy, don't share

```bash
./copy-to.sh cpp path/to/sketch      # lsap.h, lsap.cpp, lsap_crypto.cpp
./copy-to.sh js  path/to/node/src    # lsap.js, link.js
```

The copies must stay identical to this canonical source. **Never edit a copy**: change it here, bump
`LSAP_VERSION` (semantic versioning: the wire format or API changing is a major bump), run the tests,
and copy it again. Projects using it today: the watering controller and its Node adapter
(`esp32-watering`), the LoRa→MQTT gateway (`esp32-lora2mqtt`).

C++ usage in short:

```cpp
#include "lsap.h"
// frame a message (nonce = 4 fresh random bytes, only used when `keys` is given)
size_t n = lsap::encode(type, out, sizeof(out), nodeId, seq, lsap::F_ACKREQ, body, len, keysOrNull, nonce);
lsap::Frame f;
if (lsap::decode(buf, n, f) && (!f.enc || lsap::verify(buf, f, keys))) lsap::openBody(buf, f, &keys, plain);
```

## Tests

```bash
./test.sh        # C++ (needs g++ and OpenSSL's libcrypto) and Node (>= 18)
```
