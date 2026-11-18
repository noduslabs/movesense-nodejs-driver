'use strict';

const { EventEmitter } = require('events');
const protocol = require('./protocol');
const parsers = require('./parsers');

const DEFAULT_OPTS = {
  autoReconnect: true,
  initialReconnectDelayMs: 1000,
  maxReconnectDelayMs: 30000,
  commandTimeoutMs: 8000,
  // Hard ceiling on connect (BLE link + service discovery). Movesense
  // sensors normally complete this in 1-3 s; if we hit the timeout the
  // sensor is almost always running a firmware variant that doesn't
  // expose the GATT SensorData Protocol (e.g. early MDS-only firmware).
  connectTimeoutMs: 15000,
  // Some Movesense firmwares only respond reliably to write-with-response on
  // macOS/CoreBluetooth. Default to that and let the user opt back into
  // write-without-response (lower latency) if their stack supports it.
  writeWithoutResponse: false,
  // Emit a `debug` event with each raw notification buffer (in hex). Useful
  // when bringing up a new firmware variant.
  debug: false,
};

// Wraps one Movesense peripheral. EventEmitter — see README for events.
class MovesenseDevice extends EventEmitter {
  constructor(peripheral, opts = {}) {
    super();
    this.peripheral = peripheral;
    this.id = peripheral.id;
    // Don't snapshot the name: when scanning with allowDuplicates the packet
    // that constructs this device may not be the one carrying the local name
    // (see scanner.js). `localName` reads live from the advertisement noble
    // keeps merging, and is sticky once a name has been seen.
    this._localName = (peripheral.advertisement && peripheral.advertisement.localName) || null;

    this._opts = Object.assign({}, DEFAULT_OPTS, opts);
    // Make stray `emit('error')` calls safe even if no listener is attached —
    // Node's default behaviour would otherwise throw and crash the host app.
    // Adding a no-op listener here doesn't suppress real listeners; the
    // `_safeEmit` helper still routes errors to user-attached handlers when
    // present, and only logs/swallows when there are none.
    this.on('error', noop);
    this._writeChar = null;
    this._notifyChar = null;
    this._connected = false;
    this._userDisconnected = false;
    this._reconnectAttempts = 0;
    this._reconnecting = false;
    this._activeSubs = new Map();      // path -> { ref, parser, event, path }
    this._pendingResponses = new Map(); // ref -> { resolve, reject, timer }
    this._nextRef = 1;
  }

  /** Advertised BLE local name, e.g. "Movesense 210330000123". */
  get localName() {
    const live = this.peripheral && this.peripheral.advertisement && this.peripheral.advertisement.localName;
    if (live) this._localName = live;
    return this._localName;
  }

  /** Serial number parsed out of the local name, e.g. "210330000123". */
  get serial() {
    return extractSerial(this.localName);
  }

  // ---------- public connection API ----------

  async connect() {
    this._userDisconnected = false;
    await withTimeout(
      this._connectInternal(),
      this._opts.connectTimeoutMs,
      `connect timed out after ${this._opts.connectTimeoutMs}ms — sensor may be running pre-GSP firmware`
    );
  }

  async disconnect() {
    this._userDisconnected = true;
    if (this._connected && this._writeChar) {
      for (const sub of this._activeSubs.values()) {
        try { await this._writeFrame(protocol.buildUnsubscribe(sub.ref)); } catch (_) {}
      }
    }
    this._activeSubs.clear();
    this._rejectAllPending(new Error('Device disconnected'));
    if (this.peripheral.state === 'connected' || this.peripheral.state === 'connecting') {
      try { await this.peripheral.disconnectAsync(); } catch (_) { /* ignore */ }
    }
  }

  isConnected() { return this._connected; }

  // ---------- public subscription API ----------

