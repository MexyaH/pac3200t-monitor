#!/usr/bin/env node
'use strict';

/**
 * Scansione Modbus di una sottorete.
 *
 *   node tools/scan.js 192.168.10.0/24
 *   node tools/scan.js 192.168.10.11-50 --csv ../db/devices-example.csv
 *
 * Serve il giorno della messa in servizio, per due cose:
 *
 *  1. Il progetto powerconfig e' stato compilato a mano: gli IP sono
 *     quelli che qualcuno intendeva assegnare, non quelli verificati in
 *     campo. Questo dice quali rispondono davvero.
 *  2. Se un contatore ha un unit id diverso da quello atteso, la lettura
 *     va in timeout e sembra un problema di rete. Lo scanner prova anche
 *     gli unit id alternativi e te lo dice.
 *
 * Distingue tre esiti, che vogliono interventi diversi:
 *   - risponde        -> a posto
 *   - porta aperta ma Modbus muto -> unit id sbagliato, o troppe
 *                        sessioni gia' aperte sul dispositivo
 *   - nessuna risposta -> spento, IP diverso, o VLAN che non passa
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const ModbusRTU = require('modbus-serial');

// -------------------------------------------------------------------
// Argomenti
// -------------------------------------------------------------------
const args = process.argv.slice(2);
const target = args[0];
if (!target || target.startsWith('-')) {
  console.error(`uso: node tools/scan.js <rete> [opzioni]

  <rete>              192.168.10.0/24  oppure  192.168.10.11-50
  --port <n>          porta TCP (default 502)
  --unit <n>          unit id atteso (default 126)
  --also-try <a,b>    unit id alternativi da provare (default 1,255)
  --csv <file>        confronta con un'anagrafica CSV (colonne ip,name)
  --concurrency <n>   host in parallelo (default 32)
  --timeout <ms>      per singolo tentativo (default 800)
`);
  process.exit(2);
}

const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const PORT = Number(opt('port', 502));
const UNIT = Number(opt('unit', 126));
const ALSO = String(opt('also-try', '1,255'))
  .split(',').map(Number).filter((n) => Number.isFinite(n) && n !== UNIT);
const CONC = Number(opt('concurrency', 32));
const TIMEOUT = Number(opt('timeout', 800));
const CSV = opt('csv', null);

// -------------------------------------------------------------------
// Espansione della lista di indirizzi
// -------------------------------------------------------------------
function expand(spec) {
  const ips = [];
  const toInt = (s) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0);
  const toStr = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

  if (spec.includes('/')) {
    const [base, bitsRaw] = spec.split('/');
    const bits = Number(bitsRaw);
    if (bits < 16 || bits > 32) throw new Error('prefisso fra /16 e /32');
    const size = 2 ** (32 - bits);
    const start = (toInt(base) & (size === 2 ** 32 ? 0 : ~(size - 1) >>> 0)) >>> 0;
    // Salta network e broadcast per le reti con host multipli.
    const from = size > 2 ? start + 1 : start;
    const to = size > 2 ? start + size - 2 : start + size - 1;
    for (let n = from; n <= to; n += 1) ips.push(toStr(n));
  } else if (/-\d+$/.test(spec)) {
    const [head, lastPart] = spec.split('-');
    const parts = head.split('.');
    const first = Number(parts[3]);
    const last = Number(lastPart);
    for (let n = first; n <= last; n += 1) {
      ips.push(`${parts[0]}.${parts[1]}.${parts[2]}.${n}`);
    }
  } else {
    ips.push(spec);
  }
  return ips;
}

// -------------------------------------------------------------------
// Sonde
// -------------------------------------------------------------------

/** Connessione TCP grezza: veloce, con timeout proprio. Separarla dalla
 *  lettura Modbus permette di distinguere "porta chiusa" da "porta
 *  aperta ma nessuna risposta applicativa", che sono guasti diversi. */
function tcpProbe(ip) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ok, ms: Date.now() - t0, err });
    };
    sock.setTimeout(TIMEOUT);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false, 'timeout'));
    sock.once('error', (e) => finish(false, e.code || e.message));
    sock.connect(PORT, ip);
  });
}

/** Lettura FC3 di 2 registri: il minimo per dire che il dispositivo
 *  parla Modbus su quell'unit id. */
async function modbusProbe(ip, unitId) {
  const client = new ModbusRTU();
  try {
    client.setTimeout(TIMEOUT);
    await client.connectTCP(ip, { port: PORT });
    client.setID(unitId);
    // Registro 1 = indirizzo 1, come in registers.js: con 0 la lettura
    // cade a meta' di un float e il PAC risponde con l'eccezione 2.
    const res = await client.readHoldingRegisters(1, 2);
    return { ok: true, buffer: res.buffer };
  } catch (err) {
    return { ok: false, err: err.code || err.message };
  } finally {
    // destroy, non close: il callback di close non arriva se la socket
    // l'ha gia' chiusa il dispositivo, e la scansione resterebbe appesa.
    try { client.destroy(() => {}); } catch { /* gia' chiusa */ }
  }
}

