// Basic example: scan, connect to first Movesense found, stream accelerometer
// at 52 Hz and heart rate / RR intervals. Ctrl-C to stop.

const { MovesenseScanner } = require('..');

async function main() {
  // Set DEBUG=1 to see raw notification bytes from the sensor.
  const scanner = new MovesenseScanner({ debug: !!process.env.DEBUG });

  console.log('Scanning for Movesense sensors...');
  const device = await scanner.findOne({ timeoutMs: 30000 });
  console.log(`Found ${device.localName} (id=${device.id})`);

  device.on('connect',      () => console.log('connected'));
  device.on('disconnect',   () => console.log('disconnected'));
  device.on('reconnecting', ({ attempt, delayMs }) =>
    console.log(`reconnecting (attempt ${attempt}, in ${delayMs}ms)`));
  device.on('reconnect',    () => console.log('reconnected'));
  device.on('error',        (e) => console.error('error:', e.message));
  device.on('debug',        (d) => console.log('rx', d.hex));

  device.on('acc', ({ timestamp, samples }) => {
    const last = samples[samples.length - 1];
    console.log(`acc  t=${timestamp} n=${samples.length} last=`, last);
  });

  device.on('hr', ({ average, rrIntervals }) => {
    console.log(`hr   avg=${average.toFixed(1)} bpm  rr=${rrIntervals.join(',')}`);
  });

  await device.connect();
  await device.subscribeAcc(52);
  await device.subscribeHr();

  process.on('SIGINT', async () => {
    console.log('\nstopping...');
    await device.disconnect();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
