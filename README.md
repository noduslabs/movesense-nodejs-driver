# movesense-driver

A small, dependency-light Node.js driver for [Movesense](https://www.movesense.com/) BLE sensors. Talks the GATT SensorData Protocol (GSP) directly — no native bridges, no React Native shims — so you can stream accelerometer, gyro, magnetometer, IMU6/9, ECG, heart rate (with R-R intervals) and temperature into any Node app.

- Pure JavaScript, ships with TypeScript types.
- Single transport dependency: [`@abandonware/noble`](https://github.com/abandonware/noble) (macOS / Linux / Windows BLE central).
- `EventEmitter` API per device.
- Auto-reconnect with exponential backoff and automatic re-subscription of all active streams.

## Requirements

| Platform | Setup |
|---|---|
| macOS | Grant Bluetooth permission to the terminal / Node process the first time you run. |
| Linux | `sudo apt install libbluetooth-dev` and either run as root or `sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))`. |
| Windows | Use a recent build of `@abandonware/noble` with the WinRT backend. |

Node ≥ 18. Sensor must be flashed with `gatt-sensordata-app` firmware (or the default firmware ≥ 2.3, which exposes the GSP service).

## Install

```bash
npm install movesense-driver
```

## Quick start

```js
const { MovesenseScanner } = require('movesense-driver');

const scanner = new MovesenseScanner();
const device = await scanner.findOne({ timeoutMs: 30000 });

device.on('connect',    () => console.log('connected'));
device.on('disconnect', () => console.log('disconnected'));
device.on('reconnect',  () => console.log('reconnected & resubscribed'));

device.on('acc', ({ timestamp, samples }) => {
  // samples: [{x, y, z}, ...]   // mg
});

device.on('hr', ({ average, rrIntervals }) => {
  // average: bpm     rrIntervals: ms
});

await device.connect();
await device.subscribeAcc(52);   // 13 / 26 / 52 / 104 / 208 / 416 / 833 / 1666 Hz
await device.subscribeHr();
```

To target a specific sensor by serial number (the digits after “Movesense ” in the BLE name):

```js
const device = await scanner.findOne({ serial: '210330000123' });
```

## API

### `class MovesenseScanner`

```js
const scanner = new MovesenseScanner(deviceOptions?);
await scanner.start();
scanner.on('discover', (device) => { /* MovesenseDevice */ });
await scanner.stop();

// or one-shot:
const device = await scanner.findOne({ serial?, timeoutMs? });
```

`deviceOptions` are forwarded to every discovered `MovesenseDevice`.

### `class MovesenseDevice` (extends `EventEmitter`)

#### Connection

| Method | Description |
|---|---|
| `connect()` | Opens the BLE connection, discovers the GSP service, enables notifications. |
| `disconnect()` | Unsubscribes everything, drops the connection, disables auto-reconnect for this instance. |
| `isConnected()` | Boolean. |

Properties: `id`, `localName`, `serial`.

#### Subscriptions

All subscribe methods return a `Promise<Subscription>` and start emitting events after the sensor ACKs the SUBSCRIBE.

| Method | Default rate | Event | Payload |
|---|---|---|---|
| `subscribeAcc(rate)` | 52 Hz | `acc`  | `{ timestamp, samples: [{x,y,z}] }` (mg) |
| `subscribeGyro(rate)` | 52 Hz | `gyro` | `{ timestamp, samples: [{x,y,z}] }` (deg/s) |
| `subscribeMagn(rate)` | 52 Hz | `magn` | `{ timestamp, samples: [{x,y,z}] }` (µT) |
| `subscribeImu6(rate)` | 52 Hz | `imu6` | `{ timestamp, samples: [{acc,gyro}] }` |
| `subscribeImu9(rate)` | 52 Hz | `imu9` | `{ timestamp, samples: [{acc,gyro,magn}] }` |
| `subscribeEcg(rate)` | 125 Hz | `ecg`  | `{ timestamp, samples: number[] }` (raw int32) |
| `subscribeHr()` | — | `hr` | `{ average, rrIntervals }` — also re-emitted as `rr` |
| `subscribeTemp()` | — | `temp` | `{ timestamp, kelvin, celsius }` |

Valid motion-sensor rates: `13, 26, 52, 104, 208, 416, 833, 1666` Hz. Valid ECG rates: `125, 128, 200, 250, 256, 500, 512` Hz. Higher rates need a negotiated MTU ≥ 185.

For paths this driver doesn't wrap (e.g. `/Meas/IMU6m`, app-specific resources):

```js
const { parsers } = require('movesense-driver');
await device.subscribe('/Meas/IMU6/104', parsers.parseImu6, 'imu6_fast');
device.on('imu6_fast', (data) => { ... });
```

`unsubscribe(path)` stops a stream. `get(path)` issues a one-shot GET and resolves with `{ status, payload }` (raw SBEM bytes — caller decodes).

#### Events

| Event | When |
|---|---|
| `connect`      | Connection up, characteristics ready. |
| `disconnect`   | Connection lost (expected or not). |
| `reconnecting` | `{ attempt, delayMs }` before each retry. |
| `reconnect`    | Reconnect succeeded; all prior subscriptions are restored. |
| `error`        | Non-fatal error (parse failure, timed-out command, MTU drop). |
| sensor events  | See subscription table above. |

### Error handling

The driver is designed to never crash the host app. Specifically:

- Every device and scanner has an internal guard that catches throws from `'error'` listeners and the throws Node's `EventEmitter` raises when an `'error'` event is emitted with no listener attached.
- Every async path inside the driver (reconnect loop, notification handler, command writes, parser invocations) wraps its work and surfaces failures as an `'error'` event rather than as an unhandled rejection.
- `connect()`, `subscribeXxx()`, `get()` and `disconnect()` all reject their returned promises on failure so the caller can `try/catch` or `.catch(...)` them.

You should still attach `device.on('error', fn)` so you can see what went wrong; the guard only prevents crashes, it doesn't suppress information.

```js
device.on('error', (err) => {
  // err is a normal Error. Examples you may see:
  //   "Subscribe /Meas/Acc/52 failed (status 404)"   // bad rate / firmware
  //   "Command ref 5 timed out"                       // sensor stopped responding
  //   "Disconnected"                                  // mid-flight when link dropped
  //   "Parse failure for /Meas/HR: ..."               // malformed payload
  //   "Dropped DATA_CONT for /Meas/ECG/500 (MTU too small)"
  myLogger.warn(err);
});

// One stream failing doesn't poison the rest:
const results = await Promise.allSettled([
  device.subscribeAcc(52),
  device.subscribeEcg(125),
]);
for (const r of results) if (r.status === 'rejected') myLogger.warn(r.reason);
```

### Reconnect strategy

On unexpected `disconnect`, the device retries with exponential backoff capped at `maxReconnectDelayMs` (default 30s). On success it re-subscribes every previously active path with fresh reference numbers. Calling `disconnect()` cancels the loop. Override:

```js
const scanner = new MovesenseScanner({
  autoReconnect: true,
  initialReconnectDelayMs: 1000,
  maxReconnectDelayMs: 30000,
  commandTimeoutMs: 5000,
});
```

## Examples

```bash
node examples/basic.js                                    # Acc + HR
MOVESENSE_SERIAL=210330000123 node examples/all-sensors.js  # everything
```

## Protocol notes

The sensor exposes one GATT service:

| | UUID |
|---|---|
| Service | `34802252-7185-4d5d-b431-630e7050e8f0` |
| Write   | `34800001-7185-4d5d-b431-630e7050e8f0` |
| Notify  | `34800002-7185-4d5d-b431-630e7050e8f0` |

Every command is `[code, ref, ...path/payload]`. Every notification is `[code, ref, ...]`, where `code` is `0x01` (one-shot reply, has `uint16` HTTP status at offset 2) or `0x02`/`0x03` (streaming DATA / continuation). Sensor `Meas/*` payloads start with a `uint32` LE timestamp at offset 2, followed by a fixed-stride sample batch. HR is the only stream without a timestamp prefix.

References:
- [GATT SensorData Protocol](https://www.movesense.com/docs/esw/gatt_sensordata_protocol/)
- [API reference (resource paths and SBEM schemas)](https://www.movesense.com/docs/esw/api_reference/)
- [Movesense API YAML specs](https://bitbucket.org/movesense/movesense-device-lib/src/master/MovesenseCoreLib/resources/movesense-api/)

## License

MIT
