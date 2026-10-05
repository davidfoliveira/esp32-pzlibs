// lsap_crypto.cpp — device-side crypto primitives for lsap (mbedtls, bundled
// with the ESP32 core): HMAC-SHA256 and AES-128-CTR.
#include "lsap.h"
#include <mbedtls/md.h>
#include <mbedtls/aes.h>
#include <string.h>

namespace lsap {

void hmac256(const uint8_t* key, size_t keyLen, const uint8_t* data, size_t len, uint8_t out[32]) {
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, keyLen, data, len, out);
}

void aes128ctr(const uint8_t key[16], const uint8_t iv[16], const uint8_t* in, uint8_t* out, size_t len) {
  mbedtls_aes_context ctx;
  mbedtls_aes_init(&ctx);
  mbedtls_aes_setkey_enc(&ctx, key, 128);
  uint8_t counter[16], stream[16];
  memcpy(counter, iv, 16);                 // mbedtls advances the counter in place
  size_t off = 0;
  mbedtls_aes_crypt_ctr(&ctx, len, &off, counter, stream, in, out);
  mbedtls_aes_free(&ctx);
}

}  // namespace lsap
