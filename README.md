# PAC3200T Monitor

Servizio che legge i contatori **Siemens SENTRON PAC3200T** via Modbus TCP,
salva le misure su **PostgreSQL** e mostra in una dashboard web quali
contatori sono raggiungibili.

```
 rete Docker
 ┌───────────────────────────────────────┐
 │  pac-poller ───── Modbus TCP ─────────┼──►  contatori PAC3200T
 │      │                                │
 │      ▼                                │
 │  PostgreSQL (esistente, schema `pac`) │
 │      ▲                                │
 │  pac-api ─── dashboard :8080          │
 └───────────────────────────────────────┘
```

Il poller e' **l'unico** processo che deve parlare con i contatori: il
PAC3200T accetta poche sessioni Modbus simultanee e, se altri sistemi
(Node-RED, SCADA, ...) lo interrogano in parallelo, inizia a rifiutare le
connessioni.

## Requisiti

- Docker con Docker Compose
- un PostgreSQL raggiungibile (lo stack **non** lo include)
- una rete Docker esterna gia' esistente, condivisa con Postgres
- una rotta dall'host verso la sottorete dei contatori

## Avvio rapido

```bash
git clone <url-del-repo> pac3200t-monitor
cd pac3200t-monitor
cp .env.example .env          # poi modifica DATABASE_URL e DOCKER_NETWORK
docker compose up -d --build
docker compose logs -f poller
```

Dashboard su `http://<ip-server>:8080`.

Su Windows leggi prima [WINDOWS.md](WINDOWS.md): un `.env` creato con
`echo` da PowerShell non viene letto da Docker.

Al primo avvio il poller:

1. aspetta che il database risponda;
2. esegue [db/schema.sql](db/schema.sql) e crea lo schema `pac` con le
   tabelle (tutto `IF NOT EXISTS`, i riavvii non cambiano niente);
3. carica l'anagrafica da `DEVICES_CSV`, se impostata;
4. comincia a leggere.

Non tocca niente fuori dal suo schema. Per rimuovere tutto:
`DROP SCHEMA pac CASCADE;`

