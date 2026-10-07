# LSAPGI — LoRa Sync/Async Protocol Gateway Integrations

**Language version 1.**

An LSAP gateway moves opaque message bodies between LoRa nodes and MQTT. An **LSAPGI file** (extension
`.lsapgi`) is what gives those bodies a meaning: it tells the gateway how to turn a device's binary body into
MQTT topics + JSON, and an MQTT command into a body for the node. It is a single JSON text file, interpreted
at run time. Adding or changing support for a device is *uploading a file* — never a firmware change, never
generated code.

This document is the complete specification **and** the guide for writing an integration for a device. If you
are an agent or a person asked to "write an integration for device X", read §1 (the method), then use §3–§8 as
the reference, §10 for the error messages you will meet, and §11 for the worked examples. Two complete,
validated example files accompany it: [`examples/watering.lsapgi`](examples/watering.lsapgi) (a controller
with valves and flow sensors) and [`examples/climate.lsapgi`](examples/climate.lsapgi) (a sensor; exercises
scale/offset, null sentinels, enums, bit flags, a repeating group, string/number settings and a command without
ACK).

The reference implementation is the `lora_forwarder` ESP32 gateway (`lsapgi.cpp`, `lsapgi_store.cpp`, host tests
in `tests/lsapgi_test.cpp`); its `tools/lsapgi_check` command-line validator runs the same code as the gateway:

```
lsapgi_check check my.lsapgi        # prints "OK: ..." or "REJECTED: <reason>"; exit status 0 only if it installs
```

Everything below describes behaviour that the gateway enforces; "rejected" always means the file is refused on
install with a message, and whatever was installed before is kept.

---

## 0. Principles (what the language is, and is not)

* **Data, not code.** There are no general expressions, no user-defined loops, no conditionals beyond the ones
  listed. The only arithmetic is `raw * scale + offset`.
* **Stateless.** What is published depends only on the received frame, the integration and its settings. There are
  no "last value" caches, no "publish on change", no edge detection, no timers.
* **Node-agnostic.** The gateway has no node list. The node id comes from the frame header (uplink) or from the
  MQTT topic (downlink). One installed integration serves any number of nodes.
* **No presence logic.** There is no online/offline concept. A consumer that needs "this node went quiet" owns
  that logic (for example Home Assistant `expire_after`).
* **Never breaks forwarding.** A body that matches no declared message is published on the gateway's raw
  `.../rx` topic. A file that fails to load is skipped.
* **Safe topics.** A value coming from a payload can never create a wildcard or an extra topic level (§4.2).

---

## 1. Method: writing an integration for a device

1. **Write down the device's message bodies** as byte tables: for each message, its direction, opcode, length
   (fixed, or "at least N"), and every field with offset, width, endianness, bit position, units and special
   values. LSAPGI bodies are addressed **from byte 0 of the LSAP body** (the body does not include the LSAP
   header). All multi-byte integers and floats are **little-endian**.
2. **Decide the MQTT interface** you want consumers to see: topic names, payload shapes, which topics are
   retained. Keep to one value per topic where you can (`{"value": ...}`). Retain state-like values; do not
   retain events or measurements that go stale.
3. **Decide the settings.** Almost always exactly one: a `topic` setting (type `topic`) whose default contains
   `{id}`, e.g. `mydevice/{id}`. All your topics then start with `{topic}`.
4. **Write one `uplink` message per body layout** with `match`, `fields`, optional `group`, and `publish` rules.
5. **Write one `downlink` command per MQTT command** with its `topic` pattern, `payload` parser and `body`.
6. **Write test vectors** — real captured bodies if you have them, otherwise bodies you compute by hand from your
   byte tables. Cover: each message, every optional/null case, the empty repeating group, a body that must not
   match (`"unmatched": true`), each command, a clamped value, and an out-of-range command (`"ignored": true`).
7. **Validate** with `lsapgi_check check file.lsapgi`, or by uploading it in the gateway's config portal. Read
   the error (§10), fix, repeat. The test vectors are compared *exactly* (topic, payload text, retain flag, and
   the number and order of publishes), so a failing vector tells you precisely what the interpreter produced.
8. **Do not "fix" a failing vector by pasting the interpreter's output blindly.** First check by hand that the
   output is what the device protocol requires.

Typical mistakes, all caught by the validator: a field that does not fit the declared `len` condition; two
fields on the same bytes; forgetting that a group needs a `">="` length; using a float field in a topic;
a command topic whose variable is not a whole topic level; a `body` variable whose range does not fit its type.

---

## 2. File structure

```json
{
  "lsapgi": 1,
  "name": "mydevice",
  "title": "My device",
  "version": "1.0.0",
  "types": ["0x72"],
  "config":   [ ... ],
  "uplink":   [ ... ],
  "downlink": [ ... ],
  "tests":    [ ... ]
}
```

