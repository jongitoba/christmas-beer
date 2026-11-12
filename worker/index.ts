/**
 * Cloudflare Worker for christmas-beer.jonoba.no.
 *
 * Static pages (Astro build in ./dist) are served directly by Cloudflare and contain no data.
 * Only /api/* reaches this Worker (see run_worker_first in wrangler.jsonc).
 * The results of revealed years are public (PUBLIC_ROUTES, Jon's decision). Every other
 * API route except login needs a valid session cookie (worker/session.ts).
 *
 * Visibility: before a tasting is revealed you only see your own scores and comments (plus how many
 * people have rated each beer). After the admin reveals it, everyone sees all scores.
 * Revealed tastings are locked: no new beers or scores until the admin hides them again.
 *
 * Error messages are Norwegian because the pages show them to visitors.
 */
import {
  clearSessionCookie, newSession, readCookie, safeEqual, sessionCookie, signSession, verifySession,
  SESSION_COOKIE, type Session,
} from './session.ts';
import * as db from './db.ts';
import { DEFAULT_PARTICIPANTS } from './config.ts';
import { rank, summarize, toMilli } from '../src/lib/score.ts';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  // Secrets. Without all three the API answers 500 (fail closed).
  GROUP_CODE?: string;
  ADMIN_CODE?: string;
  SESSION_SECRET?: string;
}

const MAX_BODY = 8 * 1024;
const PRIVATE_HEADERS = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' };

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS, ...headers },
  });

/** The tasting year, by the calendar in Norway. */
export const currentYear = (now = new Date()) =>
  Number(new Intl.DateTimeFormat('en', { timeZone: 'Europe/Oslo', year: 'numeric' }).format(now));

/** This year's tasting, created with the default participants the first time it is needed. */
const thisYearsTasting = (env: Env) => db.ensureTasting(env.DB, currentYear(), DEFAULT_PARTICIPANTS);

const configOk = (env: Env) =>
  Boolean(env.DB && env.GROUP_CODE && env.ADMIN_CODE && env.GROUP_CODE !== env.ADMIN_CODE && env.SESSION_SECRET && env.SESSION_SECRET.length >= 32);

const sameOrigin = (request: Request) => {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
};

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Forventet JSON');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'For stor forespørsel');
  try {
    const body = JSON.parse(text);
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw new HttpError(400, 'Ugyldig JSON');
}

const cleanText = (value: unknown, field: string, max: number, required = true): string => {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (required && !text) throw new HttpError(400, `${field} mangler`);
  if (text.length > max) throw new HttpError(400, `${field} kan være maks ${max} tegn`);
  return text;
};

const MAX_COMMENT = 500;

/** A comment keeps its line breaks (at most one blank line in a row); other whitespace is tidied. */
const cleanComment = (value: unknown): string => {
  if (typeof value !== 'string') throw new HttpError(400, 'Kommentaren må være tekst');
  const text = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > MAX_COMMENT) throw new HttpError(400, `Kommentaren kan være maks ${MAX_COMMENT} tegn`);
  return text;
};

function beerInput(body: Record<string, unknown>): db.BeerInput {
  let abv: number | null = null;
  if (body.abv !== undefined && body.abv !== null && body.abv !== '') {
    abv = Number(body.abv);
    if (!Number.isFinite(abv) || abv < 0 || abv > 30) throw new HttpError(400, 'Alkoholprosent må være mellom 0 og 30');
    abv = Math.round(abv * 10) / 10;
  }
  return { name: cleanText(body.name, 'Navn på ølet', 80), brewery: cleanText(body.brewery, 'Bryggeri', 80, false), abv };
}

const idFrom = (text: string | undefined) => {
  const id = Number(text);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Fant ikke');
  return id;
};

const yearParam = (url: URL) => {
  const raw = url.searchParams.get('year');
  if (raw === null) return currentYear();
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 2000 || year > 3000) throw new HttpError(400, 'Ugyldig år');
  return year;
};

interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  session: Session;
  /** The participant you have picked, if they belong to the current year. */
  me: db.Participant | null;
}

const requireMe = (ctx: Ctx) => {
  if (!ctx.me) throw new HttpError(403, 'Velg hvem du er først');
  return ctx.me;
};

