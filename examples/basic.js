// Basic example: scan, connect to first Movesense found, stream accelerometer
// at 52 Hz and heart rate / RR intervals. Ctrl-C to stop.
//
// Demonstrates graceful error handling: no uncaught exceptions, errors are
// surfaced via `error` events, and the client app decides what to do.

const { MovesenseScanner } = require('..');

async function main() {
  // Set DEBUG=1 to see raw notification bytes from the sensor.
  const scanner = new MovesenseScanner({ debug: !!process.env.DEBUG });
  scanner.on('error', (e) => console.error('scanner error:', e.message));

  console.log('Scanning for Movesense sensors...');
  const device = await scanner.findOne({ timeoutMs: 30000 });
  console.log(`Found ${device.localName} (id=${device.id})`);

  device.on('connect',      () => console.log('connected'));
  device.on('disconnect',   () => console.log('disconnected'));
  device.on('reconnecting', ({ attempt, delayMs }) =>
    console.log(`reconnecting (attempt ${attempt}, in ${delayMs}ms)`));
  device.on('reconnect',    () => console.log('reconnected & resubscribed'));
  // IMPORTANT: always attach an `error` listener. Without one, Node's default
  // behaviour would be to throw. The driver installs its own internal guard
  // so your app won't crash even if you forget, but you won't see errors.
  device.on('error',        (e) => console.error('device error:', e.message));
  device.on('debug',        (d) => console.log('rx', d.hex));

  device.on('acc', ({ timestamp, samples }) => {
    const last = samples[samples.length - 1];
    console.log(`acc  t=${timestamp} n=${samples.length} last=`, last);
  });

  device.on('hr', ({ average, rrIntervals }) => {
    console.log(`hr   avg=${average.toFixed(1)} bpm  rr=${rrIntervals.join(',')}`);
  });

  await device.connect();

  // Subscribe individually so one failing stream doesn't block the others.
  await Promise.allSettled([
    device.subscribeAcc(52),
    device.subscribeHr(),
  ]).then((results) => {
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`subscribe #${i} failed:`, r.reason.message);
      }
    });
  });

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
