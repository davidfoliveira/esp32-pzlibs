# esp32-pzlibs

Small, device-agnostic libraries used by my ESP32 projects. Each library lives in its own folder,
is versioned, and is used by the projects as a dependency (an Arduino library for firmware, an npm
package for Node) — never copied. Change it here, bump its version.

| Library | What it is |
|---------|------------|
| [`lsap/`](lsap) | LSAP — a small protocol over LoRa (frames, ACKs, retries, duplicate handling) and its optional encryption layer. C++ (ESP32) and Node.js. |
