'use strict';

const { Client } = require('pg');
const config = require('./config');
const { pool, waitForDb, loadDevices } = require('./db');
const { prepare } = require('./bootstrap');
const { Semaphore } = require('./semaphore');
const { Writer } = require('./writer');
const { DeviceTask } = require('./device-task');

const semaphore = new Semaphore(config.concurrency);
const writer = new Writer();
const tasks = new Map();   // device_id -> DeviceTask

async function syncDevices() {
  const devices = await loadDevices();
  const seen = new Set();

  for (const d of devices) {
    seen.add(d.id);
    const existing = tasks.get(d.id);
    if (!existing) {
      const task = new DeviceTask(d, { semaphore, writer });
      tasks.set(d.id, task);
      task.start();
      continue;
    }
    // Se sono cambiati i parametri di connessione, ricrea il task.
    const e = existing.device;
    const changed = e.ip !== d.ip || e.port !== d.port
      || e.unit_id !== d.unit_id || e.word_swap !== d.word_swap;
    if (changed) {
      await existing.stop();
      const task = new DeviceTask(d, { semaphore, writer });
      tasks.set(d.id, task);
      task.start();
    } else {
      // Cadenze e nome si aggiornano a caldo senza riaprire la socket.
      e.poll_ms = d.poll_ms;
      e.energy_ms = d.energy_ms;
      e.totalpower_ms = d.totalpower_ms;
      e.name = d.name;
    }
  }

  // Device disabilitati o rimossi.
  for (const [id, task] of tasks) {
    if (!seen.has(id)) {
      await task.stop();
      tasks.delete(id);
    }
  }

  console.log(`[poller] ${tasks.size} contatori attivi, `
    + `concorrenza ${config.concurrency}`);
}

/** LISTEN su devices_changed: l'anagrafica si ricarica a caldo, senza
 *  riavviare il poller ogni volta che il cliente aggiunge un contatore. */
async function startListener() {
  const client = new Client({ connectionString: config.databaseUrl });
  let debounce = null;

  client.on('notification', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      syncDevices().catch((e) => console.error('[poller] sync:', e.message));
    }, 1000);
  });

  client.on('error', async (err) => {
    console.error('[poller] listener caduto, riprovo fra 5 s:', err.message);
    try { await client.end(); } catch { /* ignora */ }
    setTimeout(() => startListener().catch(() => {}), 5000);
  });

  await client.connect();
  await client.query('LISTEN devices_changed');
  console.log('[poller] in ascolto su devices_changed');
}

function startHeartbeat() {
  setInterval(() => {
    const byState = { online: 0, degraded: 0, offline: 0, unknown: 0 };
    for (const t of tasks.values()) byState[t.state.state] += 1;
    console.log(
      `[poller] online ${byState.online} / degraded ${byState.degraded} / `
      + `offline ${byState.offline} / unknown ${byState.unknown} - `
      + `code ${semaphore.pending}, righe scritte ${writer.stats.rows}, `
      + `flush ${writer.stats.flushes}, errori ${writer.stats.errors}`);
  }, 60000);
}

async function main() {
  console.log('[poller] avvio');
  await waitForDb();
  await prepare();          // crea schema e tabelle se mancano
  writer.start();
  await syncDevices();
  await startListener();
  startHeartbeat();

  const shutdown = async (signal) => {
    console.log(`[poller] ${signal}, chiusura`);
    await Promise.all(Array.from(tasks.values()).map((t) => t.stop()));
    await writer.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[poller] avvio fallito:', err);
  process.exit(1);
});
