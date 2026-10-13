#!/usr/bin/env node
'use strict';

/**
 * Sonda un dispositivo Modbus leggendo piccole finestre di registri,
 * invece del blocco intero da 70 registri che usa verify-map.js.
 *
 * Serve quando un dispositivo risponde "Illegal data address" sul
 * blocco pieno: dice se il problema e' la dimensione della richiesta o
 * se davvero quegli indirizzi non esistono su questo esemplare.
 *
 *   node tools/probe.js <ip> [porta] [unit_id]
 */
const ModbusRTU = require('modbus-serial');

const [ip, portArg, unitArg] = process.argv.slice(2);
if (!ip) {
  console.error('uso: node tools/probe.js <ip> [porta] [unit_id]');
  process.exit(2);
}
const port = Number(portArg || 502);
const unitId = Number(unitArg || 126);

// Indirizzi uguali al numero di registro del manuale Siemens, come in
// registers.js (verificato su un contatore reale). Con offset-1 le letture
// cadono a meta' di un float e il PAC risponde con l'eccezione 2.
const WINDOWS = [
  [1, 2,  'primi 2 registri (1 float: U L1-N)'],
  [1, 10, 'primi 10 registri (5 float)'],
  [1, 70, 'blocco misure intero (quello che usa verify-map.js)'],
  [41, 2, "registri 41-42 (meta' blocco)"],
  [69, 2, 'ultimi 2 del blocco misure (69-70)'],
  [801, 2, 'inizio blocco energia (801-802)'],
  [801, 16, 'blocco energia intero (801-816)'],
];

// FC3 (Holding Registers) e' quello che usa il resto del progetto.
// FC4 (Input Registers) e' un codice funzione diverso: alcuni modelli
// della famiglia SENTRON PAC espongono le misure li' invece che in FC3.
// Se FC3 fallisce ovunque, uniformemente, e' il primo sospetto.
const FUNCTIONS = [
  ['FC3 Holding', (c, o, q) => c.readHoldingRegisters(o, q)],
  ['FC4 Input  ', (c, o, q) => c.readInputRegisters(o, q)],
];

async function main() {
  const client = new ModbusRTU();
  client.setTimeout(1500);
  console.log(`Connessione a ${ip}:${port} unit ${unitId}\n`);
  await client.connectTCP(ip, { port });
  client.setID(unitId);

  const pad = (s, n) => String(s).padEnd(n);
  const results = {};
  for (const [fcLabel, read] of FUNCTIONS) {
    results[fcLabel] = 0;
    for (const [offset, qty, label] of WINDOWS) {
      try {
        const res = await read(client, offset, qty);
        const first = res.data.slice(0, 4).join(',');
        console.log(`OK   ${fcLabel}  reg ${pad(offset, 4)}-${pad(offset + qty - 1, 4)}  `
          + `${pad(label, 38)} valori grezzi: [${first}...]`);
        results[fcLabel] += 1;
      } catch (err) {
        console.log(`FAIL ${fcLabel}  reg ${pad(offset, 4)}-${pad(offset + qty - 1, 4)}  `
          + `${pad(label, 38)} ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 150));  // non incalzare il dispositivo
    }
    console.log('');
  }

  client.destroy(() => {});   // close() puo' non richiamare mai, vedi modbus-client.js

  console.log('--- riepilogo ---');
  for (const [fcLabel] of FUNCTIONS) {
    console.log(`${fcLabel}: ${results[fcLabel]}/${WINDOWS.length} letture riuscite`);
  }
  console.log('');
  console.log('Se FC4 funziona dove FC3 fallisce ovunque: le misure su questo');
  console.log('  esemplare sono Input Registers, non Holding Registers. Va');
  console.log('  cambiato readHoldingRegisters -> readInputRegisters nel poller.');
  console.log('Se falliscono ENTRAMBE le function code su OGNI indirizzo:');
  console.log('  il dispositivo probabilmente non e\' ancora commissionato (nessun');
  console.log('  tipo di collegamento/misura configurato), oppure non e\' davvero');
  console.log('  un PAC3200T. Controlla l\'etichetta fisica e la configurazione');
  console.log('  di base (tipo di rete, tensione nominale) da PowerConfig o dal');
  console.log('  display del contatore prima di insistere sul Modbus.');
  console.log('Se solo i blocchi grandi falliscono ma quelli piccoli passano su');
  console.log('  una delle due: il dispositivo limita la quantita\' per richiesta.');
}

main().catch((err) => {
  console.error(`errore di connessione: ${err.message}`);
  process.exit(1);
});
