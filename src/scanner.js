'use strict';

const { EventEmitter } = require('events');
const { MovesenseDevice } = require('./device');

// Lazy-load noble so requiring this module doesn't immediately spin up the BLE
// stack (and so a noble-less environment can at least import for tests).
let noble = null;
function loadNoble() {
  if (!noble) noble = require('@abandonware/noble');
  return noble;
}

class MovesenseScanner extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._opts = opts;
    this._scanning = false;
    this._discovered = new Map(); // peripheral.id -> MovesenseDevice
    this._discoverHandler = null;
    // Prevent missing 'error' listener from crashing the host.
    this.on('error', () => {});
  }

  _emit(event, ...args) {
    try {
      EventEmitter.prototype.emit.call(this, event, ...args);
    } catch (err) {
      if (event === 'error') {
        try { console.error('[movesense-driver] scanner error listener threw:', err); } catch (_) {}
        return;
      }
      try {
        EventEmitter.prototype.emit.call(this, 'error', err);
      } catch (_) {
        try { console.error('[movesense-driver] scanner listener threw:', err); } catch (_) {}
      }
    }
  }

  async start() {
    if (this._scanning) return;
    const n = loadNoble();
    await waitForPoweredOn(n);

    this._discoverHandler = (peripheral) => this._onDiscover(peripheral);
    n.on('discover', this._discoverHandler);
    // allowDuplicates=false: only emit each Movesense once per scan session.
    await n.startScanningAsync([], false);
    this._scanning = true;
  }

  async stop() {
    if (!this._scanning) return;
    const n = loadNoble();
    if (this._discoverHandler) {
      n.removeListener('discover', this._discoverHandler);
      this._discoverHandler = null;
    }
    try { await n.stopScanningAsync(); } catch (_) { /* ignore */ }
    this._scanning = false;
  }

  // Convenience: scan until a matching Movesense is found, then stop scanning
  // and return the device. `serial` is matched against the trailing token of
  // the advertised local name (e.g. "Movesense 210330000123").
  async findOne({ serial, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('discover', onDiscover);
        this.stop().catch(() => {});
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Movesense device not found within timeout'));
      }, timeoutMs);
      const onDiscover = (device) => {
        if (settled) return;
        if (serial && device.serial !== String(serial)) return;
        settled = true;
        cleanup();
        resolve(device);
      };
      this.on('discover', onDiscover);
      this.start().catch((e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      });
    });
  }

  _onDiscover(peripheral) {
    try {
      const name = peripheral && peripheral.advertisement && peripheral.advertisement.localName;
      if (!name || !name.startsWith('Movesense')) return;
      if (this._discovered.has(peripheral.id)) return;
      const device = new MovesenseDevice(peripheral, this._opts);
      this._discovered.set(peripheral.id, device);
      this._emit('discover', device);
    } catch (err) {
      this._emit('error', err);
    }
  }
}

function waitForPoweredOn(n) {
  return new Promise((resolve, reject) => {
    if (n.state === 'poweredOn') return resolve();
    if (n.state === 'unsupported' || n.state === 'unauthorized') {
      return reject(new Error(`BLE adapter not available (state: ${n.state})`));
    }
    const onState = (state) => {
      if (state === 'poweredOn') {
        n.removeListener('stateChange', onState);
        resolve();
      } else if (state === 'unsupported' || state === 'unauthorized') {
        n.removeListener('stateChange', onState);
        reject(new Error(`BLE adapter not available (state: ${state})`));
      }
    };
    n.on('stateChange', onState);
  });
}

module.exports = { MovesenseScanner };
