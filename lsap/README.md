# LSAP

**LSAP** is a small protocol over LoRa between *nodes* (sensors, controllers…) and a *gateway*:
a four-byte header, sequence numbers, ACKs with retries, duplicate handling, and an optional
encryption layer (**LSAP-ENC**: AES-128-CTR body + a MAC over the whole frame; the header stays
readable). It is device-agnostic: it never looks inside a message body — what a device puts there is
defined by that device's own project.

Current version: **1.0.0** — kept in `library.properties`, `package.json`, `LSAP_VERSION` in
`src/lsap.h` and `js/lsap.js` (bump all four together, and tag the commit `lsap-v1.0.0`).

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
library.properties        Arduino library metadata
src/lsap.h, lsap.cpp      frame codec, encryption/MAC layer, duplicate cache (SeenCache)
src/lsap_crypto.cpp       HMAC-SHA256 + AES-128-CTR on the ESP32 (mbedtls) — the one platform file
package.json, js/         the same codec + encryption layer for Node.js (lsap.js) and a gateway-side
                          endpoint for one node: seq, retry-until-ACK, ACKing, dedupe (link.js)
docs/                     the protocol specifications
tests/                    C++ and Node tests (known-answer frames are checked in both)
```

## Using it — as a dependency

**Firmware (Arduino library).** Put this folder where the Arduino tools find libraries, then just
`#include <lsap.h>`:

```bash
ln -s ~/projects/esp32-pzlibs/lsap ~/Documents/Arduino/libraries/lsap     # the sketchbook's libraries/ folder
```

(or pass it per build: `arduino-cli compile --library ~/projects/esp32-pzlibs/lsap ...`; the
`firmware.sh` of the projects using it also finds a checkout of this repository next to theirs, or
`LSAP_LIB=<path>`.)

**Node.js.** Depend on the folder:

```json
"dependencies": { "lsap": "file:../../esp32-pzlibs/lsap" }
```

```js
const { encode, decode, verify, openBody, deriveKeys, F, Link } = require('lsap');
```

```cpp
#include <lsap.h>
// frame a message (nonce = 4 fresh random bytes, only used when `keys` is given)
size_t n = lsap::encode(type, out, sizeof(out), nodeId, seq, lsap::F_ACKREQ, body, len, keysOrNull, nonce);
lsap::Frame f;
if (lsap::decode(buf, n, f) && (!f.enc || lsap::verify(buf, f, keys))) lsap::openBody(buf, f, &keys, plain);
```

Projects using it: the watering controller and its Node adapter (`esp32-watering`), the LoRa→MQTT
gateway (`esp32-lora2mqtt`).

## Tests

```bash
./test.sh        # C++ (needs g++ and OpenSSL's libcrypto) and Node (>= 18)
```