const requireAdmin = (ctx: Ctx) => {
  if (ctx.session.role !== 'admin') throw new HttpError(403, 'Bare for admin');
};

async function requireOpenTasting(env: Env, year: number) {
  const tasting = await db.getTasting(env.DB, year);
  if (!tasting) throw new HttpError(404, 'Fant ikke smakingen');
  if (tasting.revealed) throw new HttpError(409, 'Resultatene er avslørt, så smakingen er låst');
  return tasting;
}

const publicParticipant = (p: db.Participant) => ({ id: p.id, name: p.name });

const meResponse = (session: Session, me: db.Participant | null) =>
  ({ role: session.role, year: currentYear(), participant: me ? publicParticipant(me) : null });

async function tastingView(ctx: Ctx, year: number) {
  const tasting = year === currentYear() ? await thisYearsTasting(ctx.env) : await db.getTasting(ctx.env.DB, year);
  if (!tasting) throw new HttpError(404, 'Fant ingen smaking for ' + year);
  const [participants, beers, ratings, comments] = await Promise.all([
    db.listParticipants(ctx.env.DB, year),
    db.listBeers(ctx.env.DB, year),
    db.listRatings(ctx.env.DB, year),
    db.listComments(ctx.env.DB, year),
  ]);
  const meId = ctx.me?.year === year ? ctx.me.id : null;
  const names = new Map(participants.map((p) => [p.id, p.name]));
  const criteriaCount = tasting.criteria.length;
  const scoresBy = (participantId: number, beerId: number) =>
    ratings.filter((r) => r.participantId === participantId && r.beerId === beerId);

  return {
    year,
    revealed: tasting.revealed,
    criteria: tasting.criteria,
    me: meId,
    // Progress only: how many beers each person has fully scored. No scores.
    participants: participants.map((p) => ({
      ...publicParticipant(p),
      completed: beers.filter((b) => scoresBy(p.id, b.id).length === criteriaCount).length,
    })),
    beers: beers.map((b) => {
      const mine: Record<string, number> = {};
      if (meId) for (const r of scoresBy(meId, b.id)) mine[r.criterion] = r.milli / 1000;
      return {
        id: b.id,
        name: b.name,
        brewery: b.brewery,
        abv: b.abv,
        broughtBy: b.broughtBy == null ? null : { id: b.broughtBy, name: names.get(b.broughtBy) ?? '?' },
        description: b.description,
        note: b.note,
        raterCount: new Set(ratings.filter((r) => r.beerId === b.id).map((r) => r.participantId)).size,
        mine,
        // Only your own comment; other people's stay hidden like their scores.
        myComment: (meId && comments.find((c) => c.participantId === meId && c.beerId === b.id)?.text) || '',
      };
    }),
  };
}

/** Full results for one revealed year: ranking, averages and everyone's scores and comments. */
async function yearResults(env: Env, tasting: db.Tasting) {
  const year = tasting.year;
  const [participants, beers, ratings, comments] = await Promise.all([
    db.listParticipants(env.DB, year),
    db.listBeers(env.DB, year),
    db.listRatings(env.DB, year),
    db.listComments(env.DB, year),
  ]);
  const names = new Map(participants.map((p) => [p.id, p.name]));
  const beerById = new Map(beers.map((b) => [b.id, b]));
  // Beers marked unranked keep their scores but get no place; they come last.
  const unranked = new Set(beers.filter((b) => b.unranked).map((b) => b.id));
  const summaries = summarize(beers.map((b) => b.id), ratings, tasting.criteria);
  const ranked = [
    ...rank(summaries.filter((s) => !unranked.has(s.beerId))),
    ...summaries.filter((s) => unranked.has(s.beerId)).map((s) => ({ ...s, place: null })),
  ];
  return {
    year,
    criteria: tasting.criteria,
    participants: participants.map((p) => p.name),
    ratingRows: ratings.map((r) => ({ ...r, participant: names.get(r.participantId) ?? '?' })),
    ranking: ranked.map((s) => {
      const beer = beerById.get(s.beerId)!;
      const raters = [...new Set(ratings.filter((r) => r.beerId === s.beerId).map((r) => r.participantId))];
      return {
        place: s.place,
        overall: s.overall,
        criteria: s.criteria,
        raterCount: s.raterCount,
        beer: {
          id: beer.id, name: beer.name, brewery: beer.brewery, abv: beer.abv, description: beer.description, note: beer.note, unranked: beer.unranked,
          broughtBy: beer.broughtBy == null ? null : names.get(beer.broughtBy) ?? '?',
        },
        ratings: raters
          .map((pid) => {
            const scores: Record<string, number> = {};
            for (const r of ratings) if (r.beerId === s.beerId && r.participantId === pid) scores[r.criterion] = r.milli / 1000;
            return { participant: names.get(pid) ?? '?', scores };
          })
          .sort((a, b) => a.participant.localeCompare(b.participant, 'nb')),
        comments: comments
          .filter((c) => c.beerId === s.beerId)
          .map((c) => ({ participant: names.get(c.participantId) ?? '?', text: c.text }))
          .sort((a, b) => a.participant.localeCompare(b.participant, 'nb')),
      };
    }),
  };
}

