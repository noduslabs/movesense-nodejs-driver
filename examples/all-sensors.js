// Subscribe to every common stream at once. Useful for verifying the driver
// against a real sensor.

const { MovesenseScanner } = require('..');

async function main() {
  const scanner = new MovesenseScanner();
  const device = await scanner.findOne({
    serial: process.env.MOVESENSE_SERIAL,  // optional pinning, e.g. "210330000123"
    timeoutMs: 30000,
  });
  console.log(`Connecting to ${device.localName}...`);

  device.on('error', (e) => console.error('error:', e.message));

  let counts = { acc: 0, gyro: 0, magn: 0, imu9: 0, ecg: 0, hr: 0, temp: 0 };
  for (const k of Object.keys(counts)) {
    device.on(k, () => { counts[k]++; });
  }
  setInterval(() => {
    console.log('rates/sec:', Object.fromEntries(
      Object.entries(counts).map(([k, v]) => [k, v])
    ));
    for (const k of Object.keys(counts)) counts[k] = 0;
  }, 1000);

  await device.connect();
  await device.subscribeAcc(52);
  await device.subscribeGyro(52);
  await device.subscribeMagn(13);
  await device.subscribeImu9(52);
  await device.subscribeEcg(125);
  await device.subscribeHr();
  await device.subscribeTemp();

  process.on('SIGINT', async () => {
    await device.disconnect();
    process.exit(0);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
