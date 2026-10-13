'use strict';

const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const auth = require('./auth');
const { parseCsv } = require('./csv');

const PORT = Number(process.env.PORT || 8080);
const REFRESH_MS = Number(process.env.REFRESH_MS || 3000);

const DB_SCHEMA = process.env.DB_SCHEMA || 'pac';
if (!/^[a-z_][a-z0-9_]*$/i.test(DB_SCHEMA)) {
  throw new Error(`DB_SCHEMA non valido: ${DB_SCHEMA}`);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
    || 'postgres://postgres@postgres:5432/postgres',
  max: Number(process.env.PG_POOL_MAX || 6),
  application_name: 'pac-api',
  // Schema dedicato, impostato all'apertura della connessione. L'API
  // scrive solo l'anagrafica, quindi qui non serve toccare
  // synchronous_commit.
  options: `-c search_path=${DB_SCHEMA}`,
});

pool.on('error', (err) => console.error('[api] client idle:', err.message));

const app = express();
// 2 MB: basta per un CSV con migliaia di contatori.
app.use(express.json({ limit: '2mb' }));
// Prima dei file statici: senza sessione anche index.html rimanda al login.
auth.install(app);
app.use(express.static(path.join(__dirname, '..', 'public')));

if (!auth.enabled) {
  console.warn('[api] ADMIN_PASSWORD non impostata: dashboard aperta, modifica disabilitata');
}

// --------------------------------------------------------------------
// Snapshot corrente
// --------------------------------------------------------------------
async function readSnapshot() {
  const { rows } = await pool.query(`
    SELECT id, name, site, panel, ip, state, enabled,
           seen_age_s, latency_ms, consec_errors, last_error, last_seen,
           u_ln_avg, u_ll_avg, i_avg, i_l1, i_l2, i_l3,
           p_total, q_total, s_total, pf_total, freq
      FROM v_dashboard
     ORDER BY id`);
  return rows;
}

