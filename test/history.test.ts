import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { type Env } from '../worker/index.ts';
import { ensureSchema } from '../worker/db.ts';
import { createTestDb } from './helpers/fake-d1.ts';
// @ts-ignore – plain JS module
import { cleanScore, dropCopiedDescriptions, parseYear, toSql } from '../scripts/import-history.mjs';

const SECRET = 'test-session-secret-that-is-long-enough';
const env = (DB = createTestDb()): Env => ({
  ASSETS: { fetch: async () => new Response('') } as unknown as Fetcher,
  DB, GROUP_CODE: 'jul', ADMIN_CODE: 'nisse', SESSION_SECRET: SECRET,
});

async function loggedIn(e: Env) {
  const res = await worker.fetch(new Request('https://x/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":"jul"}' }), e, {} as ExecutionContext);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  return async (path: string) => {
    const r = await worker.fetch(new Request('https://x' + path, { headers: { cookie } }), e, {} as ExecutionContext);
    return { status: r.status, body: (await r.json()) as any };
  };
}

/** Runs a multi-statement SQL script against the fake D1. */
async function runSql(db: D1Database, sql: string) {
  const statements = sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
  for (const s of statements) await db.prepare(s).run();
}

test('cleanScore: dates, zero, dash, rounding and clamping', () => {
  const fixes: string[] = [];
  assert.equal(cleanScore(44382, 'a', fixes), 5700); // "5.7" read as 5 July by Sheets
  assert.equal(cleanScore(44386, 'a', fixes), 9700);
  assert.equal(cleanScore(0, 'a', fixes), null);
  assert.equal(cleanScore('-', 'a', fixes), null);
  assert.equal(cleanScore(' 7,5 ', 'a', fixes), 7500);
  assert.equal(cleanScore(3.14159265, 'a', fixes), 3142);
  assert.equal(cleanScore(0.21, 'a', fixes), 1000);
  assert.equal(cleanScore(undefined, 'a', fixes), null);
  assert.equal(cleanScore(11, 'a', fixes), 11000);
  assert.equal(fixes.length, 5); // dash and comma are not fixes
});

// A small sheet in the old layout.
const sheet = [
  ['Skalla går fra 1-11', undefined, 'John', 'Volden', 'Kari', 'Snitt'],
  [],
  [undefined, 'Tuborg juleøl (4,5)', 'Maltet bygg, lakris og humle'],
  [],
  ['Godt tempo', 'Utsende', 10, 8, 0, 6],
  [undefined, 'Lyd', 8, '-', 7, 5],
  [undefined, 'Totalscore', 9, 8, 7, 99],
  ['Ett øl', 'Ukjent øl', 'Maltet bygg, lakris og humle'],
  ['Kari'],
  [9, 'Utsende', 2, 4, 6],
  [undefined, 'Lyd', 3, 3, 3],
  [undefined, 'Totalscore', 1, 1, 1],
  [undefined, 'Tomt øl'],
  [undefined, 'Utsende'],
  [undefined, 'Vinner 2023 - TUBORG'],
];

test('parseYear reads people, beers, criteria, notes and a beer written in column A', () => {
  const fixes: string[] = [];
  const y = parseYear(2023, sheet, fixes);
  assert.deepEqual(y.people, ['John', 'Voldæn', 'Kari']);
  assert.deepEqual(y.criteria.map((c: any) => c.key), ['utseende', 'lyd']);
  const [tuborg, unknown, side] = y.beers;
  assert.equal(tuborg.name, 'Tuborg Juleøl');
  assert.equal(tuborg.abv, 4.5);
  assert.equal(tuborg.description, 'Maltet bygg, lakris og humle');
  assert.equal(tuborg.note, 'Godt tempo');
  // Kari's 0 and Volden's "-" are not ratings; the Totalscore row is ignored.
  assert.deepEqual(tuborg.scores.map((s: any) => `${s.person}:${s.criterion}:${s.milli}`), [
    'John:utseende:10000', 'Voldæn:utseende:8000', 'John:lyd:8000', 'Kari:lyd:7000',
  ]);
  assert.equal(unknown.name, 'Ukjent øl');
  assert.equal(side.name, 'Ett øl');
  assert.deepEqual(side.scores.map((s: any) => `${s.person}:${s.criterion}:${s.milli}`), ['Kari:utseende:9000']);
  assert.ok(!y.beers.some((b: any) => b.name === 'Tomt øl'), 'beers without scores are left out');
  assert.ok(fixes.some((f) => f.includes('Tomt øl')));

  dropCopiedDescriptions([y], fixes);
  assert.equal(y.beers[1].description, '', 'a description copied from another beer is dropped');
});

test('toSql refuses the current year', () => {
  assert.throws(() => toSql([parseYear(2026, sheet, [])], 2026), /Refusing/);
});