  subscribeAcc (rate = 52)  { return this._subscribePath(`/Meas/Acc/${rate}`,  parsers.parseXYZ,  'acc');  }
  subscribeGyro(rate = 52)  { return this._subscribePath(`/Meas/Gyro/${rate}`, parsers.parseXYZ,  'gyro'); }
  subscribeMagn(rate = 52)  { return this._subscribePath(`/Meas/Magn/${rate}`, parsers.parseXYZ,  'magn'); }
  subscribeImu6(rate = 52)  { return this._subscribePath(`/Meas/IMU6/${rate}`, parsers.parseImu6, 'imu6'); }
  subscribeImu9(rate = 52)  { return this._subscribePath(`/Meas/IMU9/${rate}`, parsers.parseImu9, 'imu9'); }
  subscribeEcg (rate = 125) { return this._subscribePath(`/Meas/ECG/${rate}`,  parsers.parseEcg,  'ecg');  }
  subscribeHr  ()           { return this._subscribePath(`/Meas/HR`,           parsers.parseHr,   'hr');   }
  subscribeTemp()           { return this._subscribePath(`/Meas/Temp`,         parsers.parseTemp, 'temp'); }

  // Generic — for resources this driver doesn't know about.
  subscribe(path, parser, event) {
    return this._subscribePath(path, parser, event);
  }

  // ---- Battery (standard BLE Battery Service, not Whiteboard) ----
  // Works on every Movesense firmware variant. Returns a uint8 percentage.
  async getBatteryLevel() {
    const ch = await this._ensureBatteryChar();
    const data = await ch.readAsync();
    if (!data || data.length < 1) throw new Error('Battery characteristic returned no data');
    return validateBatteryPercent(data.readUInt8(0));
  }

  // Subscribe to battery-level change notifications. Emits 'battery'
  // events with `{ percent }`. Out-of-spec values surface as 'error' events.
  async subscribeBatteryLevel() {
    const ch = await this._ensureBatteryChar();
    if (this._batteryNotifyHandler) return;
    this._batteryNotifyHandler = (data) => {
      if (!data || data.length < 1) return;
      try {
        const percent = validateBatteryPercent(data.readUInt8(0));
        this._emit('battery', { percent });
      } catch (e) {
        this._emit('error', e);
      }
    };
    ch.on('data', this._batteryNotifyHandler);
    await ch.subscribeAsync();
  }

  async unsubscribeBatteryLevel() {
    if (!this._batteryChar || !this._batteryNotifyHandler) return;
    try { await this._batteryChar.unsubscribeAsync(); } catch (_) {}
    this._batteryChar.removeListener('data', this._batteryNotifyHandler);
    this._batteryNotifyHandler = null;
  }

  async _ensureBatteryChar() {
    if (!this._connected) throw new Error('Not connected');
    if (!this._batteryChar) {
      throw new Error('Standard Battery Service not exposed by this sensor');
    }
    return this._batteryChar;
  }

  async unsubscribe(path) {
    const sub = this._activeSubs.get(path);
    if (!sub) return false;
    this._activeSubs.delete(path);
    if (this._connected && this._writeChar) {
      try { await this._writeFrame(protocol.buildUnsubscribe(sub.ref)); } catch (_) {}
    }
    return true;
  }

  // ---------- internal ----------

