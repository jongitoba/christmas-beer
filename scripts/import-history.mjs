#!/usr/bin/env node
/**
 * Imports earlier years (2021–2025) from the old Google spreadsheet into D1.
 *
 *   1. In Google Sheets: File → Download → Microsoft Excel (.xlsx). Keep it outside the repo.
 *   2. node scripts/import-history.mjs <file.xlsx> [out.sql]
 *      Prints what it found and every data fix it made, and writes the SQL (default:
 *      .wrangler/import-history.sql, which is gitignored). Nothing is written to any database.
 *   3. Make sure the Worker has migrated the database once (open the site, or start
 *      `npm run dev` and open it), then load the SQL:
 *        local:      npx wrangler d1 execute DB --local --env dev --file .wrangler/import-history.sql
 *        production: npx wrangler d1 execute DB --remote --file .wrangler/import-history.sql
 *
 * The SQL first deletes the imported years and then inserts them again, so running it twice
 * gives the same result. It never touches the current year or later.
 *
 * Scores are imported as given by each person. Overall scores are NOT taken from the sheet:
 * its "Snitt" column divides by the wrong number of people in several years. The app
 * recomputes everything the same way as for new years.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

/** Sheet row labels → criterion keys (the sheet spells Utseende "Utsende"). */
const CRITERION_KEYS = { utsende: 'utseende', utseende: 'utseende', lyd: 'lyd', rase: 'rase', fylde: 'fylde', smak: 'smak', wok: 'wok' };
const CRITERION_LABELS = { utseende: 'Utseende', lyd: 'Lyd', rase: 'Rase', fylde: 'Fylde', smak: 'Smak', wok: 'Wok' };
const CRITERION_ORDER = ['utseende', 'lyd', 'rase', 'fylde', 'smak', 'wok'];

/** The same person written differently in different years. */
export const PERSON_ALIASES = { Volden: 'Voldæn' };

/**
 * Cleaned-up beer names. ABV and brewery are pulled out of the name where the sheet has
 * them; names that refer to the same beer in different years are made identical so the
 * site can follow a beer across years. Anything not listed is kept as written.
 */
export const BEER_NAMES = {
  'Tuborg juleøl (4,5)': { name: 'Tuborg Juleøl', abv: 4.5 },
  'Hansa julebrygg (4.7)': { name: 'Hansa Julebrygg', abv: 4.7 },
  'Møck Juleøl (4,5%)': { name: 'Møck Juleøl', abv: 4.5 },
  'Dahls Juleøl (4,6)': { name: 'Dahls Juleøl', abv: 4.6 },
  'Gjertruds julevarmer': { name: 'Gjertruds Julevarmer' },
  'St bernardus (10%)': { name: 'St. Bernardus', abv: 10 },
  'Ringnes Klassisk Juleøl (4,6)': { name: 'Ringnes Klassisk Juleøl', abv: 4.6 },
  'Austmann Juleøl (4,7)': { name: 'Austmann Juleøl', abv: 4.7 },
  'Møck Lite Juleøl (4,5%)': { name: 'Møck Juleøl Lite', abv: 4.5 },
  'Nordlands Juleøl (4,5%)': { name: 'Nordlands Juleøl', abv: 4.5 },
  'Naught and Nice (8,0)': { name: 'Naught and Nice', abv: 8 },
  // 2023 is written "Brewery/Beer/Style".
  'Fjord Folk/Brown Ale/Juleøl': { name: 'Fjord Folk Brown Ale', brewery: 'Fjord Folk', description: 'Juleøl' },
  'Mack/Vellagret/Juleøl': { name: 'Mack Vellagret', brewery: 'Mack', description: 'Juleøl' },
  'Kansa/Vinterlys': { name: 'Kansa Vinterlys', brewery: 'Kansa' },
  'Ægir/Julepott/xmas red lager': { name: 'Ægir Julepott', brewery: 'Ægir', description: 'Xmas red lager' },
  'Nøgne Ø/Grønn jul/Indian Pale Christmas Ale': { name: 'Nøgne Ø Grønn Jul', brewery: 'Nøgne Ø', description: 'Indian Pale Christmas Ale' },
  'Skudenes/Nordpol/X-mas Ale': { name: 'Skudenes Nordpol', brewery: 'Skudenes', description: 'X-mas Ale' },
  'Frydenlund/Juleøl/Retest': { name: 'Frydenlund Juleøl', brewery: 'Frydenlund', description: 'Retest' },
  'AAS premium Juleøl på glassflaske': { name: 'AAS Premium Juleøl', description: 'På glassflaske' },
  'Lys Juleøl fra 7 fjell': { name: 'Lys Juleøl', brewery: '7 Fjell' },
  'Lysende Jul Austmann Bryggeri': { name: 'Lysende Jul', brewery: 'Austmann Bryggeri' },
  'St arnold juleøl': { name: 'St. Arnold Juleøl' },
  'Galileo Christmas Sasion (Monkey Brew)': { name: 'Galileo Christmas Sasion', brewery: 'Monkey Brew' },
  'Norlands Juleøl': { name: 'Nordlands Juleøl' },
};

