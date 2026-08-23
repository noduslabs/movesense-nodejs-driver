'use strict';

// Regression test for the Windows/WinRT discovery case: the first advertising
// packet a Movesense sends carries no local name (it's in the scan response),
// so the scanner must keep looking at later packets for the same peripheral.

const assert = require('assert');
const Module = require('module');
const { EventEmitter } = require('events');

// Stub out noble so this runs without a BLE adapter (or noble installed).
const fakeNoble = new EventEmitter();
fakeNoble.state = 'poweredOn';
fakeNoble.scanCalls = [];
fakeNoble.startScanningAsync = async (uuids, allowDuplicates) => {
  fakeNoble.scanCalls.push({ uuids, allowDuplicates });
};
fakeNoble.stopScanningAsync = async () => {};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@abandonware/noble') return fakeNoble;
  return origLoad.call(this, request, ...rest);
};

const { MovesenseScanner } = require('../src/scanner');

(async () => {
  // 1. Duplicates are allowed by default, and can be turned off explicitly.
  await new MovesenseScanner().start();
  assert.strictEqual(fakeNoble.scanCalls.pop().allowDuplicates, true);
  await new MovesenseScanner({ allowDuplicates: false }).start();
  assert.strictEqual(fakeNoble.scanCalls.pop().allowDuplicates, false);

  // 2. A peripheral whose name only shows up on a later packet is discovered.
  const scanner = new MovesenseScanner();
  const found = [];
  scanner.on('discover', (d) => found.push(d));
  await scanner.start();

  // Packet 1: connectable ADV — no local name yet.
  const peripheral = { id: 'aabbccddeeff', advertisement: { localName: undefined, serviceUuids: ['fdf3'] } };
  fakeNoble.emit('discover', peripheral);
  assert.strictEqual(found.length, 0, 'unnamed packet must not produce a device');

  // Packet 2: scan response — noble merges the name into the same object.
  peripheral.advertisement.localName = 'Movesense 210330000123';
  fakeNoble.emit('discover', peripheral);
  assert.strictEqual(found.length, 1, 'named packet must produce a device');
  assert.strictEqual(found[0].localName, 'Movesense 210330000123');
  assert.strictEqual(found[0].serial, '210330000123');

  // 3. Every further packet from the same peripheral is ignored.
  fakeNoble.emit('discover', peripheral);
  fakeNoble.emit('discover', peripheral);
  assert.strictEqual(found.length, 1, 'discover must fire once per peripheral');

  // 4. Non-Movesense traffic is still filtered out.
  fakeNoble.emit('discover', { id: 'ffeeddccbbaa', advertisement: { localName: 'Some Headphones' } });
  assert.strictEqual(found.length, 1);

  // 5. A device built before its name arrived still reports it (live getter).
  const { MovesenseDevice } = require('../src/device');
  const late = { id: '112233445566', advertisement: {} };
  const device = new MovesenseDevice(late);
  assert.strictEqual(device.serial, null);
  late.advertisement.localName = 'Movesense 210330000999';
  assert.strictEqual(device.serial, '210330000999');

  await scanner.stop();
  Module._load = origLoad;
  console.log('All scanner tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
