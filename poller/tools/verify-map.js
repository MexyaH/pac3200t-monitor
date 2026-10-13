#!/usr/bin/env node
'use strict';

/**
 * Verifica della mappa registri contro un PAC3200T reale.
 *
 *   node tools/verify-map.js 192.168.1.50 [porta] [unit_id]
 *
 * Stampa il blocco misure e i contatori di energia decodificati in
 * entrambi gli ordinamenti di word, cosi' si vede subito quale e' quello
 * giusto (indirizzi e formati sono gia' verificati contro il manuale
 * Siemens, vedi l'intestazione di registers.js — qui resta da confermare
 * solo l'ordine delle word).
 *
 * Confronta i valori col display del contatore: e' il solo modo di
 * essere sicuri. Da fare PRIMA della messa in servizio.
 */

const { PacClient } = require('../src/modbus-client');
const {
  BLOCKS, MEASUREMENTS, decodeMeasurements, swapWords, sanityCheck,
} = require('../src/registers');

const [ip, portArg, unitArg] = process.argv.slice(2);
if (!ip) {
  console.error('uso: node tools/verify-map.js <ip> [porta] [unit_id]');
  process.exit(2);
}
const port = Number(portArg || 502);
const unitId = Number(unitArg || 126);   // il PAC3200T risponde su 126, non 1

const pad = (s, n) => String(s).padEnd(n);
const fmt = (v) => (v == null ? 'NaN/null' : v.toPrecision(7));

async function main() {
  const client = new PacClient({ ip, port, unitId, timeoutMs: 3000 });
  console.log(`\nConnessione a ${ip}:${port} unit ${unitId}\n`);
  await client.connect();

  // --- blocco misure -------------------------------------------------
  const buf = await client.readBlock(
    BLOCKS.measurements.offset, BLOCKS.measurements.quantity);

  const normal = decodeMeasurements(buf, false);
  const swapped = decodeMeasurements(buf, true);

  console.log('MISURE ISTANTANEE');
  console.log(`${pad('colonna', 12)} ${pad('reg', 5)} ${pad('normale', 16)} word-swap`);
  console.log('-'.repeat(60));
  for (const [col, idx] of Object.entries(MEASUREMENTS)) {
    const reg = idx * 2 + 1;
    console.log(`${pad(col, 12)} ${pad(reg, 5)} ${pad(fmt(normal[col]), 16)} ${fmt(swapped[col])}`);
  }

  console.log('\nPlausibilita\':');
  const pn = sanityCheck(normal);
  const ps = sanityCheck(swapped);
  console.log(`  normale   : ${pn.length ? pn.join('; ') : 'ok'}`);
  console.log(`  word-swap : ${ps.length ? ps.join('; ') : 'ok'}`);
  if (!pn.length && ps.length) {
    console.log('\n  => usa word_swap = false');
  } else if (pn.length && !ps.length) {
    console.log('\n  => usa word_swap = true');
  } else {
    console.log('\n  => ambiguo: confronta a mano col display del contatore.');
    console.log('     Se nessuna delle due colonne e\' sensata, controlla che');
    console.log('     l\'esemplare sia lo stesso modello/firmware documentato');
    console.log('     nel manuale usato per costruire questa mappa (vedi');
    console.log('     l\'intestazione di registers.js).');
  }

  // --- contatori di energia ------------------------------------------
  // Etichette dal manuale: Tariffa 1 e Tariffa 2 intercalate ogni 4
  // registri. Il poller usa solo la Tariffa 1 (vedi ENERGY in
  // registers.js); qui si stampano comunque tutti gli 8 slot per
  // controllo, segnalando quali sono effettivamente in uso.
  const ENERGY_LABELS = [
    'Energia attiva importata T1  (usata)',
    'Energia attiva importata T2',
    'Energia attiva esportata T1  (usata)',
    'Energia attiva esportata T2',
    'Energia reattiva importata T1 (usata)',
    'Energia reattiva importata T2',
    'Energia reattiva esportata T1 (usata)',
    'Energia reattiva esportata T2',
  ];
  console.log(`\nCONTATORI DI ENERGIA (registri ${BLOCKS.energy.offset}-`
    + `${BLOCKS.energy.offset + BLOCKS.energy.quantity - 1}, formato double confermato dal manuale)`);
  try {
    const ebuf = await client.readBlock(BLOCKS.energy.offset, BLOCKS.energy.quantity);
    const swappedE = swapWords(ebuf);
    console.log(`${pad('reg', 5)} ${pad('grandezza', 40)} ${pad('normale', 16)} word-swap`);
    console.log('-'.repeat(85));
    for (let i = 0; i < ENERGY_LABELS.length; i += 1) {
      const off = i * 8;
      if (off + 8 > ebuf.length) break;
      const reg = BLOCKS.energy.offset + i * 4;
      const dNorm = ebuf.readDoubleBE(off);
      const dSwap = swappedE.readDoubleBE(off);
      console.log(`${pad(reg, 5)} ${pad(ENERGY_LABELS[i], 40)} `
        + `${pad(Number.isFinite(dNorm) ? dNorm.toPrecision(10) : 'NaN', 16)} `
        + `${Number.isFinite(dSwap) ? dSwap.toPrecision(10) : 'NaN'}`);
    }
    console.log('\n  Confronta i valori "T1 (usata)" con il totale energia mostrato');
    console.log('  dal display. Se sono plausibili nella colonna "normale", va bene');
    console.log('  cosi\'; se lo sono solo in "word-swap", imposta word_swap=true');
    console.log('  per questo device in tabella (si applica anche alle misure).');
  } catch (err) {
    console.log(`  lettura fallita: ${err.message}`);
  }

  // --- dump grezzo ---------------------------------------------------
  console.log('\nDUMP GREZZO primi 24 registri (per confronto manuale)');
  for (let i = 0; i < Math.min(24, buf.length / 2); i += 1) {
    const w = buf.readUInt16BE(i * 2);
    process.stdout.write(`${pad(`r${i + 1}=0x${w.toString(16).padStart(4, '0')}`, 14)}`);
    if ((i + 1) % 6 === 0) process.stdout.write('\n');
  }
  console.log('\n');

  await client.close();
}

main().catch((err) => {
  console.error(`\nerrore: ${err.message}`);
  process.exit(1);
});
