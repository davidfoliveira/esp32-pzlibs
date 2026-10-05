// lsap.cpp — see lsap.h.
#include "lsap.h"
#include <string.h>

namespace lsap {


// CTR IV: direction, node id, seq, the frame's random nonce, then zeros (the low bytes are
// the AES block counter). The nonce makes the keystream unique per frame even though seq
// wraps every 256 messages.
static void makeIv(uint8_t iv[16], uint8_t flags, uint8_t id, uint8_t seq, const uint8_t* nonce) {
  memset(iv, 0, 16);
  iv[0] = (flags & F_DOWN) ? 1 : 0;
  iv[1] = id;
  iv[2] = seq;
  memcpy(iv + 3, nonce, NONCE_LEN);
}

void deriveKeys(const uint8_t* secret, size_t len, Keys& k) {
  uint8_t t[32];
  hmac256(secret, len, (const uint8_t*)"lsap-enc", 8, t);
  memcpy(k.enc, t, 16);
  hmac256(secret, len, (const uint8_t*)"lsap-mac", 8, k.mac);
}

static void mac4(const Keys& keys, const uint8_t* data, size_t len, uint8_t out[MAC_LEN]) {
  uint8_t full[32];
  hmac256(keys.mac, sizeof(keys.mac), data, len, full);
  memcpy(out, full, MAC_LEN);
}

size_t encode(uint8_t type, uint8_t* out, size_t cap, uint8_t id, uint8_t seq, uint8_t flags,
              const uint8_t* body, size_t bodyLen,
              const Keys* keys, const uint8_t* nonce) {
  const bool enc = keys && nonce;
  const size_t total = HDR_LEN + bodyLen + (enc ? SEC_LEN : 0);
  if (total > cap) return 0;
  out[0] = type;
  out[1] = id;
  out[2] = seq;
  out[3] = enc ? (flags | F_ENC) : (flags & ~F_ENC);
  if (enc) {
    uint8_t iv[16];
    makeIv(iv, out[3], id, seq, nonce);
    if (bodyLen) aes128ctr(keys->enc, iv, body, out + HDR_LEN, bodyLen);
    size_t p = HDR_LEN + bodyLen;
    memcpy(out + p, nonce, NONCE_LEN);
    mac4(*keys, out, p + NONCE_LEN, out + p + NONCE_LEN);   // MAC covers everything before it
  } else if (bodyLen) {
    memcpy(out + HDR_LEN, body, bodyLen);
  }
  return total;
}

bool decode(const uint8_t* in, size_t len, Frame& f) {
  if (len < HDR_LEN) return false;
  f.type = in[0]; f.id = in[1]; f.seq = in[2]; f.flags = in[3];
  f.enc = (f.flags & F_ENC) != 0;
  size_t tail = f.enc ? SEC_LEN : 0;
  if (len < HDR_LEN + tail) return false;
  f.body     = in + HDR_LEN;
  f.bodyLen  = len - HDR_LEN - tail;
  f.nonceOff = f.enc ? HDR_LEN + f.bodyLen : 0;
  f.macOff   = f.enc ? f.nonceOff + NONCE_LEN : 0;
  return true;
}

bool verify(const uint8_t* in, const Frame& f, const Keys& keys) {
  if (!f.enc) return false;
  uint8_t mac[MAC_LEN];
  mac4(keys, in, f.macOff, mac);
  uint8_t diff = 0;                                   // constant-time compare
  for (size_t i = 0; i < MAC_LEN; i++) diff |= mac[i] ^ in[f.macOff + i];
  return diff == 0;
}

void openBody(const uint8_t* in, const Frame& f, const Keys* keys, uint8_t* out) {
  if (!f.bodyLen) return;
  if (f.enc && keys) {
    uint8_t iv[16];
    makeIv(iv, f.flags, f.id, f.seq, in + f.nonceOff);
    aes128ctr(keys->enc, iv, f.body, out, f.bodyLen);
  } else {
    memcpy(out, f.body, f.bodyLen);
  }
}

}  // namespace lsap