| Key | Required | Meaning |
|---|---|---|
| `lsapgi` | yes | The language version the file needs (an integer ≥ 1). A gateway refuses a version newer than it implements (this document: `1`). |
| `name` | yes | Unique id: 1–24 characters, lowercase letters, digits, `_`. It becomes the stored file name. Installing a file whose `name` is already installed **replaces** it (an upgrade) and keeps the owner's settings for the keys the new file still declares. |
| `title` | no | Human name shown in the portal (≤ 48 characters; default the `name`). |
| `version` | yes | Free text, ≤ 16 characters. |
| `types` | yes | List (1–4) of the LSAP device types the integration claims: numbers or strings in `0x70`–`0x7F` (the first byte of an LSAP frame). **Two installed integrations cannot claim the same type.** |
| `config` | no | Settings the owner can change (§3). |
| `uplink` | no | Node → MQTT messages (§4). |
| `downlink` | no | MQTT → node commands (§5). |
| `tests` | yes (on install) | Test vectors (§6). |

**Unknown keys are rejected everywhere** (in every object of the file). A typo is an error, not a silently
ignored setting.

**Numbers** may be written as JSON numbers or as strings (`"0x81"`, `"12"`); hexadecimal needs the `0x` prefix. Do not write decimal strings with leading zeros (`"012"` is read as octal).

**Limits** (all enforced on install; §9 has the table): file ≤ 24 576 bytes; ≤ 4 device types; ≤ 8 settings;
≤ 8 uplink messages; ≤ 24 fields per message; ≤ 12 publish rules per message; ≤ 20 publishes produced by one
frame; ≤ 8 downlink commands; ≤ 32 test vectors.

---

## 3. Settings: `config`

Settings are the values an integration lets its owner choose. The gateway shows a form for them, stores the
values per integration, and **substitutes them by name** into topic templates and static payloads (`{key}`).
Substitution is plain text replacement done when the integration is loaded (changing a setting takes effect
after the gateway reloads, which on the ESP32 gateway means a reboot).

```json
{"key": "topic", "label": "MQTT topic template", "type": "topic", "default": "mydevice/{id}",
 "required": true, "help": "Base of every topic of the node. May use {id}, the node's id."}
```

| Field | Required | Meaning |
|---|---|---|
| `key` | yes | Identifier (letters, digits, `_`, ≤ 24; not starting with a digit). The name used as `{key}`. Must not be `id`, `type`, `seq`, `rx_rssi`, `rx_snr`, and must not collide with a field name. Unique. |
| `type` | no (`string`) | `string`, `number`, `bool` or `topic` (below). |
| `default` | no | Text, number or boolean. Used when nothing valid is stored. **Must itself be valid** for the type, and non-empty when `required`. |
| `label` | no | Label in the form (default the key). |
| `help` | no | Help text under the field. |
| `required` | no | The value may not be empty. |
| `min`, `max` | no | For `number`: integer bounds. |

Types:

* `string` — up to 64 characters; must not contain `{`, `}`, `+`, `#` or control characters.
* `number` — a whole number (optionally within `min`/`max`).
* `bool` — `true`/`false` (`1`/`0`/`on`/`off` accepted); substituted as `true` or `false`.
* `topic` — up to 100 characters; a topic template that may contain `/` and the **single** variable `{id}`
  (nothing else in braces), never `+` or `#`. Substituting it brings `{id}` into every topic it is used in.

A stored value that is invalid (wrong type, wildcard, out of range, empty for a required setting) is ignored and
the default is used. Unknown stored keys are ignored.

Where `{key}` is substituted: in `topic` of uplink publishes and downlink commands, and in static `payload`
strings. It is **not** substituted in `json` keys, field names, or anywhere else.

---

## 4. Uplink: `uplink` (node → MQTT)

`uplink` is a list of messages (≤ 8). When a frame of a claimed type arrives, the gateway tries the messages **in
file order**; the first whose `match` holds decodes the body and its `publish` rules run. If none matches, the
body goes to the raw `.../rx` topic (nothing is ever dropped silently).

A message object:

```json
{
  "name": "state",
  "match":   [ ... ],
  "fields":  { ... },
  "group":   { ... },
  "publish": [ ... ]
}
```

`name` (required, identifier, unique), `match` (required), `fields` (optional), `group` (optional), `publish`
(required, ≥ 1 rule).

### 4.1 `match`

A non-empty list of conditions, **all** of which must hold (AND):

