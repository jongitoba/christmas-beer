import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { currentYear, type Env } from '../worker/index.ts';
import { DEFAULT_GROUP_CODE } from '../worker/config.ts';
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
  for (const o of [{ ADMIN_CODE: undefined }, { ADMIN_CODE: '' }, { SESSION_SECRET: undefined }, { SESSION_SECRET: 'short' }, { ADMIN_CODE: 'jul' }]) {
    const res = await client(makeEnv(o)).call('POST', '/api/login', { code: 'jul' });
    assert.equal(res.status, 500, JSON.stringify(o));
  }
});

test('without a GROUP_CODE secret the hard-coded "password" is the group code', async () => {
  assert.equal(DEFAULT_GROUP_CODE, 'password');
  const env = makeEnv({ GROUP_CODE: undefined });
  const c = client(env);
  assert.equal((await c.call('POST', '/api/login', { code: 'jul' })).status, 401);
  assert.equal((await c.call('POST', '/api/login', { code: 'password' })).status, 200);
  assert.equal((await c.call('GET', '/api/me')).body.role, 'member');
  // The admin code cannot be the same as the default group code.
  assert.equal((await client(makeEnv({ GROUP_CODE: undefined, ADMIN_CODE: 'password' })).call('POST', '/api/login', { code: 'password' })).status, 500);
  // A GROUP_CODE secret replaces the default.
  assert.equal((await client(makeEnv({ GROUP_CODE: 'jul' })).call('POST', '/api/login', { code: 'password' })).status, 401);
});

test('non-API paths are served as static assets', async () => {
  const res = await worker.fetch(new Request(BASE + '/smaking/'), makeEnv(), {} as ExecutionContext);
  assert.equal(await res.text(), 'static page');
});

test('everything except login needs a session', async () => {
  const c = client(makeEnv());
  for (const path of ['/api/me', '/api/tasting', '/api/results', '/api/years', '/api/participants']) {
    assert.equal((await c.call('GET', path)).status, 401, path);
  }
  assert.equal((await c.call('POST', '/api/beers', { name: 'X' })).status, 401);
  assert.equal((await c.call('PUT', '/api/ratings/1', { scores: {} })).status, 401);
  c.setCookie('forged.cookie');
  assert.equal((await c.call('GET', '/api/me')).status, 401);
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
  assert.deepEqual(list.body, [{ id, name: 'Kari' }]);
  // Picking by id works too.
  const c = client(env);
  await c.call('POST', '/api/login', { code: 'jul' });
  assert.equal((await c.call('POST', '/api/me', { participantId: id })).body.participant.name, 'Kari');
  assert.equal((await c.call('POST', '/api/me', { participantId: 999 })).status, 404);
  assert.equal((await c.call('POST', '/api/me', { name: '   ' })).status, 400);
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
  assert.ok(!JSON.stringify(olaView).includes('"10"') && !JSON.stringify(olaView).includes(':10'), 'no foreign scores leak');
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

test('beer validation', async () => {
  const c = client(makeEnv());
  await c.join('jul', 'Kari');
  assert.equal((await c.call('POST', '/api/beers', { name: '' })).status, 400);
  assert.equal((await c.call('POST', '/api/beers', { name: 'x'.repeat(81) })).status, 400);
  assert.equal((await c.call('POST', '/api/beers', { name: 'Øl', abv: 99 })).status, 400);
  assert.equal((await c.call('POST', '/api/beers', { name: 'Øl', abv: 'abc' })).status, 400);
  assert.equal((await c.call('POST', '/api/beers', { name: 'Øl', abv: 4.56 })).body.abv, 4.6);
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
  assert.deepEqual(view.participants.map((p: Json) => p.name), ['Jon', 'Ola']);
});

test('unknown routes and methods give 404', async () => {
  const c = client(makeEnv());
  await c.join('jul', 'Kari');
  for (const [m, p] of [['GET', '/api/nope'], ['DELETE', '/api/me'], ['GET', '/api/beers/1/x'], ['PUT', '/api/ratings/abc']]) {
    assert.equal((await c.call(m!, p!, m === 'PUT' ? { scores: {} } : undefined)).status, 404, `${m} ${p}`);
  }
});
