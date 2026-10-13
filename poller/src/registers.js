'use strict';

/**
 * ============================================================
 *  Mappa verificata contro il manuale ufficiale
 * ============================================================
 *
 * Fonte: PAC3200T Manuale del prodotto, 09/2022, L1V30838945A-03
 * (Siemens), Appendice A.1.3 "Grandezze di misura Modbus con i codici
 * di funzioni 0x03 e 0x04" (blocco misure) e la tabella dei registri
 * energia a partire da 801.
 *
 * Punto cruciale, confermato dal manuale E su un esemplare reale: gli
 * "Offset" della tabella Siemens vanno usati COSI' COME SONO come
 * indirizzo Modbus (funzione 0x03/0x04), SENZA sottrarre 1. Non e' la
 * convenzione Modicon classica (40001 -> indirizzo 0): su questo
 * apparecchio l'indirizzo 0 non esiste, il primo registro valido e'
 * l'indirizzo 1. Un tentativo di lettura sull'indirizzo 0 restituisce
 * "Illegal Data Address" — e' il sintomo che ha portato a scoprire
 * l'errore (ogni lettura falliva, anche la piu' piccola sul registro 1,
 * perche' si chiedeva l'indirizzo 0 anziche' 1).
 *
 * Il blocco misure (registri 1-70) e' stato confrontato campo per campo
 * con la tabella del manuale: 34 grandezze, corrispondenza esatta.
 *
 * Resta da verificare solo l'ordine delle word all'interno di ogni
 * float/double (big-endian normale oppure invertito): il manuale non lo
 * specifica, va confermato con verify-map.js contro un contatore acceso
 * confrontando col display.
 */

/** Blocchi di lettura. Il PAC accetta fino a 125 registri per FC3,
 *  quindi ogni blocco = un round trip. */
const BLOCKS = {
  // Registri 1..70: nessuna conversione, l'indirizzo Modbus e' 1, non 0.
  measurements: { offset: 1, quantity: 70 },
  // Registri 801..832: energia attiva/reattiva import/export, Tariffa 1
  // e Tariffa 2 intercalate (vedi ENERGY sotto). Si legge tutto il
  // blocco anche usando solo la Tariffa 1: un'unica richiesta e' piu'
  // semplice che leggere a pezzi, e il costo e' irrilevante dato che
  // l'energia si legge ogni pochi minuti.
  energy: { offset: 801, quantity: 32 },
};

/**
 * Misure istantanee: nome colonna DB -> indice del float nel blocco.
 * indice = (registro_1based - 1) / 2
 */
const MEASUREMENTS = {
  u_l1_n:   0,   // reg 1
  u_l2_n:   1,   // reg 3
  u_l3_n:   2,   // reg 5
  u_l1_l2:  3,   // reg 7
  u_l2_l3:  4,   // reg 9
  u_l3_l1:  5,   // reg 11
  i_l1:     6,   // reg 13
  i_l2:     7,   // reg 15
  i_l3:     8,   // reg 17
  // 9..11  = potenza apparente per fase (non memorizzata)
  p_l1:    12,   // reg 25
  p_l2:    13,   // reg 27
  p_l3:    14,   // reg 29
  q_l1:    15,   // reg 31
  q_l2:    16,   // reg 33
  q_l3:    17,   // reg 35
  pf_l1:   18,   // reg 37
  pf_l2:   19,   // reg 39
  pf_l3:   20,   // reg 41
  thd_u_l1: 21,  // reg 43
  thd_u_l2: 22,  // reg 45
  thd_u_l3: 23,  // reg 47
  thd_i_l1: 24,  // reg 49
  thd_i_l2: 25,  // reg 51
  thd_i_l3: 26,  // reg 53
  freq:    27,   // reg 55
  u_ln_avg: 28,  // reg 57
  u_ll_avg: 29,  // reg 59
  i_avg:   30,   // reg 61
  s_total: 31,   // reg 63
  p_total: 32,   // reg 65
  q_total: 33,   // reg 67
  pf_total: 34,  // reg 69
};

/** Ordine delle colonne per INSERT/UPSERT. Deve combaciare con lo schema. */
const MEASUREMENT_COLUMNS = Object.keys(MEASUREMENTS);

/**
 * Contatori di energia: double IEEE754 su 4 registri (confermato dal
 * manuale, colonna "Formato" = Double, "Numero di registri" = 4).
 *
 * Il manuale intercala Tariffa 1 e Tariffa 2 per ogni grandezza, non le
 * mette in sequenza (import, export, ...) come avevo assunto in origine:
 *   801 import attiva T1   805 import attiva T2
 *   809 export attiva T1   813 export attiva T2
 *   817 import reattiva T1 821 import reattiva T2
 *   825 export reattiva T1 829 export reattiva T2
 *
 * Qui si usa solo la Tariffa 1, che e' quella che accumula quando
 * l'impianto non ha una tariffazione multi-fascia configurata (il caso
 * di questo progetto). "index" e' in unita' di 4 registri dall'inizio
 * del blocco (BLOCKS.energy.offset = 801), quindi index 2 = registro
 * 801 + 2*4 = 809, e cosi' via.
 */