test('imported SQL loads, can be re-run, and shows up as revealed history with recomputed scores', async () => {
  const db = createTestDb();
  await ensureSchema(db);
  const sql = toSql([parseYear(2023, sheet, [])], 2026);
  await runSql(db, sql);
  await runSql(db, sql); // idempotent
  const call = await loggedIn(env(db));

  const results = (await call('/api/results?year=2023')).body;
  assert.equal(results.ranking.length, 3);
  const tuborg = results.ranking.find((r: any) => r.beer.name === 'Tuborg Juleøl');
  // utseende (10+8)/2 = 9, lyd (8+7)/2 = 7.5 → 8.25; the sheet's own "Snitt" (6, 5, 99) is ignored.
  assert.equal(tuborg.overall, 8.25);
  assert.equal(tuborg.beer.broughtBy, null);
  assert.equal(tuborg.beer.note, 'Godt tempo');
  // The beer only Kari rated (9.0) would beat Tuborg, but it is unranked: no place, listed last.
  const side = results.ranking.find((r: any) => r.beer.name === 'Ett øl');
  assert.equal(side.overall, 9);
  assert.equal(side.place, null);
  assert.equal(side.beer.unranked, true);
  assert.equal(results.ranking.at(-1).beer.name, 'Ett øl');
  assert.equal(results.ranking[0].beer.name, 'Tuborg Juleøl');
  assert.equal(results.ranking[0].place, 1);

  const hist = (await call('/api/history')).body;
  assert.deepEqual(hist.years.map((y: any) => y.year), [2023]);
  assert.equal(hist.years[0].beers.length, 3);
  assert.ok(!('ratings' in hist.years[0].beers[0]), 'history has no individual scores');
  const john = hist.years[0].people.find((p: any) => p.name === 'John');
  assert.equal(john.scoreCount, 4);
  assert.equal(john.average, (10 + 8 + 2 + 3) / 4);
});

test('history leaves out years that are not revealed', async () => {
  const e = env();
  const call = await loggedIn(e);
  await call('/api/tasting'); // creates this year's tasting, not revealed
  assert.deepEqual((await call('/api/history')).body.years, []);
});

test('migration: an old database gets the new columns and a nullable brought_by', async () => {
  const db = createTestDb();
  // The schema as the first version created it.
  await db.prepare("CREATE TABLE tastings (year INTEGER PRIMARY KEY, criteria TEXT NOT NULL, revealed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await db.prepare("CREATE TABLE participants (id INTEGER PRIMARY KEY, year INTEGER NOT NULL REFERENCES tastings(year), name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (year, name COLLATE NOCASE))").run();
  await db.prepare("CREATE TABLE beers (id INTEGER PRIMARY KEY, year INTEGER NOT NULL REFERENCES tastings(year), brought_by INTEGER NOT NULL REFERENCES participants(id), name TEXT NOT NULL, brewery TEXT NOT NULL DEFAULT '', abv REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await ensureSchema(db);
  const cols = (await db.prepare('PRAGMA table_info(beers)').all<{ name: string; notnull: number }>()).results;
  assert.ok(cols.some((c) => c.name === 'description') && cols.some((c) => c.name === 'note'));
  assert.equal(cols.find((c) => c.name === 'brought_by')!.notnull, 0);
});

test('migration keeps beers and ratings when the old table has rows', async () => {
  const db = createTestDb();
  await db.prepare("CREATE TABLE tastings (year INTEGER PRIMARY KEY, criteria TEXT NOT NULL, revealed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await db.prepare("CREATE TABLE participants (id INTEGER PRIMARY KEY, year INTEGER NOT NULL REFERENCES tastings(year), name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (year, name COLLATE NOCASE))").run();
  await db.prepare("CREATE TABLE beers (id INTEGER PRIMARY KEY, year INTEGER NOT NULL REFERENCES tastings(year), brought_by INTEGER NOT NULL REFERENCES participants(id), name TEXT NOT NULL, brewery TEXT NOT NULL DEFAULT '', abv REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await db.prepare("INSERT INTO tastings (year, criteria) VALUES (2026, '[]')").run();
  await db.prepare("INSERT INTO participants (year, name) VALUES (2026, 'Kari')").run();
  await db.prepare("INSERT INTO beers (year, brought_by, name) VALUES (2026, 1, 'Nisseøl')").run();
  const orig = console.warn;
  console.warn = () => {};
  try {
    await ensureSchema(db);
  } finally {
    console.warn = orig;
  }
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM beers').first<number>('n'), 1);
  const cols = (await db.prepare('PRAGMA table_info(beers)').all<{ name: string }>()).results;
  assert.ok(cols.some((c) => c.name === 'description'));
});
