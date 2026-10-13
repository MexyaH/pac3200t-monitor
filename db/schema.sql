-- =====================================================================
-- PAC3200T monitor - schema
-- 106 contatori, lettura una volta al minuto.
--
-- Tabelle normali, niente partizionamento: a questa cadenza sono ~56
-- milioni di righe l'anno, che Postgres regge senza problemi. Il
-- partizionamento avrebbe richiesto un job schedulato per creare le
-- partizioni future, e se quel job salta gli INSERT falliscono in
-- silenzio. Non vale il rischio per 8 GB l'anno.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Le tabelle vanno in uno schema dedicato dentro il database esistente,
-- non in `public`. Nomi come `devices` o `measurements` sono abbastanza
-- generici da collidere con quelli del gestionale, e uno schema separato
-- rende anche banale il giorno in cui il monitoraggio va dismesso:
--   DROP SCHEMA pac CASCADE;
-- Non tocca ruoli, password, porte ne' altri schemi.
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS pac;
SET search_path TO pac;

-- ---------------------------------------------------------------------
-- Anagrafica
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id          serial PRIMARY KEY,
  name        text    NOT NULL UNIQUE,     -- es. 'Q3-LINEA2'
  site        text    NOT NULL DEFAULT 'default',
  panel       text,                        -- quadro elettrico
  -- text e non inet: cosi' accetta sia un indirizzo sia un nome di host
  -- o di container. In impianto ci vanno gli IP; sul banco di prova ci
  -- va il nome del simulatore, che Docker risolve da solo.
  ip          text    NOT NULL,
  port        int     NOT NULL DEFAULT 502,
  unit_id     int     NOT NULL DEFAULT 126,  -- il PAC3200T risponde su 126, non 1
  word_swap   boolean NOT NULL DEFAULT false, -- inverti word nei float32
  -- Rapporto del TA e tensione nominale, da powerconfig. Non servono per
  -- leggere (il PAC applica il rapporto internamente e trasmette i valori
  -- di primario) ma permettono un controllo di plausibilita' per device:
  -- 85 A su un TA 50/5 e' un errore di lettura, su un 1000/5 e' normale.
  ct_primary      int,
  ct_secondary    int,
  nominal_voltage int,
  poll_ms     int     NOT NULL DEFAULT 60000,
  energy_ms   int     NOT NULL DEFAULT 300000,
  totalpower_ms int   NOT NULL DEFAULT 600000,  -- cadenza di totalpower_<nome>
  enabled     boolean NOT NULL DEFAULT true,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ip, port, unit_id)
);

-- Aggiunta dopo: sui database creati prima la CREATE TABLE sopra non
-- tocca la tabella esistente.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS totalpower_ms int NOT NULL DEFAULT 600000;

-- ---------------------------------------------------------------------
-- Stato di raggiungibilita'. 100 righe, UPDATE frequenti.
-- fillfactor + autovacuum aggressivo: senza questo la tabella accumula
-- tuple morte e le query rallentano senza motivo apparente.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_status (
  device_id     int PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  state         text NOT NULL DEFAULT 'unknown'
                CHECK (state IN ('unknown','online','degraded','offline')),
  last_seen     timestamptz,
  last_attempt  timestamptz,
  last_error    text,
  consec_errors int NOT NULL DEFAULT 0,
  latency_ms    int,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE device_status SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold    = 50,
  autovacuum_analyze_scale_factor = 0.05
);

