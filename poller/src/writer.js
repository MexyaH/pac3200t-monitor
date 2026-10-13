'use strict';

const { pool } = require('./db');
const { MEASUREMENT_COLUMNS, ENERGY_COLUMNS } = require('./registers');
const config = require('./config');

/**
 * Scritture batchate.
 *
 * A 15 s con 100 device sono ~7 righe/secondo. Farne 7 transazioni al
 * secondo significa 7 fsync: con un batch ogni 2 s si sta a uno. La
 * differenza si vede sotto carico e su storage mediocre.
 *
 * Se in futuro si scende a 1 s (100 righe/s) conviene passare a COPY
 * con pg-copy-streams; a questa cadenza l'INSERT multi-riga basta.
 */
class Writer {
  constructor() {
    this.measurements = [];
    this.totalPower = [];
    this.energy = [];
    this.events = [];
    // Lo stato non viene scritto a ogni ciclo: tenuto in memoria e
    // persistito ogni statusFlushMs oppure quando cambia. 1,7M UPDATE
    // al giorno su 100 righe gonfiano la tabella inutilmente.
    this.statusByDevice = new Map();
    this.latestByDevice = new Map();
    this.timer = null;
    this.flushing = false;
    this.stats = { rows: 0, flushes: 0, errors: 0 };
  }

