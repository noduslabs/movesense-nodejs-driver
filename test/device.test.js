'use strict';

// Regression test: when the GATT channel is dead, a write-with-response never
// gets its ack. A failed subscribe used to await its cleanup UNSUBSCRIBE write
// with no bound, so the subscribe timeout never surfaced and the caller hung
// with the sensor looking "connected" and delivering no samples.

const assert = require('assert');
const { EventEmitter } = require('events');
const { MovesenseDevice } = require('../src/device');

function deadLinkDevice() {
  const peripheral = new EventEmitter();
  peripheral.id = 'fake';
  peripheral.state = 'disconnected';
  peripheral.advertisement = { localName: 'Movesense 210330000123' };
  const device = new MovesenseDevice(peripheral, {
    autoReconnect: false,
    commandTimeoutMs: 50,
    cleanupTimeoutMs: 50,
  });
  // Skip the BLE handshake: mark it connected with a write characteristic
  // whose writes never complete.
  device._connected = true;
  device._writeChar = { writeAsync: () => new Promise(() => {}) };
  return device;
}

async function settlesWithin(promise, ms, what) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  try { return await Promise.race([promise, guard]); } finally { clearTimeout(timer); }
}

(async () => {
  // 1. A subscribe on a dead link rejects with its timeout instead of hanging.
  const a = deadLinkDevice();
  await assert.rejects(
    settlesWithin(a.subscribeAcc(13), 1000, 'subscribeAcc'),
    /timed out/
  );
  assert.strictEqual(a._activeSubs.size, 0, 'failed subscription must not stay tracked');

  // 2. unsubscribe() and disconnect() on a dead link return too.
  const b = deadLinkDevice();
  b._activeSubs.set('/Meas/Acc/13', { ref: 1, path: '/Meas/Acc/13' });
  b._activeSubs.set('/Meas/HR', { ref: 2, path: '/Meas/HR' });
  assert.strictEqual(await settlesWithin(b.unsubscribe('/Meas/Acc/13'), 1000, 'unsubscribe'), true);
  await settlesWithin(b.disconnect(), 1000, 'disconnect');
  assert.strictEqual(b._activeSubs.size, 0);

  console.log('All device tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
