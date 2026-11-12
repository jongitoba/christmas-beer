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
  broughtBy: { id: number; name: string };
  raterCount: number;
  mine: Record<string, number>;
}

export interface Tasting {
  year: number;
  revealed: boolean;
  criteria: Criterion[];
  me: number | null;
  participants: { id: number; name: string; completed: number }[];
  beers: TastingBeer[];
}

export interface RankedBeer {
  place: number | null;
  overall: number | null;
  criteria: Record<string, number | null>;
  raterCount: number;
  beer: { id: number; name: string; brewery: string; abv: number | null; broughtBy: string };
  ratings: { participant: string; scores: Record<string, number> }[];
}

export interface Results {
  year: number;
  criteria: Criterion[];
  ranking: RankedBeer[];
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