app.get('/api/devices', async (req, res) => {
  try {
    res.json({ ts: Date.now(), devices: await readSnapshot() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------------------
// Anagrafica: lettura e modifica di un contatore dalla dashboard.
// Il poller vede le modifiche da solo (trigger NOTIFY su devices), e i
// trigger dello schema creano o rinominano le tabelle storico.
// Niente DELETE: cancellerebbe anche lo storico. Si disabilita.
// --------------------------------------------------------------------
const EDITABLE = {
  name: 'text', site: 'text', panel: 'text', ip: 'text',
  port: 'int', unit_id: 'int', word_swap: 'bool',
  ct_primary: 'int', ct_secondary: 'int', nominal_voltage: 'int',
  poll_ms: 'int', energy_ms: 'int', totalpower_ms: 'int',
  enabled: 'bool', notes: 'text',
};
const REQUIRED = new Set(['name', 'ip']);
const NOT_NULL = new Set(['site', 'port', 'unit_id', 'word_swap',
                          'poll_ms', 'energy_ms', 'totalpower_ms', 'enabled']);

/** Valida il corpo della richiesta. Restituisce { values } oppure
 *  { error }. Con partial=true i campi assenti restano invariati. */
function parseDevice(body, partial) {
  const values = {};
  for (const [col, type] of Object.entries(EDITABLE)) {
    if (!(col in body)) {
      if (!partial && REQUIRED.has(col)) return { error: `${col} obbligatorio` };
      continue;
    }
    let v = body[col];
    if (typeof v === 'string') v = v.trim();
    if (v === '' || v === null || v === undefined) {
      if (REQUIRED.has(col) || NOT_NULL.has(col)) return { error: `${col} obbligatorio` };
      values[col] = null;
      continue;
    }
    if (type === 'int') {
      const num = Number(v);
      if (!Number.isInteger(num) || num < 0) return { error: `${col}: numero intero non valido` };
      values[col] = num;
    } else if (type === 'bool') {
      if (typeof v !== 'boolean') return { error: `${col}: atteso true/false` };
      values[col] = v;
    } else {
      values[col] = String(v);
    }
  }
  if (values.name !== undefined && values.name.length > 44) {
    return { error: 'nome troppo lungo (max 44 caratteri)' };
  }
  if (values.port !== undefined && (values.port < 1 || values.port > 65535)) {
    return { error: 'porta fuori range' };
  }
  if (values.unit_id !== undefined && values.unit_id > 255) {
    return { error: 'unit id fuori range (0-255)' };
  }
  for (const k of ['poll_ms', 'energy_ms', 'totalpower_ms']) {
    if (values[k] !== undefined && values[k] < 1000) return { error: `${k}: minimo 1000 ms` };
  }
  return { values };
}

/** Errori del database in messaggi leggibili dalla dashboard. */
function dbError(res, err) {
  if (err.code === '23505') {
    res.status(409).json({ error: err.constraint === 'devices_name_key'
      ? 'esiste gia\' un contatore con questo nome'
      : 'esiste gia\' un contatore con questo IP, porta e unit id' });
  } else if (err.code === 'P0001') {               // RAISE EXCEPTION dei trigger
    res.status(400).json({ error: err.message });
  } else {
    res.status(500).json({ error: err.message });
  }
}

const DEVICE_COLS = `id, ${Object.keys(EDITABLE).join(', ')}`;

app.get('/api/devices/:id/config', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${DEVICE_COLS} FROM devices WHERE id = $1`, [Number(req.params.id)]);
    if (!rows.length) {
      res.status(404).json({ error: 'contatore non trovato' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/devices', auth.requireEditor, async (req, res) => {
  const { values, error } = parseDevice(req.body || {}, false);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  // Le colonne vengono solo da EDITABLE, i valori sono parametri.
  const cols = Object.keys(values);
  try {
    const { rows } = await pool.query(
      `INSERT INTO devices (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING ${DEVICE_COLS}`,
      cols.map((c) => values[c]));
    res.status(201).json(rows[0]);
  } catch (err) {
    dbError(res, err);
  }
});

app.put('/api/devices/:id', auth.requireEditor, async (req, res) => {
  const { values, error } = parseDevice(req.body || {}, true);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const cols = Object.keys(values);
  if (!cols.length) {
    res.status(400).json({ error: 'nessun campo da modificare' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `UPDATE devices SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}
        WHERE id = $1
       RETURNING ${DEVICE_COLS}`,
      [Number(req.params.id), ...cols.map((c) => values[c])]);
    if (!rows.length) {
      res.status(404).json({ error: 'contatore non trovato' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    dbError(res, err);
  }
});

// --------------------------------------------------------------------
// Import CSV: piu' contatori in una volta, stesso formato dei file in
// db/ (intestazione con i nomi delle colonne di devices).
//
// Tutto o niente: se anche una sola riga e' sbagliata non si importa
// nulla e si restituisce l'elenco completo degli errori, cosi' si
// corregge il file in un giro solo. Con dryRun il risultato e' lo stesso
// ma la transazione viene sempre annullata: e' la "Verifica" della UI.
//
// Celle vuote = colonna non impostata: in un contatore nuovo vale il
// default della tabella, in uno esistente resta il valore attuale.
// --------------------------------------------------------------------
const BOOL_TRUE = /^(true|1|s[iì]|yes|y|x)$/i;
const BOOL_FALSE = /^(false|0|no|n)$/i;

function csvRecordToDevice(values) {
  const body = {};
  for (const [col, type] of Object.entries(EDITABLE)) {
    const v = values[col];
    if (v === undefined || v === '') continue;
    if (type === 'bool') {
      if (BOOL_TRUE.test(v)) body[col] = true;
      else if (BOOL_FALSE.test(v)) body[col] = false;
      else return { error: `${col}: atteso true/false, trovato "${v}"` };
    } else {
      body[col] = v;
    }
  }
  if (!body.name) return { error: 'name mancante' };
  return parseDevice(body, true);
}

app.post('/api/devices/import', auth.requireEditor, async (req, res) => {
  const { csv, update = false, dryRun = false } = req.body || {};
  const { header, records } = parseCsv(csv);
  if (!records.length) {
    res.status(400).json({ error: 'file vuoto o senza righe dopo l\'intestazione' });
    return;
  }
  if (!header.includes('name') || !header.includes('ip')) {
    res.status(400).json({ error: 'servono almeno le colonne name e ip' });
    return;
  }
  const ignored = header.filter((h) => h && !(h in EDITABLE) && h !== 'id');

  const report = { inserted: [], updated: [], skipped: [], errors: [], ignored };
  const seen = new Map();   // nome -> riga, per i doppioni nel file

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { line, values } of records) {
      const name = values.name || '';
      // Il doppione si controlla prima della validazione: anche se la
      // prima occorrenza ha un altro errore, la seconda va segnalata.
      if (name && seen.has(name)) {
        report.errors.push({ line, name, error: `nome ripetuto (gia' alla riga ${seen.get(name)})` });
        continue;
      }
      if (name) seen.set(name, line);
      const { values: dev, error } = csvRecordToDevice(values);
      if (error) { report.errors.push({ line, name, error }); continue; }

      // Un savepoint per riga: un errore del database su una riga non
      // impedisce di controllare le successive.
      await client.query('SAVEPOINT r');
      try {
        const { rows } = await client.query('SELECT id FROM devices WHERE name = $1', [dev.name]);
        const cols = Object.keys(dev);
        if (!rows.length) {
          if (!dev.ip) throw new Error('ip obbligatorio per un contatore nuovo');
          await client.query(
            `INSERT INTO devices (${cols.join(', ')})
             VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
            cols.map((c) => dev[c]));
          report.inserted.push(dev.name);
        } else if (update) {
          const set = cols.filter((c) => c !== 'name');
          if (set.length) {
            await client.query(
              `UPDATE devices SET ${set.map((c, i) => `${c} = $${i + 2}`).join(', ')}
                WHERE id = $1`,
              [rows[0].id, ...set.map((c) => dev[c])]);
          }
          report.updated.push(dev.name);
        } else {
          report.skipped.push(dev.name);
        }
        await client.query('RELEASE SAVEPOINT r');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT r');
        let msg = err.message;
        if (err.code === '23505') msg = 'IP, porta e unit id gia\' usati da un altro contatore';
        report.errors.push({ line, name, error: msg });
      }
    }

    const commit = !dryRun && !report.errors.length;
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    report.committed = commit;
    res.status(report.errors.length ? 422 : 200).json(report);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/** Riepilogo per l'intestazione. */
app.get('/api/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COALESCE(s.state,'unknown') AS state, count(*)::int AS n
        FROM devices d LEFT JOIN device_status s ON s.device_id = d.id
       WHERE d.enabled GROUP BY 1`);
    const out = { online: 0, degraded: 0, offline: 0, unknown: 0 };
    for (const r of rows) out[r.state] = r.n;
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Un identificatore per contatore, quotato come farebbe quote_ident:
 *  il nome arriva da devices.name e finisce nel nome della tabella, mai
 *  concatenato in un valore SQL. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Storico per grafici puntuali. Per i trend seri conviene Grafana
 *  puntato sullo stesso Postgres.
 *
 *  Legge solo energyvalue_<nome> (un campione al minuto): totalpower_<nome>
 *  ha un campione ogni 10 minuti, quindi la potenza totale qui e' la
 *  somma delle tre fasi. */
app.get('/api/devices/:id/history', async (req, res) => {
  const id = Number(req.params.id);
  const hours = Math.min(Number(req.query.hours || 24), 24 * 31);
  const bucket = Math.max(Number(req.query.bucket_s || 60), 15);
  try {
    const { rows: devRows } = await pool.query(
      'SELECT name FROM devices WHERE id = $1', [id]);
    if (!devRows.length) {
      res.status(404).json({ error: 'contatore non trovato' });
      return;
    }
    const ev = quoteIdent(`energyvalue_${devRows[0].name}`);
    const { rows } = await pool.query(`
      SELECT to_timestamp(floor(extract(epoch FROM "timestamp") / $2) * $2) AS ts,
             avg(activepowerl1 + activepowerl2 + activepowerl3)::real AS p_total,
             avg((currentl1 + currentl2 + currentl3) / 3.0)::real AS i_avg,
             avg((voltagel1 + voltagel2 + voltagel3) / 3.0)::real AS u_ln_avg,
             avg((activepowerl1 + activepowerl2 + activepowerl3)
                 / NULLIF(totalapparent, 0))::real AS pf_total
        FROM ${ev}
       WHERE "timestamp" > now() - ($1 || ' hour')::interval
       GROUP BY 1 ORDER BY 1`, [hours, bucket]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Ultime transizioni di stato: la traccia da mostrare al cliente
 *  quando sostiene che il software perde dati. */
app.get('/api/events', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  try {
    const { rows } = await pool.query(`
      SELECT e.id, e.ts, d.name, e.from_state, e.to_state, e.detail
        FROM device_events e JOIN devices d ON d.id = e.device_id
       ORDER BY e.ts DESC LIMIT $1`, [limit]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// --------------------------------------------------------------------
// SSE: manda diff, non snapshot.
// Uno snapshot completo di 100 device e' ~25 KB di JSON per ciclo per
// ogni client aperto, e i valori che cambiano in modo interessante
// sono pochi. Lo stato online/offline cambia rarissimamente.
// --------------------------------------------------------------------
const clients = new Set();
let previous = new Map();

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // niente buffering se c'e' nginx davanti
  });
  res.write('retry: 5000\n\n');

  const client = { res };
  clients.add(client);

  // Primo messaggio: snapshot completo, poi solo diff.
  readSnapshot()
    .then((rows) => send(client, 'snapshot', { ts: Date.now(), devices: rows }))
    .catch(() => {});

  const ka = setInterval(() => res.write(': keepalive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ka);
    clients.delete(client);
  });
});

function send(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

/** Campi su cui vale la pena mandare un aggiornamento, con la soglia
 *  sotto la quale la variazione e' rumore di misura. */
const TRACKED = {
  name: null, site: null, panel: null, ip: null, enabled: null,
  state: null, seen_age_s: 15, latency_ms: 50,
  p_total: 0.5, q_total: 0.5, s_total: 0.5,
  i_avg: 0.5, i_l1: 0.5, i_l2: 0.5, i_l3: 0.5,
  u_ln_avg: 1, u_ll_avg: 1, pf_total: 0.02, freq: 0.05,
  consec_errors: null, last_error: null,
};

function diffRow(prev, next) {
  if (!prev) return next;
  const out = {};
  let changed = false;
  for (const [k, tol] of Object.entries(TRACKED)) {
    const a = prev[k];
    const b = next[k];
    if (tol == null || typeof b !== 'number' || typeof a !== 'number') {
      if (a !== b) { out[k] = b; changed = true; }
    } else if (Math.abs(a - b) >= tol) {
      out[k] = b; changed = true;
    }
  }
  if (!changed) return null;
  out.id = next.id;
  return out;
}

async function tick() {
  if (!clients.size) return;                   // nessuno guarda: non interrogare il DB
  let rows;
  try {
    rows = await readSnapshot();
  } catch (err) {
    console.error('[api] snapshot:', err.message);
    return;
  }

  const next = new Map(rows.map((r) => [r.id, r]));
  const changes = [];
  for (const [id, row] of next) {
    const d = diffRow(previous.get(id), row);
    if (d) changes.push(d);
  }
  const removed = [...previous.keys()].filter((id) => !next.has(id));
  previous = next;

  if (!changes.length && !removed.length) return;
  const payload = { ts: Date.now(), changes, removed };
  for (const c of clients) send(c, 'update', payload);
}

setInterval(() => { tick().catch(() => {}); }, REFRESH_MS);

const server = app.listen(PORT, () => {
  console.log(`[api] in ascolto su :${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => pool.end().then(() => process.exit(0)));
});
