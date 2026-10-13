#!/usr/bin/env node
'use strict';

/**
 * Simulatore di PAC3200T su Modbus TCP.
 *
 *   node tools/simulator.js [porta] [numero_device]
 *
 * Serve per collaudare poller e dashboard senza avere i contatori in
 * rete, e per provare cosa succede quando un contatore cade: il
 * simulatore "spegne" un dispositivo ogni tanto, cosi' si vede la
 * macchina a stati passare online -> degraded -> offline e il banner
 * comparire in dashboard.
 *
 * Ogni istanza ascolta su una porta diversa (porta_base + i), cosi' si
 * possono registrare N device in tabella con lo stesso IP e porte
 * consecutive.
 */

const ModbusRTU = require('modbus-serial');
const { MEASUREMENTS } = require('../src/registers');

const basePort = Number(process.argv[2] || 5020);
const count = Number(process.argv[3] || 3);

/** Valori nominali plausibili per una cabina in bassa tensione. */
function nominal() {
  return {
    u_l1_n: 231, u_l2_n: 230, u_l3_n: 229.5,
    u_l1_l2: 400, u_l2_l3: 399, u_l3_l1: 401,
    i_l1: 85, i_l2: 91, i_l3: 78,
    p_l1: 19000, p_l2: 20500, p_l3: 17500,
    q_l1: 5000, q_l2: 5400, q_l3: 4600,
    pf_l1: 0.96, pf_l2: 0.95, pf_l3: 0.94,
    thd_u_l1: 2.1, thd_u_l2: 2.3, thd_u_l3: 2.0,
    thd_i_l1: 6.5, thd_i_l2: 7.1, thd_i_l3: 5.9,
    freq: 50.01,
    u_ln_avg: 230.2, u_ll_avg: 400, i_avg: 84.7,
    s_total: 59000, p_total: 57000, q_total: 15000, pf_total: 0.95,
  };
}

function jitter(v, pct = 0.02) {
  return v * (1 + (Math.random() * 2 - 1) * pct);
}

/** Frequenza e fattore di potenza in rete non oscillano del 2%: se il
 *  simulatore li fa ballare, in collaudo si perde tempo a chiedersi se
 *  il problema e' nel decoding. */
const TIGHT = new Set(['freq', 'pf_l1', 'pf_l2', 'pf_l3', 'pf_total']);

/** Costruisce il blocco misure come lo presenta il dispositivo:
 *  float32 big-endian su 2 registri. */
function buildBlock() {
  const buf = Buffer.alloc(70 * 2);   // 35 float
  const vals = nominal();
  for (const [col, idx] of Object.entries(MEASUREMENTS)) {
    buf.writeFloatBE(jitter(vals[col], TIGHT.has(col) ? 0.001 : 0.02), idx * 4);
  }
  // slot non mappati (potenze apparenti per fase): NaN, come fa il PAC
  // per le grandezze non disponibili
  for (const idx of [9, 10, 11]) buf.writeFloatBE(NaN, idx * 4);
  return buf;
}

function buildEnergy(seed) {
  const buf = Buffer.alloc(16 * 2);
  const base = 1_250_000 + seed * 10_000 + Date.now() / 1000 * 0.02;
  buf.writeDoubleBE(base, 0);
  buf.writeDoubleBE(base * 0.01, 8);
  buf.writeDoubleBE(base * 0.3, 16);
  buf.writeDoubleBE(base * 0.02, 24);
  return buf;
}

for (let i = 0; i < count; i += 1) {
  const port = basePort + i;
  // Un device su tre "cade" periodicamente, per provare il debounce.
  const flaky = i % 3 === 2;
  let down = false;
  if (flaky) {
    setInterval(() => {
      down = !down;
      console.log(`[sim:${port}] ${down ? 'SPENTO' : 'riacceso'}`);
    }, 45000);
  }

  const vector = {
    getMultipleHoldingRegisters(addr, length, unitId, cb) {
      if (down) return;                     // nessuna risposta: timeout
      // Ogni blocco ha il suo buffer che parte dal proprio offset base,
      // quindi il registro r-esimo della richiesta sta a r*2 byte.
      const buf = addr === 800 ? buildEnergy(i) : buildBlock();
      const regs = [];
      for (let r = 0; r < length; r += 1) {
        const off = r * 2;
        regs.push(off + 1 < buf.length ? buf.readUInt16BE(off) : 0);
      }
      cb(null, regs);
    },
  };

  // eslint-disable-next-line no-new
  new ModbusRTU.ServerTCP(vector, { host: '0.0.0.0', port, debug: false });
  console.log(`[sim] PAC simulato su :${port}${flaky ? ' (instabile)' : ''}`);
}

console.log(`\n${count} contatori simulati. Registrali con:\n`);
for (let i = 0; i < count; i += 1) {
  console.log(`INSERT INTO devices (name, site, panel, ip, port) VALUES `
    + `('SIM-${i + 1}', 'collaudo', 'banco', '127.0.0.1', ${basePort + i});`);
}