-- ---------------------------------------------------------------------
-- Ultimo campione per contatore. Evita il DISTINCT ON su measurements,
-- che a 200M di righe diventa il collo di bottiglia della dashboard.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_latest (
  device_id int PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  ts        timestamptz NOT NULL,
  u_l1_n real, u_l2_n real, u_l3_n real,
  u_l1_l2 real, u_l2_l3 real, u_l3_l1 real,
  u_ln_avg real, u_ll_avg real,
  i_l1 real, i_l2 real, i_l3 real, i_avg real,
  p_l1 real, p_l2 real, p_l3 real, p_total real,
  q_l1 real, q_l2 real, q_l3 real, q_total real, s_total real,
  pf_l1 real, pf_l2 real, pf_l3 real, pf_total real,
  freq real,
  thd_u_l1 real, thd_u_l2 real, thd_u_l3 real,
  thd_i_l1 real, thd_i_l2 real, thd_i_l3 real
);

ALTER TABLE device_latest SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold    = 50
);

-- Potenza reattiva per fase, aggiunta dopo: sui database creati prima la
-- CREATE TABLE IF NOT EXISTS sopra non tocca la tabella esistente.
ALTER TABLE device_latest
  ADD COLUMN IF NOT EXISTS q_l1 real,
  ADD COLUMN IF NOT EXISTS q_l2 real,
  ADD COLUMN IF NOT EXISTS q_l3 real;

-- ---------------------------------------------------------------------
-- Storico misure: una coppia di tabelle PER CONTATORE, non una tabella
-- condivisa. Stesso formato dello schema storico gia' in uso altrove
-- (tabelle energyvalue/totalpower), cosi' gli strumenti
-- pensati per quello schema funzionano anche qui.
--
-- create_device_history_tables_for() crea energyvalue_<nome> (tensioni,
-- correnti, potenze per fase) e totalpower_<nome> (potenza attiva
-- totale) per un singolo contatore; il trigger sotto la richiama a ogni
-- INSERT su devices, e il blocco DO la richiama una volta per i
-- contatori gia' censiti al momento in cui questo schema viene applicato.
--
-- Il nome delle tabelle incorpora devices.name: niente SQL costruito
-- per concatenazione di stringhe, solo format('%I', ...) come quote_ident.
--
-- SET search_path FROM CURRENT fissa su ogni funzione lo schema attivo
-- qui (pac): senza, una INSERT su pac.devices da pgAdmin o psql (dove il
-- search_path e' public) non troverebbe la funzione, o creerebbe le
-- tabelle in public.
-- ---------------------------------------------------------------------
-- client_min_messages = warning: niente NOTICE "already exists, skipping"
-- a ogni avvio (backfill) o a ogni rinomina.
CREATE OR REPLACE FUNCTION create_device_history_tables_for(dev devices)
RETURNS void LANGUAGE plpgsql
SET search_path FROM CURRENT SET client_min_messages = warning AS $$
DECLARE
  ev_table text := 'energyvalue_' || dev.name;
  tp_table text := 'totalpower_' || dev.name;
BEGIN
  -- Il nome piu' lungo generato e' l'indice di energyvalue; oltre i 63
  -- byte Postgres troncherebbe in silenzio, e due nomi lunghi simili
  -- finirebbero sulla stessa tabella.
  IF octet_length(ev_table || '_ts_idx') > 63 THEN
    RAISE EXCEPTION
      'nome contatore troppo lungo per le tabelle storico (max 44 caratteri): %',
      dev.name;
  END IF;

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS %I (
      id bigserial PRIMARY KEY,
      voltagel1 real, voltagel2 real, voltagel3 real,
      currentl1 real, currentl2 real, currentl3 real,
      activepowerl1 real, activepowerl2 real, activepowerl3 real,
      reactivepowerl1 real, reactivepowerl2 real, reactivepowerl3 real,
      cosl1 real, cosl2 real, cosl3 real,
      totalreactive real, totalapparent real,
      "timestamp" timestamptz NOT NULL
    )
  $f$, ev_table);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("timestamp" DESC)',
                 ev_table || '_ts_idx', ev_table);

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS %I (
      id bigserial PRIMARY KEY,
      totalactivepower real,
      "timestamp" timestamptz NOT NULL
    )
  $f$, tp_table);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("timestamp" DESC)',
                 tp_table || '_ts_idx', tp_table);