async function results(env: Env, year: number) {
  const tasting = await db.getTasting(env.DB, year);
  if (!tasting) throw new HttpError(404, 'Fant ingen smaking for ' + year);
  if (!tasting.revealed) throw new HttpError(403, 'Resultatene er ikke avslørt ennå');
  const { ratingRows: _, participants: __, ...rest } = await yearResults(env, tasting);
  return rest;
}

/**
 * Every revealed year, for the charts across years. Per beer only the averages (no individual
 * scores); per person how many scores they gave and their average, to compare who rates hard.
 * Years that are not revealed yet are left out entirely.
 */
async function history(env: Env) {
  const years = (await db.listTastings(env.DB)).filter((t) => t.revealed).map((t) => t.year);
  const out = [];
  for (const year of years.sort((a, b) => a - b)) {
    const r = await yearResults(env, (await db.getTasting(env.DB, year))!);
    const scores = r.ratingRows.map((x) => x.milli / 1000);
    const people = r.participants
      .map((name) => {
        const given = r.ratingRows.filter((x) => x.participant === name).map((x) => x.milli / 1000);
        return { name, scoreCount: given.length, average: given.length ? given.reduce((a, b) => a + b, 0) / given.length : null };
      })
      .filter((p) => p.scoreCount > 0);
    out.push({
      year,
      criteria: r.criteria,
      scoreAverage: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      people,
      beers: r.ranking.map(({ ratings: _, comments: __, ...beer }) => beer),
    });
  }
  return { years: out };
}

