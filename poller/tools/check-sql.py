#!/usr/bin/env python3
"""
Valida tutto il SQL del progetto col parser vero di PostgreSQL (pglast,
che usa libpg_query, lo stesso lexer/parser del server).

Serve perche' un errore di sintassi in una query che gira una volta sola
all'avvio, o solo quando cade un contatore, si scopre in campo invece che
in laboratorio.

    pip install pglast
    python3 tools/check-sql.py
"""
import re
import sys
from pathlib import Path

try:
    import pglast
except ImportError:
    sys.exit("serve pglast:  pip install pglast")

ROOT = Path(__file__).resolve().parent.parent.parent

# Sostituisce i segnaposto delle template literal JS con identificatori
# validi, cosi' il parser vede SQL sintatticamente completo.
PLACEHOLDER = re.compile(r'\$\{[^}]*\}')

# Query costruite a runtime: la lista di VALUES viene generata in JS.
BUILT = {'VALUES ${': '(1)'}


def extract_sql(js_text):
    """Tira fuori le template literal che contengono SQL."""
    out = []
    for m in re.finditer(r'`([^`]*)`', js_text, re.S):
        body = m.group(1)
        if not re.search(r'\b(SELECT|INSERT|UPDATE|DELETE|CREATE|SET|LISTEN)\b',
                         body, re.I):
            continue
        line = js_text[:m.start()].count('\n') + 1
        out.append((line, body))
    return out


def normalize(sql):
    """Rende parsabile una query con segnaposto JS."""
    # VALUES ${...} -> una tupla finta
    sql = re.sub(r'VALUES\s*\$\{[^}]*\}', 'VALUES (1)', sql, flags=re.I)
    # SET x = EXCLUDED.x costruito in JS
    sql = re.sub(r'DO UPDATE SET \$\{[^}]*\}', 'DO UPDATE SET a = 1', sql, flags=re.I)
    # elenchi di colonne generati in JS
    sql = re.sub(r'\(\$\{[^}]*\}\)', '(a)', sql)
    # resto dei segnaposto -> identificatore
    sql = PLACEHOLDER.sub('x', sql)
    return sql.strip()


def check(label, sql, line=None):
    where = f"{label}:{line}" if line else label
    try:
        pglast.parse_sql(sql)
        return True, where
    except Exception as e:
        return False, f"{where}  →  {e}"


def main():
    ok = bad = 0
    problems = []

    # --- schema.sql, così com'è ---
    schema = ROOT / 'db' / 'schema.sql'
    good, msg = check(str(schema.relative_to(ROOT)), schema.read_text())
    (problems.append(msg) if not good else None)
    ok, bad = (ok + 1, bad) if good else (ok, bad + 1)
    print(f"{'OK  ' if good else 'FAIL'} db/schema.sql")

    # --- query dentro il codice ---
    for js in sorted(list((ROOT / 'poller' / 'src').glob('*.js'))
                     + list((ROOT / 'api' / 'src').glob('*.js'))):
        rel = js.relative_to(ROOT)
        found = extract_sql(js.read_text())
        if not found:
            continue
        n_ok = n_bad = 0
        for line, raw in found:
            good, msg = check(str(rel), normalize(raw), line)
            if good:
                n_ok += 1
            else:
                n_bad += 1
                problems.append(msg)
        ok += n_ok
        bad += n_bad
        print(f"{'OK  ' if n_bad == 0 else 'FAIL'} {rel}: {n_ok} query valide"
              + (f", {n_bad} con errori" if n_bad else ""))

    print(f"\n{ok} valide, {bad} con errori")
    if problems:
        print("\nProblemi:")
        for p in problems:
            print(f"  {p}")
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
