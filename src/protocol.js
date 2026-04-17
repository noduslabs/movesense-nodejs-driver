'use strict';

// Movesense GATT SensorData Protocol (GSP)
// Spec: https://www.movesense.com/docs/esw/gatt_sensordata_protocol/
//
// One service, two characteristics. UUIDs are stored in noble's normalised form
// (lowercase, no dashes) so equality checks against `characteristic.uuid` work.

const SERVICE_UUID      = '3480225271854d5db431630e7050e8f0';
const WRITE_CHAR_UUID   = '3480000171854d5db431630e7050e8f0';
const NOTIFY_CHAR_UUID  = '3480000271854d5db431630e7050e8f0';

// Standard BLE Battery Service (0x180F) — exposed by Movesense alongside the
// Whiteboard service. Works regardless of firmware variant.
const BATTERY_SERVICE_UUID = '180f';
const BATTERY_LEVEL_CHAR_UUID = '2a19';

// Command codes (client -> sensor)
const CMD = Object.freeze({
  HELLO:       0,
  SUBSCRIBE:   1,
  UNSUBSCRIBE: 2,
  GET:         3,
  PUT:         4,
  POST:        5,
  DEL:         6,
});

// Response codes (sensor -> client)
const RESP = Object.freeze({
  ONESHOT:   0x01, // reply to GET/PUT/POST/DEL/SUBSCRIBE-ack — has uint16 status
  DATA:      0x02, // streaming notification payload
  DATA_CONT: 0x03, // continuation of an oversized DATA payload
});

function buildSubscribe(ref, path) {
  const pathBuf = Buffer.from(path, 'utf8');
  const out = Buffer.alloc(2 + pathBuf.length);
  out.writeUInt8(CMD.SUBSCRIBE, 0);
  out.writeUInt8(ref, 1);
  pathBuf.copy(out, 2);
  return out;
}

function buildUnsubscribe(ref) {
  return Buffer.from([CMD.UNSUBSCRIBE, ref]);
}

function buildGet(ref, path) {
  const pathBuf = Buffer.from(path, 'utf8');
  const out = Buffer.alloc(2 + pathBuf.length);
  out.writeUInt8(CMD.GET, 0);
  out.writeUInt8(ref, 1);
  pathBuf.copy(out, 2);
  return out;
}

module.exports = {
  SERVICE_UUID,
  WRITE_CHAR_UUID,
  NOTIFY_CHAR_UUID,
  BATTERY_SERVICE_UUID,
  BATTERY_LEVEL_CHAR_UUID,
  CMD,
  RESP,
  buildSubscribe,
  buildUnsubscribe,
  buildGet,
};