async function route(ctx: Ctx): Promise<Response> {
  const { request, env, url } = ctx;
  const method = request.method;
  const path = url.pathname;
  // /api/<resource>/<id> for beers and ratings.
  const parts = path.split('/').slice(2);
  const [resource, idText] = parts.length === 2 ? parts : [];

  if (path === '/api/me' && method === 'GET') return json(meResponse(ctx.session, ctx.me));

  if (path === '/api/me' && method === 'POST') {
    const body = await readBody(request);
    const year = currentYear();
    await thisYearsTasting(env);
    let participant: db.Participant | null;
    if (body.participantId !== undefined) {
      participant = await db.getParticipant(env.DB, idFrom(String(body.participantId)));
      if (!participant || participant.year !== year) throw new HttpError(404, 'Fant ikke personen');
    } else {
      participant = await db.findOrCreateParticipant(env.DB, year, cleanText(body.name, 'Navn', 40));
    }
    const session = { ...ctx.session, participantId: participant.id };
    const token = await signSession(session, env.SESSION_SECRET!);
    return json(meResponse(session, participant), 200, { 'set-cookie': sessionCookie(token) });
  }

  if (path === '/api/participants' && method === 'GET') {
    await thisYearsTasting(env);
    return json((await db.listParticipants(env.DB, currentYear())).map(publicParticipant));
  }


  if (path === '/api/tasting' && method === 'GET') return json(await tastingView(ctx, yearParam(url)));


  if (path === '/api/beers' && method === 'POST') {
    const me = requireMe(ctx);
    const input = beerInput(await readBody(request));
    await requireOpenTasting(env, me.year);
    return json(await db.createBeer(env.DB, me.year, me.id, input), 201);
  }

  if (resource === 'beers' && idText && (method === 'PATCH' || method === 'DELETE')) {
    const beer = await db.getBeer(env.DB, idFrom(idText));
    if (!beer) throw new HttpError(404, 'Fant ikke ølet');
    if (ctx.session.role !== 'admin' && beer.broughtBy !== ctx.me?.id) throw new HttpError(403, 'Du kan bare endre ølet du tok med');
    if (method === 'PATCH') {
      const input = beerInput(await readBody(request));
      await requireOpenTasting(env, beer.year);
      await db.updateBeer(env.DB, beer.id, input);
      return json(await db.getBeer(env.DB, beer.id));
    }
    await requireOpenTasting(env, beer.year);
    await db.deleteBeer(env.DB, beer.id);
    return json({ ok: true });
  }

  if (resource === 'ratings' && idText && method === 'PUT') {
    const me = requireMe(ctx);
    const beer = await db.getBeer(env.DB, idFrom(idText));
    if (!beer || beer.year !== me.year) throw new HttpError(404, 'Fant ikke ølet');
    const body = await readBody(request);
    const tasting = await requireOpenTasting(env, beer.year);
    // Scores, a comment, or both. A comment on its own is fine.
    const comment = body.comment === undefined ? undefined : cleanComment(body.comment);
    const input = body.scores ?? (comment !== undefined ? {} : undefined);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Mangler karakterer');
    const keys = new Set(tasting.criteria.map((c) => c.key));
    const scores: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!keys.has(key)) throw new HttpError(400, `Ukjent kriterium: ${key}`);
      try {
        scores[key] = value === null ? null : toMilli(value);
      } catch (e) {
        throw new HttpError(400, `${tasting.criteria.find((c) => c.key === key)!.label}: ${(e as Error).message}`);
      }
    }
    await db.saveRatings(env.DB, me.id, beer.id, scores, comment);
    return json({ ok: true });
  }

  if (path === '/api/admin/reveal' && method === 'POST') {
    requireAdmin(ctx);
    const body = await readBody(request);
    const year = Number(body.year);
    if (!(await db.getTasting(env.DB, year))) throw new HttpError(404, 'Fant ikke smakingen');
    await db.setRevealed(env.DB, year, body.revealed === true);
    return json({ ok: true });
  }

  if (parts.length === 3 && parts[0] === 'admin' && parts[1] === 'participants' && method === 'DELETE') {
    requireAdmin(ctx);
    const id = idFrom(parts[2]);
    if (await db.countBeersBroughtBy(env.DB, id)) throw new HttpError(409, 'Personen har tatt med øl. Slett ølet først.');
    await db.deleteParticipant(env.DB, id);
    return json({ ok: true });
  }

  throw new HttpError(404, 'Fant ikke');
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  if (!configOk(env)) return json({ error: 'Appen er ikke satt opp riktig' }, 500);
  if (request.method !== 'GET' && !sameOrigin(request)) return json({ error: 'Feil opphav' }, 403);
  const url = new URL(request.url);

  try {
    await db.ensureSchema(env.DB);

    if (url.pathname === '/api/login' && request.method === 'POST') {
      const body = await readBody(request);
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      // Check both codes every time, so timing does not reveal which one matched.
      const [isAdmin, isMember] = await Promise.all([safeEqual(code, env.ADMIN_CODE!), safeEqual(code, env.GROUP_CODE!)]);
      if (!isAdmin && !isMember) return json({ error: 'Feil kode' }, 401);
      const token = await signSession(newSession(isAdmin ? 'admin' : 'member'), env.SESSION_SECRET!);
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token) });
    }

    if (url.pathname === '/api/logout' && request.method === 'POST') {
      return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
    }

    // Public, no login: results of revealed years only. Unrevealed years still answer 403.
    if (request.method === 'GET') {
      if (url.pathname === '/api/years') return json(await db.listTastings(env.DB));
      if (url.pathname === '/api/results') return json(await results(env, yearParam(url)));
      if (url.pathname === '/api/history') return json(await history(env));
    }

    const token = readCookie(request, SESSION_COOKIE);
    const session = token ? await verifySession(token, env.SESSION_SECRET!) : null;
    if (!session) return json({ error: 'Ikke logget inn' }, 401);

    let me: db.Participant | null = null;
    if (session.participantId) {
      const p = await db.getParticipant(env.DB, session.participantId);
      if (p && p.year === currentYear()) me = p;
    }
    return await route({ request, env, url, session, me });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Noe gikk galt' }, 500);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
