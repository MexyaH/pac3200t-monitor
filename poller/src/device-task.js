'use strict';

const { PacClient } = require('./modbus-client');
const { DeviceState } = require('./state-machine');
const { BLOCKS, decodeMeasurements, decodeEnergy, sanityCheck } = require('./registers');
const config = require('./config');

/**
 * Un task indipendente per contatore, con setTimeout ricorsivo.
 *
 * Non un loop seriale su tutti i device: con 100 contatori e 1,2 s di
 * timeout, un ciclo sequenziale durerebbe due minuti appena ne cade
 * qualcuno. Ogni device ha la sua cadenza e il suo backoff; il semaforo
 * condiviso limita quanti parlano insieme.
 */
class DeviceTask {
  constructor(device, { semaphore, writer }) {
    this.device = device;
    this.sem = semaphore;
    this.writer = writer;
    this.state = new DeviceState(device.id, device.name);
    this.client = new PacClient({
      ip: device.ip,
      port: device.port,
      unitId: device.unit_id,
      timeoutMs: config.modbusTimeoutMs,
    });
    this.timer = null;
    this.stopped = false;
    this.lastEnergyAt = 0;
    this.lastTotalPowerAt = 0;
    this.lastStatusFlush = 0;
    this.mapWarned = false;
  }

  start() {
    // Sfasa la partenza dei task su tutto il periodo di polling, cosi'
    // le letture si distribuiscono invece di arrivare tutte insieme
    // ogni 15 secondi.
    const jitter = Math.random() * this.device.poll_ms;
    this.timer = setTimeout(() => this._tick(), jitter);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.client.close();
  }

  async _tick() {
    if (this.stopped) return;
    try {
      await this.sem.run(() => this._poll());
    } catch (err) {
      // _poll gestisce i suoi errori: qui finisce solo l'imprevisto.
      console.error(`[${this.device.name}] errore inatteso: ${err.message}`);
    } finally {
      if (!this.stopped) {
        const delay = this.state.nextDelay(this.device.poll_ms);
        this.timer = setTimeout(() => this._tick(), delay);
      }
    }
  }

  async _poll() {
    const t0 = Date.now();
    try {
      const buf = await this.client.readBlock(
        BLOCKS.measurements.offset, BLOCKS.measurements.quantity);
      const values = decodeMeasurements(buf, this.device.word_swap);
      const ts = new Date();   // timestamp lato server: l'orologio
                               // interno dei contatori e' sempre sbagliato

      this._warnOnImplausible(values);

      this.state.onSuccess(Date.now() - t0);
      this.writer.addMeasurement(this.device.id, this.device.name, ts, values);

      // totalpower_<nome> ha una cadenza sua, piu' lenta delle misure.
      if (Date.now() - this.lastTotalPowerAt >= this.device.totalpower_ms) {
        this.lastTotalPowerAt = Date.now();
        this.writer.addTotalPower(this.device.name, ts, values.p_total);
      }

      // Energia a cadenza piu' lenta, sulla stessa connessione aperta.
      if (Date.now() - this.lastEnergyAt >= this.device.energy_ms) {
        this.lastEnergyAt = Date.now();
        try {
          const ebuf = await this.client.readBlock(
            BLOCKS.energy.offset, BLOCKS.energy.quantity);
          this.writer.addEnergy(this.device.id, ts,
            decodeEnergy(ebuf, this.device.word_swap));
        } catch (err) {
          // Un fallimento sui contatori di energia non deve marcare il
          // device offline: le misure istantanee sono arrivate.
          console.warn(`[${this.device.name}] lettura energia: ${err.message}`);
        }
      }
    } catch (err) {
      const prev = this.state.state;
      this.state.onError(err);
      if (this.state.state !== prev) {
        console.warn(`[${this.device.name}] ${prev} -> ${this.state.state}: ${this.state.lastError}`);
      }
    }

    this._publishStatus();
    if (config.verbose) {
      console.log(`[${this.device.name}] ${this.state.state} ${this.state.latencyMs ?? '-'}ms`);
    }
  }

  /** Lo stato si scrive quando cambia, altrimenti al piu' ogni
   *  statusFlushMs: non serve un UPDATE per ogni lettura. */
  _publishStatus() {
    const now = Date.now();
    if (this.state.dirty || now - this.lastStatusFlush >= config.statusFlushMs) {
      this.lastStatusFlush = now;
      this.writer.setStatus(this.state);
    }
  }

  /** In collaudo intercetta una mappa registri sbagliata. Una volta per
   *  device: non riempie il log per anni se qualcosa resta storto. */
  _warnOnImplausible(values) {
    if (this.mapWarned) return;
    const problems = sanityCheck(values, {
      ctPrimary: this.device.ct_primary,
      nominalVoltage: this.device.nominal_voltage || 400,
    });
    if (problems.length) {
      this.mapWarned = true;
      console.warn(
        `[${this.device.name}] valori implausibili, verifica mappa registri ` +
        `o word_swap: ${problems.join('; ')}`);
    }
  }
}

module.exports = { DeviceTask };