END $$;

-- Le tabelle seguono il ciclo di vita del contatore: create all'INSERT,
-- rinominate se cambia il nome (il poller scrive sempre su quelle col
-- nome corrente, quindi senza rinomina lo storico si fermerebbe per
-- tutti), cancellate al DELETE come faceva l'ON DELETE CASCADE della
-- vecchia tabella condivisa.
CREATE OR REPLACE FUNCTION devices_history_trigger() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  prefix text;
  suffix text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE format('DROP TABLE IF EXISTS %I, %I',
                   'energyvalue_' || OLD.name, 'totalpower_' || OLD.name);
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.name IS DISTINCT FROM NEW.name THEN
    FOREACH prefix IN ARRAY ARRAY['energyvalue_', 'totalpower_'] LOOP
      EXECUTE format('ALTER TABLE IF EXISTS %I RENAME TO %I',
                     prefix || OLD.name, prefix || NEW.name);
      FOREACH suffix IN ARRAY ARRAY['_pkey', '_ts_idx'] LOOP
        EXECUTE format('ALTER INDEX IF EXISTS %I RENAME TO %I',
                       prefix || OLD.name || suffix, prefix || NEW.name || suffix);
      END LOOP;
      EXECUTE format('ALTER SEQUENCE IF EXISTS %I RENAME TO %I',
                     prefix || OLD.name || '_id_seq', prefix || NEW.name || '_id_seq');
    END LOOP;
  END IF;

  PERFORM create_device_history_tables_for(NEW);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS devices_history_trg ON devices;
CREATE TRIGGER devices_history_trg
  AFTER INSERT OR UPDATE OF name OR DELETE ON devices
  FOR EACH ROW EXECUTE FUNCTION devices_history_trigger();

-- Backfill per i contatori censiti prima che il trigger esistesse.
-- Idempotente (le CREATE TABLE sopra sono IF NOT EXISTS): si puo'
-- rilanciare a ogni avvio senza effetti collaterali.
DO $$
DECLARE d devices%ROWTYPE;
BEGIN
  FOR d IN SELECT * FROM devices LOOP
    PERFORM create_device_history_tables_for(d);
  END LOOP;
END $$;

-- La vecchia tabella condivisa non serve piu': lo storico vive nelle
-- tabelle per contatore create sopra.
DROP TABLE IF EXISTS measurements;

-- ---------------------------------------------------------------------
-- Query cross-contatore: con una tabella per device al posto di un'unica
-- `measurements`, un JOIN diretto non esiste piu'. Queste due funzioni
-- fanno il loop sui contatori con EXECUTE format(...) al posto
-- dell'operatore, una riga per contatore; l'aggregazione finale (somma,
-- max, group by panel) resta a chi chiama, in query normale.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION device_reliability(days int DEFAULT 7)
RETURNS TABLE(name text, ricevuti bigint, attesi int, pct numeric)
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  d devices%ROWTYPE;
  n bigint;
BEGIN
  FOR d IN SELECT * FROM devices WHERE enabled ORDER BY id LOOP
    EXECUTE format(
      $f$SELECT count(*) FROM %I WHERE "timestamp" > now() - ($1 || ' day')::interval$f$,
      'energyvalue_' || d.name
    ) INTO n USING days;
    name := d.name;
    ricevuti := n;
    attesi := (days * 86400 / (d.poll_ms / 1000.0))::int;
    pct := round(100.0 * n / NULLIF(attesi, 0), 1);
    RETURN NEXT;
  END LOOP;
END $$;

-- Il picco si cerca in energyvalue (un campione al minuto, potenza
-- totale = somma delle tre fasi) e non in totalpower, che ha un solo
-- campione istantaneo ogni 10 minuti e i picchi brevi li perde.
CREATE OR REPLACE FUNCTION device_peak_power(days int DEFAULT 30)
RETURNS TABLE(name text, panel text, kw_max numeric)
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  d devices%ROWTYPE;
  v real;
