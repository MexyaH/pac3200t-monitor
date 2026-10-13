'use strict';

const fs = require('fs');
const { pool } = require('./db');
const config = require('./config');

/**
 * Preparazione del database all'avvio del poller.
 *
 * Niente script esterni, niente psql da installare, nessun passaggio
 * manuale: il poller e' gia' collegato al database, quindi si crea le
 * tabelle da solo. Tutto e' idempotente, quindi rieseguirlo a ogni
 * riavvio non fa danni.
 */

/** Esegue schema.sql. Tutte le istruzioni sono IF NOT EXISTS oppure
 *  OR REPLACE, quindi su un database gia' inizializzato non cambia
 *  niente. */
async function applySchema() {
  let sql;
  try {
    sql = fs.readFileSync(config.schemaFile, 'utf8');
  } catch (err) {
    throw new Error(
      `schema non leggibile in ${config.schemaFile}: ${err.message}. `
      + `Controlla che la cartella db/ sia montata nel container.`);
  }

  const client = await pool.connect();
  try {
    await client.query(sql);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1`,
      [config.dbSchema]);
    console.log(`[db] schema ${config.dbSchema} pronto, ${rows[0].n} tabelle`);
  } finally {
    client.release();
  }
}

/**
 * Parser CSV minimo, con gestione dei campi fra virgolette: il file lo
 * modifichera' una persona a mano, quindi meglio non rompersi su una
 * virgola dentro un campo note.
 */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);

  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = {};
    head.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

const NUMERIC = new Set(['port', 'unit_id', 'ct_primary', 'ct_secondary',
                         'nominal_voltage', 'poll_ms', 'energy_ms',
                         'totalpower_ms']);
const ALLOWED = ['name', 'site', 'panel', 'ip', 'port', 'unit_id',
                 'word_swap', 'ct_primary', 'ct_secondary',
                 'nominal_voltage', 'poll_ms', 'energy_ms', 'totalpower_ms',
                 'notes'];

/**
 * Importa l'anagrafica da CSV.
 *
 * ON CONFLICT (name) DO NOTHING: i contatori gia' in tabella non vengono
 * toccati. Chi e' stato aggiunto o corretto a mano resta com'e', e il
 * file serve solo come carico iniziale o per aggiungere i nuovi.
 */
async function importDevices(csvPath) {
  let text;
  try {
    text = fs.readFileSync(csvPath, 'utf8');
  } catch (err) {
    console.warn(`[db] anagrafica ${csvPath} non leggibile, salto: ${err.message}`);
    return;
  }

  const records = parseCsv(text);
  if (!records.length) {
    console.warn(`[db] anagrafica ${csvPath} vuota, salto`);
    return;
  }

  const cols = ALLOWED.filter((c) => c in records[0]);
  if (!cols.includes('name') || !cols.includes('ip')) {
    console.warn(`[db] anagrafica senza colonne name/ip, salto`);
    return;
  }

  const params = [];
  const tuples = records.map((r) => {
    const ph = cols.map((c) => {
      let v = r[c];
      if (v === '' || v === undefined) v = null;
      else if (NUMERIC.has(c)) v = Number(v);
      else if (c === 'word_swap') v = /^(true|1|s[i']?)$/i.test(v);
      params.push(v);
      return `$${params.length}`;
    });
    return `(${ph.join(',')})`;
  });

  const { rowCount } = await pool.query(
    `INSERT INTO ${config.dbSchema}.devices (${cols.join(',')})
     VALUES ${tuples.join(',')}
     ON CONFLICT (name) DO NOTHING`,
    params);

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM ${config.dbSchema}.devices`);
  console.log(`[db] anagrafica: ${rowCount} nuovi contatori da `
    + `${csvPath}, ${rows[0].n} in totale`);
}

async function prepare() {
  await applySchema();
  if (config.devicesCsv) await importDevices(config.devicesCsv);
}

module.exports = { prepare, parseCsv };
