'use strict';

// All streaming DATA packets start with:
//   [0]     uint8   response code (0x02 or 0x03)
//   [1]     uint8   client reference number
//   [2..5]  uint32  timestamp (LE, milliseconds since boot)   [most streams]
//   [6..]   payload (sample batch)
//
// HR is the one exception: no timestamp, payload starts at byte 2.

function parseXYZ(buf) {
  const timestamp = buf.readUInt32LE(2);
  const samples = [];
  const n = Math.floor((buf.length - 6) / 12);
  for (let i = 0; i < n; i++) {
    const off = 6 + i * 12;
    samples.push({
      x: buf.readFloatLE(off),
      y: buf.readFloatLE(off + 4),
      z: buf.readFloatLE(off + 8),
    });
  }
  return { timestamp, samples };
}

function parseImu6(buf) {
  const timestamp = buf.readUInt32LE(2);
  const samples = [];
  const n = Math.floor((buf.length - 6) / 24);
  for (let i = 0; i < n; i++) {
    const off = 6 + i * 24;
    samples.push({
      acc:  { x: buf.readFloatLE(off),      y: buf.readFloatLE(off + 4),  z: buf.readFloatLE(off + 8)  },
      gyro: { x: buf.readFloatLE(off + 12), y: buf.readFloatLE(off + 16), z: buf.readFloatLE(off + 20) },
    });
  }
  return { timestamp, samples };
}

function parseImu9(buf) {
  const timestamp = buf.readUInt32LE(2);
  const samples = [];
  const n = Math.floor((buf.length - 6) / 36);
  for (let i = 0; i < n; i++) {
    const off = 6 + i * 36;
    samples.push({
      acc:  { x: buf.readFloatLE(off),      y: buf.readFloatLE(off + 4),  z: buf.readFloatLE(off + 8)  },
      gyro: { x: buf.readFloatLE(off + 12), y: buf.readFloatLE(off + 16), z: buf.readFloatLE(off + 20) },
      magn: { x: buf.readFloatLE(off + 24), y: buf.readFloatLE(off + 28), z: buf.readFloatLE(off + 32) },
    });
  }
  return { timestamp, samples };
}

// ECG: raw int32 samples. Microvolts ~= raw * 0.381 (raw * 0.05 / 2^17 volts).
function parseEcg(buf) {
  const timestamp = buf.readUInt32LE(2);
  const samples = [];
  const n = Math.floor((buf.length - 6) / 4);
  for (let i = 0; i < n; i++) samples.push(buf.readInt32LE(6 + i * 4));
  return { timestamp, samples };
}

// HR payload: [respCode u8][ref u8][average f32][rrCount u8][rr u16 * rrCount]
function parseHr(buf) {
  const average = buf.readFloatLE(2);
  const rrCount = buf.readUInt8(6);
  const rrIntervals = [];
  for (let i = 0; i < rrCount; i++) {
    const off = 7 + i * 2;
    if (off + 2 > buf.length) break;
    rrIntervals.push(buf.readUInt16LE(off));
  }
  return { average, rrIntervals };
}

function parseTemp(buf) {
  const timestamp = buf.readUInt32LE(2);
  const kelvin = buf.readFloatLE(6);
  return { timestamp, kelvin, celsius: kelvin - 273.15 };
}

module.exports = {
  parseXYZ,
  parseImu6,
  parseImu9,
  parseEcg,
  parseHr,
  parseTemp,
};
