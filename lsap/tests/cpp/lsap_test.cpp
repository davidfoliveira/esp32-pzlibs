// Host-side unit test for the LSAP library (src/lsap.h, lsap.cpp): framing, the optional
// encryption/MAC layer, and the duplicate cache. Device-agnostic — message bodies are arbitrary
// bytes here. Uses OpenSSL for the two crypto primitives the device implements with mbedtls
// (lsap_crypto.cpp). Run everything with ../test.sh, or by hand (macOS/Homebrew):
//   g++ -std=c++17 -Wall -I lsap/src -I/opt/homebrew/opt/openssl@3/include \
//       lsap/tests/cpp/lsap_test.cpp lsap/src/lsap.cpp \
//       -L/opt/homebrew/opt/openssl@3/lib -lcrypto -o /tmp/lsap_test && /tmp/lsap_test
#include "lsap.h"
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>

namespace lsap {
void hmac256(const uint8_t* key, size_t keyLen, const uint8_t* data, size_t len, uint8_t out[32]) {
  unsigned int n = 32;
  HMAC(EVP_sha256(), key, (int)keyLen, data, len, out, &n);
}
void aes128ctr(const uint8_t key[16], const uint8_t iv[16], const uint8_t* in, uint8_t* out, size_t len) {
  EVP_CIPHER_CTX* c = EVP_CIPHER_CTX_new();
  int n = 0;
  EVP_EncryptInit_ex(c, EVP_aes_128_ctr(), nullptr, key, iv);
  EVP_EncryptUpdate(c, out, &n, in, (int)len);
  EVP_CIPHER_CTX_free(c);
}
}

using namespace lsap;

static void hex(const uint8_t* b, size_t n, char* out) { for (size_t i = 0; i < n; i++) snprintf(out + 2 * i, 3, "%02x", b[i]); }

