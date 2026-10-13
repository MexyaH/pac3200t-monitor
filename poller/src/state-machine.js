'use strict';

/**
 * Stato di raggiungibilita' con debounce.
 *
 * Senza debounce un singolo timeout fa lampeggiare l'allarme e in due
 * settimane nessuno gli crede piu'. Soglie:
 *   1-2 errori consecutivi -> degraded  (il dato manca ma non allarmiamo)
 *   3+  errori consecutivi -> offline   (allarme)
 *   prima lettura buona    -> online
 *
 * Il ping NON viene usato come criterio: un PAC3200T risponde a ICMP
 * anche con lo stack Modbus piantato. La lettura Modbus stessa e'
 * l'health probe.
 */

const DEGRADED_AFTER = 1;
const OFFLINE_AFTER  = 3;

/** Backoff per i device non raggiungibili, in ms. */
const BACKOFF_STEPS = [5000, 15000, 30000, 60000];

class DeviceState {
  constructor(deviceId, name) {
    this.deviceId = deviceId;
    this.name = name;
    this.state = 'unknown';
    this.consecErrors = 0;
    this.lastSeen = null;
    this.lastAttempt = null;
    this.lastError = null;
    this.latencyMs = null;
    // true quando lo stato e' cambiato e va scritto su device_events
    this.dirty = false;
    this.pendingTransition = null;
  }

  /** Lettura riuscita. */
  onSuccess(latencyMs) {
    const prev = this.state;
    this.consecErrors = 0;
    this.lastSeen = new Date();
    this.lastAttempt = this.lastSeen;
    this.lastError = null;
    this.latencyMs = latencyMs;
    this.state = 'online';
    if (prev !== 'online') this._transition(prev, 'online', null);
  }

  /** Lettura fallita. */
  onError(err) {
    const prev = this.state;
    this.consecErrors += 1;
    this.lastAttempt = new Date();
    this.lastError = shortError(err);
    this.latencyMs = null;

    let next = prev;
    if (this.consecErrors >= OFFLINE_AFTER) next = 'offline';
    else if (this.consecErrors >= DEGRADED_AFTER) next = 'degraded';

    this.state = next;
    if (prev !== next) this._transition(prev, next, this.lastError);
  }

  _transition(from, to, detail) {
    this.dirty = true;
    this.pendingTransition = { from, to, detail };
  }

  /** Intervallo prima del prossimo tentativo.
   *  I device morti escono dal ciclo normale: se ne cadono 30 e li
   *  riprovi ogni giro, si mangiano tutti gli slot del pool e i device
   *  sani perdono campioni. */
  nextDelay(basePollMs) {
    if (this.state !== 'offline') return basePollMs;
    const i = Math.min(this.consecErrors - OFFLINE_AFTER, BACKOFF_STEPS.length - 1);
    return Math.max(basePollMs, BACKOFF_STEPS[Math.max(0, i)]);
  }
}

function shortError(err) {
  if (!err) return 'errore sconosciuto';
  const code = err.code ? `${err.code}: ` : '';
  return (code + String(err.message || err)).slice(0, 300);
}

module.exports = { DeviceState, BACKOFF_STEPS, DEGRADED_AFTER, OFFLINE_AFTER };