| Condition | Holds when |
|---|---|
| `{"len": "=N"}` or `{"len": ">=N"}` | the body length is exactly N / at least N. Other operators (`>`, `<`, `<=`, `!=`, `==`) are rejected. |
| `{"byte": N, "eq": V}` | `body[N] == V`. N is any offset (the opcode is just `"byte": 0`). |
| `{"byte": N, "eq": V, "mask": M}` | `(body[N] & M) == V` (`V` must have no bits outside `M`, or it could never match → rejected). |
| `{"type": "0x72"}` | the frame's device type equals this one (must be a claimed type). Only needed when an integration claims several types. |

**Exactly one `len` condition is required.** It declares the message's layout length: every field must fit
inside it (§4.2) and every `byte` condition must lie below it. For `">=N"`, N is the minimum length; the
message may be longer (a longer body is fine; bytes past the declared fields are simply ignored).

### 4.2 `fields`

An object `{name: spec}` (≤ 24 fields per message, group fields included). Field names: identifier of ≤ 16
characters, unique within the message, not `id type seq rx_rssi rx_snr`, not a setting key.

```json
"rssi": {"at": 3, "type": "u8", "bits": "7..3", "scale": 4, "offset": -140, "null": 0}
```

| Key | Required | Meaning |
|---|---|---|
| `at` | yes | Byte offset in the body (0–255). |
| `type` | yes | `u8`, `u16`, `u32`, `i8`, `i16`, `i32` (two's complement, little-endian) or `f32` (IEEE-754 single, little-endian). |
| `bits` | no | A bit range **inside a u8**: `"7..3"` (high..low; bit 7 = most significant) or `"0"` for a single bit. The value becomes the extracted bits as an unsigned number (`bits "7..3"` → 0..31). Requires `type: "u8"`. |
| `scale`, `offset` | no (1, 0) | `value = raw * scale + offset`, computed in double precision. Numbers (may be fractional or negative). |
| `enum` | no | `{"0": "OK", "1": "BAD_ARG"}`: raw value → name (applied to the extracted bits, before `scale`/`offset`). ≤ 16 entries, names 1–24 characters. The field then evaluates to the **name** (a string). A raw value with no entry evaluates to its decimal number, as a string (`"9"`) — a new device code never makes a publish fail. |
| `null` | no | A sentinel. If the **whole stored integer** at `at` (all bytes of the type, *before* bit extraction) equals this number, the field is **absent** (§4.4). Not allowed on `f32`. |

Checks on install:

* **Layout:** `at + size` must be ≤ the declared `len` (`u8` is 1 byte, `u16` 2, `u32` 4, `f32` 4).
* **No overlap:** two fields may not share bits. Bit ranges in the same byte may sit side by side
  (`7..3` and `2..0`); a whole-byte field and a bit field on the same byte overlap.
* A field is a **float field** when it is `f32`, or when its `scale`/`offset` is not a whole number and it has
  no `enum`. Float fields cannot be used in topics (§4.2.1).

`null` and `bits` together: `null` compares the *whole byte*, which is how "0x00 = nothing yet" is expressed for
a byte that carries two bit fields (the watering example does exactly this for the link byte).

NaN and infinite `f32` values make the field absent.

### 4.2.1 Variables

Anywhere a template or JSON value names a variable, these exist:

| Variable | Value | In topics? |
|---|---|---|
| `id` | the node id from the frame header (0–254) | yes |
| `seq` | the frame's sequence number | yes |
| `type` | the device type as two hex digits (`"72"`) | yes |
| `rx_rssi`, `rx_snr` | the gateway's reception quality of the frame that carried the body (for a body piggybacked in an ACK, that ACK frame) | no (float) |
| each field | its value (number, or string for an `enum` field) | integer or enum fields only |
| group fields and group index | only inside a rule with `"each": "group"` | integer or enum fields only |
| loop variables | declared by `each` (§4.3) | yes |

**Topic safety rules** (checked on install, and again at run time):

* No float variable in a topic. (Floats belong in payloads.)
* An enum name used in a topic must not contain `/`, `+`, `#` or NUL. Because the only variable values that can
  reach a topic are integers, enum names that were validated, and your own literal text, **a payload can never
  create a wildcard or another topic level**.
* Every variable used must exist in that message (and, for a group field, inside a group rule).

### 4.3 `group`: one repeating tail

For bodies that end in a repeated structure with no count on the wire (e.g. one 8-byte record per sensor).

```json
"group": {
  "at": 8, "size": 8, "max": 4, "index": "n",
  "fields": { "rate": {"at": 0, "type": "f32"}, "volume": {"at": 4, "type": "f32"} }
}
```

* `at` — offset of the first element; `size` — bytes per element (1–64); `max` — at most this many elements
  (1–16); `index` — name of the 1-based element number variable (default `n`).
* The number of elements is `min(max, floor((len − at) / size))`. A trailing partial element is ignored; a
  body shorter than `at` has zero elements.
* Group field offsets are **relative to the element start** and must fit in `size`; they follow the same
  field rules as §4.2 (no overlap within an element).
* The message must have a `">="` length condition, and the group must start at or after the end of every
  fixed field (no overlap).
* Group fields and the index are visible only inside publish rules that carry `"each": "group"`.

### 4.4 Absent values

A variable is **absent** when its field hit its `null` sentinel, did not fit the body, was NaN/infinite, or
(for `rx_rssi`/`rx_snr`) the radio data is unknown. **A publish rule that uses an absent variable — in its topic
or its JSON — is skipped.** That is how "only publish when the field is present" is written: no extra
condition is needed.

### 4.5 `publish`

A list (1–12) of rules; each rule produces zero or more MQTT publishes. Rules run in order and their outputs
are published in that order.

```json
{
  "each":   { "bits": "valves", "as": "n", "value": "on" },
  "when":   { "count": ">=1" },
  "topic":  "{topic}/valve/{n}/state",
  "retain": true,
  "json":   { "value": { "var": "on", "map": {"0": "OFF", "1": "ON"} } }
}
```

| Key | Meaning |
|---|---|
| `topic` | Required. A template (§4.6). |
| `payload` | A **static string** published as is (after `{setting}` substitution). `""` is allowed (publishing an empty retained payload clears a retained topic). |
| `json` | An object `{key: valueSpec}` rendered as a compact JSON object (no spaces) in the file's key order. **Exactly one of `payload` / `json`** per rule. |
| `retain` | `true`/`false` (default `false`). QoS is always 0. |
| `each` | Optional loop (below). |
| `when` | Optional condition: `{"count": ">=N"}` / `{"count": "=N"}` on the number of group elements (the message needs a group). |

**`each`:**

* `"each": "group"` — run the rule once per group element (`n = 1..count`), with the group fields and index in
  scope. Zero elements → zero publishes.
* `"each": {"bits": "<field>", "as": "n", "value": "on"}` — run the rule once per bit of a `u8` field, from the
  least significant bit: `n` (name from `as`, required) is the **1-based bit number** (bit 0 → 1), and `value`
  (optional name) is that bit's value, `0` or `1`. For a field with `bits "4..2"` the width is 3 and there are 3
  iterations; for a whole `u8` there are 8. The loop names must not collide with fields, settings or header
  variables (they may coincide with the *group index name*, since a rule has either loop, not both).
* Without `each` the rule runs once.

**Fan-out cap:** the sum over a message's rules of 1 (no `each`), the bit width, or the group `max` must be
≤ 20, so a single frame can never produce more than 20 publishes. Rejected otherwise.

**`valueSpec`** (the value of each key in `json`):

```json
{"var": "volume", "round": 4}
{"var": "on", "map": {"0": "OFF", "1": "ON"}}
{"var": "fault", "bool": true}
{"var": "rssi"}
```

| Key | Meaning |
|---|---|
| `var` | Required. A variable in scope. |
| `round` | 0–9: render a number with at most this many decimals, trailing zeros removed (`12.3400` → `12.34`, `0.0000` → `0`). |
| `bool` | `true`: render `true` when the value is non-zero, else `false` (a JSON boolean). |
| `map` | `{"<integer>": "text"}`: if the value, rounded to an integer, has an entry, render that string; otherwise fall back to normal rendering. Not combinable with `bool`. |

Normal rendering of a value: an `enum` field or `type` → a JSON string; a number → a JSON number: a whole
number prints as an integer (`25`, `-10`, `0`), a non-whole number with `round` prints rounded, without `round`
up to 6 decimals with trailing zeros removed. Negative zero prints `0`. There are no exponents.

Rendered payloads are limited to 256 bytes and topics to 192; a rule that would exceed that is skipped.

### 4.6 Templates

A template is literal text with `{name}` variables, used in publish `topic`s and downlink `topic`s.

* Literal text must not contain `+` or `#` (no wildcards in a topic you publish).
* `{name}` first resolves against the **settings** (substituted textually when the integration is loaded);
  otherwise it must be a variable in scope (§4.2.1). Anything else is rejected (`unknown variable {name}`).
* There is no escaping for braces; a stray `}` or an unclosed `{` is rejected.
* Integers render as decimal; there is no zero padding or formatting.

---

## 5. Downlink: `downlink` (MQTT → node)

`downlink` is a list of commands (≤ 8). The gateway subscribes to each command's topic pattern; a message on a
matching topic is decoded into variables, turned into a body, and handed to the LSAP engine, which frames it,
sets the per-node sequence number, sends it and retries until the node ACKs (`ackreq`, default `true`).

```json
{
  "name": "valve_set",
  "topic": "{topic}/valve/{n}/set",
  "vars": { "n": {"min": 1, "max": 8} },
  "payload": [
    {"var": "on",  "from": "value", "as": "bool", "bare": true},
    {"var": "ttl", "from": "ttl",   "as": "int", "min": 0, "max": 65535, "default": 0}
  ],
  "requires": "on",
  "ackreq": true,
  "type": "0x72",
  "body": ["0x01", {"var": "n"}, {"var": "on"}, {"var": "ttl", "type": "u16"}]
}
```

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | Identifier, unique. Reported as `ref` in the engine's `tx/result` message. |
| `topic` | yes | The pattern to listen on (§5.1). |
| `vars` | if the topic has variables | `{name: {"min": a, "max": b}}` for every **captured** variable (not `id`). |
| `payload` | no | How to read the MQTT payload into variables (§5.2). Omit to accept any payload and ignore it. |
| `requires` | no | Name of a `bool` payload variable that must be ON, otherwise the message is ignored. |
| `ackreq` | no (`true`) | `false` = send once, no ACK, no retries. |
| `type` | no | The device type to send as. Default: the integration's only type; **required** when it claims several. |
| `body` | yes | The bytes to send (§5.3). |

### 5.1 Topic pattern

The topic is split at `/` into levels. A level is either literal text or a **single whole-level variable**
`{name}`; text mixed with a variable (`valve{n}`) is rejected, because the pattern must be subscribable with
MQTT `+` wildcards (`{topic}/valve/{n}/set` is subscribed as `mydevice/+/valve/+/set`).

* `{id}` is implicit and is the **node to address** (decimal, 0–254). It normally comes from the `topic`
  setting (`mydevice/{id}`).
* Every other variable must be declared in `vars` with a range, and must appear in the topic. A captured value
  must be plain decimal digits (1–6 of them) within its range. **A topic that matches the pattern but whose value
  is not a number or is out of range is ignored (and logged); nothing is sent.** (Valve 9 on an 8-valve device.)
* If, after substituting the settings, a command's topic has no `{id}`, no node can be addressed: that command
  is switched off, the portal shows a warning, and the integration otherwise works (uplink is unaffected).
* No wildcard characters are allowed in the pattern.
* If several commands could match one topic, the first in file order wins.

### 5.2 Payload parsing: `payload`

A list of variable definitions; each defines a variable readable by `body` and `requires`.

| Key | Meaning |
|---|---|
| `var` | Required. New variable name (identifier ≤ 16; not reserved; not already a topic variable). |
| `as` | Required. `"bool"` or `"int"`. |
| `from` | The key to read when the payload is a JSON **object** (`{"value":"ON","ttl":600}`). Optional for a `bare`-only variable. |
| `bare` | `true`: when the payload is *not* a JSON object (bare text, `1`, `true`, `"on"`, ...), the whole payload is this variable's value. At most one variable may be `bare`. |
| `min`, `max`, `default` | For `int`: clamp range (defaults `0` and `65535`) and the value used when the variable is missing or unusable (default `0`; must be within range). |

Rules:

* The payload is treated as a JSON object only if, after trimming, it starts with `{` and parses as JSON.
  Otherwise it is bare text. (Only the first 512 bytes are considered.)
* **`bool`** — ON is: JSON `true`; a non-zero number (also as text); the text `1`, `on` or `true`
  (case-insensitive, optionally in double quotes, surrounding whitespace ignored). **Anything else, an empty
  payload, or a missing key is OFF.**
* **`int`** — a JSON number or numeric text, clamped into `min..max` (fractions are truncated toward zero).
  Missing, or text that is not a number → `default`.
* A variable with no value source (a non-object payload and no `bare` entry; an object without its `from` key)
  takes its default (OFF / `default`).

### 5.3 `body`

A non-empty list of entries, each producing 1, 2 or 4 bytes, **little-endian**; at most 96 bytes in total.

* a number `0`–`255` or a hex string `"0x04"` — one constant byte;
* `{"const": N, "type": T}` — a constant of type `T`;
* `{"var": name, "type": T}` — the value of a variable (a captured topic variable, `id`, or a payload variable;
  a `bool` is 0/1). `T` is one of `u8 u16 u32 i8 i16 i32` (default `u8`).

On install, the **whole range** of every variable (its `vars` `min..max`, `bool` 0..1, an `int` payload
variable's `min..max`, `id` 0..254) must fit its type, so a body can never overflow a field.

The `body` is exactly what the node receives as the LSAP body. The gateway does not add an opcode.

---

## 6. Test vectors: `tests`

At least 1, at most 32. The gateway runs **every vector on install** and refuses the file if any fails (they
are not kept or run at boot). A vector is an object `{"name": "...", "uplink": {...}}` or
`{"name": "...", "downlink": {...}}`, optionally with `"config": {...}`.

### Uplink vector

```json
{"name": "valve 2 on", "uplink": {
   "id": 1, "seq": 7, "type": "0x72",
   "body": "8102005b40e20100a470454103d55d47",
   "rssi": -97, "snr": 5.5,
   "publish": [
     {"topic": "watering/1/valve/1/state", "payload": "{\"value\":\"OFF\"}", "retain": true}
   ]}}
```

* `id` required (0–254); `type` defaults to the integration's first type; `seq` default 0; `body` is hex
  (spaces allowed).
* `rssi`/`snr` are optional; give them to feed `rx_rssi`/`rx_snr` (without them those variables are absent).
* `publish` is the **complete expected list, in order**: same count, and for each the exact `topic`, the exact
  `payload` text, and `retain` (default `false`). An empty list means "decodes, publishes nothing".
* `"unmatched": true` (and no `publish`) expects that **no message matches** (the body would go to the raw
  `.../rx` topic).

### Downlink vector

```json
{"name": "valve 2 on for 10 minutes", "downlink": {
   "topic": "watering/1/valve/2/set", "payload": "{\"value\":\"ON\",\"ttl\":600}",
   "id": 1, "type": "0x72", "body": "0102015802", "ackreq": true }}
{"name": "valve 9 does not exist", "downlink": {
   "topic": "watering/1/valve/9/set", "payload": "on", "ignored": true }}
```

* `topic` and `payload` (text; may be empty) are the MQTT message.
* Either the expected result — `body` (hex), optionally `id`, `type`, `ackreq` (default `true`), compared exactly —
  or `"ignored": true` (no command is produced).

### Settings in vectors

A vector runs with the integration's **declared default settings**, not the owner's. To test another setting, add
`"config": {"topic": "garden/{id}/water", "site": "cabin"}` to that vector (values for declared keys; others
fall back to defaults).

---

## 7. How a frame is processed (the whole picture)

**Uplink.** A frame of a claimed device type arrives and the LSAP layer has already validated it, verified/decrypted
it if the node has a key, and rejected repeats. Then:

1. The first `uplink` message whose `match` holds is chosen. None → the raw `.../rx` message is published
   instead (and nothing else).
2. Its `publish` rules run in order; loops expand; any rule using an absent variable, or rendering an unsafe or
   oversize topic/payload, is skipped.
3. The raw `.../rx` message is *also* published only if the owner enabled "also publish raw rx".
4. If the frame asked for an ACK, **it is ACKed only after all of these publishes are queued**: when the outbox
   lacks room for all of them, nothing is published and no ACK is sent, so the node's retry brings the frame
   back. Design the node's retry accordingly; the gateway guarantees it never ACKs and then loses outputs.

**Piggybacked responses.** When the gateway sent a command with `ackreq` and the node's ACK carries a body
(for example a RESULT), that body is passed through the same decoding and publishing as an uplink frame
(without the raw fallback). The LSAP engine's own `.../tx/result` message (`status` `acked`/`sent`/`failed`,
`ref` = command name, `response` = the hex body) is still published as it always was.

**Downlink.** An MQTT message arrives on a subscribed topic → pattern match → range checks → payload parse →
`requires` → body built → queued like a message published on `.../tx` (framing, per-node sequence numbers, ACK
retries, airtime budget — all the LSAP engine's job; the integration neither sees nor controls them).

---

## 8. Design guidance (what works well)

* **State topics are retained, events are not.** Retain `valve/N/state`, `fault`, `volume`; do not retain
  `link`, `rate`, `result`.
* **Publish every value a message carries, every time**, rather than only changes — the gateway has no memory,
  and repeated identical publishes are harmless to consumers.
* **Use the bitmap loop** for a "channel N is on" byte: one `each` bits rule gives per-channel topics from one
  byte. Use `map` to turn the `0`/`1` bit into `"OFF"`/`"ON"`.
* **Express "not available yet" as a `null` sentinel** on the field, not as a special publish: the rule using it
  disappears automatically.
* **A report without optional records** (a group with zero elements) simply publishes no record topics. Do not
  invent a "no data" payload.
* **Put one concept per topic**, as `{"value": x}`, so consumers can subscribe to a single value.
* **Give every command a range** (`vars`), including the device's real limits. An out-of-range index is
  ignored and logged — it never reaches the node.
* **Keep `ackreq` true** for commands the node must perform; use `false` only for fire-and-forget ones.
* Anything the language cannot express (conditions on values, state across messages, computed ids) is out of
  scope on purpose: do it in the consumer, or change the device's protocol to make the data directly publishable.

---

## 9. Limits

| | Limit |
|---|---|
| File size | 24 576 bytes |
| Installed integrations (per gateway) | 4 |
| Device types per integration | 4 |
| Settings per integration | 8 |
| Uplink messages | 8 |
| Fields per message (group fields included) | 24 |
| Enum entries per field | 16 |
| Publish rules per message | 12 |
| **Publishes produced by one frame** | **20** |
| Group `max` / `size` | 16 / 64 |
| Downlink commands | 8 |
| Command body | 96 bytes |
| Test vectors | 32 |
| Rendered topic / payload | 192 / 256 bytes |

---

## 10. Rejection messages you will meet

The gateway reports the first problem found, naming the message, field or rule. Common ones:

| Message contains | Cause / fix |
|---|---|
| `not valid JSON (...)` | Syntax error (a trailing comma, a missing quote). |
| `file too big` | Over 24 576 bytes. Shorten `help` texts and test vectors. |
| `needs LSAPGI language version N` | `"lsapgi"` is newer than the gateway understands. |
| `unknown key "x"` | A misspelled or unsupported key. |
| `"types" entries must be LSAP device types, 0x70-0x7F` | Wrong device type. |
| `device type 0x72 is already claimed by "other"` | Another installed integration owns the type (uninstall it first). |
| `at most 4 integrations can be installed` | Uninstall one first. |
| `"match" needs exactly one "len" condition` | Add `{"len": "=N"}` or `{"len": ">=N"}`. |
| `bad length condition ... other operators are unknown` | Only `=` and `>=`. |
| `byte N is beyond the declared length` | A `byte` condition at or past `len`. |
| `... it can never match` | `eq` has bits outside `mask`. |
| `bytes A..B fall outside the message (declared length N)` | A field does not fit `len`: fix the offset or raise the length. |
| `field "x" overlaps field "y"` | Two fields on the same bits. |
| `bit range H..L is outside a byte or reversed` | Write `"high..low"` with 7 ≥ high ≥ low ≥ 0. |
| `"bits" needs type u8` | Bit ranges only on `u8`. |
| `unknown type "u64"` | Use `u8 u16 u32 i8 i16 i32 f32`. |
| `unknown variable {x}` / `unknown variable "x"` | The name is not in scope (typo, or a group field outside a group rule). |
| `{x} is a float: floats are only allowed in payloads, not in topics` | Use an integer field or enum in the topic. |
| `contains a wildcard character` | `+` or `#` in literal topic text. |
| `enum value "..." is used in a topic but contains / + # or NUL` | Rename the enum value. |
| `it can produce N publishes from one frame; the limit is 20` | Reduce loops, or split the data over topics differently. |
| `a repeating group needs a ">=" length condition` | Use `">=N"` when a group is declared. |
| `starts at byte N, which overlaps field ...` | The group begins inside a fixed field. |
| `each.bits "x" must be a u8 field of the message` | The bitmap field is missing or not a `u8`. |
| `needs exactly one of "payload" ... or "json"` | A publish rule has both, or neither. |
| `in a downlink topic a variable must be a whole topic level` | Write `.../{n}/...`, not `.../valve{n}`. |
| `topic variable {x} is not declared in "vars"` / `declared but not in the topic` | `vars` and the topic must agree. |
| `body: "x" (a..b) does not fit u8` | Widen the body type (`u16`) or narrow the range. |
| `"requires" must name a bool payload var` | `requires` refers to a `"as": "bool"` variable. |
| `no "tests"` / `test #N "name": ...` | Vectors are mandatory; the second form shows the expected vs. actual publish or body. |

---

## 11. Worked examples

### 11.1 Climate sensor (`examples/climate.lsapgi`)

The device sends, on device type `0x71`:

* `READING 0x10` (9 bytes): `[0]=0x10 · [1..2]=temperature i16, 0.01 °C · [3..4]=humidity u16, 0.1 %, 0xFFFF =
  not measured · [5]=battery u8, volts = 1.8 + 0.02·x · [6]=flags (bits 1..0 mode 0 idle / 1 sampling / 2 alarm,
  bit 7 charging) · [7..8]=uptime u16 seconds`.
* `HISTORY 0x11`: `[0]=0x11 · [1]=count · then one i16 (0.01 °C) per sample`, up to 8.

and accepts `0x20 secs(u16)` (set interval), `0x21` (identify, no ACK wanted), `0x22 channel(u8) value(i16)`.

The uplink side of the file:

```json
{
  "name": "reading",
  "match": [{"type": "0x71"}, {"byte": 0, "eq": "0x10"}, {"len": "=9"}],
  "fields": {
    "temp": {"at": 1, "type": "i16", "scale": 0.01},
    "hum": {"at": 3, "type": "u16", "scale": 0.1, "null": 65535},
    "batt": {"at": 5, "type": "u8", "scale": 0.02, "offset": 1.8},
    "mode": {"at": 6, "type": "u8", "bits": "1..0", "enum": {"0": "idle", "1": "sampling", "2": "alarm"}},
    "charging": {"at": 6, "type": "u8", "bits": "7"},
    "uptime": {"at": 7, "type": "u16"}
  },
  "publish": [
    {"topic": "{topic}/temperature", "retain": true, "json": {"value": {"var": "temp", "round": 2}}},
    {"topic": "{topic}/humidity", "retain": true, "json": {"value": {"var": "hum", "round": 1}}},
    {"topic": "{topic}/battery", "json": {"value": {"var": "batt", "round": 2}, "charging": {"var": "charging", "bool": true}}},
    {"topic": "{topic}/mode/{mode}", "payload": "1"},
    {"topic": "{topic}/uptime", "json": {"seconds": {"var": "uptime"}, "node": {"var": "id"}, "seq": {"var": "seq"}}},
    {"topic": "{topic}/info", "payload": "site={site} interval={interval}s"}
  ]
}
```

Things this demonstrates: `hum` becomes *absent* at `0xFFFF`, so the humidity publish silently disappears;
`mode` and `charging` share a byte; an enum value used in a topic (`.../mode/sampling`); a static payload with
settings substituted; a history message with a group (`"each": "group"`) and a `when` count; `ackreq: false`;
a captured `{ch}` with a range; an `i16` command argument. Open the file for the history message, the
commands and the test vectors.

### 11.2 Watering controller (`examples/watering.lsapgi`)

Device type `0x72`. `STATE 0x81` carries a valve bitmap, system flags, a link byte and an uptime, and **optionally
8 bytes per flow sensor** (no count: `(len − 8)/8` sets, at most 4). The interesting parts:

```json
{ "name": "state",
  "match": [{"byte": 0, "eq": "0x81"}, {"len": ">=8"}],
  "fields": {
    "valves": {"at": 1, "type": "u8"},
    "fault":  {"at": 2, "type": "u8", "bits": "0"},
    "rssi":   {"at": 3, "type": "u8", "bits": "7..3", "scale": 4, "offset": -140, "null": 0},
    "snr":    {"at": 3, "type": "u8", "bits": "2..0", "scale": 5, "offset": -20,  "null": 0} },
  "group": {"at": 8, "size": 8, "max": 4, "index": "n",
            "fields": {"rate": {"at": 0, "type": "f32"}, "volume": {"at": 4, "type": "f32"}}},
  "publish": [
    {"each": {"bits": "valves", "as": "n", "value": "on"}, "topic": "{topic}/valve/{n}/state", "retain": true,
     "json": {"value": {"var": "on", "map": {"0": "OFF", "1": "ON"}}}},
    {"topic": "{topic}/fault", "retain": true, "json": {"value": {"var": "fault", "bool": true}}},
    {"topic": "{topic}/link", "json": {"rssi": {"var": "rssi"}, "snr": {"var": "snr"}}},
    {"each": "group", "topic": "{topic}/flow/{n}/volume", "retain": true, "json": {"value": {"var": "volume", "round": 4}}},
    {"each": "group", "topic": "{topic}/flow/{n}/rate", "json": {"value": {"var": "rate", "round": 4}}} ] }
```

* An 8-byte routine report has an empty group: no flow topics. A link byte of `0x00` makes `rssi`/`snr` absent,
  so the `link` publish is skipped. Both are expressed by the data alone.
* The `RESULT 0x82` message (usually piggybacked in the node's ACK) re-publishes all 8 valve states from its
  bitmap, so a confirmed valve state arrives whether the node reports it itself or in an ACK.
* Commands: `.../valve/<n>/set` (`{"value":"ON","ttl":600}` or a bare `ON`/`off`/`1`), `.../flow/<n>/reset`
  (any truthy payload; `"requires": "go"`), `.../cmd/close_all`, `.../cmd/get_state`.

---

## 12. Conformance notes for other interpreters

An implementation of this language (on another gateway) must reproduce: first-match message selection;
little-endian decoding; the null sentinel on the *stored* integer; enum fallback to the decimal text; the
absent-variable skip rule; the rendering rules of §4.5 (compact JSON, key order, whole numbers as integers,
rounding with trimmed zeros, no `-0`); the topic safety rules; the fan-out cap and "ACK only after all publishes
are queued"; and the downlink range/parse rules (§5). The two example files, with their test vectors, are the
conformance suite: an interpreter is conformant for version 1 when both install and pass their own vectors.
