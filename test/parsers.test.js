// Hardware-free smoke test for the parsers. Run: `node test/parsers.test.js`.
// Builds synthetic notification packets with known values and asserts the
// decoded output matches.

'use strict';

const assert = require('assert');
const { parsers, protocol } = require('..');

function header(code, ref, timestampLE) {
  const b = Buffer.alloc(6);
  b.writeUInt8(code, 0);
  b.writeUInt8(ref, 1);
  b.writeUInt32LE(timestampLE, 2);
  return b;
}

// ----- Acc / Gyro / Magn (XYZ float32) -----
{
  const head = header(protocol.RESP.DATA, 7, 12345);
  const body = Buffer.alloc(2 * 12);
  body.writeFloatLE(1.0, 0);  body.writeFloatLE(2.0, 4);  body.writeFloatLE(3.0, 8);
  body.writeFloatLE(-1.5, 12); body.writeFloatLE(-2.5, 16); body.writeFloatLE(-3.5, 20);
  const out = parsers.parseXYZ(Buffer.concat([head, body]));
  assert.strictEqual(out.timestamp, 12345);
  assert.strictEqual(out.samples.length, 2);
  assert.deepStrictEqual(out.samples[0], { x: 1.0, y: 2.0, z: 3.0 });
  assert.deepStrictEqual(out.samples[1], { x: -1.5, y: -2.5, z: -3.5 });
}

// ----- IMU6 -----
{
  const head = header(protocol.RESP.DATA, 8, 999);
  const body = Buffer.alloc(24);
  body.writeFloatLE(0.1, 0);  body.writeFloatLE(0.2, 4);  body.writeFloatLE(0.3, 8);
  body.writeFloatLE(1.1, 12); body.writeFloatLE(1.2, 16); body.writeFloatLE(1.3, 20);
  const out = parsers.parseImu6(Buffer.concat([head, body]));
  assert.strictEqual(out.samples.length, 1);
  assert.ok(Math.abs(out.samples[0].acc.x - 0.1) < 1e-6);
  assert.ok(Math.abs(out.samples[0].gyro.z - 1.3) < 1e-6);
}

// ----- IMU9 -----
{
  const head = header(protocol.RESP.DATA, 9, 1);
  const body = Buffer.alloc(36);
  for (let i = 0; i < 9; i++) body.writeFloatLE(i + 1, i * 4);
  const out = parsers.parseImu9(Buffer.concat([head, body]));
  assert.strictEqual(out.samples.length, 1);
  const s = out.samples[0];
  assert.deepStrictEqual(
    [s.acc.x, s.acc.y, s.acc.z, s.gyro.x, s.gyro.y, s.gyro.z, s.magn.x, s.magn.y, s.magn.z],
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
}

// ----- ECG (int32) -----
{
  const head = header(protocol.RESP.DATA, 10, 42);
  const body = Buffer.alloc(12);
  body.writeInt32LE(100, 0);
  body.writeInt32LE(-200, 4);
  body.writeInt32LE(2_000_000, 8);
  const out = parsers.parseEcg(Buffer.concat([head, body]));
  assert.strictEqual(out.timestamp, 42);
  assert.deepStrictEqual(out.samples, [100, -200, 2_000_000]);
}

// ----- HR -----
{
  const buf = Buffer.alloc(2 + 4 + 1 + 6); // code, ref, avg f32, count u8, 3 rr u16
  buf.writeUInt8(protocol.RESP.DATA, 0);
  buf.writeUInt8(11, 1);
  buf.writeFloatLE(72.5, 2);
  buf.writeUInt8(3, 6);
  buf.writeUInt16LE(800, 7);
  buf.writeUInt16LE(820, 9);
  buf.writeUInt16LE(790, 11);
  const out = parsers.parseHr(buf);
  assert.strictEqual(Math.round(out.average * 10), 725);
  assert.deepStrictEqual(out.rrIntervals, [800, 820, 790]);
}

// ----- Temp -----
{
  const head = header(protocol.RESP.DATA, 12, 7);
  const body = Buffer.alloc(4);
  body.writeFloatLE(310.15, 0); // 37 °C
  const out = parsers.parseTemp(Buffer.concat([head, body]));
  assert.strictEqual(out.timestamp, 7);
  assert.ok(Math.abs(out.celsius - 37) < 1e-3);
}

// ----- Frame builders -----
{
  const sub = protocol.buildSubscribe(5, '/Meas/Acc/52');
  assert.strictEqual(sub[0], protocol.CMD.SUBSCRIBE);
  assert.strictEqual(sub[1], 5);
  assert.strictEqual(sub.slice(2).toString('utf8'), '/Meas/Acc/52');

  const unsub = protocol.buildUnsubscribe(5);
  assert.deepStrictEqual([...unsub], [protocol.CMD.UNSUBSCRIBE, 5]);

  const get = protocol.buildGet(9, '/Info');
  assert.strictEqual(get[0], protocol.CMD.GET);
  assert.strictEqual(get.slice(2).toString('utf8'), '/Info');
}

console.log('All parser tests passed.');
