import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { currentYear, type Env } from '../worker/index.ts';
import { DEFAULT_PARTICIPANTS } from '../worker/config.ts';
import { newSession, signSession, SESSION_COOKIE } from '../worker/session.ts';
import { createTestDb } from './helpers/fake-d1.ts';

const BASE = 'https://christmas-beer.jonoba.no';
const SECRET = 'test-session-secret-that-is-long-enough';
const YEAR = currentYear();

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  ASSETS: { fetch: async () => new Response('static page') } as unknown as Fetcher,
  DB: createTestDb(),
  GROUP_CODE: 'jul',
  ADMIN_CODE: 'nisse',
  SESSION_SECRET: SECRET,
  ...overrides,
});

type Json = any;

/** A browser-like client: keeps its session cookie between calls. */
function client(env: Env) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await worker.fetch(
      new Request(BASE + path, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
      env,
      {} as ExecutionContext,
    );
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0]!;
    return { status: res.status, body: (await res.json()) as Json, setCookie };
  };
  return {
    call,
    setCookie: (value: string) => (cookie = `${SESSION_COOKIE}=${value}`),
    async join(code: string, name: string) {
      assert.equal((await call('POST', '/api/login', { code })).status, 200);
      const me = await call('POST', '/api/me', { name });
      assert.equal(me.status, 200);
      return me.body.participant.id as number;
    },
  };
}

const scores = (u: number, l: number, r: number, f: number, s: number, w: number) => ({ utseende: u, lyd: l, rase: r, fylde: f, smak: s, wok: w });

test('missing or weak config fails closed (500)', async () => {
  for (const o of [
    { GROUP_CODE: undefined }, { GROUP_CODE: '' }, { ADMIN_CODE: undefined }, { ADMIN_CODE: '' }, { ADMIN_CODE: 'jul' },
    { SESSION_SECRET: undefined }, { SESSION_SECRET: 'short' }, { DB: undefined as unknown as D1Database },
  ]) {
    const res = await client(makeEnv(o)).call('POST', '/api/login', { code: 'jul' });
    assert.equal(res.status, 500, JSON.stringify(o));
  }
});

test('there are no built-in codes: the old placeholders do not log anyone in', async () => {
  for (const code of ['password', 'password-admin']) {
    assert.equal((await client(makeEnv()).call('POST', '/api/login', { code })).status, 401, code);
  }
});

test('non-API paths are served as static assets', async () => {
  const res = await worker.fetch(new Request(BASE + '/smaking/'), makeEnv(), {} as ExecutionContext);
  assert.equal(await res.text(), 'static page');
});

test('everything except login and public results needs a session', async () => {
  const c = client(makeEnv());
  for (const path of ['/api/me', '/api/tasting', '/api/tasting?year=2000', '/api/participants']) {
    assert.equal((await c.call('GET', path)).status, 401, path);
  }
  assert.equal((await c.call('POST', '/api/beers', { name: 'X' })).status, 401);
  assert.equal((await c.call('PUT', '/api/ratings/1', { scores: {} })).status, 401);
  c.setCookie('forged.cookie');
  assert.equal((await c.call('GET', '/api/me')).status, 401);
});

test('results are public, but only for revealed years', async () => {
  const env = makeEnv();
  const kari = client(env);
  const jon = client(env);
  await kari.join('jul', 'Kari');
  await jon.join('nisse', 'Jon');
  const beer = (await kari.call('POST', '/api/beers', { name: 'Nisseøl' })).body;
  await kari.call('PUT', `/api/ratings/${beer.id}`, { scores: { smak: 9 } });
  const anon = client(env);

  // Not revealed: nobody sees results, logged in or not.
  assert.equal((await anon.call('GET', '/api/results')).status, 403);
  assert.deepEqual((await anon.call('GET', '/api/history')).body, { years: [] });
  const years = await anon.call('GET', '/api/years');
  assert.equal(years.status, 200);
  assert.deepEqual(years.body.map((y: Json) => [y.year, y.revealed]), [[YEAR, false]]);

  await jon.call('POST', '/api/admin/reveal', { year: YEAR, revealed: true });
  const res = await anon.call('GET', '/api/results');
  assert.equal(res.status, 200);
  assert.equal(res.body.ranking[0].beer.name, 'Nisseøl');
  assert.equal((await anon.call('GET', '/api/history')).body.years[0].year, YEAR);

  // Everything else still needs login, and writes are still refused.
  assert.equal((await anon.call('GET', '/api/tasting')).status, 401);
  assert.equal((await anon.call('PUT', `/api/ratings/${beer.id}`, { scores: { smak: 1 } })).status, 401);
  assert.equal((await anon.call('POST', '/api/results', {})).status, 401);
});

