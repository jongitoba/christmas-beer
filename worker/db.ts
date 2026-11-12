/**
 * D1 schema and queries. The Worker creates the tables itself on first use
 * (CREATE TABLE IF NOT EXISTS), so a fresh database works without a migration step.
 * Scores are stored as integer thousandths (7.345 → 7345) to avoid float rounding.
 */
import { CRITERIA, type Criterion, type RatingRow } from '../src/lib/score.ts';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tastings (
    year INTEGER PRIMARY KEY,
    criteria TEXT NOT NULL,
    revealed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY,
    year INTEGER NOT NULL REFERENCES tastings(year),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (year, name COLLATE NOCASE)
  )`,
  `CREATE TABLE IF NOT EXISTS beers (
    id INTEGER PRIMARY KEY,
    year INTEGER NOT NULL REFERENCES tastings(year),
    brought_by INTEGER NOT NULL REFERENCES participants(id),
    name TEXT NOT NULL,
    brewery TEXT NOT NULL DEFAULT '',
    abv REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS ratings (
    participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    beer_id INTEGER NOT NULL REFERENCES beers(id) ON DELETE CASCADE,
    criterion TEXT NOT NULL,
    score_milli INTEGER NOT NULL CHECK (score_milli BETWEEN 1000 AND 11000),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (participant_id, beer_id, criterion)
  )`,
  `CREATE INDEX IF NOT EXISTS ratings_beer ON ratings(beer_id)`,
];

const ready = new WeakSet<D1Database>();

export async function ensureSchema(db: D1Database): Promise<void> {
  if (ready.has(db)) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  ready.add(db);
}

export interface Tasting {
  year: number;
  criteria: Criterion[];
  revealed: boolean;
}

export interface Participant {
  id: number;
  year: number;
  name: string;
}

export interface Beer {
  id: number;
  year: number;
  broughtBy: number;
  name: string;
  brewery: string;
  abv: number | null;
}

interface TastingRow { year: number; criteria: string; revealed_at: string | null }
interface BeerRow { id: number; year: number; brought_by: number; name: string; brewery: string; abv: number | null }

const toTasting = (r: TastingRow): Tasting => ({ year: r.year, criteria: JSON.parse(r.criteria), revealed: r.revealed_at != null });
const toBeer = (r: BeerRow): Beer => ({ id: r.id, year: r.year, broughtBy: r.brought_by, name: r.name, brewery: r.brewery, abv: r.abv });

export async function getTasting(db: D1Database, year: number): Promise<Tasting | null> {
  const row = await db.prepare('SELECT year, criteria, revealed_at FROM tastings WHERE year = ?').bind(year).first<TastingRow>();
  return row ? toTasting(row) : null;
}

/**
 * Returns the tasting for a year. If it does not exist yet, creates it with the current
 * criteria and the given starting participants. The participants are added only on
 * creation, so people the admin deletes later do not come back.
 */
export async function ensureTasting(db: D1Database, year: number, participants: readonly string[] = []): Promise<Tasting> {
  const existing = await getTasting(db, year);
  if (existing) return existing;
  const created = await db.prepare('INSERT OR IGNORE INTO tastings (year, criteria) VALUES (?, ?)').bind(year, JSON.stringify(CRITERIA)).run();
  // Only the request that actually created the row adds the participants.
  if (created.meta.changes === 1 && participants.length) {
    await db.batch(participants.map((name) => db.prepare('INSERT OR IGNORE INTO participants (year, name) VALUES (?, ?)').bind(year, name)));
  }
  return (await getTasting(db, year))!;
}

export async function listTastings(db: D1Database): Promise<{ year: number; revealed: boolean; beerCount: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT t.year, t.revealed_at, (SELECT COUNT(*) FROM beers b WHERE b.year = t.year) AS beer_count
       FROM tastings t ORDER BY t.year DESC`,
    )
    .all<{ year: number; revealed_at: string | null; beer_count: number }>();
  return results.map((r) => ({ year: r.year, revealed: r.revealed_at != null, beerCount: r.beer_count }));
}