// ---------------------------------------------------------------- reading the .xlsx

/** Minimal zip reader (an .xlsx is a zip). Uses the central directory, so data descriptors are fine. */
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not an .xlsx file (no zip directory found)');
  const files = {};
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0, n = buf.readUInt16LE(eocd + 10); i < n; i++) {
    const method = buf.readUInt16LE(off + 10);
    const size = buf.readUInt32LE(off + 20);
    const [nameLen, extraLen, commentLen] = [28, 30, 32].map((o) => buf.readUInt16LE(off + o));
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescapeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&amp;/g, '&');

/** Returns { sheetName: rows[][] } with numbers as numbers and text as strings. */
export function readXlsx(path) {
  const files = unzip(readFileSync(path));
  const shared = [...(files['xl/sharedStrings.xml'] ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unescapeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')),
  );
  const rels = files['xl/_rels/workbook.xml.rels'];
  const target = (id) => {
    const rel = [...rels.matchAll(/<Relationship ([^>]*)\/?>/g)].map((m) => m[1]).find((a) => a.includes(`Id="${id}"`));
    return 'xl/' + rel.match(/Target="([^"]+)"/)[1].replace(/^\/?xl\//, '');
  };
  const column = (ref) => [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const sheets = {};
  for (const [, attrs] of files['xl/workbook.xml'].matchAll(/<sheet ([^>]*)\/>/g)) {
    const name = unescapeXml(attrs.match(/name="([^"]+)"/)[1]);
    const rows = [];
    for (const [, col, row, cellAttrs, inner = ''] of files[target(attrs.match(/r:id="([^"]+)"/)[1])].matchAll(
      /<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value;
      if (/t="s"/.test(cellAttrs) && v !== undefined) value = shared[Number(v)];
      else if (/t="(str|inlineStr|e)"/.test(cellAttrs)) value = unescapeXml(v ?? inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '');
      else if (v !== undefined) value = Number(v);
      if (value === undefined || value === '') continue;
      (rows[Number(row) - 1] ??= [])[column(col)] = value;
    }
    sheets[name] = rows;
  }
  return sheets;
}

// ---------------------------------------------------------------- understanding the sheets

/**
 * Turns one raw cell into a score, or null for "not rated". Records every fix in `fixes`.
 * - Empty, "-" and text → not rated. 0 → not rated (it was used for "left early").
 * - Values like 44382 are dates: Sheets read "5.7" as 5 July. They are turned back into 5.7.
 * - Rounded to 3 decimals and kept within 1–11, like scores entered in the app.
 */
export function cleanScore(raw, where, fixes) {
  if (raw === undefined || raw === null) return null;
  let v = raw;
  if (typeof v === 'string') {
    const t = v.trim().replace(',', '.');
    if (t === '' || t === '-') return null;
    v = Number(t);
    if (!Number.isFinite(v)) {
      fixes.push(`${where}: "${raw}" is not a number, skipped`);
      return null;
    }
  }
  if (v > 40000 && v < 60000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    const fixed = Number(`${d.getUTCDate()}.${d.getUTCMonth() + 1}`);
    fixes.push(`${where}: ${raw} was a date in the sheet, read as ${fixed}`);
    v = fixed;
  }
  if (v === 0) {
    fixes.push(`${where}: 0 treated as not rated`);
    return null;
  }
  let milli = Math.round(v * 1000);
  if (Math.abs(v * 1000 - milli) > 1e-6) fixes.push(`${where}: ${raw} rounded to ${milli / 1000}`);
  if (milli < 1000 || milli > 11000) {
    const clamped = Math.min(11000, Math.max(1000, milli));
    fixes.push(`${where}: ${raw} is outside 1–11, set to ${clamped / 1000}`);
    milli = clamped;
  }
  return milli;
}

const beerInfo = (raw, fixes, year) => {
  const known = BEER_NAMES[raw];
  if (known) return { brewery: '', abv: null, description: '', ...known };
  const abvMatch = raw.match(/\((\d+(?:[.,]\d+)?)\s*%?\)\s*$/);
  if (abvMatch) fixes.push(`${year}: "${raw}" not in BEER_NAMES, took ABV from the name`);
  return {
    name: abvMatch ? raw.slice(0, abvMatch.index).trim() : raw,
    brewery: '',
    abv: abvMatch ? Number(abvMatch[1].replace(',', '.')) : null,
    description: '',
  };
};

/**
 * Reads one year's sheet. Layout: row 1 has "Skalla går fra 1-11", then one column per person,
 * then "Snitt". Each beer is a name row (column B, with an optional description in C) followed
 * by one row per criterion and a "Totalscore" row. Column A may hold comments for the beer,
 * or a beer that only one person rated (a name, then that person's name, then their scores).
 */
export function parseYear(year, rows, fixes) {
  const header = rows[0] ?? [];
  const people = [];
  for (let c = 2; c < header.length; c++) {
    const name = typeof header[c] === 'string' ? header[c].trim() : '';
    if (name === 'Snitt') break;
    if (name) people.push({ column: c, name: PERSON_ALIASES[name] ?? name });
  }
  const knownPeople = new Set(people.map((p) => p.name));
  const beers = [];
  let beer = null;
  let side = null; // a beer written down in column A
  const finish = () => {
    if (side && side.scores.length) beers.push(side);
    side = null;
  };

  rows.forEach((row = [], i) => {
    if (i === 0) return;
    const label = typeof row[1] === 'string' ? row[1].trim() : '';
    const key = CRITERION_KEYS[label.toLowerCase()];
    const colA = row[0];

    if (key) {
      for (const p of people) {
        const milli = cleanScore(row[p.column], `${year} ${beer?.raw} ${p.name} ${key}`, fixes);
        if (milli != null) beer.scores.push({ person: p.name, criterion: key, milli });
      }
      if (side?.person && typeof colA === 'number') {
        const milli = cleanScore(colA, `${year} ${side.raw} ${side.person} ${key}`, fixes);
        if (milli != null) side.scores.push({ person: side.person, criterion: key, milli });
        return;
      }
    } else if (label && label !== 'Totalscore' && !/^Vinner/i.test(label)) {
      finish();
      beer = { raw: label, ...beerInfo(label, fixes, year), scores: [], notes: [] };
      if (typeof row[2] === 'string' && row[2].trim()) beer.description = row[2].replace(/\\t/g, ' ').replace(/\s+/g, ' ').trim();
      beers.push(beer);
    }

    if (typeof colA === 'string' && colA.trim() && i > 1) {
      const text = colA.trim();
      const next = rows[i + 1]?.[0];
      if (side && !side.person && knownPeople.has(PERSON_ALIASES[text] ?? text)) side.person = PERSON_ALIASES[text] ?? text;
      else if (typeof next === 'string' && knownPeople.has(PERSON_ALIASES[next.trim()] ?? next.trim())) {
        finish();
        // Rated by one person only, so it is shown but not ranked against the others.
        side = { raw: text, ...beerInfo(text, fixes, year), scores: [], notes: [], person: null, unranked: true };
      } else if (beer) beer.notes.push(text);
    }
  });
  finish();

  const kept = beers.filter((b) => {
    if (!b.scores.length) fixes.push(`${year} ${b.raw}: no scores, left out`);
    return b.scores.length > 0;
  });
  const names = new Set();
  for (const b of kept) {
    if (names.has(b.name)) throw new Error(`${year}: two beers named "${b.name}"`);
    names.add(b.name);
  }
  const used = new Set(kept.flatMap((b) => b.scores.map((s) => s.criterion)));
  return {
    year,
    criteria: CRITERION_ORDER.filter((k) => used.has(k)).map((key) => ({ key, label: CRITERION_LABELS[key] })),
    people: [...new Set(kept.flatMap((b) => b.scores.map((s) => s.person)))],
    beers: kept.map(({ raw, scores, notes, person, unranked = false, ...b }) => ({ ...b, note: notes.join('\n'), unranked, scores })),
  };
}

/**
 * Some sheets were made by copying the year before, so a beer can carry another beer's
 * tasting note (2022's Naught and Nice has the text of 2021's Dahls). A description that
 * already belongs to a differently named beer is dropped. Short ones such as a style
 * ("Juleøl") are allowed to repeat.
 */
export function dropCopiedDescriptions(years, fixes) {
  const owner = new Map();
  for (const y of years) {
    for (const b of y.beers) {
      if (b.description.length < 20) continue;
      const first = owner.get(b.description);
      if (first && first.name !== b.name) {
        fixes.push(`${y.year} ${b.name}: description "${b.description}" is copied from ${first.year} ${first.name}, dropped`);
        b.description = '';
      } else if (!first) owner.set(b.description, { name: b.name, year: y.year });
    }
  }
  return years;
}

// ---------------------------------------------------------------- SQL

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

export function toSql(years, currentYear) {
  const out = ['-- Generated by scripts/import-history.mjs. Replaces these years completely.', ''];
  for (const y of years) {
    if (y.year >= currentYear) throw new Error(`Refusing to import ${y.year}: only earlier years can be imported`);
    out.push(
      `-- ${y.year}`,
      `DELETE FROM ratings WHERE beer_id IN (SELECT id FROM beers WHERE year = ${y.year});`,
      `DELETE FROM ratings WHERE participant_id IN (SELECT id FROM participants WHERE year = ${y.year});`,
      `DELETE FROM beers WHERE year = ${y.year};`,
      `DELETE FROM participants WHERE year = ${y.year};`,
      `DELETE FROM tastings WHERE year = ${y.year};`,
      `INSERT INTO tastings (year, criteria, revealed_at) VALUES (${y.year}, ${q(JSON.stringify(y.criteria))}, '${y.year}-12-31 00:00:00');`,
    );
    for (const p of y.people) out.push(`INSERT INTO participants (year, name) VALUES (${y.year}, ${q(p)});`);
    for (const b of y.beers) {
      out.push(
        `INSERT INTO beers (year, brought_by, name, brewery, abv, description, note, unranked) VALUES (${y.year}, NULL, ${q(b.name)}, ${q(b.brewery)}, ${q(b.abv)}, ${q(b.description)}, ${q(b.note)}, ${b.unranked ? 1 : 0});`,
      );
      const values = b.scores.map((s) => `(${q(s.person)}, ${q(s.criterion)}, ${s.milli})`).join(',\n  ');
      out.push(
        `WITH v(person, criterion, score) AS (VALUES\n  ${values}\n)
INSERT INTO ratings (participant_id, beer_id, criterion, score_milli)
SELECT p.id, (SELECT id FROM beers WHERE year = ${y.year} AND name = ${q(b.name)}), v.criterion, v.score
FROM v JOIN participants p ON p.year = ${y.year} AND p.name = v.person;`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- CLI

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [input, output = '.wrangler/import-history.sql'] = process.argv.slice(2);
  if (!input) {
    console.error('Usage: node scripts/import-history.mjs <file.xlsx> [out.sql]');
    process.exit(1);
  }
  const fixes = [];
  const sheets = readXlsx(input);
  const years = Object.entries(sheets)
    .filter(([name]) => /^\d{4}$/.test(name.trim()))
    .map(([name, rows]) => parseYear(Number(name), rows, fixes))
    .sort((a, b) => a.year - b.year);
  dropCopiedDescriptions(years, fixes);
  const currentYear = Number(new Intl.DateTimeFormat('en', { timeZone: 'Europe/Oslo', year: 'numeric' }).format(new Date()));
  const sql = toSql(years, currentYear);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, sql);

  for (const y of years) {
    console.log(`${y.year}: ${y.beers.length} beers, ${y.people.length} people (${y.people.join(', ')}), criteria ${y.criteria.map((c) => c.label).join('/')}`);
    for (const b of y.beers) {
      const extras = [b.unranked && 'NOT RANKED', b.brewery && `brewery ${b.brewery}`, b.abv != null && `${b.abv} %`, b.description && 'description', b.note && 'note'].filter(Boolean);
      console.log(`  ${b.name} – ${new Set(b.scores.map((s) => s.person)).size} raters, ${b.scores.length} scores${extras.length ? ` (${extras.join(', ')})` : ''}`);
    }
  }
  console.log(`\nData fixes (${fixes.length}):\n${fixes.map((f) => '  ' + f).join('\n')}`);
  console.log(`\nWrote ${output}`);
}