int main() {
  Keys k, wrong;
  deriveKeys((const uint8_t*)"secret", 6, k);
  deriveKeys((const uint8_t*)"wrong!", 6, wrong);
  assert(memcmp(k.enc, k.mac, 16) != 0);                       // separate working keys
  uint8_t buf[MAX_FRAME], buf2[MAX_FRAME], plain[MAX_FRAME];
  const uint8_t body[5] = {0x01, 0x02, 0x01, 0x58, 0x02};
  const uint8_t nonce[NONCE_LEN] = {1, 2, 3, 4};
  const uint8_t TYPE = 0x72, flags = F_DOWN | F_ACKREQ;

  // ---- plain frame: header + body, nothing else ----
  size_t n = encode(TYPE, buf, sizeof(buf), 7, 42, flags, body, 5, nullptr, nullptr);
  assert(n == HDR_LEN + 5);
  Frame f;
  assert(decode(buf, n, f));
  assert(f.type == TYPE && f.id == 7 && f.seq == 42 && !f.enc && f.bodyLen == 5 && f.flags == flags);
  assert(memcmp(f.body, body, 5) == 0);

  // ---- encrypted frame: known answer, computed independently with Python hmac + `openssl enc` ----
  n = encode(TYPE, buf, sizeof(buf), 7, 42, flags, body, 5, &k, nonce);
  assert(n == HDR_LEN + 5 + SEC_LEN);
  char hx[2 * MAX_FRAME + 1];
  hex(buf, n, hx);
  assert(strcmp(hx, "72072a0ebb94bd106601020304951103e4") == 0);
  assert(buf[0] == TYPE && buf[1] == 7 && buf[2] == 42 && buf[3] == (flags | F_ENC));   // header in clear
  assert(memcmp(buf + HDR_LEN, body, 5) != 0);                                         // body scrambled
  assert(decode(buf, n, f) && f.enc && f.bodyLen == 5);
  assert(verify(buf, f, k));
  assert(!verify(buf, f, wrong));
  openBody(buf, f, &k, plain);
  assert(memcmp(plain, body, 5) == 0);

  // any single flipped bit in a verifiable frame is caught (header included)
  for (size_t i = 0; i < n; i++)
    for (int b = 0; b < 8; b++) {
      uint8_t t[MAX_FRAME]; memcpy(t, buf, n); t[i] ^= (1 << b);
      Frame g;
      if (!decode(t, n, g) || !g.enc) continue;            // mangled ENC flag: rejected earlier
      assert(!verify(t, g, k));
    }

  // fresh nonce => different ciphertext for the same body; direction is in the IV too
  const uint8_t nonce2[NONCE_LEN] = {9, 9, 9, 9};
  encode(TYPE, buf2, sizeof(buf2), 7, 42, flags, body, 5, &k, nonce2);
  assert(memcmp(buf + HDR_LEN, buf2 + HDR_LEN, 5) != 0);
  encode(TYPE, buf2, sizeof(buf2), 7, 42, F_ACKREQ, body, 5, &k, nonce);       // same but uplink
  assert(memcmp(buf + HDR_LEN, buf2 + HDR_LEN, 5) != 0);

  // a body spanning several AES blocks round-trips
  uint8_t big[90]; for (size_t i = 0; i < sizeof(big); i++) big[i] = (uint8_t)(i * 7 + 1);
  n = encode(TYPE, buf, sizeof(buf), 1, 5, F_ACKREQ, big, sizeof(big), &k, nonce);
  assert(n == HDR_LEN + sizeof(big) + SEC_LEN);
  assert(decode(buf, n, f) && verify(buf, f, k));
  openBody(buf, f, &k, plain);
  assert(f.bodyLen == sizeof(big) && memcmp(plain, big, sizeof(big)) == 0);

  // empty body (an ACK) still carries/validates the trailer
  n = encode(TYPE, buf, sizeof(buf), 1, 5, F_DOWN | F_ACK, nullptr, 0, &k, nonce);
  assert(n == HDR_LEN + SEC_LEN && decode(buf, n, f) && f.bodyLen == 0 && verify(buf, f, k));
  n = encode(TYPE, buf, sizeof(buf), 7, 42, F_ACK, nullptr, 0, nullptr, nullptr);
  assert(n == HDR_LEN && decode(buf, n, f) && f.bodyLen == 0 && (f.flags & F_ACK));

  // ---- any device type: LSAP doesn't care ----
  n = encode(0x71, buf, sizeof(buf), 9, 1, 0, body, 2, nullptr, nullptr);
  assert(decode(buf, n, f) && f.type == 0x71 && f.flags == 0 && f.bodyLen == 2);
  n = encode(0x9A, buf, sizeof(buf), 9, 1, F_ACKREQ, body, 2, &k, nonce);
  assert(decode(buf, n, f) && f.type == 0x9A && verify(buf, f, k));

  // ---- rejections ----
  assert(!decode(buf, 3, f));                                  // shorter than a header
  uint8_t shortEnc[6] = {TYPE, 1, 1, F_ENC, 0, 0};             // ENC but no room for the trailer
  assert(!decode(shortEnc, sizeof(shortEnc), f));
  assert(encode(TYPE, buf, 5, 1, 1, 0, body, 5, nullptr, nullptr) == 0);   // doesn't fit

  // ---- duplicate cache: independent of encryption ----
  struct Outcome { uint8_t a, b; };
  SeenCache<Outcome> rc;
  assert(!rc.find(5));
  rc.add(5, {1, 0});
  rc.add(6, {1, 2});
  assert(rc.find(5) && rc.find(5)->b == 0);
  assert(rc.find(6) && rc.find(6)->b == 2);                    // remembers what to answer with
  assert(!rc.find(7));
  for (uint8_t i = 100; i < 100 + REPLAY_WINDOW; i++) rc.add(i, {9, 9});
  assert(!rc.find(5) && !rc.find(6));                          // pushed out after REPLAY_WINDOW newer messages
  assert(rc.find(100) && rc.find(100 + REPLAY_WINDOW - 1));

  puts("lsap: all tests passed");
  return 0;
}
