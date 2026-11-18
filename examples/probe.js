// Sensor capability probe.
//
// Connects to a Movesense, then walks through every documented endpoint
// (GETs and SUBSCRIBEs at every standard rate) one at a time, reporting:
//
//   - Whether the request was accepted (ack status code)
//   - For SUBSCRIBE: whether any notification arrived within PROBE_MS, what
//     the parsed value looked like, and the raw hex of the first packet.
//   - For GET:     status + raw hex payload.
//
// At the end it prints a summary so you can see exactly what your firmware
// build supports — useful when an "older" sensor refuses paths the newer
// firmware accepts.
//
// Run:
//   node examples/probe.js                                   # all sensors in range
//   SCAN_SECONDS=20 node examples/probe.js                   # longer scan window
//   MOVESENSE_SERIAL=210330000123 node examples/probe.js     # one specific sensor
//   PROBE_MS=3000 node examples/probe.js                     # longer per-probe window
//   DEBUG=1 node examples/probe.js                           # raw RX bytes for every packet

const { MovesenseScanner, parsers } = require('..');

const SCAN_SECONDS = Number(process.env.SCAN_SECONDS) || 10;
const PROBE_MS     = Number(process.env.PROBE_MS) || 1500;
const TARGET       = process.env.MOVESENSE_SERIAL || null;
const DEBUG        = !!process.env.DEBUG;

// All probes. `kind` is GET / SUB. For SUB, `parser` is optional — if absent
// we just dump the first notification's hex.
const PROBES = [
  // ---- One-shot reads ----
  { kind: 'GET', path: '/Info' },
  { kind: 'GET', path: '/System/Mode' },
  { kind: 'GET', path: '/System/Energy/Level' },
  { kind: 'GET', path: '/System/Energy' },
  { kind: 'GET', path: '/Time' },
  { kind: 'GET', path: '/Component/Eeprom/0' },

  // ---- Acc at every standard rate ----
  { kind: 'SUB', path: '/Meas/Acc/13',   parser: parsers.parseXYZ },
  { kind: 'SUB', path: '/Meas/Acc/26',   parser: parsers.parseXYZ },
  { kind: 'SUB', path: '/Meas/Acc/52',   parser: parsers.parseXYZ },
  { kind: 'SUB', path: '/Meas/Acc/104',  parser: parsers.parseXYZ },
  { kind: 'SUB', path: '/Meas/Acc/208',  parser: parsers.parseXYZ },
  { kind: 'SUB', path: '/Meas/Acc/416',  parser: parsers.parseXYZ },
  { kind: 'SUB', path: '/Meas/Acc/833',  parser: parsers.parseXYZ },
  { kind: 'SUB', path: '/Meas/Acc/1666', parser: parsers.parseXYZ },

  // ---- Other motion & combined ----
  { kind: 'SUB', path: '/Meas/Gyro/52',  parser: parsers.parseXYZ },
  { kind: 'SUB', path: '/Meas/Magn/26',  parser: parsers.parseXYZ },
  { kind: 'SUB', path: '/Meas/IMU6/52',  parser: parsers.parseImu6 },
  { kind: 'SUB', path: '/Meas/IMU9/52',  parser: parsers.parseImu9 },

  // ---- Bio ----
  { kind: 'SUB', path: '/Meas/ECG/125',  parser: parsers.parseEcg },
  { kind: 'SUB', path: '/Meas/ECG/250',  parser: parsers.parseEcg },
  { kind: 'SUB', path: '/Meas/HR',       parser: parsers.parseHr },

  // ---- Environment / system ----
  { kind: 'SUB', path: '/Meas/Temp',           parser: parsers.parseTemp },
  { kind: 'SUB', path: '/System/Energy/Level' /* no parser → hex dump */ },
  { kind: 'SUB', path: '/System/States/0'     /* movement state */ },
];

