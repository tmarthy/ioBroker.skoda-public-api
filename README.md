![Logo](admin/skoda-public-api.png)
# ioBroker.skoda-public-api

[![NPM version](https://img.shields.io/npm/v/iobroker.skoda-public-api.svg)](https://www.npmjs.com/package/iobroker.skoda-public-api)
[![Downloads](https://img.shields.io/npm/dm/iobroker.skoda-public-api.svg)](https://www.npmjs.com/package/iobroker.skoda-public-api)
![Number of Installations](https://iobroker.live/badges/skoda-public-api-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/skoda-public-api-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.skoda-public-api.png?downloads=true)](https://nodei.co/npm/iobroker.skoda-public-api/)

**Tests:** ![Test and Release](https://github.com/tmarthy/ioBroker.skoda-public-api/workflows/Test%20and%20Release/badge.svg)

## skoda-public-api adapter for ioBroker

Read and control Škoda vehicles via the official
[MyŠkoda Public API](https://public.api.connect.skoda-auto.cz/docs).

The adapter is published on npm. Inclusion in the ioBroker `latest` repository is
tracked in [ioBroker.repositories#6592](https://github.com/ioBroker/ioBroker.repositories/pull/6592).
Development status and open work are documented in [HANDOFF.md](HANDOFF.md).

### The one constraint that shapes everything

The API allows **20 requests per hour per VIN**. There is a single read endpoint,
several command endpoints, no push, no webhooks, and no operation-status endpoint — a
command returns `202 Accepted` and you learn the outcome only from a later poll, which
costs quota again. Near-real-time monitoring is not possible with this API, and neither
is PV surplus charging with current modulation. Plan accordingly.

## Getting the API key

The adapter uses the **official** MyŠkoda Public API — not the reverse-engineered app
interface that `iobroker.vw-connect` talks to.

1. Open the MyŠkoda app (version 8.16 or newer) and go to **API key**.
2. Select the vehicles the key may access. The key is bound to that selection: a VIN
   that was not selected answers with `403`, no matter how correct it looks.
3. Copy the key into the adapter instance. It **expires** after a while — the adapter
   watches the expiry date and warns you (see [Key expiry](#key-expiry)).

The key is stored encrypted (`encryptedNative`). Enter it in the admin UI, **not** in
the object browser: a plain value there is treated as encrypted on startup and turns
into garbage.

## Configuration

| Field | Default | What it does |
|---|---|---|
| API key | — | The key from the app. Required. |
| Vehicles | — | One row per VIN. **The API has no vehicle list**, so every VIN is entered by hand. |
| Base interval | 15 min | Cadence when nothing is happening. Minimum 5. |
| Interval while charging or climatising | 5 min | Cadence while the vehicle is doing something. Minimum 3. |
| Maximum interval for a sleeping vehicle | 60 min | Ceiling for the freshness backoff, see below. |
| Requests reserved for commands | 6 | Polling stops once only this many requests are left. |
| Command lifetime | 10 min | A queued command that could not be sent within this time is discarded. |
| S-PIN | — | Only needed for auxiliary heating. Never put it into a state. |
| Read parking position | on | When off, the position is **not even requested** from the API. |
| Language for logs and notifications | System | Uses the ioBroker system language or forces English/German. |

There is a **Test connection** button. It sends exactly one request (out of the 20) and
tells you what is wrong in plain words — a typo in the VIN and a key that does not cover
the vehicle both produce the same `403`, and nobody guesses that from the raw error.

There is deliberately **no field for the API server**. A visible "API server" field
invites pointing the adapter — and its key — at a foreign host. For development the base
URL comes from the environment variable `SKODA_API_BASE_URL`.

## What you get

The object tree under `<vin>` mirrors the API response 1:1. Objects are created **only
for parts the vehicle actually delivers** — a battery-electric Enyaq has no
`fuelStatus`, so no such states appear. Nothing is ever deleted automatically.

Two additions that are not in the API:

- `<vin>.parkingPosition.position` — `lat;lon` in one state, for VIS maps and geofence
  adapters.
- `<vin>.chargingProfiles.profiles.<id>.*` — charging profiles by **profile id**, not by
  index. Deleting a profile in the app would otherwise silently shift all the others.

### The `info` states

| State | Meaning |
|---|---|
| `info.connection` | `false` when the key is rejected (401/403). **Stays `true` when the quota is exhausted** — an empty budget is normal operation, not a fault. |
| `<vin>.rateLimit.*` | `limit`, `remaining`, `resetAt`, `lastRequestAt` — the separate budget for this VIN, from the `RateLimit-*` headers and the adapter's memory across restarts. |
| `info.apiKey.expiresAt`, `.daysRemaining` | From the `X-API-Key-Expires-At` header of every response. |
| `<vin>.info.dataAge` | Seconds since the newest `carCapturedTimestamp` in the response. |
| `<vin>.info.lastErrors` | The `errors[]` of the last response as JSON. |
| `<vin>.info.lastCommand.*` | `name`, `result`, `timestamp`, `problemType` of the last command. |

**Incomplete responses are normal.** When the API reports a failed part, or a field
disappears from a returned part, its states keep their last value with quality "not
good". This also applies to states retained across a restart and removed charging
profiles. Returning values regain good quality, even if their value has not changed.
Parts intentionally excluded from the request are left alone. `dataAge` measures the
age of the newest vehicle timestamp at the last successful poll; it is not a live clock
or a freshness guarantee for every individual state.

### Display units

The following numeric values use more readable display units. Their state IDs keep
the API field names, including the original unit suffixes:

| State below `<vin>` | Display unit | Example |
|---|---|---|
| `charging.status.battery.remainingCruisingRangeInMeters` | km | API `352000` → state `352` |
| `activeVentilation.durationInSeconds` | min | API `600` → state `10` |
| `auxiliaryHeating.durationInSeconds` | min | API `90` → state `1.5` |

Other ranges and the odometer already use km; charging time already uses minutes.
Values are divided without rounding. Existing object units and default descriptions
are updated when the corresponding value is next received; custom names are retained.
Scripts reading these three states must use km/min. Existing recorded time series are
not rewritten. API responses and command payloads retain the API units.

## Controlling the vehicle

Each domain the vehicle supports gets three states, for example under `<vin>.charging`:

- `enabled` (switch) carries the **target state**. Writing it sends a command — unless
  the target already matches what the last poll saw, in which case nothing is sent and
  `info.lastCommand.result` reads `COALESCED`.
- `start` and `stop` (buttons) **force** the call. They are the way out when the polled
  data is ten minutes old and no longer true.

**`ack = true` means "handed over to the API", not "the car did it".** The API answers a
command with `202 Accepted` and offers no endpoint that reports the outcome; the adapter
schedules a verification poll 60 seconds later, and only that poll shows what actually
happened. Anyone building automation on top of this needs to know that.

While a command is awaiting confirmation, repeating the same switch value is also
`COALESCED`; an opposite value can still send a command. A matching vehicle timestamp
newer than the accepted command ends this waiting phase. Without confirmation it lasts
at most the configured command lifetime (10 minutes by default), after which a new
switch write can retry. Expiry does not automatically resend the command.

The current Public API also advertises supported operations in `<vin>.operations` and
offers endpoints for charging limit, charging mode and charging-profile updates. The
adapter mirrors the operation list but does not expose these three setting operations
as writable states yet; the on/off commands listed above are supported.

`info.lastCommand.result` is one of:

| Result | Meaning |
|---|---|
| `SENT` | Handed over to the API. |
| `QUEUED` | Waiting for quota; it will go out on its own. |
| `COALESCED` | No request: the target matches the known state or a command still awaiting confirmation. |
| `EXPIRED` | Dropped, could not be sent within its lifetime. |
| `REJECTED_BY_VEHICLE` | The vehicle refused it (not supported, disabled, or busy). |
| `FAILED` | Anything else — see the log. |

## Cadence, or why your data can be an hour old

A parked vehicle reports the **same** `carCapturedTimestamp` at every poll. Asking
faster costs the full quota and yields exactly nothing, so the adapter doubles its
interval every time the timestamp has not moved, up to the configured ceiling. As soon
as the vehicle reports something new — or you send a command — it falls back to the base
cadence immediately.

What this API cannot give you, no matter how it is configured:

- **No second-by-second monitoring.** 20 requests per hour is one every three minutes,
  and that is the whole budget.
- **No immediate notification when charging ends.** You learn about it at the next poll.
- **No current modulation.** The API can set a target state of charge and a charging
  mode, but it cannot set charging current, so surplus charging remains on/off only.

## PV surplus charging

`examples/pv-surplus-charging.js` is a commented template for the ioBroker JavaScript
adapter: switch-on threshold, switch-off threshold with a delay, minimum on and off
times, a cap on switching operations per hour, and evaluation of
`info.lastCommand.result`. The control logic deliberately lives **outside** the adapter —
every PV setup has different state IDs and meter semantics.

Two things decide whether this works for you:

- **Set the AC charging current in the MyŠkoda app to `REDUCED`.** The API cannot set
  it. At `MAXIMUM` the vehicle pulls whatever the wallbox offers, and a small surplus
  cannot cover it.
- **Measure what your vehicle actually draws** (`charging.status.chargePowerInKw`) and
  set your thresholds from that number, not from the label on the wallbox.

## Key expiry

The key cannot be renewed automatically — the API does not offer it, and creating a new
one needs a human with the phone in hand. Since values in the tree keep their last state
when polling fails, an expired key would otherwise go unnoticed for weeks. The adapter
therefore escalates once per day: an `info` message at 14 days, a warning at 7, an error
at 2, plus an ioBroker notification from 7 days on and an alert once the key is gone.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `403 api-key-not-authorized` | Either the VIN has a typo, or the vehicle was not selected when the key was created. The **Test connection** button says which. |
| `401 api-key-expired` | New key needed. `info.connection` goes to `false` and polling drops to once per hour. |
| `429 rate-limit-exceeded` | Budget spent. Normal operation; the adapter waits for the window and keeps `info.connection` at `true`. |
| Commands do nothing | Check `info.lastCommand.result`. `COALESCED` means the target already matched the last known state — use the `start`/`stop` buttons to force the call. |
| States stop updating | Look at `<vin>.info.dataAge`. A sleeping vehicle is polled less and less often, on purpose. |

## Languages

The adapter configuration and object tree are available in English and German. Logs,
notifications and connection-test results use the ioBroker system language by default.
The instance setting **Language for logs and notifications** can override this with
English or German. Other ioBroker UI languages continue to use English backend text as
their fallback.

## Disclaimer

Škoda and MyŠkoda are trademarks of Škoda Auto a.s. This project is an independent
open-source adapter and is neither affiliated with nor endorsed by Škoda Auto. It uses
the publicly documented MyŠkoda Public API with a key that the vehicle owner creates
themselves. The adapter icon is original, brand-neutral project artwork and does not
reproduce the official Škoda logo; it is distributed under this project's MIT license.

## Changelog
### 0.1.5 (2026-09-06)
* (Thomas Marthy) aligned the test workflow and changelog archive with repository checker requirements

### 0.1.4 (2026-09-06)
* (Thomas Marthy) added complete backend translations for all supported ioBroker languages

### 0.1.3 (2026-09-06)
* (Thomas Marthy) completed missing admin UI translations for all supported languages

### 0.1.2 (2026-09-06)
* (Thomas Marthy) resolved repository checker warnings for CI test discovery, environment access, changelog archiving and npm packaging

### 0.1.1 (2026-09-06)
* (Thomas Marthy) completed ioBroker object name translations for all supported languages

### 0.1.0 (2026-09-05)
* (Thomas Marthy) fixed ioBroker state roles reported by object structure validation
* (Thomas Marthy) added German and English backend messages, notifications, connection-test results and object names
* (Thomas Marthy) ensured compiled code and backend translations are included in the npm package

### 0.0.2 (2026-09-05)
* (Thomas Marthy) enabled npm Trusted Publishing for automated releases

### 0.0.1 (2026-09-05)
* (Thomas Marthy) initial release

[Older changelog entries](https://github.com/tmarthy/ioBroker.skoda-public-api/blob/main/CHANGELOG_OLD.md)

## License
MIT License

Copyright (c) 2026 Thomas Marthy <261668002+tmarthy@users.noreply.github.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