Per provare senza contatori reali vedi [Simulatore](#simulatore).

## Configurazione

### Variabili d'ambiente (`.env`)

| Variabile        | Default                       | Note                                                   |
| ---------------- | ----------------------------- | ------------------------------------------------------ |
| `DATABASE_URL`   | —                             | obbligatoria                                           |
| `DB_SCHEMA`      | `pac`                         | schema dedicato dentro il database                     |
| `DOCKER_NETWORK` | `pacnet`                      | rete Docker esterna condivisa con Postgres             |
| `DEVICES_CSV`    | `/app/db/devices-example.csv` | anagrafica iniziale; vuota = solo inserimento manuale |
| `API_PORT`       | `8080`                        | porta della dashboard sull'host                        |
| `ADMIN_USER`     | `admin`                       | utente della dashboard                                 |
| `ADMIN_PASSWORD` | —                             | password; vuota = dashboard aperta, modifica disabilitata |
| `SESSION_SECRET` | —                             | stringa casuale per firmare le sessioni (consigliata)  |

Altri parametri del poller sono in [docker-compose.yml](docker-compose.yml):
`CONCURRENCY` (letture contemporanee, 10), `MODBUS_TIMEOUT_MS` (1200),
`VERBOSE` (1 = logga ogni lettura).

### Accesso

Con `ADMIN_PASSWORD` impostata la dashboard chiede il login (un solo
utente, definito nel `.env`). La sessione dura 30 giorni. Cambiando la
password tutte le sessioni aperte decadono. Dopo 5 tentativi errati
dallo stesso IP il login resta bloccato per 15 minuti.

Il cookie di sessione non ha il flag `Secure` perche' la dashboard gira in
http. Se la esponi fuori dalla rete d'impianto, mettila dietro un reverse
proxy https.

### Contatori

L'anagrafica e' la tabella `pac.devices`. Si riempie in tre modi:

- **dalla dashboard**, con i pulsanti "+ Nuovo contatore" e "Modifica" su
  ogni riga. Rinominare un contatore rinomina anche le sue tabelle
  storico. La cancellazione non c'e' (eliminerebbe lo storico): togli
  "Abilitato" per escluderlo dal polling. Con "Importa CSV" se ne
  caricano molti insieme, nello stesso formato dei file in `db/`
  (separatore `,` o `;`, quindi va bene anche un CSV salvato da Excel).
  Il file viene prima verificato e si importa tutto o niente: se una riga
  ha un errore non viene scritto nulla e compare l'elenco delle righe da
  correggere. I contatori gia' presenti (stesso nome) vengono ignorati, a
  meno di spuntare "Aggiorna i contatori gia' presenti";

- **da CSV** (`DEVICES_CSV`), vedi [db/devices-example.csv](db/devices-example.csv).
  I contatori gia' presenti in tabella non vengono sovrascritti, quindi le
  correzioni fatte a mano restano dopo un riavvio. Chiama le anagrafiche
  reali `db/<nome>.local.csv`: sono escluse da git;
- **a mano**, con `INSERT`/`UPDATE`. Il poller ricarica l'anagrafica a
  caldo (`LISTEN/NOTIFY`), senza riavvio.

```sql
SET search_path TO pac;

INSERT INTO devices (name, site, panel, ip, unit_id, ct_primary, ct_secondary)
VALUES ('Q1-GENERALE', 'stabilimento', 'Q1', '192.168.10.11', 126, 100, 5);

UPDATE devices SET ip = '192.168.10.99' WHERE name = 'Q1-GENERALE';
UPDATE devices SET enabled = false      WHERE name = 'Q1-GENERALE';
```

| Colonna                                 | Significato                                      |
| --------------------------------------- | ------------------------------------------------ |
| `name`                                  | identificativo univoco                           |
| `ip`, `port`                            | indirizzo e porta Modbus (502)                   |
| `unit_id`                               | unit id Modbus (sul PAC3200T spesso **126**)     |
| `site`, `panel`                         | raggruppamento in dashboard                      |
| `ct_primary`, `ct_secondary`            | rapporto TA, per il controllo di plausibilita'   |
| `nominal_voltage`                       | tensione nominale (400)                          |
| `poll_ms`, `energy_ms`, `totalpower_ms` | cadenze di lettura (60 s, 5 min, 10 min)         |
| `word_swap`                             | `true` se i float arrivano con le word invertite |
| `enabled`                               | `false` esclude il contatore dal polling         |

## Collaudo

Gli strumenti stanno nel profilo `tools` e non partono con lo stack:

```bash
docker compose --profile tools build tools
```

### Verifica della mappa registri

Da fare **su un contatore reale prima della messa in servizio**: una mappa
sbagliata produce numeri plausibili ma falsi.

```bash
docker compose --profile tools run --rm tools tools/verify-map.js <ip> 502 126
```

Stampa misure ed energie decodificate nei due ordinamenti di word e indica
quale e' plausibile. Confronta i valori con il display del contatore.

| Sintomo                          | Causa probabile                                    |
| -------------------------------- | -------------------------------------------------- |
| valori tipo `1e-38`, `2.9e+26`   | word invertite → `word_swap = true`                |
| leggi la tensione, arriva corrente | offset sbagliato di uno (1-based vs 0-based)     |
| tutto in timeout                 | unit id sbagliato                                  |
| tutto a zero                     | Modbus disabilitato sul contatore                  |

### Scansione della rete

```bash
docker compose --profile tools run --rm tools \
  tools/scan.js 192.168.10.0/24 --csv db/devices-example.csv
```

Distingue `risponde`, `porta aperta, Modbus muto` (unit id sbagliato o
sessioni occupate) e `niente`, e confronta il risultato con l'anagrafica.

### Simulatore

Cinque PAC3200T finti; il terzo si spegne e riaccende ogni 45 s per
vedere allarmi e transizioni di stato.

```bash
# nel .env: DEVICES_CSV=/app/db/devices-local.csv
docker compose --profile sim up -d --build
```

## Funzionamento

**Stato online.** Non si usa il ping (un PAC3200T risponde a ICMP anche con
lo stack Modbus bloccato): la lettura Modbus e' il controllo di salute.

- 1-2 errori consecutivi → `degraded`
- 3+ errori consecutivi → `offline` (allarme)
- prima lettura riuscita → `online`

I contatori offline passano su backoff (5 s → 60 s) per non occupare gli
slot di quelli sani. Ogni transizione viene registrata in `device_events`.

**Dati salvati** (schema `pac`):

| Tabella                     | Contenuto                                         |
| --------------------------- | ------------------------------------------------- |
| `devices`                   | anagrafica                                        |
| `device_status`             | stato corrente di ogni contatore                  |
| `device_latest`             | ultima lettura completa                           |
| `device_events`             | storico delle transizioni di stato                |
| `energy_counters`           | contatori di energia cumulati                     |
| `energyvalue_<nome>`        | storico misure, una riga per lettura              |
| `totalpower_<nome>`         | storico potenze, una riga ogni 10 min             |

Le tabelle non sono partizionate e non c'e' nessun job di pulizia: per
limitare lo storico usa un `DELETE ... WHERE "timestamp" < now() - interval '2 year'`
per tabella.

Il poller imposta `synchronous_commit = off` sulle proprie sessioni: in caso
di crash del server si perdono gli ultimi ~200 ms di campioni. Se i dati
servono per rendicontazione contrattuale, togli l'impostazione in
[poller/src/db.js](poller/src/db.js).

**Dashboard.** Elenco raggruppato per sito e quadro, con gli offline in
cima e aggiornamenti in tempo reale via SSE. Se l'API non risponde per
20 s l'orologio in alto diventa un avviso rosso. Per i grafici storici
si consiglia Grafana collegato allo stesso Postgres.

## Query utili

```sql
SET search_path TO pac;

-- Contatori che non rispondono
SELECT name, state, last_seen, last_error
  FROM v_dashboard WHERE state <> 'online' ORDER BY last_seen NULLS FIRST;

-- Affidabilita' per contatore negli ultimi 7 giorni
SELECT * FROM device_reliability(7) ORDER BY pct;

-- Dropout degli ultimi 30 giorni
SELECT d.name, e.ts, e.from_state, e.to_state, e.detail
  FROM device_events e JOIN devices d ON d.id = e.device_id
 WHERE e.to_state IN ('offline','degraded') AND e.ts > now() - interval '30 day'
 ORDER BY e.ts DESC;

-- Energia attiva per intervallo (i delta negativi da reset vengono scartati)
SELECT ts, GREATEST(wh_import - LAG(wh_import) OVER w, 0) AS wh
  FROM energy_counters
 WHERE device_id = 1 AND ts > now() - interval '7 day'
WINDOW w AS (ORDER BY ts);
```

## Deploy senza internet sul server

La build scarica `node:20-alpine` e le dipendenze npm. Se il server non
ha accesso a internet, builda altrove e trasferisci le immagini:

```bash
docker compose build
docker save pac3200t-poller pac3200t-api | gzip > pac-images.tar.gz
# sul server
gunzip -c pac-images.tar.gz | docker load
```

Poi nel compose sostituisci `build: ./poller` con `image: pac3200t-poller`
(e lo stesso per l'api). La cartella `db/` va copiata comunque. Controlla i
nomi esatti delle immagini con `docker images`.

## Sviluppo

```
api/          dashboard e API (Node.js)
poller/src/   poller Modbus; mappa registri in registers.js
poller/tools/ verify-map, scan, simulator, check-sql, parse_splx
db/           schema.sql e anagrafiche CSV di esempio
```

Validazione del SQL (schema e query nel codice) con il parser di PostgreSQL:

```bash
pip install pglast
python3 poller/tools/check-sql.py
```

Generazione dell'anagrafica da un progetto SENTRON powerconfig (`.splx`):

```bash
docker run --rm -v "$PWD":/work -w /work python:3-alpine \
  sh -c "apk add --no-cache unzip >/dev/null && mkdir -p /tmp/splx && \
         unzip -q -o progetto.splx -d /tmp/splx && \
         python3 poller/tools/parse_splx.py /tmp/splx"
```