export async function setRevealed(db: D1Database, year: number, revealed: boolean): Promise<void> {
  await db
    .prepare("UPDATE tastings SET revealed_at = CASE WHEN ? THEN COALESCE(revealed_at, datetime('now')) ELSE NULL END WHERE year = ?")
    .bind(revealed ? 1 : 0, year)
    .run();
}

export async function listParticipants(db: D1Database, year: number): Promise<Participant[]> {
  const { results } = await db
    .prepare('SELECT id, year, name FROM participants WHERE year = ? ORDER BY name COLLATE NOCASE')
    .bind(year)
    .all<Participant>();
  return results;
}

export async function getParticipant(db: D1Database, id: number): Promise<Participant | null> {
  return db.prepare('SELECT id, year, name FROM participants WHERE id = ?').bind(id).first<Participant>();
}

/** Finds a participant by name (case-insensitive) or creates one. */
export async function findOrCreateParticipant(db: D1Database, year: number, name: string): Promise<Participant> {
  await db.prepare('INSERT OR IGNORE INTO participants (year, name) VALUES (?, ?)').bind(year, name).run();
  return (await db
    .prepare('SELECT id, year, name FROM participants WHERE year = ? AND name = ? COLLATE NOCASE')
    .bind(year, name)
    .first<Participant>())!;
}

export async function deleteParticipant(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM participants WHERE id = ?').bind(id).run();
}

export async function countBeersBroughtBy(db: D1Database, participantId: number): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM beers WHERE brought_by = ?').bind(participantId).first<number>('n')) ?? 0;
}

export async function listBeers(db: D1Database, year: number): Promise<Beer[]> {
  const { results } = await db
    .prepare('SELECT id, year, brought_by, name, brewery, abv FROM beers WHERE year = ? ORDER BY id')
    .bind(year)
    .all<BeerRow>();
  return results.map(toBeer);
}

export async function getBeer(db: D1Database, id: number): Promise<Beer | null> {
  const row = await db.prepare('SELECT id, year, brought_by, name, brewery, abv FROM beers WHERE id = ?').bind(id).first<BeerRow>();
  return row ? toBeer(row) : null;
}

export interface BeerInput {
  name: string;
  brewery: string;
  abv: number | null;
}

export async function createBeer(db: D1Database, year: number, broughtBy: number, input: BeerInput): Promise<Beer> {
  const row = await db
    .prepare('INSERT INTO beers (year, brought_by, name, brewery, abv) VALUES (?, ?, ?, ?, ?) RETURNING id, year, brought_by, name, brewery, abv')
    .bind(year, broughtBy, input.name, input.brewery, input.abv)
    .first<BeerRow>();
  return toBeer(row!);
}

export async function updateBeer(db: D1Database, id: number, input: BeerInput): Promise<void> {
  await db.prepare('UPDATE beers SET name = ?, brewery = ?, abv = ? WHERE id = ?').bind(input.name, input.brewery, input.abv, id).run();
}

export async function deleteBeer(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM beers WHERE id = ?').bind(id).run();
}

export async function listRatings(db: D1Database, year: number): Promise<RatingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT r.beer_id AS beerId, r.participant_id AS participantId, r.criterion, r.score_milli AS milli
       FROM ratings r JOIN beers b ON b.id = r.beer_id WHERE b.year = ?`,
    )
    .bind(year)
    .all<RatingRow>();
  return results;
}

/** Sets or clears (null) one participant's scores for one beer, all in one transaction. */
export async function saveRatings(db: D1Database, participantId: number, beerId: number, scores: Record<string, number | null>): Promise<void> {
  const statements = Object.entries(scores).map(([criterion, milli]) =>
    milli == null
      ? db.prepare('DELETE FROM ratings WHERE participant_id = ? AND beer_id = ? AND criterion = ?').bind(participantId, beerId, criterion)
      : db
          .prepare(
            `INSERT INTO ratings (participant_id, beer_id, criterion, score_milli) VALUES (?, ?, ?, ?)
             ON CONFLICT (participant_id, beer_id, criterion) DO UPDATE SET score_milli = excluded.score_milli, updated_at = datetime('now')`,
          )
          .bind(participantId, beerId, criterion, milli),
  );
  if (statements.length) await db.batch(statements);
}
