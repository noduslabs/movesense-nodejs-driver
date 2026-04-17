// Basic example: scan for every Movesense in range, connect to each, and
// stream accelerometer (52 Hz) + heart rate / RR intervals concurrently from
// all of them. Output is tagged with the sensor serial so you can tell which
// stream is which. Ctrl-C to stop.
//
// Demonstrates graceful error handling: no uncaught exceptions, errors are
// surfaced via `error` events, and one device's failure doesn't take down
// the others.
//
// Run:
//   node examples/basic.js                                   # all sensors, 10s scan
//   SCAN_SECONDS=20 node examples/basic.js                   # longer scan window
//   ACC_RATE=104 node examples/basic.js                      # custom acc rate
//   MOVESENSE_SERIAL=210330000123 node examples/basic.js     # one specific sensor
//   DEBUG=1 node examples/basic.js                           # raw RX bytes

const { MovesenseScanner } = require('..');

const SCAN_SECONDS  = Number(process.env.SCAN_SECONDS) || 10;
const ACC_RATE      = Number(process.env.ACC_RATE) || 52;
const TARGET_SERIAL = process.env.MOVESENSE_SERIAL || null;
const DEBUG         = !!process.env.DEBUG;

async function handleDevice(device) {
  const tag = device.serial || device.id.slice(0, 8);

  device.on('error',        (e) => console.error(`[${tag}] error: ${e.message}`));
  device.on('disconnect',   () => console.log(`[${tag}] disconnected`));
  device.on('reconnecting', ({ attempt, delayMs }) =>
    console.log(`[${tag}] reconnecting (attempt ${attempt}, in ${delayMs}ms)`));
  device.on('reconnect',    () => console.log(`[${tag}] reconnected & resubscribed`));
  if (DEBUG) device.on('debug', (d) => console.log(`[${tag}] rx ${d.hex}`));

  device.on('acc', ({ timestamp, samples }) => {
    const last = samples[samples.length - 1];
    console.log(
      `[${tag}] acc t=${timestamp} n=${samples.length} ` +
      `last=(${last.x.toFixed(0)},${last.y.toFixed(0)},${last.z.toFixed(0)}) mg`
    );
  });

  device.on('hr', ({ average, rrIntervals }) => {
    console.log(`[${tag}] hr  ${average.toFixed(0)} bpm  rr=[${rrIntervals.join(',')}]`);
  });

  try {
    await device.connect();
  } catch (e) {
    console.error(`[${tag}] connect failed: ${e.message}`);
    return;
  }

  // Subscribe independently so one failing stream doesn't block the others.
  const results = await Promise.allSettled([
    device.subscribeAcc(ACC_RATE),
    device.subscribeHr(),
  ]);
  const labels = [`acc@${ACC_RATE}Hz`, 'hr'];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[${tag}] subscribe ${labels[i]} failed: ${r.reason.message}`);
    }
  });
}

async function main() {
  const scanner = new MovesenseScanner({ debug: DEBUG });
  scanner.on('error', (e) => console.error('scanner error:', e.message));

  const devices = new Map();   // peripheral.id -> MovesenseDevice
  const inFlight = [];

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
  console.log(`Streaming acc@${ACC_RATE}Hz + HR from ${devices.size} sensor(s). Ctrl-C to stop.`);

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
