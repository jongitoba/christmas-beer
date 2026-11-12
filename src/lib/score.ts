/**
 * Criteria, score validation and score aggregation.
 * Shared by the Worker (validation, results) and the pages (input, formatting).
 */

export interface Criterion {
  key: string;
  label: string;
}

/** Criteria for new tastings. Each tasting stores its own copy, so editing this list never changes earlier years. */
export const CRITERIA: readonly Criterion[] = [
  { key: 'utseende', label: 'Utseende' },
  { key: 'lyd', label: 'Lyd' },
  { key: 'rase', label: 'Rase' },
  { key: 'fylde', label: 'Fylde' },
  { key: 'smak', label: 'Smak' },
  { key: 'wok', label: 'Wok' },
];

export const MIN_SCORE = 1;
export const MAX_SCORE = 11;
export const DECIMALS = 3;
const SCALE = 10 ** DECIMALS;

/**
 * Converts a score to integer thousandths (7.345 → 7345), which is how scores are stored.
 * Throws a RangeError (Norwegian message, shown on the page) if the score is out of range or has more than 3 decimals.
 */
export function toMilli(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('Karakteren må være et tall');
  const milli = Math.round(value * SCALE);
  if (Math.abs(value * SCALE - milli) > 1e-6) throw new RangeError(`Maks ${DECIMALS} desimaler`);
  if (milli < MIN_SCORE * SCALE || milli > MAX_SCORE * SCALE) {
    throw new RangeError(`Karakteren må være mellom ${MIN_SCORE} og ${MAX_SCORE}`);
  }
  return milli;
}

export const fromMilli = (milli: number) => milli / SCALE;

/**
 * Parses what someone typed into a score field. Accepts comma or dot as decimal separator.
 * Returns null for an empty field. Throws a RangeError for invalid input.
 */
export function parseScoreInput(text: string): number | null {
  const cleaned = text.trim().replace(/\s/g, '').replace(',', '.');
  if (cleaned === '') return null;
  if (!/^\d{1,2}(\.\d*)?$/.test(cleaned)) throw new RangeError('Skriv et tall, f.eks. 7,345');
  const value = Number(cleaned);
  return fromMilli(toMilli(value));
}

/** Formats a score the Norwegian way with 3 decimals: 7.5 → "7,500". */
export function formatScore(value: number | null | undefined): string {
  if (value == null) return '–';
  return value.toLocaleString('nb-NO', { minimumFractionDigits: DECIMALS, maximumFractionDigits: DECIMALS });
}

/** Rounds to 3 decimals, used for display and for deciding ties. */
export const round3 = (value: number) => Math.round(value * SCALE) / SCALE;

export interface RatingRow {
  beerId: number;
  participantId: number;
  criterion: string;
  milli: number;
}

export interface BeerSummary {
  beerId: number;
  /** Average per criterion over everyone who scored it; null if nobody did. */
  criteria: Record<string, number | null>;
  /** Mean of the criterion averages (criteria nobody scored are left out); null if the beer has no scores. */
  overall: number | null;
  /** Number of people who gave the beer at least one score. */
  raterCount: number;
}

/**
 * Overall score for each beer: first the average per criterion over all scores given,
 * then the mean of those criterion averages. Missing scores are simply left out.
 */
export function summarize(beerIds: readonly number[], ratings: readonly RatingRow[], criteria: readonly Criterion[]): BeerSummary[] {
  return beerIds.map((beerId) => {
    const own = ratings.filter((r) => r.beerId === beerId);
    const perCriterion: Record<string, number | null> = {};
    const averages: number[] = [];
    for (const c of criteria) {
      const scores = own.filter((r) => r.criterion === c.key).map((r) => r.milli);
      const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length / SCALE : null;
      perCriterion[c.key] = avg;
      if (avg != null) averages.push(avg);
    }
    return {
      beerId,
      criteria: perCriterion,
      overall: averages.length ? averages.reduce((a, b) => a + b, 0) / averages.length : null,
      raterCount: new Set(own.map((r) => r.participantId)).size,
    };
  });
}

export type Ranked<T> = T & { place: number | null };

/**
 * Sorts by overall score, highest first. Beers that are equal to 3 decimals share a place (1, 2, 2, 4).
 * Beers without any score come last with place null.
 */
export function rank<T extends { overall: number | null }>(items: readonly T[]): Ranked<T>[] {
  const scored = items.filter((i) => i.overall != null).sort((a, b) => b.overall! - a.overall!);
  const unscored = items.filter((i) => i.overall == null);
  const out: Ranked<T>[] = [];
  scored.forEach((item, i) => {
    const prev = out[i - 1];
    const tied = prev && round3(prev.overall!) === round3(item.overall!);
    out.push({ ...item, place: tied ? prev.place : i + 1 });
  });
  return [...out, ...unscored.map((item) => ({ ...item, place: null }))];
}
