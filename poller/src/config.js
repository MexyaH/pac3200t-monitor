'use strict';

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} non e' un numero: ${v}`);
  return n;
}

module.exports = {
  databaseUrl: process.env.DATABASE_URL
    || 'postgres://postgres@postgres:5432/postgres',

  // Schema dedicato dentro il database esistente. Impostato per sessione
  // sulle connessioni del poller: non cambia niente per gli altri utenti
  // del database.
  dbSchema: process.env.DB_SCHEMA || 'pac',

  // Il poller si crea le tabelle da solo all'avvio: nessuno script
  // esterno, nessun psql da installare.
  schemaFile: process.env.SCHEMA_FILE || '/app/db/schema.sql',

  // Anagrafica da caricare all'avvio. I contatori gia' in tabella non
  // vengono toccati, quindi le modifiche fatte a mano restano. Lascia
  // vuoto se vuoi inserire gli IP solo a mano.
  devicesCsv: process.env.DEVICES_CSV || '',

  // Letture Modbus contemporanee. Con 106 contatori a 60 s bastano
  // abbondantemente: il ciclo completo si chiude in circa un secondo.
  concurrency: num('CONCURRENCY', 10),

  // Timeout per singola lettura. 1000-1500 ms: non 5000, altrimenti un
  // device morto tiene occupato uno slot del pool per cinque secondi.
  modbusTimeoutMs: num('MODBUS_TIMEOUT_MS', 1200),

  // Intervallo di flush delle scritture su Postgres.
  flushMs: num('FLUSH_MS', 2000),

  // Ogni quanto persistere lo stato anche se non e' cambiato nulla.
  statusFlushMs: num('STATUS_FLUSH_MS', 30000),

  pgPoolMax: num('PG_POOL_MAX', 6),

  // Log di una riga per ciclo completato, utile in collaudo.
  verbose: process.env.VERBOSE === '1',
};
