// lsap.h — LSAP, the protocol over LoRa, plus its optional encryption layer ("LSAP-ENC").
//
// THE LSAP LIBRARY (an Arduino library): lsap.h, lsap.cpp and lsap_crypto.cpp. Home:
// github.com/davidfoliveira/esp32-pzlibs (lsap/). Projects that speak LSAP (a node, a gateway,
// ...) depend on it as a library — `#include <lsap.h>` — and never carry their own copy.
// Change it here and bump LSAP_VERSION (and library.properties, package.json, js/lsap.js).
//
// Device-agnostic: this library knows frames, flags, sequence numbers, ACKs, the duplicate
// cache and the encryption/MAC layer, and nothing about what any device puts in a message
// body. Whatever uses it layers its own message definitions on top (here: commands.h). No
// Arduino, no radio, no globals — so it is unit-tested on a host. lsap_crypto.cpp is the one
// platform-specific file (ESP32 mbedtls). Spec: docs/LSAP.md and docs/LSAP-ENC.md.
// Multi-byte fields are little-endian.
//
//   [0] type    device type (family nibble | type nibble): says how to read the body
//   [1] id      the node's ID, in both directions
//   [2] seq     8-bit message sequence; an ACK echoes the seq it acknowledges
//   [3] flags   F_ACK | F_ENC | F_DOWN | F_ACKREQ
//   [4..] body  opaque to LSAP (AES-128-CTR encrypted when F_ENC)
//   [..]  trailer, only when F_ENC: nonce (4 random bytes) + MAC (4 bytes)
//
// The first four bytes are ALWAYS cleartext. Two independent layers:
//  * link layer — seq, ACK/ACKREQ, retries, duplicate cache (SeenCache): works with or
//                 without a key;
//  * security   — F_ENC: encrypt the body + a MAC over the whole frame (header included,
//                 so a tampered seq/flags is caught).
#pragma once
#include <stdint.h>
#include <stddef.h>

#define LSAP_VERSION "1.1.0"

namespace lsap {

// flags
constexpr uint8_t F_ACK    = 0x01;   // this frame IS an ACK: "message <seq> was received". The body is normally
                                     // empty; it MAY carry one piggybacked message, which a receiver that
                                     // doesn't understand it must ignore.
constexpr uint8_t F_ENC    = 0x02;   // body encrypted + trailer (nonce + MAC) present
constexpr uint8_t F_DOWN   = 0x04;   // gateway -> node (clear = node -> gateway)
constexpr uint8_t F_ACKREQ = 0x08;   // sender wants an ACK for this frame

// Device types carry the device family in the high nibble. A frame is LSAP only if its first
// byte is in this family; a gateway also carrying other protocols (text frames, ...) uses
// isLsapType() to tell them apart.
constexpr uint8_t DEVICE_FAMILY = 0x7;
inline bool isLsapType(uint8_t type) { return (type >> 4) == DEVICE_FAMILY; }

constexpr size_t HDR_LEN   = 4;
constexpr size_t NONCE_LEN = 4;
constexpr size_t MAC_LEN   = 4;
constexpr size_t SEC_LEN   = NONCE_LEN + MAC_LEN;   // trailer size when F_ENC
constexpr size_t MAX_FRAME = 128;                   // bound for frames we build (LoRa allows 255)

// How many recent message seqs a receiver remembers. A sender must never reuse a seq
// within 20 distinct messages, so a window below that can't false-positive.
constexpr size_t REPLAY_WINDOW = 10;

// ---- platform crypto primitives ----
// Provided by lsap_crypto.cpp on the device (mbedtls) and by the test on a host (OpenSSL).
void hmac256(const uint8_t* key, size_t keyLen, const uint8_t* data, size_t len, uint8_t out[32]);
void aes128ctr(const uint8_t key[16], const uint8_t iv[16], const uint8_t* in, uint8_t* out, size_t len);

// Working keys derived from the configured secret (never sent over the air).
struct Keys { uint8_t enc[16]; uint8_t mac[32]; };
void deriveKeys(const uint8_t* secret, size_t len, Keys& k);

// A decoded frame; `body` points into the caller's buffer (ciphertext when `enc`).
struct Frame {
  uint8_t  type, id, seq, flags;
  const uint8_t* body;
  size_t   bodyLen;
  bool     enc;        // F_ENC set
  size_t   nonceOff;   // offset of the nonce in the buffer (valid when enc)
  size_t   macOff;     // offset of the MAC in the buffer (valid when enc)
};

// Build a frame into `out`. With `keys` non-null the body is encrypted, F_ENC set and the
// nonce + MAC trailer appended (`nonce` must then be NONCE_LEN fresh random bytes per
// frame); with `keys` null the frame is plain and `nonce` is ignored. Returns the frame
// length, or 0 if it doesn't fit.
size_t encode(uint8_t type, uint8_t* out, size_t cap, uint8_t id, uint8_t seq, uint8_t flags,
              const uint8_t* body, size_t bodyLen,
              const Keys* keys, const uint8_t* nonce);

// Parse the framing (not the MAC). False if shorter than a header (or an ENC frame too
// short for its trailer). The device type is NOT checked: the caller decides which it handles.
bool decode(const uint8_t* in, size_t len, Frame& f);

// Check the MAC of a decoded F_ENC frame. Do this BEFORE trusting any field or feeding the
// duplicate cache (forged frames must not be able to poison it).
bool verify(const uint8_t* in, const Frame& f, const Keys& keys);

// Copy the body into `out` (>= f.bodyLen bytes), decrypting when F_ENC (then `keys` must be
// non-null and the frame verified). Plain frames are just copied.
void openBody(const uint8_t* in, const Frame& f, const Keys* keys, uint8_t* out);

// ---- duplicate cache (link layer; independent of encryption) ----
// Remembers the last REPLAY_WINDOW message seqs, each with whatever `T` the owner wants to
// replay when the message repeats (e.g. the result to piggyback on a re-sent ACK). A repeat —
// a retransmission whose ACK was lost, or a replayed capture — is then answered from the
// cache instead of being acted on again. RAM only.
template <typename T>
class SeenCache {
 public:
  const T* find(uint8_t seq) const {
    for (size_t i = 0; i < n_; i++) if (seq_[i] == seq) return &val_[i];
    return nullptr;
  }
  void add(uint8_t seq, const T& v) {
    seq_[next_] = seq; val_[next_] = v;
    next_ = (next_ + 1) % REPLAY_WINDOW;
    if (n_ < REPLAY_WINDOW) n_++;
  }
 private:
  uint8_t seq_[REPLAY_WINDOW];
  T       val_[REPLAY_WINDOW];
  size_t  n_ = 0, next_ = 0;
};

}  // namespace lsap