  start() {
    this.timer = setInterval(() => {
      this.flush().catch((e) => console.error('[writer] flush:', e.message));
    }, config.flushMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  addMeasurement(deviceId, deviceName, ts, values) {
    this.measurements.push({ deviceId, deviceName, ts, values });
    this.latestByDevice.set(deviceId, { ts, values });
  }

  addTotalPower(deviceName, ts, value) {
    this.totalPower.push({ deviceName, ts, value });
  }

  addEnergy(deviceId, ts, values) {
    this.energy.push({ deviceId, ts, values });
  }

  setStatus(state) {
    this.statusByDevice.set(state.deviceId, {
      state: state.state,
      lastSeen: state.lastSeen,
      lastAttempt: state.lastAttempt,
      lastError: state.lastError,
      consecErrors: state.consecErrors,
      latencyMs: state.latencyMs,
    });
    if (state.dirty && state.pendingTransition) {
      const t = state.pendingTransition;
      this.events.push({
        deviceId: state.deviceId,
        from: t.from,
        to: t.to,
        detail: t.detail,
      });
      state.dirty = false;
      state.pendingTransition = null;
    }
  }

  async flush() {
    if (this.flushing) return;             // evita flush sovrapposti
    this.flushing = true;

    const meas = this.measurements.splice(0);
    const tpow = this.totalPower.splice(0);
    const ener = this.energy.splice(0);
    const evts = this.events.splice(0);
    const statuses = Array.from(this.statusByDevice.entries());
    const latest = Array.from(this.latestByDevice.entries());
    this.statusByDevice.clear();
    this.latestByDevice.clear();

    if (!meas.length && !tpow.length && !ener.length && !evts.length
        && !statuses.length) {
      this.flushing = false;
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (meas.length)     await insertEnergyValues(client, meas);
      if (tpow.length)     await insertTotalPowers(client, tpow);
      if (latest.length)   await upsertLatest(client, latest);
      if (ener.length)     await insertEnergy(client, ener);
      if (statuses.length) await upsertStatus(client, statuses);
      if (evts.length)     await insertEvents(client, evts);
      await client.query('COMMIT');
      this.stats.rows += meas.length;
      this.stats.flushes += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      this.stats.errors += 1;
      // I campioni persi sono persi: rimetterli in coda su un DB che
      // non risponde fa crescere la memoria senza limite. Il buco
      // resta visibile nello storico, che e' il comportamento corretto.
      console.error(`[writer] scrittura fallita, ${meas.length} campioni scartati: ${err.message}`);
    } finally {
      client.release();
      this.flushing = false;
    }
  }
}

// --------------------------------------------------------------------
// Helper: costruzione INSERT multi-riga con placeholder
// --------------------------------------------------------------------
function buildValues(rows, colCount, startAt = 1) {
  const chunks = [];
  let p = startAt;
  for (let i = 0; i < rows; i += 1) {
    const ph = [];
    for (let c = 0; c < colCount; c += 1) ph.push(`$${p++}`);
    chunks.push(`(${ph.join(',')})`);
  }
  return chunks.join(',');
}

/** Un identificatore per contatore, quotato come farebbe quote_ident:
 *  il nome del contatore arriva dalla tabella devices e finisce diretto
 *  nel nome della tabella, quindi niente concatenazione di stringhe. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** energyvalue_<nome>: colonna di destinazione -> colonna sorgente nei
 *  valori decodificati da registers.js. Stesso formato delle tabelle
 *  storico gia' in uso altrove. */
const ENERGYVALUE_MAP = {
  voltagel1: 'u_l1_n', voltagel2: 'u_l2_n', voltagel3: 'u_l3_n',
  currentl1: 'i_l1', currentl2: 'i_l2', currentl3: 'i_l3',
  activepowerl1: 'p_l1', activepowerl2: 'p_l2', activepowerl3: 'p_l3',
  reactivepowerl1: 'q_l1', reactivepowerl2: 'q_l2', reactivepowerl3: 'q_l3',
  cosl1: 'pf_l1', cosl2: 'pf_l2', cosl3: 'pf_l3',
  totalreactive: 'q_total', totalapparent: 's_total',
};
const ENERGYVALUE_COLUMNS = Object.keys(ENERGYVALUE_MAP);

/** Ogni contatore ha le sue tabelle storico: un INSERT multi-riga per
 *  device invece di uno solo su una tabella condivisa. */
function byDeviceName(batch) {
  const out = new Map();
  for (const r of batch) {
    if (!out.has(r.deviceName)) out.set(r.deviceName, []);
    out.get(r.deviceName).push(r);
  }
  return out;
}

async function insertEnergyValues(client, batch) {
  const cols = [...ENERGYVALUE_COLUMNS, '"timestamp"'];
  for (const [name, rows] of byDeviceName(batch)) {
    const params = [];
    for (const r of rows) {
      for (const col of ENERGYVALUE_COLUMNS) params.push(r.values[ENERGYVALUE_MAP[col]]);
      params.push(r.ts);
    }
    await client.query(
      `INSERT INTO ${quoteIdent(`energyvalue_${name}`)} (${cols.join(',')})
       VALUES ${buildValues(rows.length, cols.length)}`, params);
  }
}

async function insertTotalPowers(client, batch) {
  for (const [name, rows] of byDeviceName(batch)) {
    const params = [];
    for (const r of rows) params.push(r.value, r.ts);
    await client.query(
      `INSERT INTO ${quoteIdent(`totalpower_${name}`)} (totalactivepower, "timestamp")
       VALUES ${buildValues(rows.length, 2)}`, params);
  }
}

async function upsertLatest(client, entries) {
  const cols = ['device_id', 'ts', ...MEASUREMENT_COLUMNS];
  const params = [];
  for (const [deviceId, { ts, values }] of entries) {
    params.push(deviceId, ts);
    for (const c of MEASUREMENT_COLUMNS) params.push(values[c]);
  }
  const updates = ['ts = EXCLUDED.ts']
    .concat(MEASUREMENT_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`))
    .join(', ');
  const sql = `INSERT INTO device_latest (${cols.join(',')})
               VALUES ${buildValues(entries.length, cols.length)}
               ON CONFLICT (device_id) DO UPDATE SET ${updates}`;
  await client.query(sql, params);
}

async function insertEnergy(client, batch) {
  const cols = ['device_id', 'ts', ...ENERGY_COLUMNS];
  const params = [];
  for (const r of batch) {
    params.push(r.deviceId, r.ts);
    for (const c of ENERGY_COLUMNS) params.push(r.values[c]);
  }
  const sql = `INSERT INTO energy_counters (${cols.join(',')})
               VALUES ${buildValues(batch.length, cols.length)}
               ON CONFLICT (device_id, ts) DO NOTHING`;
  await client.query(sql, params);
}

async function upsertStatus(client, entries) {
  const params = [];
  for (const [deviceId, s] of entries) {
    params.push(deviceId, s.state, s.lastSeen, s.lastAttempt,
                s.lastError, s.consecErrors, s.latencyMs);
  }
  const sql = `INSERT INTO device_status
                 (device_id, state, last_seen, last_attempt,
                  last_error, consec_errors, latency_ms)
               VALUES ${buildValues(entries.length, 7)}
               ON CONFLICT (device_id) DO UPDATE SET
                 state = EXCLUDED.state,
                 last_seen = COALESCE(EXCLUDED.last_seen, device_status.last_seen),
                 last_attempt = EXCLUDED.last_attempt,
                 last_error = EXCLUDED.last_error,
                 consec_errors = EXCLUDED.consec_errors,
                 latency_ms = EXCLUDED.latency_ms,
                 updated_at = now()`;
  await client.query(sql, params);
}

async function insertEvents(client, batch) {
  const params = [];
  for (const e of batch) params.push(e.deviceId, e.from, e.to, e.detail);
  const sql = `INSERT INTO device_events (device_id, from_state, to_state, detail)
               VALUES ${buildValues(batch.length, 4)}`;
  await client.query(sql, params);
}

module.exports = { Writer };