async function probeGet(device, path, log) {
  try {
    const { status } = await device.get(path);
    const ok = status >= 200 && status < 400;
    log(`GET  ${pad(path, 28)} ${ok ? 'OK   ' : 'FAIL '} status=${status}`);
    return { ok, status };
  } catch (e) {
    log(`GET  ${pad(path, 28)} FAIL  ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Reports only WHETHER the stream is alive (and how many packets in the
// window) — never the actual sample values.
async function probeSub(device, path, parser, log) {
  let count = 0;
  const eventName = `_probe_${Math.random().toString(36).slice(2, 8)}`;
  // Parser is invoked but its output is discarded. We just want to count
  // packets, not surface contents.
  const wrappedParser = parser ? ((buf) => { try { parser(buf); } catch (_) {} return null; })
                                : (() => null);
  const onEvent = () => { count++; };
  device.on(eventName, onEvent);

  try {
    await device.subscribe(path, wrappedParser, eventName);
  } catch (e) {
    device.removeListener(eventName, onEvent);
    log(`SUB  ${pad(path, 28)} FAIL  ${e.message}`);
    return { ok: false, error: e.message };
  }

  await new Promise(r => setTimeout(r, PROBE_MS));
  try { await device.unsubscribe(path); } catch (_) {}
  device.removeListener(eventName, onEvent);

  if (count === 0) {
    log(`SUB  ${pad(path, 28)} SILENT (subscribed, 0 packets in ${PROBE_MS}ms)`);
    return { ok: false, ack: true, packets: 0 };
  }
  const rate = (count / (PROBE_MS / 1000)).toFixed(1);
  log(`SUB  ${pad(path, 28)} STREAMING ${count} pkts (~${rate} pkt/s)`);
  return { ok: true, packets: count };
}

function pad(s, n) { return s.length >= n ? s : s + ' '.repeat(n - s.length); }

async function probeDevice(device) {
  const tag = device.serial || device.id.slice(0, 8);
  const log = (msg) => console.log(`[${tag}] ${msg}`);

  device.on('error',      (e) => console.error(`[${tag}] error: ${e.message}`));
  device.on('disconnect', () => log('disconnected'));
  if (DEBUG) device.on('debug', (d) => console.log(`[${tag}] rx ${d.hex}`));

  try {
    await device.connect();
    log('connected');
  } catch (e) {
    const msg = (e && e.message) || (e == null ? 'unknown error (no rejection value)' : String(e));
    console.error(`[${tag}] connect failed: ${msg}`);
    return;
  }

  // Standard BLE Battery Service (separate from Whiteboard).
  try {
    await device.getBatteryLevel();
    log(`BLE  Battery Service           OK   `);
  } catch (e) {
    log(`BLE  Battery Service           FAIL  ${e.message}`);
  }

  // Sequentially walk every probe.
  const summary = [];
  for (const p of PROBES) {
    const result = p.kind === 'GET'
      ? await probeGet(device, p.path, log)
      : await probeSub(device, p.path, p.parser, log);
    summary.push({ kind: p.kind, path: p.path, ...result });
  }

  // Per-device summary: which streams are actively delivering data.
  const streaming = summary.filter(r => r.kind === 'SUB' && r.ok).map(r => r.path);
  const silent    = summary.filter(r => r.kind === 'SUB' && !r.ok && r.ack).map(r => r.path);
  const subFailed = summary.filter(r => r.kind === 'SUB' && !r.ok && !r.ack).map(r => r.path);
  const getOk     = summary.filter(r => r.kind === 'GET' && r.ok).map(r => r.path);
  const getFail   = summary.filter(r => r.kind === 'GET' && !r.ok).map(r => r.path);

  log('—— summary ——');
  log(`  STREAMING (${streaming.length}):  ${streaming.join(', ') || '<none>'}`);
  log(`  SILENT    (${silent.length}):  ${silent.join(', ') || '<none>'}`);
  log(`  SUB FAIL  (${subFailed.length}):  ${subFailed.join(', ') || '<none>'}`);
  log(`  GET OK    (${getOk.length}):  ${getOk.join(', ') || '<none>'}`);
  log(`  GET FAIL  (${getFail.length}):  ${getFail.join(', ') || '<none>'}`);

  await device.disconnect();
  log('done');
}

async function main() {
  const scanner = new MovesenseScanner({ debug: DEBUG });
  scanner.on('error', (e) => console.error('scanner error:', e.message));

  const devices = new Map();   // peripheral.id -> MovesenseDevice
  scanner.on('discover', (device) => {
    if (devices.has(device.id)) return;
    if (TARGET && device.serial !== TARGET) return;
    devices.set(device.id, device);
    console.log(`discovered: ${device.localName} (id=${device.id})`);
  });

  console.log(TARGET
    ? `Scanning for Movesense ${TARGET} (${SCAN_SECONDS}s)...`
    : `Scanning for all Movesense sensors in range (${SCAN_SECONDS}s)...`);
  await scanner.start();
  await new Promise(r => setTimeout(r, SCAN_SECONDS * 1000));
  await scanner.stop();

  if (devices.size === 0) {
    console.error('No Movesense sensors found.');
    process.exit(1);
  }
  console.log(`Probing ${devices.size} sensor(s) in parallel — each probe walks ~25 endpoints @ ${PROBE_MS}ms...\n`);

  // Probe every device in parallel — each device is independent so this is
  // wallclock-bounded by the slowest one, not the sum.
  await Promise.allSettled(Array.from(devices.values()).map(probeDevice));

  console.log('\nAll probes complete.');
  process.exit(0);
}

main().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
