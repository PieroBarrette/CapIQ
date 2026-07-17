/* ============================================================
   Capiq V0.1 — BLEService (Web Bluetooth API)

   Les UUID DOIVENT rester identiques à firmware/src/config.h
   (Web Bluetooth exige des UUID en minuscules).

   Événements émis (CustomEvent, via addEventListener) :
     'connection' → { connected: bool, name?: string }
     'telemetry'  → { target, heading, error, battery, pitch, roll }
     'status'     → { fw, mode, imu, mag, cal, rate, ... }
     'battery'    → { level }  (service standard 0x180F)

   Limitation connue : Web Bluetooth n'expose pas le RSSI d'une
   connexion active. La "qualité signal" est donc estimée côté app
   par la fraîcheur du dernier paquet (lastPacketAt).
   ============================================================ */

export const CAPIQ_BLE = {
  service:   'ca910000-56e8-4b3a-9a2f-d3f1a2b4c5d6',
  target:    'ca910001-56e8-4b3a-9a2f-d3f1a2b4c5d6', // WRITE
  telemetry: 'ca910002-56e8-4b3a-9a2f-d3f1a2b4c5d6', // READ/NOTIFY
  status:    'ca910003-56e8-4b3a-9a2f-d3f1a2b4c5d6', // READ/NOTIFY
  command:   'ca910004-56e8-4b3a-9a2f-d3f1a2b4c5d6', // WRITE
};

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

function safeParseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export class BLEService extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.chTarget = null;
    this.chTelemetry = null;
    this.chStatus = null;
    this.chCommand = null;
    this.lastPacketAt = 0;
    // File d'attente GATT : Web Bluetooth rejette les opérations concurrentes
    this._queue = Promise.resolve();
    this._onDisconnected = this._onDisconnected.bind(this);
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get connected() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected);
  }

  get deviceName() {
    return this.device ? (this.device.name || 'Capiq') : null;
  }

  async connect() {
    if (!BLEService.isSupported()) {
      throw new Error('Web Bluetooth non disponible (utilisez Chrome sur Android).');
    }

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [CAPIQ_BLE.service] }, { namePrefix: 'Capiq' }],
      optionalServices: [CAPIQ_BLE.service, 'battery_service'],
    });
    this.device.addEventListener('gattserverdisconnected', this._onDisconnected);

    const gatt = await this.device.gatt.connect();
    const svc = await gatt.getPrimaryService(CAPIQ_BLE.service);

    this.chTarget    = await svc.getCharacteristic(CAPIQ_BLE.target);
    this.chTelemetry = await svc.getCharacteristic(CAPIQ_BLE.telemetry);
    this.chStatus    = await svc.getCharacteristic(CAPIQ_BLE.status);
    this.chCommand   = await svc.getCharacteristic(CAPIQ_BLE.command);

    await this._subscribeJSON(this.chTelemetry, 'telemetry');
    await this._subscribeJSON(this.chStatus, 'status');

    // État initial (avant la première notification)
    try {
      const v = await this.chStatus.readValue();
      const obj = safeParseJSON(decoder.decode(v));
      if (obj) this._emit('status', obj);
    } catch { /* non bloquant */ }

    // Service batterie standard — optionnel, sans échec bloquant
    try {
      const battSvc = await gatt.getPrimaryService('battery_service');
      const battCh = await battSvc.getCharacteristic('battery_level');
      await battCh.startNotifications();
      battCh.addEventListener('characteristicvaluechanged', (e) => {
        this._emit('battery', { level: e.target.value.getUint8(0) });
      });
      const b = await battCh.readValue();
      this._emit('battery', { level: b.getUint8(0) });
    } catch { /* certains navigateurs bloquent 0x180F : le champ telemetry.battery suffit */ }

    this._emit('connection', { connected: true, name: this.deviceName });
  }

  disconnect() {
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
  }

  /** Envoie l'azimut cible (degrés 0-360) au casque. */
  async sendTargetAzimuth(deg) {
    const payload = JSON.stringify({ target: Math.round(deg * 10) / 10 });
    return this._write(this.chTarget, payload);
  }

  /** Envoie une commande JSON ({cmd: 'set'|'cal_mag'|'cal_imu'|'reset_cal', ...}). */
  async sendCommand(obj) {
    return this._write(this.chCommand, JSON.stringify(obj));
  }

  /** Pousse les réglages utilisateur vers le casque. */
  async sendSettings({ deadzone, brightness, rate, offset }) {
    return this.sendCommand({ cmd: 'set', deadzone, brightness, rate, offset });
  }

  /**
   * Abonnement au cap temps réel (nom imposé par la spec V0.1).
   * Équivalent à addEventListener('telemetry', ...).
   */
  receiveHeading(callback) {
    this.addEventListener('telemetry', (e) => callback(e.detail));
  }

  // ---- interne ----------------------------------------------------------

  async _subscribeJSON(characteristic, eventName) {
    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', (e) => {
      const obj = safeParseJSON(decoder.decode(e.target.value));
      if (!obj) return;
      this.lastPacketAt = Date.now();
      this._emit(eventName, obj);
    });
  }

  _write(characteristic, text) {
    if (!this.connected || !characteristic) {
      return Promise.reject(new Error('Non connecté au casque.'));
    }
    const data = encoder.encode(text);
    const op = () =>
      characteristic.writeValueWithResponse
        ? characteristic.writeValueWithResponse(data)
        : characteristic.writeValue(data);
    this._queue = this._queue.catch(() => {}).then(op);
    return this._queue;
  }

  _onDisconnected() {
    this.chTarget = this.chTelemetry = this.chStatus = this.chCommand = null;
    this._emit('connection', { connected: false });
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
