'use strict';

const { Pool } = require('pg');
const config = require('./config');

// Il nome dello schema finisce in un parametro di connessione: accetta
// solo identificatori semplici.
if (!/^[a-z_][a-z0-9_]*$/i.test(config.dbSchema)) {
  throw new Error(`DB_SCHEMA non valido: ${config.dbSchema}`);
}

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  idleTimeoutMillis: 30000,
  application_name: 'pac-poller',
  // Impostazioni PER SESSIONE, passate all'apertura della connessione.
  // Il database e' condiviso col gestionale: non va toccata nessuna
  // configurazione di istanza o di ruolo. synchronous_commit off vale
  // solo per le connessioni del poller — su crash del server si perdono
  // gli ultimi ~200 ms di campioni, in cambio di molte meno fsync.
  options: `-c search_path=${config.dbSchema} -c synchronous_commit=off`,
});

pool.on('error', (err) => {
  console.error('[db] errore su client idle:', err.message);
});

/** Attende che Postgres sia raggiungibile. All'avvio del container il DB
 *  puo' non essere ancora pronto: senza questo il poller muore e
 *  Portainer lo riavvia a ciclo. */
async function waitForDb({ retries = 30, delayMs = 2000 } = {}) {
  for (let i = 1; i <= retries; i += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      console.warn(`[db] non pronto (${i}/${retries}): ${err.message}`);
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function loadDevices() {
  const { rows } = await pool.query(
    `SELECT id, name, site, panel, ip, port, unit_id,
            word_swap, poll_ms, energy_ms, totalpower_ms,
            ct_primary, nominal_voltage
       FROM devices
      WHERE enabled
      ORDER BY id`
  );
  return rows;
}

module.exports = { pool, waitForDb, loadDevices };
