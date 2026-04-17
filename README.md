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

## What data the sensor provides

The Movesense exposes the following streams via the GATT SensorData Protocol. Subscribe to one with the matching helper, listen on the matching event, get sample batches at the chosen rate.

| Data | Subscribe call | Event | Sample shape | Units | Available rates (Hz) |
|---|---|---|---|---|---|
| **Accelerometer** | `subscribeAcc(rate)` | `acc` | `{x, y, z}` (float32) | mg | 13 · 26 · 52 · 104 · 208 · 416 · 833 · 1666 |
| **Gyroscope** | `subscribeGyro(rate)` | `gyro` | `{x, y, z}` | °/s | same as Acc |
| **Magnetometer** | `subscribeMagn(rate)` | `magn` | `{x, y, z}` | µT | same as Acc |
| **IMU6** (acc + gyro, time-aligned) | `subscribeImu6(rate)` | `imu6` | `{acc:{x,y,z}, gyro:{x,y,z}}` | mg + °/s | same as Acc |
| **IMU9** (acc + gyro + magn) | `subscribeImu9(rate)` | `imu9` | `{acc, gyro, magn}` | mg + °/s + µT | same as Acc |
| **ECG** | `subscribeEcg(rate)` | `ecg` | `int32` raw counts | × 0.381 → µV | 125 · 128 · 200 · 250 · 256 · 500 · 512 |
| **Heart rate** | `subscribeHr()` | `hr` | `{average, rrIntervals}` | bpm + ms | event-driven (per beat) |
| **R-R intervals** | `subscribeHr()` | `rr` | `number[]` | ms | re-emitted from `hr` |
| **Temperature** | `subscribeTemp()` | `temp` | `{kelvin, celsius}` | K / °C | event-driven (~1 Hz) |

Every `Meas` packet (HR is the exception) includes a `timestamp` (uint32 ms since sensor boot) and arrives as a *batch* of N samples per BLE notification — N depends on the rate and the negotiated MTU. Higher rates (≥ 416 Hz motion, ≥ 250 Hz ECG) need a negotiated MTU ≥ 185.

### Worked examples

```js
// Motion — accelerometer at 52 Hz
await device.subscribeAcc(52);
device.on('acc', ({ timestamp, samples }) => {
  for (const s of samples) {
    console.log(timestamp, s.x, s.y, s.z); // mg
  }
});

// Heart rate + R-R intervals (HRV)
await device.subscribeHr();
device.on('hr', ({ average, rrIntervals }) => {
  console.log(`${average.toFixed(0)} bpm`, rrIntervals, 'ms');
});
device.on('rr', (rr) => myHrvBuffer.push(...rr)); // convenience event

// ECG at 250 Hz, converted to microvolts
await device.subscribeEcg(250);
device.on('ecg', ({ timestamp, samples }) => {
  const microvolts = samples.map(s => s * 0.381);
  myEcgBuffer.push({ t: timestamp, uV: microvolts });
});

// Combined IMU at 104 Hz
await device.subscribeImu9(104);
device.on('imu9', ({ samples }) => {
  for (const s of samples) {
    // s.acc.{x,y,z}  s.gyro.{x,y,z}  s.magn.{x,y,z}
  }
});

// Temperature
await device.subscribeTemp();
device.on('temp', ({ celsius }) => console.log(`${celsius.toFixed(1)} °C`));
```

### Battery level

Movesense exposes battery via the **standard BLE Battery Service** (UUID `0x180F`), which works on every firmware variant and returns the value instantly:

```js
const percent = await device.getBatteryLevel();   // 0–100, immediate
console.log(`battery: ${percent}%`);

// Optional: live updates when the level changes
await device.subscribeBatteryLevel();
device.on('battery', ({ percent }) => console.log(`battery: ${percent}%`));
```

The Whiteboard endpoints `/System/Energy/Level` and `/System/Energy` also exist but are unreliable across firmware builds (some `gatt-sensordata-app` variants strip them and return `400`). Prefer `getBatteryLevel()`.

### One-shot reads (GET endpoints)

Beyond the `/Meas/*` streams and battery, the sensor exposes static and on-demand info you can fetch with `device.get(path)`. The driver returns the raw SBEM payload bytes; you decode the fields you need.

| Path | Returns |
|---|---|
| `/Info` | manufacturer, product name, **serial**, sw/hw versions, API level, hw config |
| `/System/Mode` | current power / operation mode |
| `/Time` | UTC clock (µs) |
| `/Component/Leds` | LED control (also writeable) |
| `/Mem/Logbook/Entries` | list of on-device recorded sessions |
| `/Misc/Gear/Id` | paired-gear ID (HR-strap variants) |

```js
const { status, payload } = await device.get('/Info');
// status === 200, payload is a Buffer of SBEM-encoded bytes
```

The full set of resources, parameters and SBEM schemas is documented in the [Movesense API YAML specs](https://bitbucket.org/movesense/movesense-device-lib/src/master/MovesenseCoreLib/resources/movesense-api/).

### Custom paths

For any resource the driver doesn't wrap, use the generic `subscribe(path, parser, eventName)`:

```js
const { parsers } = require('movesense-driver');
await device.subscribe('/Meas/IMU6/208', parsers.parseImu6, 'imu6_fast');
device.on('imu6_fast', (data) => { /* ... */ });
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

See [What data the sensor provides](#what-data-the-sensor-provides) for the full list of streams, payload shapes, units, and rates. Method defaults: `subscribeAcc/Gyro/Magn/Imu6/Imu9` default to 52 Hz, `subscribeEcg` to 125 Hz; `subscribeHr` and `subscribeTemp` take no rate.

All subscribe methods return a `Promise<Subscription>` and start emitting events after the sensor ACKs the SUBSCRIBE (or sends the first DATA packet, whichever comes first).

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
node examples/basic.js                                      # Acc + HR
node examples/battery.js                                    # battery level (one-shot + stream)
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
