'use strict';

const ModbusRTU = require('modbus-serial');

/**
 * Wrapper su modbus-serial per un singolo PAC3200T.
 *
 * Connessione TCP persistente, una sola per dispositivo. Il PAC3200T
 * accetta pochissime sessioni Modbus simultanee (3-4 secondo il
 * manuale): se dashboard, Node-RED e poller aprono ognuno la propria,
 * i contatori iniziano a rifiutare connessioni e sembrano offline
 * senza esserlo. Il poller deve essere l'unico a parlare coi contatori.
 */
class PacClient {
  constructor({ ip, port = 502, unitId = 1, timeoutMs = 1200 }) {
    this.ip = ip;
    this.port = port;
    this.unitId = unitId;
    this.timeoutMs = timeoutMs;
    this.client = new ModbusRTU();
    this.connected = false;
    // Se il contatore chiude lui la connessione, il prossimo giro deve
    // riconnettersi invece di scrivere su una socket morta.
    this.client.on('close', () => { this.connected = false; });
  }

  async connect() {
    if (this.connected) return;
    this.client.setTimeout(this.timeoutMs);
    await this.client.connectTCP(this.ip, { port: this.port });
    this.client.setID(this.unitId);
    this.connected = true;
  }

  /**
   * Chiude la socket subito, senza aspettare il FIN del contatore.
   *
   * Non usare client.close(): in modbus-serial il suo callback arriva solo
   * se la socket era ancora aperta. Se l'ha gia' chiusa il contatore
   * (reset, riavvio, sessioni esaurite) il callback non arriva mai, e il
   * task del contatore resta appeso per sempre: niente piu' tentativi, e
   * in dashboard resta fermo sull'ultimo stato. destroy() annulla anche
   * le richieste in volo e richiama subito.
   */
  async close() {
    this.connected = false;
    try {
      this.client.destroy(() => {});
    } catch {
      /* la socket era gia' andata */
    }
  }

  /**
   * FC3 su un blocco contiguo. Ritorna il Buffer grezzo: il decoding
   * sta in registers.js, cosi' la mappa e' cambiabile in un solo punto.
   *
   * Tutto il giro (connessione compresa) ha un tetto di tempo proprio:
   * qualunque cosa la libreria lasci in sospeso, la lettura finisce
   * comunque con un errore e il task riprova al giro dopo.
   */
  async readBlock(offset, quantity) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out (nessuna risposta)')),
        this.timeoutMs * 2 + 500);
    });
    try {
      return await Promise.race([this._read(offset, quantity), deadline]);
    } catch (err) {
      // Su errore di trasporto la socket resta in stato sporco:
      // la chiudiamo per forzare una riconnessione pulita al giro dopo.
      if (isTransportError(err)) await this.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async _read(offset, quantity) {
    if (!this.connected) await this.connect();
    const res = await this.client.readHoldingRegisters(offset, quantity);
    return res.buffer;
  }
}

/** Distingue errori di trasporto (socket da riaprire) da errori Modbus
 *  applicativi (es. indirizzo illegale), che non richiedono reconnect. */
function isTransportError(err) {
  const code = err && err.code;
  if (code && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH',
               'ENETUNREACH', 'EPIPE', 'ERR_STREAM_DESTROYED'].includes(code)) {
    return true;
  }
  const msg = String((err && err.message) || '');
  return /timed out|port not open|not connected|closed/i.test(msg);
}

module.exports = { PacClient, isTransportError };
