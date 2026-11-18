// Battery check for one OR many Movesense sensors.
//
// Behaviour:
//   - Scans for SCAN_SECONDS (default 10) and connects to every Movesense it
//     finds in that window.
//   - Prints the current battery percentage for each, then subscribes for
//     live updates.
//   - If MOVESENSE_SERIAL is set, only that one sensor is targeted.
//
// Run:
//   node examples/battery.js                                # all sensors in range
//   SCAN_SECONDS=20 node examples/battery.js                # longer scan window
//   MOVESENSE_SERIAL=210330000123 node examples/battery.js  # one specific sensor

const { MovesenseScanner } = require('..');

const SCAN_SECONDS  = Number(process.env.SCAN_SECONDS) || 10;
const TARGET_SERIAL = process.env.MOVESENSE_SERIAL || null;

async function handleDevice(device) {
  const tag = device.serial || device.id.slice(0, 8);
  device.on('error',        (e) => console.error(`[${tag}] error: ${e.message}`));
  device.on('disconnect',   () => console.log(`[${tag}] disconnected`));
  device.on('reconnecting', ({ attempt, delayMs }) =>
    console.log(`[${tag}] reconnecting (attempt ${attempt}, in ${delayMs}ms)`));
  device.on('reconnect',    () => console.log(`[${tag}] reconnected`));
  device.on('battery',      ({ percent }) => console.log(`[${tag}] battery -> ${percent}%`));

  try {
    await device.connect();
  } catch (e) {
    console.error(`[${tag}] connect failed: ${e.message}`);
    return;
  }

  try {
    const percent = await device.getBatteryLevel();
    console.log(`[${tag}] battery: ${percent}%`);
  } catch (e) {
    console.error(`[${tag}] battery read failed: ${e.message}`);
  }

  try {
    await device.subscribeBatteryLevel();
  } catch (e) {
    console.error(`[${tag}] battery subscribe failed: ${e.message}`);
  }
}

async function main() {
  const scanner = new MovesenseScanner();
  scanner.on('error', (e) => console.error('scanner error:', e.message));

  const devices = new Map();          // peripheral.id -> MovesenseDevice
  const inFlight = [];                // promises for per-device handling

  scanner.on('discover', (device) => {
    if (devices.has(device.id)) return;
    if (TARGET_SERIAL && device.serial !== TARGET_SERIAL) return;
    devices.set(device.id, device);
    console.log(`discovered: ${device.localName} (id=${device.id})`);
    inFlight.push(handleDevice(device));
  });

  console.log(
    TARGET_SERIAL
      ? `Scanning for Movesense ${TARGET_SERIAL} (${SCAN_SECONDS}s)...`
      : `Scanning for all Movesense sensors in range (${SCAN_SECONDS}s)...`
  );
  await scanner.start();

  await new Promise(r => setTimeout(r, SCAN_SECONDS * 1000));
  await scanner.stop();

  if (devices.size === 0) {
    console.error('No Movesense sensors found.');
    process.exit(1);
  }
  console.log(`Scan window closed. ${devices.size} sensor(s). Awaiting connects...`);
  await Promise.allSettled(inFlight);
  console.log('All connected. Ctrl-C to exit.');

  const shutdown = async () => {
    console.log('\nstopping...');
    await Promise.allSettled(
      Array.from(devices.values()).map(d => d.disconnect().catch(() => {}))
    );
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
