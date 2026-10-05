# esp32-pzlibs

Small, device-agnostic libraries used by my ESP32 projects. Each library lives in its own folder,
is versioned, and is **copied** into the projects that use it — never shared by reference and never
edited in place. Change it here, bump its version, re-copy.

| Library | What it is |
|---------|------------|
| [`lsap/`](lsap) | LSAP — a small protocol over LoRa (frames, ACKs, retries, duplicate handling) and its optional encryption layer. C++ (ESP32) and Node.js. |