test('wrong code is rejected; the session cookie is HttpOnly, Secure and SameSite', async () => {
  const c = client(makeEnv());
  const bad = await c.call('POST', '/api/login', { code: 'feil' });
  assert.equal(bad.status, 401);
  assert.equal(bad.setCookie, null);
  const ok = await c.call('POST', '/api/login', { code: ' jul ' });
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie!, /^__Host-juleol=.+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  assert.deepEqual((await c.call('GET', '/api/me')).body, { role: 'member', year: YEAR, participant: null });
});

test('cross-origin writes are refused', async () => {
  const c = client(makeEnv());
  const res = await c.call('POST', '/api/login', { code: 'jul' }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('picking a name: new names are created, existing names are reused (case-insensitive)', async () => {
  const env = makeEnv();
  const a = client(env);
  const id = await a.join('jul', '  Kari ');
  const b = client(env);
  assert.equal(await b.join('jul', 'kari'), id);
  const list = await b.call('GET', '/api/participants');
  assert.deepEqual(list.body.filter((p: Json) => p.name === 'Kari'), [{ id, name: 'Kari' }]);
  assert.equal(list.body.length, DEFAULT_PARTICIPANTS.length + 1);
  // Picking by id works too.
  const c = client(env);
  await c.call('POST', '/api/login', { code: 'jul' });
  assert.equal((await c.call('POST', '/api/me', { participantId: id })).body.participant.name, 'Kari');
  assert.equal((await c.call('POST', '/api/me', { participantId: 999 })).status, 404);
  assert.equal((await c.call('POST', '/api/me', { name: '   ' })).status, 400);
});

test('a new year starts with the default people to choose from', async () => {
  const env = makeEnv();
  const c = client(env);
  await c.call('POST', '/api/login', { code: 'jul' });
  const list = (await c.call('GET', '/api/participants')).body as { id: number; name: string }[];
  assert.deepEqual(new Set(list.map((p) => p.name)), new Set(DEFAULT_PARTICIPANTS));
  // Picking a listed name reuses that person instead of creating a duplicate.
  const scott = list.find((p) => p.name === 'Scott')!;
  assert.equal(await c.join('jul', 'scott'), scott.id);
  assert.equal((await c.call('GET', '/api/participants')).body.length, DEFAULT_PARTICIPANTS.length);
});

test('a deleted default person does not come back', async () => {
  const env = makeEnv();
  const jon = client(env);
  await jon.join('nisse', 'Jon');
  const elise = (await jon.call('GET', '/api/participants')).body.find((p: Json) => p.name === 'Elise');
  assert.equal((await jon.call('DELETE', `/api/admin/participants/${elise.id}`)).status, 200);
  const names = (await jon.call('GET', '/api/participants')).body.map((p: Json) => p.name);
  assert.ok(!names.includes('Elise'));
  assert.equal((await jon.call('GET', '/api/tasting')).body.participants.length, DEFAULT_PARTICIPANTS.length);
});

test('you need to pick a name before adding beers or scores', async () => {
  const c = client(makeEnv());
  await c.call('POST', '/api/login', { code: 'jul' });
  assert.equal((await c.call('POST', '/api/beers', { name: 'Juleøl' })).status, 403);
});

test('a participant from an earlier year is not "you" this year', async () => {
  const env = makeEnv();
  const c = client(env);
  await c.call('POST', '/api/login', { code: 'jul' }); // creates schema
  await env.DB.prepare("INSERT INTO tastings (year, criteria) VALUES (2000, '[]')").run();
  const old = await env.DB.prepare("INSERT INTO participants (year, name) VALUES (2000, 'Gammel') RETURNING id").first<number>('id');
  c.setCookie(await signSession(newSession('member', old), SECRET));
  assert.equal((await c.call('GET', '/api/me')).body.participant, null);
});

test('full tasting: own scores only before reveal, full results after, locked once revealed', async () => {
  const env = makeEnv();
  const kari = client(env);
  const ola = client(env);
  const jon = client(env);
  const kariId = await kari.join('jul', 'Kari');
  await ola.join('jul', 'Ola');
  await jon.join('nisse', 'Jon');
  assert.equal((await jon.call('GET', '/api/me')).body.role, 'admin');

  const beerA = (await kari.call('POST', '/api/beers', { name: 'Nisseøl', brewery: 'Aass', abv: '6.5' })).body;
  assert.equal(beerA.broughtBy, kariId);
  const beerB = (await ola.call('POST', '/api/beers', { name: 'Juleøl', brewery: '' })).body;

  // Kari rates her own beer (allowed) and Ola's. Ola rates Kari's beer partially.
  assert.equal((await kari.call('PUT', `/api/ratings/${beerA.id}`, { scores: scores(10, 9, 8, 7, 6, 5) })).status, 200);
  assert.equal((await kari.call('PUT', `/api/ratings/${beerB.id}`, { scores: scores(2, 2, 2, 2, 2, 2) })).status, 200);
  assert.equal((await ola.call('PUT', `/api/ratings/${beerA.id}`, { scores: { utseende: 7.345, smak: 11 } })).status, 200);

  // Before reveal: you see only your own scores, plus counts.
  const olaView = (await ola.call('GET', '/api/tasting')).body;
  assert.equal(olaView.revealed, false);
  const a = olaView.beers.find((b: Json) => b.id === beerA.id);
  assert.deepEqual(a.mine, { utseende: 7.345, smak: 11 });
  assert.equal(a.raterCount, 2);
  assert.equal(a.broughtBy.name, 'Kari');
  assert.equal(olaView.beers.find((b: Json) => b.id === beerB.id).raterCount, 1);
  assert.deepEqual(olaView.beers.find((b: Json) => b.id === beerB.id).mine, {});
  assert.equal(olaView.participants.find((p: Json) => p.name === 'Kari').completed, 2);
  assert.equal(olaView.participants.find((p: Json) => p.name === 'Ola').completed, 0);
  // No one else's scores anywhere in the response: beers only carry "mine", nothing like ratings or averages.
  for (const b of olaView.beers) assert.deepEqual(Object.keys(b).sort(), ['abv', 'brewery', 'broughtBy', 'description', 'id', 'mine', 'myComment', 'name', 'note', 'raterCount']);
  assert.ok(!JSON.stringify(olaView).includes('ratings') && !JSON.stringify(olaView).includes('overall'), 'no foreign scores leak');
  assert.equal((await ola.call('GET', '/api/results')).status, 403);

  // Only the admin can reveal.
  assert.equal((await kari.call('POST', '/api/admin/reveal', { year: YEAR, revealed: true })).status, 403);
  assert.equal((await jon.call('POST', '/api/admin/reveal', { year: YEAR, revealed: true })).status, 200);

  const res = (await ola.call('GET', '/api/results')).body;
  const [first, second] = res.ranking;
  assert.equal(first.beer.name, 'Nisseøl');
  assert.equal(first.place, 1);
  // utseende (10+7.345)/2, smak (6+11)/2, the others only Kari's.
  assert.deepEqual(first.criteria, { utseende: 8.6725, lyd: 9, rase: 8, fylde: 7, smak: 8.5, wok: 5 });
  assert.ok(Math.abs(first.overall - (8.6725 + 9 + 8 + 7 + 8.5 + 5) / 6) < 1e-9);
  assert.equal(first.raterCount, 2);
  assert.deepEqual(first.ratings.map((r: Json) => r.participant), ['Kari', 'Ola']);
  assert.equal(second.beer.name, 'Juleøl');
  assert.equal(second.overall, 2);
  assert.equal((await ola.call('GET', '/api/years')).body[0].revealed, true);

  // Locked after reveal.
  assert.equal((await ola.call('PUT', `/api/ratings/${beerB.id}`, { scores: { lyd: 5 } })).status, 409);
  assert.equal((await ola.call('POST', '/api/beers', { name: 'Sent øl' })).status, 409);
  // Hiding again unlocks.
  await jon.call('POST', '/api/admin/reveal', { year: YEAR, revealed: false });
  assert.equal((await ola.call('PUT', `/api/ratings/${beerB.id}`, { scores: { lyd: 5 } })).status, 200);
  assert.equal((await ola.call('GET', '/api/results')).status, 403);
});

test('score validation', async () => {
  const env = makeEnv();
  const c = client(env);
  await c.join('jul', 'Kari');
  const beer = (await c.call('POST', '/api/beers', { name: 'Nisseøl' })).body;
  for (const bad of [{ smak: 11.001 }, { smak: 0.5 }, { smak: 7.3456 }, { smak: '7' }, { ukjent: 5 }]) {
    assert.equal((await c.call('PUT', `/api/ratings/${beer.id}`, { scores: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await c.call('PUT', `/api/ratings/${beer.id}`, { scores: [] })).status, 400);
  assert.equal((await c.call('PUT', `/api/ratings/999`, { scores: { smak: 5 } })).status, 404);
  // null clears a score.
  await c.call('PUT', `/api/ratings/${beer.id}`, { scores: { smak: 5, lyd: 6 } });
  await c.call('PUT', `/api/ratings/${beer.id}`, { scores: { smak: null } });
  const view = (await c.call('GET', '/api/tasting')).body;
  assert.deepEqual(view.beers[0].mine, { lyd: 6 });
});

test('comments: own only before reveal, everyone after, saved with or without scores', async () => {
  const env = makeEnv();
  const kari = client(env);
  const ola = client(env);
  const jon = client(env);
  await kari.join('jul', 'Kari');
  await ola.join('jul', 'Ola');
  await jon.join('nisse', 'Jon');
  const beer = (await kari.call('POST', '/api/beers', { name: 'Nisseøl' })).body;
  const other = (await kari.call('POST', '/api/beers', { name: 'Juleøl' })).body;

  // With scores; whitespace is tidied but line breaks are kept (at most one blank line).
  assert.equal((await kari.call('PUT', `/api/ratings/${beer.id}`, { scores: { smak: 9 }, comment: '  God   og  søt\r\n\r\n\r\nMye kanel  ' })).status, 200);
  // A comment on its own is fine too.
  assert.equal((await ola.call('PUT', `/api/ratings/${beer.id}`, { comment: 'For bitter' })).status, 200);

  const kariView = (await kari.call('GET', '/api/tasting')).body;
  assert.equal(kariView.beers.find((b: Json) => b.id === beer.id).myComment, 'God og søt\n\nMye kanel');
  assert.equal(kariView.beers.find((b: Json) => b.id === other.id).myComment, '');
  const olaView = (await ola.call('GET', '/api/tasting')).body;
  assert.equal(olaView.beers.find((b: Json) => b.id === beer.id).myComment, 'For bitter');
  assert.ok(!JSON.stringify(olaView).includes('kanel'), "Kari's comment does not leak before the reveal");
  // A comment alone does not count as a score.
  assert.equal(olaView.beers.find((b: Json) => b.id === beer.id).raterCount, 1);

  // Leaving out the comment keeps it; an empty comment removes it.
  await ola.call('PUT', `/api/ratings/${beer.id}`, { scores: { smak: 4 } });
  assert.equal((await ola.call('GET', '/api/tasting')).body.beers.find((b: Json) => b.id === beer.id).myComment, 'For bitter');
  await ola.call('PUT', `/api/ratings/${beer.id}`, { comment: 'Feil øl' });
  await kari.call('PUT', `/api/ratings/${other.id}`, { comment: 'Midt på treet' });
  await kari.call('PUT', `/api/ratings/${other.id}`, { comment: '   ' });

  // Validation.
  assert.equal((await kari.call('PUT', `/api/ratings/${beer.id}`, { comment: 'x'.repeat(501) })).status, 400);
  assert.equal((await kari.call('PUT', `/api/ratings/${beer.id}`, { comment: 42 })).status, 400);
  assert.equal((await kari.call('PUT', `/api/ratings/${beer.id}`, {})).status, 400);

  await jon.call('POST', '/api/admin/reveal', { year: YEAR, revealed: true });
  const res = (await ola.call('GET', '/api/results')).body;
  const byName = (name: string) => res.ranking.find((r: Json) => r.beer.name === name);
  assert.deepEqual(byName('Nisseøl').comments, [
    { participant: 'Kari', text: 'God og søt\n\nMye kanel' },
    { participant: 'Ola', text: 'Feil øl' },
  ]);
  assert.deepEqual(byName('Juleøl').comments, []);
  // Locked after reveal, like the scores.
  assert.equal((await ola.call('PUT', `/api/ratings/${beer.id}`, { comment: 'Endret' })).status, 409);
  // The history endpoint carries no comments.
  assert.ok(!JSON.stringify((await ola.call('GET', '/api/history')).body).includes('kanel'));

  // Deleting a beer removes its comments.
  await jon.call('POST', '/api/admin/reveal', { year: YEAR, revealed: false });
  assert.equal((await kari.call('DELETE', `/api/beers/${beer.id}`)).status, 200);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM comments').first<number>('n')), 0);
});

test('beer validation', async () => {
  const c = client(makeEnv());
  await c.join('jul', 'Kari');
  assert.equal((await c.call('POST', '/api/beers', { name: '' })).status, 400);
  assert.equal((await c.call('POST', '/api/beers', { name: 'x'.repeat(81) })).status, 400);
  assert.equal((await c.call('POST', '/api/beers', { name: 'Øl', abv: 99 })).status, 400);
  assert.equal((await c.call('POST', '/api/beers', { name: 'Øl', abv: 'abc' })).status, 400);
  assert.equal((await c.call('POST', '/api/beers', { name: 'Øl', abv: 4.56 })).body.abv, 4.6);
  assert.equal((await c.call('POST', '/api/beers', { name: 'Øl', description: 'x'.repeat(301) })).status, 400);
});

test('only the owner or admin can edit or delete a beer', async () => {
  const env = makeEnv();
  const kari = client(env);
  const ola = client(env);
  const jon = client(env);
  await kari.join('jul', 'Kari');
  await ola.join('jul', 'Ola');
  await jon.join('nisse', 'Jon');
  const beer = (await kari.call('POST', '/api/beers', { name: 'Nisseøl' })).body;
  await ola.call('PUT', `/api/ratings/${beer.id}`, { scores: { smak: 9 } });

  assert.equal((await ola.call('PATCH', `/api/beers/${beer.id}`, { name: 'Hacket' })).status, 403);
  assert.equal((await ola.call('DELETE', `/api/beers/${beer.id}`)).status, 403);
  assert.equal((await kari.call('PATCH', `/api/beers/${beer.id}`, { name: 'Nisseøl 2', brewery: 'Aass' })).body.name, 'Nisseøl 2');
  assert.equal((await jon.call('PATCH', `/api/beers/${beer.id}`, { name: 'Nisseøl 3' })).status, 200);

  // A participant with a beer cannot be deleted; delete the beer (and its scores) first.
  const kariId = (await kari.call('GET', '/api/me')).body.participant.id;
  assert.equal((await ola.call('DELETE', `/api/admin/participants/${kariId}`)).status, 403);
  assert.equal((await jon.call('DELETE', `/api/admin/participants/${kariId}`)).status, 409);
  assert.equal((await jon.call('DELETE', `/api/beers/${beer.id}`)).status, 200);
  assert.equal((await jon.call('DELETE', `/api/admin/participants/${kariId}`)).status, 200);
  const view = (await jon.call('GET', '/api/tasting')).body;
  assert.deepEqual(view.beers, []);
  const names = view.participants.map((p: Json) => p.name);
  assert.ok(!names.includes('Kari'));
  assert.ok(names.includes('Jon') && names.includes('Ola'));
});

test('unknown routes and methods give 404', async () => {
  const c = client(makeEnv());
  await c.join('jul', 'Kari');
  for (const [m, p] of [['GET', '/api/nope'], ['DELETE', '/api/me'], ['GET', '/api/beers/1/x'], ['PUT', '/api/ratings/abc']]) {
    assert.equal((await c.call(m!, p!, m === 'PUT' ? { scores: {} } : undefined)).status, 404, `${m} ${p}`);
  }
});

test('a beer can have a short description that the owner can change', async () => {
  const env = makeEnv();
  const kari = client(env);
  const ola = client(env);
  await kari.join('jul', 'Kari');
  await ola.join('jul', 'Ola');
  const created = await kari.call('POST', '/api/beers', { name: 'Nisseøl', description: '  Mørk og\n krydret  ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.description, 'Mørk og krydret');
  assert.equal((await kari.call('POST', '/api/beers', { name: 'Uten' })).body.description, '');

  // Everyone sees it before the reveal.
  const seen = (await ola.call('GET', '/api/tasting')).body.beers.find((b: Json) => b.id === created.body.id);
  assert.equal(seen.description, 'Mørk og krydret');

  // A PATCH without a description keeps it; an empty one clears it.
  const id = created.body.id;
  assert.equal((await kari.call('PATCH', `/api/beers/${id}`, { name: 'Nisseøl' })).body.description, 'Mørk og krydret');
  assert.equal((await kari.call('PATCH', `/api/beers/${id}`, { name: 'Nisseøl', description: 'Lys' })).body.description, 'Lys');
  assert.equal((await kari.call('PATCH', `/api/beers/${id}`, { name: 'Nisseøl', description: '' })).body.description, '');
  assert.equal((await ola.call('PATCH', `/api/beers/${id}`, { name: 'Nisseøl', description: 'Hacket' })).status, 403);
});

test('only people who have picked their name count as taking part this year', async () => {
  const env = makeEnv();
  const kari = client(env);
  await kari.join('jul', 'Kari'); // a new name
  const scott = client(env);
  await scott.join('jul', 'Scott'); // one of the pre-filled names

  const people = (await kari.call('GET', '/api/tasting')).body.participants as Json[];
  assert.equal(people.length, DEFAULT_PARTICIPANTS.length + 1, 'everyone on the list is still returned');
  assert.deepEqual(people.filter((p) => p.joined).map((p) => p.name).sort(), ['Kari', 'Scott']);
  // The name picker still offers everyone.
  assert.equal((await kari.call('GET', '/api/participants')).body.length, DEFAULT_PARTICIPANTS.length + 1);
});

test('a session from before joining existed is counted once it is used', async () => {
  const env = makeEnv();
  const c = client(env);
  await c.call('POST', '/api/login', { code: 'jul' });
  const list = (await c.call('GET', '/api/participants')).body as Json[];
  const elise = list.find((p) => p.name === 'Elise')!;
  c.setCookie(await signSession(newSession('member', elise.id), SECRET));
  const people = (await c.call('GET', '/api/tasting')).body.participants as Json[];
  assert.deepEqual(people.filter((p) => p.joined).map((p) => p.name), ['Elise']);
});

test('upgrading an old database marks people who already took part as joined', async () => {
  const DB = createTestDb();
  // The tables as they were before participants.joined_at.
  await DB.batch([
    `CREATE TABLE tastings (year INTEGER PRIMARY KEY, criteria TEXT NOT NULL, revealed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE participants (id INTEGER PRIMARY KEY, year INTEGER NOT NULL REFERENCES tastings(year), name TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (year, name COLLATE NOCASE))`,
    `CREATE TABLE beers (id INTEGER PRIMARY KEY, year INTEGER NOT NULL REFERENCES tastings(year), brought_by INTEGER REFERENCES participants(id),
       name TEXT NOT NULL, brewery TEXT NOT NULL DEFAULT '', abv REAL, description TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
       unranked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE ratings (participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
       beer_id INTEGER NOT NULL REFERENCES beers(id) ON DELETE CASCADE, criterion TEXT NOT NULL, score_milli INTEGER NOT NULL,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (participant_id, beer_id, criterion))`,
    `CREATE TABLE comments (participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
       beer_id INTEGER NOT NULL REFERENCES beers(id) ON DELETE CASCADE, text TEXT NOT NULL,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (participant_id, beer_id))`,
    `INSERT INTO tastings (year, criteria) VALUES (${YEAR}, '[{"key":"smak","label":"Smak"}]')`,
    `INSERT INTO participants (id, year, name) VALUES (1, ${YEAR}, 'Rater'), (2, ${YEAR}, 'Bringer'), (3, ${YEAR}, 'Commenter'), (4, ${YEAR}, 'Absent')`,
    `INSERT INTO beers (id, year, brought_by, name) VALUES (1, ${YEAR}, 2, 'Juleøl')`,
    `INSERT INTO ratings (participant_id, beer_id, criterion, score_milli) VALUES (1, 1, 'smak', 7000)`,
    `INSERT INTO comments (participant_id, beer_id, text) VALUES (3, 1, 'God')`,
  ].map((sql) => DB.prepare(sql)));

  const admin = client(makeEnv({ DB }));
  assert.equal((await admin.call('POST', '/api/login', { code: 'nisse' })).status, 200);
  const people = (await admin.call('GET', '/api/tasting')).body.participants as Json[];
  assert.deepEqual(
    Object.fromEntries(people.map((p) => [p.name, p.joined])),
    { Absent: false, Bringer: true, Commenter: true, Rater: true },
  );
});
