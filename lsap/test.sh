#!/usr/bin/env bash
# Run the LSAP library's tests: the C++ ones (need g++ and OpenSSL's libcrypto for the host-side
# stand-ins of the ESP32's mbedtls primitives) and the Node ones (Node >= 18).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

OPENSSL="${OPENSSL_PREFIX:-}"
if [ -z "$OPENSSL" ] && command -v brew >/dev/null 2>&1; then OPENSSL="$(brew --prefix openssl@3 2>/dev/null || true)"; fi
CXXFLAGS=(-std=c++17 -Wall -I cpp)
LDFLAGS=(-lcrypto)
if [ -n "$OPENSSL" ]; then CXXFLAGS+=(-I"$OPENSSL/include"); LDFLAGS=(-L"$OPENSSL/lib" -lcrypto); fi

echo "» C++"
g++ "${CXXFLAGS[@]}" tests/cpp/lsap_test.cpp cpp/lsap.cpp "${LDFLAGS[@]}" -o /tmp/lsap_test
/tmp/lsap_test

echo "» Node"
node --test tests/js/*.test.js