const ENERGY = {
  wh_import:   { index: 0, type: 'double' }, // reg 801, Energia attiva importata T1
  wh_export:   { index: 2, type: 'double' }, // reg 809, Energia attiva esportata T1
  varh_import: { index: 4, type: 'double' }, // reg 817, Energia reattiva importata T1
  varh_export: { index: 6, type: 'double' }, // reg 825, Energia reattiva esportata T1
};

const ENERGY_COLUMNS = Object.keys(ENERGY);

// --------------------------------------------------------------------
// Decoding
// --------------------------------------------------------------------

/**
 * Restituisce il buffer con le word invertite a coppie (ABCD -> BADC),
 * applicata a gruppi di 4 byte lungo tutto il buffer.
 *
 * Per i float32 (4 byte) questo e' l'unico swap possibile. Per i double
 * a 8 byte usati nei contatori di energia, questa funzione inverte le
 * word DENTRO ciascuna meta' da 4 byte separatamente, non l'intero
 * valore a 8 byte: se il dispositivo usasse un ordine di word diverso
 * per i valori a 64 bit (es. inversione completa delle 4 word), questa
 * funzione da sola non basterebbe. Da verificare con verify-map.js: se
 * i valori di energia risultano assurdi anche con word_swap attivo,
 * serve una variante di swap dedicata ai double.
 */
function swapWords(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i + 3 < buf.length; i += 4) {
    out[i]     = buf[i + 2];
    out[i + 1] = buf[i + 3];
    out[i + 2] = buf[i];
    out[i + 3] = buf[i + 1];
  }
  return out;
}

/**
 * Legge un float32 big-endian dal buffer.
 * Un valore non disponibile sul PAC torna NaN, non zero: lo mappiamo a
 * null cosi' finisce NULL in DB e non rovina le medie.
 */
function readFloat(buf, index) {
  const off = index * 4;
  if (off + 4 > buf.length) return null;
  const v = buf.readFloatBE(off);
  return Number.isFinite(v) ? v : null;
}

/** Decodifica il blocco misure in un oggetto {colonna: valore|null}. */
function decodeMeasurements(buffer, wordSwap = false) {
  const buf = wordSwap ? swapWords(buffer) : buffer;
  const out = {};
  for (const [col, index] of Object.entries(MEASUREMENTS)) {
    out[col] = readFloat(buf, index);
  }
  return out;
}

/** Decodifica i contatori di energia: double IEEE754 su 8 byte (4
 *  registri), confermato dal manuale per tutti i campi di ENERGY. */
function decodeEnergy(buffer, wordSwap = false) {
  const buf = wordSwap ? swapWords(buffer) : buffer;
  const out = {};
  for (const [col, def] of Object.entries(ENERGY)) {
    const off = def.index * 8;
    if (off + 8 > buf.length) { out[col] = null; continue; }
    const v = buf.readDoubleBE(off);
    out[col] = Number.isFinite(v) ? v : null;
  }
  return out;
}

/**
 * Controllo di plausibilita' su una lettura. Non serve a validare i dati
 * ma a intercettare una mappa registri sbagliata: se la "frequenza" e'
 * 1e-38 o la tensione e' 400000, gli indirizzi o il word order sono
 * errati e conviene accorgersene in fase di collaudo, non fra sei mesi.
 */
function sanityCheck(m, { ctPrimary = null, nominalVoltage = 400 } = {}) {
  const problems = [];
  if (m.freq != null && (m.freq < 40 || m.freq > 70)) {
    problems.push(`frequenza fuori range: ${m.freq}`);
  }
  // Il PAC applica internamente il rapporto del TV: qui attendiamo la
  // tensione di primario. Con TV assente (il caso di questo impianto)
  // nominalVoltage e' la concatenata, quindi la stellata e' /sqrt(3).
  const uLn = nominalVoltage / Math.sqrt(3);
  if (m.u_l1_n != null && m.u_l1_n !== 0
      && (m.u_l1_n < uLn * 0.5 || m.u_l1_n > uLn * 1.5)) {
    problems.push(`U L1-N ${m.u_l1_n.toFixed(1)} V, attesa intorno a ${uLn.toFixed(0)} V`);
  }
  if (m.pf_total != null && Math.abs(m.pf_total) > 1.01) {
    problems.push(`fattore di potenza fuori range: ${m.pf_total}`);
  }
  // Anche il rapporto del TA e' applicato dal dispositivo: le correnti
  // arrivano gia' in primario. Oltre il doppio del primario del TA non
  // e' sovraccarico, e' una lettura sbagliata.
  if (ctPrimary && m.i_l1 != null && Math.abs(m.i_l1) > ctPrimary * 2) {
    problems.push(`I L1 ${m.i_l1.toFixed(1)} A con TA ${ctPrimary} A`);
  }
  return problems;
}

module.exports = {
  BLOCKS,
  MEASUREMENTS,
  MEASUREMENT_COLUMNS,
  ENERGY,
  ENERGY_COLUMNS,
  decodeMeasurements,
  decodeEnergy,
  swapWords,
  sanityCheck,
};