  async _connectInternal() {
    await this.peripheral.connectAsync();

    // Two-stage discovery so a missing optional service (Battery) or the
    // entire GSP service doesn't atomic-reject the whole call. We do this
    // ONCE per connect — repeat discovery on macOS/CoreBluetooth and BlueZ
    // invalidates the active notify subscription.
    //
    // Stage 1: enumerate every service the sensor exposes. discoverServices()
    // with no UUID filter returns whatever's there; it never rejects with
    // "not found".
    const services = await this.peripheral.discoverServicesAsync();
    const serviceUuids = (services || []).map(s => s.uuid);
    const gspService     = (services || []).find(s => s.uuid === protocol.SERVICE_UUID);
    const batteryService = (services || []).find(s => s.uuid === protocol.BATTERY_SERVICE_UUID);

    if (!gspService) {
      try { await this.peripheral.disconnectAsync(); } catch (_) {}
      const list = serviceUuids.length ? serviceUuids.join(', ') : '<none discoverable>';
      const looksLikeMds = serviceUuids.some(u => u === '61353090a11211e3a8960002a5d5c51b');
      throw new Error(
        `Movesense GATT SensorData Protocol service not found on this sensor.\n` +
        `  Services exposed: ${list}\n` +
        (looksLikeMds
          ? `  Detected the older MDS protocol (Suunto service 61353090-…). `
          : `  `) +
        `This driver requires the GSP service ` +
        `(34802252-7185-4d5d-b431-630e7050e8f0) which the firmware does not expose. ` +
        `Update the sensor firmware to default-firmware >= 2.3 (or flash ` +
        `gatt-sensordata-app) and reconnect.`
      );
    }

    // Stage 2: discover characteristics for each found service, one service
    // at a time so a missing battery characteristic doesn't kill GSP.
    const gspChars = await gspService.discoverCharacteristicsAsync([
      protocol.WRITE_CHAR_UUID,
      protocol.NOTIFY_CHAR_UUID,
    ]);
    this._writeChar  = (gspChars || []).find(c => c.uuid === protocol.WRITE_CHAR_UUID);
    this._notifyChar = (gspChars || []).find(c => c.uuid === protocol.NOTIFY_CHAR_UUID);
    if (!this._writeChar || !this._notifyChar) {
      try { await this.peripheral.disconnectAsync(); } catch (_) {}
      throw new Error('GSP service present but required write/notify characteristics are missing');
    }

    this._batteryChar = null;
    if (batteryService) {
      try {
        const batChars = await batteryService.discoverCharacteristicsAsync([
          protocol.BATTERY_LEVEL_CHAR_UUID,
        ]);
        this._batteryChar = (batChars || []).find(c => c.uuid === protocol.BATTERY_LEVEL_CHAR_UUID) || null;
      } catch (_) {
        // Battery is optional; ignore discovery errors and continue.
      }
    }

    // Pick a write mode the characteristic actually supports. Honour the user
    // option when feasible, otherwise fall back.
    const props = this._writeChar.properties || [];
    const supportsNoResp = props.includes('writeWithoutResponse');
    const supportsResp   = props.includes('write');
    if (this._opts.writeWithoutResponse && supportsNoResp) {
      this._writeWithoutResponse = true;
    } else if (supportsResp) {
      this._writeWithoutResponse = false;
    } else if (supportsNoResp) {
      this._writeWithoutResponse = true;
    } else {
      throw new Error('Movesense write characteristic supports neither write nor writeWithoutResponse');
    }

    this._notifyHandler = (data) => this._handleNotification(data);
    this._notifyChar.on('data', this._notifyHandler);
    await this._notifyChar.subscribeAsync();

    this._disconnectHandler = () => this._handleDisconnect();
    this.peripheral.once('disconnect', this._disconnectHandler);

    this._connected = true;
    this._reconnectAttempts = 0;
    this._emit('connect');
  }

  _handleDisconnect() {
    if (!this._connected) return; // already torn down
    this._connected = false;
    this._writeChar = null;
    this._notifyChar = null;
    this._batteryChar = null;
    this._batteryNotifyHandler = null;
    this._rejectAllPending(new Error('Disconnected'));
    this._emit('disconnect');

    if (this._userDisconnected || !this._opts.autoReconnect || this._reconnecting) return;
    this._reconnecting = true;
    this._reconnectLoop().catch(err => this._emit('error', err)).finally(() => {
      this._reconnecting = false;
    });
  }