async function probeHost(ip) {
  const tcp = await tcpProbe(ip);
  if (!tcp.ok) return { ip, esito: 'niente', dettaglio: tcp.err };

  const m = await modbusProbe(ip, UNIT);
  if (m.ok) {
    const u = m.buffer.length >= 4 ? m.buffer.readFloatBE(0) : null;
    return {
      ip, esito: 'risponde', unit: UNIT, ms: tcp.ms,
      dettaglio: Number.isFinite(u) ? `U L1-N ~ ${u.toFixed(1)} V` : 'primo float non valido',
    };
  }

  for (const alt of ALSO) {
    const a = await modbusProbe(ip, alt);
    if (a.ok) {
      return {
        ip, esito: 'unit id diverso', unit: alt, ms: tcp.ms,
        dettaglio: `risponde su unit ${alt}, non su ${UNIT}`,
      };
    }
  }
  return { ip, esito: 'porta aperta, Modbus muto', ms: tcp.ms, dettaglio: m.err };
}

// -------------------------------------------------------------------
// Anagrafica attesa
// -------------------------------------------------------------------
function loadCsv(file) {
  const full = path.resolve(file);
  const lines = fs.readFileSync(full, 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split(',').map((s) => s.trim());
  const iIp = head.indexOf('ip');
  const iName = head.indexOf('name');
  if (iIp < 0) throw new Error(`nel CSV manca la colonna "ip"`);
  const map = new Map();
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    map.set(c[iIp].trim(), iName >= 0 ? c[iName].trim() : '');
  }
  return map;
}

// -------------------------------------------------------------------
async function main() {
  const ips = expand(target);
  const expected = CSV ? loadCsv(CSV) : null;

  console.log(`Scansione di ${ips.length} indirizzi su porta ${PORT}, `
    + `unit id ${UNIT} (alternativi: ${ALSO.join(', ') || 'nessuno'})`);
  if (expected) console.log(`Anagrafica attesa: ${expected.size} dispositivi\n`);
  else console.log('');

  const results = [];
  let done = 0;
  const queue = ips.slice();

  async function worker() {
    for (;;) {
      const ip = queue.shift();
      if (!ip) return;
      const r = await probeHost(ip);
      results.push(r);
      done += 1;
      if (done % 16 === 0 || done === ips.length) {
        process.stderr.write(`\r  ${done}/${ips.length}`);
      }
    }
  }
  await Promise.all([...Array(Math.min(CONC, ips.length))].map(worker));
  process.stderr.write('\r' + ' '.repeat(30) + '\r');

  results.sort((a, b) =>
    a.ip.split('.').map(Number)[3] - b.ip.split('.').map(Number)[3]);

  const live = results.filter((r) => r.esito !== 'niente');
  const pad = (s, n) => String(s).padEnd(n);

  console.log('DISPOSITIVI CHE RISPONDONO IN RETE\n');
  console.log(`${pad('IP', 17)}${pad('nome', 10)}${pad('esito', 26)}dettaglio`);
  console.log('-'.repeat(88));
  for (const r of live) {
    const name = expected ? (expected.get(r.ip) ?? '—') : '';
    console.log(`${pad(r.ip, 17)}${pad(name, 10)}${pad(r.esito, 26)}${r.dettaglio}`);
  }

  const byEsito = {};
  for (const r of results) byEsito[r.esito] = (byEsito[r.esito] || 0) + 1;
  console.log('\nRIEPILOGO');
  for (const [k, v] of Object.entries(byEsito)) console.log(`  ${pad(k, 28)}${v}`);

  if (expected) {
    const ok = new Set(live.filter((r) => r.esito === 'risponde').map((r) => r.ip));
    const missing = [...expected.keys()].filter((ip) => !ok.has(ip));
    const extra = live.filter((r) => !expected.has(r.ip));

    console.log('\nCONFRONTO CON L\'ANAGRAFICA');
    if (missing.length) {
      console.log(`\n  In anagrafica ma non rispondono (${missing.length}):`);
      for (const ip of missing) {
        const r = results.find((x) => x.ip === ip);
        console.log(`    ${pad(expected.get(ip), 10)}${pad(ip, 17)}`
          + `${r ? r.esito : 'fuori dal range scansionato'}`);
      }
    } else {
      console.log('\n  Tutti i dispositivi in anagrafica rispondono.');
    }
    if (extra.length) {
      console.log(`\n  Rispondono ma non sono in anagrafica (${extra.length}):`);
      for (const r of extra) console.log(`    ${pad(r.ip, 17)}${r.esito}`);
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error(`errore: ${err.message}`);
  process.exit(1);
});
