// Battery check.
//
// Movesense exposes battery level in two independent ways:
//
//   1. Standard BLE Battery Service (UUID 0x180F).
//      - Works on every firmware variant.
//      - Single read returns the current percentage immediately.
//      - Optional notify subscription for change updates.
//      => Use `device.getBatteryLevel()` and `device.subscribeBatteryLevel()`.
//
//   2. Whiteboard `/System/Energy/Level` GET / SUBSCRIBE.
//      - Stripped from some `gatt-sensordata-app` builds (returns 400).
//      - Subscribe-only on most firmwares; notifies only on ~1% change with
//        no initial value, so the first event can take many minutes.
//      => Only use as a fallback. Shown at the bottom for reference.
//
// Run:
//   node examples/battery.js
//   MOVESENSE_SERIAL=210330000123 node examples/battery.js

const { MovesenseScanner } = require('..');

async function main() {
  const scanner = new MovesenseScanner();
  scanner.on('error', (e) => console.error('scanner error:', e.message));

  console.log('Scanning for Movesense sensors...');
  const device = await scanner.findOne({
    serial: process.env.MOVESENSE_SERIAL,
    timeoutMs: 30000,
  });
  console.log(`Found ${device.localName} (id=${device.id})`);

  device.on('error',        (e) => console.error('device error:', e.message));
  device.on('disconnect',   () => console.log('disconnected'));
  device.on('reconnecting', ({ attempt, delayMs }) =>
    console.log(`reconnecting (attempt ${attempt}, in ${delayMs}ms)`));
  device.on('reconnect',    () => console.log('reconnected'));

  await device.connect();
  console.log('connected');

  // ---- Preferred: standard BLE Battery Service ----
  try {
    const percent = await device.getBatteryLevel();
    console.log(`>>> battery: ${percent}%`);
  } catch (e) {
    console.error('getBatteryLevel failed:', e.message);
    console.error('This sensor does not expose the standard Battery Service.');
    await device.disconnect();
    process.exit(2);
  }

  // Live updates (fires when the device pushes a new level).
  device.on('battery', ({ percent }) => console.log(`>>> battery update: ${percent}%`));
  try {
    await device.subscribeBatteryLevel();
    console.log('subscribed to battery notifications — Ctrl-C to exit');
  } catch (e) {
    console.error('subscribeBatteryLevel failed:', e.message);
  }

  const shutdown = async () => {
    console.log('\nstopping...');
    try { await device.disconnect(); } catch (e) { console.error('shutdown error:', e.message); }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
