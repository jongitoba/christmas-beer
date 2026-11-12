/** Calls the Worker API. A 401 sends you to the front page to enter the code. */
import type { Criterion } from '../lib/score.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(method: string, path: string, body?: unknown, { redirectOn401 = true } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Fikk ikke kontakt. Sjekk nettet og prøv igjen.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && redirectOn401) {
    location.href = '/';
    throw new ApiError(401, 'Ikke logget inn');
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Noe gikk galt');
  return data as T;
}

export interface Me {
  role: 'member' | 'admin';
  year: number;
  participant: { id: number; name: string } | null;
}

export interface TastingBeer {
  id: number;
  name: string;
  brewery: string;
  abv: number | null;
  /** null for beers imported from earlier years, where nobody knows who brought them. */
  broughtBy: { id: number; name: string } | null;
  description: string;
  note: string;
  raterCount: number;
  mine: Record<string, number>;
  /** Your own comment on the beer, '' if none. Everyone's comments show after the reveal. */
  myComment: string;
}

/** Same limit as the Worker. */
export const MAX_COMMENT = 500;

export interface Tasting {
  year: number;
  revealed: boolean;
  criteria: Criterion[];
  me: number | null;
  /** Everyone on this year's name list; `joined` is true once they have picked their name. */
  participants: { id: number; name: string; joined: boolean; completed: number }[];
  beers: TastingBeer[];
}

export interface RankedBeer {
  place: number | null;
  overall: number | null;
  criteria: Record<string, number | null>;
  raterCount: number;
  beer: { id: number; name: string; brewery: string; abv: number | null; broughtBy: string | null; description: string; note: string; unranked: boolean };
  ratings: { participant: string; scores: Record<string, number> }[];
  comments: { participant: string; text: string }[];
}

export interface Results {
  year: number;
  criteria: Criterion[];
  ranking: RankedBeer[];
}

export interface HistoryYear {
  year: number;
  criteria: Criterion[];
  /** Average of every single score given that year. */
  scoreAverage: number | null;
  people: { name: string; scoreCount: number; average: number | null }[];
  beers: Omit<RankedBeer, 'ratings' | 'comments'>[];
}

export interface History {
  years: HistoryYear[];
}

export interface YearSummary {
  year: number;
  revealed: boolean;
  beerCount: number;
}

/** Shows the Admin link in the menu for admins. */
export function showAdminLink(me: Me) {
  document.querySelector<HTMLElement>('[data-admin-link]')!.hidden = me.role !== 'admin';
}

export const beerMeta = (b: { brewery: string; abv: number | null }) =>
  [b.brewery, b.abv != null ? `${b.abv.toLocaleString('nb-NO')} %` : ''].filter(Boolean).join(' · ');