  async _reconnectLoop() {
    while (!this._userDisconnected) {
      const exp = Math.min(this._reconnectAttempts, 10);
      const delay = Math.min(
        this._opts.initialReconnectDelayMs * Math.pow(2, exp),
        this._opts.maxReconnectDelayMs
      );
      this._reconnectAttempts++;
      this._emit('reconnecting', { attempt: this._reconnectAttempts, delayMs: delay });
      await sleep(delay);
      if (this._userDisconnected) return;

      try {
        await this._connectInternal();
        // Re-subscribe everything that was active before the drop. Allocate
        // fresh refs because the sensor lost its subscription state.
        const toResubscribe = Array.from(this._activeSubs.values());
        this._activeSubs.clear();
        for (const sub of toResubscribe) {
          try {
            await this._subscribePath(sub.path, sub.parser, sub.event);
          } catch (e) {
            this._emit('error', new Error(`Resubscribe failed for ${sub.path}: ${e.message}`));
          }
        }
        this._emit('reconnect');
        return;
      } catch (e) {
        this._emit('error', e);
        // continue loop
      }
    }
  }

  async _subscribePath(path, parser, event) {
    if (!this._connected || !this._writeChar) {
      throw new Error('Not connected');
    }
    if (this._activeSubs.has(path)) return this._activeSubs.get(path);

    const ref = this._allocRef();
    const sub = { ref, parser, event, path };
    // Track first so the notification handler can route DATA packets that may
    // arrive before (or instead of) the SUBSCRIBE acknowledgement — some
    // firmwares only send the 0x01 ack, others jump straight to 0x02 DATA.
    this._activeSubs.set(path, sub);

    try {
      const status = await this._sendAndAwaitAckOrData(protocol.buildSubscribe(ref, path), ref);
      if (status !== null && status >= 400) {
        this._activeSubs.delete(path);
        throw new Error(`Subscribe ${path} failed (status ${status})`);
      }
      return sub;
    } catch (e) {
      this._activeSubs.delete(path);
      // Best-effort cleanup so the sensor doesn't leak a stale subscription.
      try { await this._writeFrame(protocol.buildUnsubscribe(ref)); } catch (_) {}
      throw e;
    }
  }

