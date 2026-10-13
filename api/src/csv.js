'use strict';

/**
 * Parser CSV minimo, con gestione dei campi fra virgolette. Stesso
 * comportamento di poller/src/bootstrap.js, piu' due cose che servono
 * quando il file arriva da Excel e non da un editor di testo:
 *  - separatore ';' riconosciuto da solo (Excel in italiano salva cosi');
 *  - BOM iniziale ignorato.
 *
 * Restituisce { header, records }, con records = [{ line, values }] e
 * line = numero di riga nel file (1 = intestazione), per gli errori.
 */
function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  const firstLine = text.split('\n', 1)[0];
  const sep = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';

  const rows = [];      // [line, fields]
  let row = [], field = '', quoted = false, line = 1, rowLine = 1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else {
        if (c === '\n') line += 1;
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === sep) {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push([rowLine, row]);
      row = [];
      line += 1;
      rowLine = line;
    } else if (c !== '\r') {
      field += c;
    }
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push([rowLine, row]);

  if (!rows.length) return { header: [], records: [] };
  const header = rows[0][1].map((h) => h.trim().toLowerCase());
  const records = rows.slice(1).map(([ln, r]) => {
    const values = {};
    header.forEach((h, i) => { values[h] = (r[i] ?? '').trim(); });
    return { line: ln, values };
  });
  return { header, records };
}

module.exports = { parseCsv };