BEGIN
  FOR d IN SELECT * FROM devices LOOP
    EXECUTE format(
      $f$SELECT max(activepowerl1 + activepowerl2 + activepowerl3) FROM %I
          WHERE "timestamp" > now() - ($1 || ' day')::interval$f$,
      'energyvalue_' || d.name
    ) INTO v USING days;
    IF v IS NOT NULL THEN
      name := d.name;
      panel := d.panel;
      kw_max := round((v / 1000)::numeric, 1);
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Contatori di energia: valori cumulati grezzi, letti 1/min.
-- I delta si calcolano in query con LAG(), scartando i valori negativi
-- (qualcuno in campo azzerera' il contatore, prima o poi).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS energy_counters (
  device_id     int NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts            timestamptz NOT NULL,
  wh_import     double precision,
  wh_export     double precision,
  varh_import   double precision,
  varh_export   double precision,
  PRIMARY KEY (device_id, ts)
);

-- ---------------------------------------------------------------------
-- Transizioni di stato. Poche righe, non partizionata.
-- E' la tabella che ti salva quando il cliente dice che il software
-- perde dati e tu gli mostri i dropout della sua rete.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_events (
  id         bigserial PRIMARY KEY,
  device_id  int NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts         timestamptz NOT NULL DEFAULT now(),
  from_state text,
  to_state   text NOT NULL,
  detail     text
);

CREATE INDEX IF NOT EXISTS device_events_device_ts_idx
  ON device_events (device_id, ts DESC);
CREATE INDEX IF NOT EXISTS device_events_ts_idx
  ON device_events (ts DESC);

-- ---------------------------------------------------------------------
-- Vista per la dashboard
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard AS
SELECT
  d.id, d.name, d.site, d.panel, d.ip, d.enabled,
  d.ct_primary, d.ct_secondary, d.nominal_voltage,
  COALESCE(s.state, 'unknown') AS state,
  s.last_seen, s.latency_ms, s.consec_errors, s.last_error,
  EXTRACT(EPOCH FROM (now() - s.last_seen))::int AS seen_age_s,
  l.ts AS sample_ts,
  l.u_ln_avg, l.u_ll_avg, l.i_avg, l.i_l1, l.i_l2, l.i_l3,
  l.p_total, l.q_total, l.s_total, l.pf_total, l.freq
FROM devices d
LEFT JOIN device_status s ON s.device_id = d.id
LEFT JOIN device_latest l ON l.device_id = d.id;

-- ---------------------------------------------------------------------
-- Canale di notifica: il poller ricarica l'anagrafica a caldo invece di
-- essere riavviato ogni volta che si aggiunge un contatore.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_devices_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('devices_changed', '');
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS devices_changed_trg ON devices;
CREATE TRIGGER devices_changed_trg
  AFTER INSERT OR UPDATE OR DELETE ON devices
  FOR EACH STATEMENT EXECUTE FUNCTION notify_devices_changed();

-- =====================================================================
-- Retention
--
-- Non serve nessun job schedulato. Se un giorno lo spazio dara' fastidio
-- (~8 GB l'anno in totale sulle 106 coppie energyvalue_*/totalpower_*),
-- una cancellazione a mano per singolo contatore basta:
--
--   DELETE FROM energyvalue_id001 WHERE "timestamp" < now() - interval '2 year';
--   DELETE FROM totalpower_id001  WHERE "timestamp" < now() - interval '2 year';
--   VACUUM ANALYZE energyvalue_id001;
--
-- Per farlo su tutti i contatori in un colpo solo, un DO block che
-- itera su devices.name con EXECUTE format(...) come nelle funzioni
-- sopra.
--
-- energy_counters conviene non toccarla: e' piccola e serve per la
-- rendicontazione storica.
-- =====================================================================