  // GET returns { status, payload }. Raw SBEM payload is returned as-is.
  async get(path) {
    if (!this._connected || !this._writeChar) throw new Error('Not connected');
    const ref = this._allocRef();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingResponses.delete(ref);
        reject(new Error(`GET ${path} timed out`));
      }, this._opts.commandTimeoutMs);
      this._pendingResponses.set(ref, {
        kind: 'oneshot',
        resolve: ({ status, payload }) => { clearTimeout(timer); resolve({ status, payload }); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      this._writeFrame(protocol.buildGet(ref, path)).catch(reject);
    });
  }

  // For SUBSCRIBE: resolve when we either get a 0x01 ack (returns its status)
  // or the first 0x02 DATA packet for this ref (returns null = implicit OK).
  _sendAndAwaitAckOrData(buf, ref) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingResponses.delete(ref);
        reject(new Error(`Command ref ${ref} timed out`));
      }, this._opts.commandTimeoutMs);
      this._pendingResponses.set(ref, {
        kind: 'subscribe',
        resolve: (result) => {
          clearTimeout(timer);
          // result is either { status, payload } (from ONESHOT) or null (from DATA).
          resolve(result == null ? null : result.status);
        },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      this._writeFrame(buf).catch((e) => {
        clearTimeout(timer);
        this._pendingResponses.delete(ref);
        reject(e);
      });
    });
  }

  _writeFrame(buf) {
    return this._writeChar.writeAsync(buf, this._writeWithoutResponse);
  }

  _handleNotification(data) {
    if (!data || data.length < 2) return;
    if (this._opts.debug) this._emit('debug', { dir: 'in', hex: data.toString('hex'), len: data.length });

    const code = data.readUInt8(0);
    const ref  = data.readUInt8(1);

    if (code === protocol.RESP.ONESHOT) {
      if (data.length < 4) return;
      const status = data.readUInt16LE(2);
      const payload = data.slice(4);
      const pending = this._pendingResponses.get(ref);
      if (pending) {
        this._pendingResponses.delete(ref);
        // Same shape works for both 'oneshot' and 'subscribe' resolvers.
        pending.resolve({ status, payload });
      }
      return;
    }

    if (code === protocol.RESP.DATA || code === protocol.RESP.DATA_CONT) {
      // If this is the first packet on a ref we're still awaiting a SUBSCRIBE
      // ack for, treat it as implicit success (status=null).
      const pending = this._pendingResponses.get(ref);
      if (pending && pending.kind === 'subscribe') {
        this._pendingResponses.delete(ref);
        pending.resolve(null);
      }

      const sub = this._findSubByRef(ref);
      if (!sub) return;
      // Continuation packets for oversized payloads are dropped here. With a
      // negotiated MTU >= 185 every Meas batch fits a single DATA packet, so
      // this only matters for high-rate ECG at default MTU; users should
      // request a higher MTU at the OS level if they hit this.
      if (code === protocol.RESP.DATA_CONT) {
        this._emit('error', new Error(`Dropped DATA_CONT for ${sub.path} (MTU too small)`));
        return;
      }
      try {
        const parsed = sub.parser(data);
        this._emit(sub.event, parsed);
        // Convenience second event for HR consumers who only care about RR.
        if (sub.event === 'hr' && parsed && parsed.rrIntervals && parsed.rrIntervals.length) {
          this._emit('rr', parsed.rrIntervals);
        }
      } catch (e) {
        this._emit('error', new Error(`Parse failure for ${sub.path}: ${e.message}`));
      }
    }
  }



  _findSubByRef(ref) {
    for (const sub of this._activeSubs.values()) {
      if (sub.ref === ref) return sub;
    }
    return null;
  }

  // Allocate a 1..255 reference that's not already in use by an active stream
  // or an in-flight one-shot request.
  _allocRef() {
    const used = new Set();
    for (const sub of this._activeSubs.values()) used.add(sub.ref);
    for (const ref of this._pendingResponses.keys()) used.add(ref);
    let r = this._nextRef;
    for (let i = 0; i < 255; i++) {
      if (!used.has(r)) {
        this._nextRef = (r % 255) + 1;
        return r;
      }
      r = (r % 255) + 1;
    }
    throw new Error('No reference numbers available (255 in use)');
  }

  _rejectAllPending(err) {
    for (const pending of this._pendingResponses.values()) {
      try { pending.reject(err); } catch (_) {}
    }
    this._pendingResponses.clear();
  }

  // Internal emit wrapper. A throwing user listener (or a missing 'error'
  // listener) must never propagate up into our own async flows. Uses the raw
  // EventEmitter.prototype.emit to avoid infinite recursion.
  _emit(event, ...args) {
    try {
      EventEmitter.prototype.emit.call(this, event, ...args);
    } catch (err) {
      if (event === 'error') {
        try { console.error('[movesense-driver] error listener threw:', err); } catch (_) {}
        return;
      }
      try {
        EventEmitter.prototype.emit.call(this, 'error', wrap(err, `listener for "${event}" threw`));
      } catch (_) {
        try { console.error('[movesense-driver] listener threw:', err); } catch (_) {}
      }
    }
  }
}

function wrap(err, prefix) {
  const e = new Error(`${prefix}: ${err && err.message ? err.message : err}`);
  e.cause = err;
  return e;
}

function extractSerial(localName) {
  // Movesense advertises as "Movesense 210330000123"
  if (!localName) return null;
  const m = /^Movesense\s+(\S+)/.exec(localName);
  return m ? m[1] : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function noop() {}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } catch (e) {
    // noble can reject with strings or undefined on some failure paths.
    // Normalise so callers can always read .message.
    if (e instanceof Error) throw e;
    if (e == null) throw new Error(`${label} (no error provided)`);
    throw new Error(typeof e === 'string' ? e : (e.toString && e.toString()) || String(e));
  } finally {
    clearTimeout(timer);
  }
}


// BLE Battery Service spec: uint8, 0-100. Anything else is firmware
// misbehaviour (e.g. 0xFF as an "unknown" sentinel) — surface as an error
// rather than silently returning a bogus number.
function validateBatteryPercent(n) {
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    throw new Error(`Battery characteristic returned out-of-spec value ${n} (expected 0-100)`);
  }
  return n;
}

module.exports = { MovesenseDevice };
