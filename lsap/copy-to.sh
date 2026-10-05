#!/usr/bin/env bash
# Copy the LSAP library into a project:   ./copy-to.sh cpp <dir>   or   ./copy-to.sh js <dir>
# The library is COPIED, never shared: the copies must stay identical to this canonical source
# (never edit a copy; change it here, bump LSAP_VERSION and re-copy).
set -euo pipefail
kind="${1:-}"; dest="${2:-}"
[ -d "$dest" ] || { echo "usage: $0 cpp|js <destination-dir>  (no such directory: '${dest}')" >&2; exit 1; }
dest="$(cd "$dest" && pwd)"            # resolve before we change directory
cd "$(dirname "${BASH_SOURCE[0]}")"
case "$kind" in
  cpp) files=(cpp/lsap.h cpp/lsap.cpp cpp/lsap_crypto.cpp) ;;
  js)  files=(js/lsap.js js/link.js) ;;
  *)   echo "usage: $0 cpp|js <destination-dir>" >&2; exit 1 ;;
esac
for f in "${files[@]}"; do cp "$f" "$dest/"; done
version="$(grep -h -o 'LSAP_VERSION[ =]*["'"'"'][0-9.]*["'"'"']' cpp/lsap.h js/lsap.js | head -1)"
echo "Copied ${files[*]} to $dest ($version)"
