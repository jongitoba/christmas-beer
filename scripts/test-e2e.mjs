#!/usr/bin/env node
/**
 * End-to-end test against the real Worker in `wrangler dev` (local D1, fresh state each run).
 *
 * Checks that pages are served, that no API route returns data without a valid session
 * (including URL tricks that might slip past run_worker_first), and runs one full tasting:
 * login → pick name → add beer → score → hidden until reveal → reveal → results.
 *
 * Against a deployed site (blocking checks only, no data is written):
 *   BASE_URL=https://christmas-beer.jonoba.no npm run test:e2e
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const remote = process.env.BASE_URL;
const PORT = 8798;
const BASE = remote ?? `http://127.0.0.1:${PORT}`;
const GROUP_CODE = 'e2e-group-code';
const ADMIN_CODE = 'e2e-admin-code';

let server;
let stateDir;
if (!remote) {
  stateDir = mkdtempSync(join(tmpdir(), 'christmas-beer-e2e-'));
  server = spawn('npx', [
    'wrangler', 'dev',
    '--port', String(PORT), '--ip', '127.0.0.1',
    '--persist-to', stateDir,
    '--var', `GROUP_CODE:${GROUP_CODE}`,
    '--var', `ADMIN_CODE:${ADMIN_CODE}`,
    '--var', 'SESSION_SECRET:e2e-session-secret-that-is-long-enough',
    '--show-interactive-dev-session=false',
  ], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const started = Date.now();
  while (true) {
    try { await fetch(BASE + '/'); break; } catch {}
    if (Date.now() - started > 90000) { console.error(log); throw new Error('wrangler dev did not start'); }
    await new Promise((r) => setTimeout(r, 500));
  }
}

let failures = 0;
let count = 0;
const check = (name, ok, detail = '') => {
  count++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
};

/** Minimal cookie-keeping client. */
function client() {
  let cookie = '';
  return async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(BASE + path, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, text, json, headers: res.headers };
  };
}

try {
  // Public static pages: served, and contain no tasting data (it is loaded via the API).
  for (const path of ['/', '/smaking/', '/resultater/', '/admin/']) {
    const res = await fetch(BASE + path);
    check(`page ${path} is served`, res.status === 200);
  }

  // Without a session nothing under /api returns data.
  const anon = client();
  const blocked = [
    ['GET', '/api/me'], ['GET', '/api/tasting'], ['GET', '/api/results'], ['GET', '/api/years'],
    ['GET', '/api/participants'], ['GET', '/api/history'], ['POST', '/api/beers', { name: 'x' }], ['PUT', '/api/ratings/1', { scores: {} }],
    ['POST', '/api/admin/reveal', { year: 2026, revealed: true }], ['DELETE', '/api/admin/participants/1'],
  ];
  for (const [m, p, b] of blocked) {
    const res = await anon(m, p, b);
    check(`${m} ${p} without session is blocked`, res.status === 401, String(res.status));
  }
  const forged = await fetch(BASE + '/api/tasting', { headers: { cookie: '__Host-juleol=eyJyb2xlIjoiYWRtaW4ifQ.AAAA' } });
  check('forged session cookie is blocked', forged.status === 401, String(forged.status));
  check('wrong code is rejected', (await anon('POST', '/api/login', { code: 'gjett' })).status === 401);
  for (const code of ['password', 'password-admin']) {
    check(`old placeholder code "${code}" is rejected`, (await anon('POST', '/api/login', { code })).status === 401);
  }

  // URL tricks must not reach data by sneaking past run_worker_first.
  for (const path of ['/%61pi/tasting', '//api/tasting', '/./api/tasting', '/x/../api/tasting', '/API/tasting', '/api%2Ftasting', '/api/tasting/']) {
    const res = await fetch(BASE + path, { redirect: 'manual' });
    const body = await res.text();
    const leaks = body.includes('"beers"') || body.includes('"participants"');
    check(`URL trick ${path} leaks nothing`, !leaks, String(res.status));
  }

  if (!remote) {
    const kari = client();
    const jon = client();
    check('member code logs in', (await kari('POST', '/api/login', { code: GROUP_CODE })).status === 200);
    check('cross-origin write refused', (await kari('POST', '/api/me', { name: 'Kari' }, { origin: 'https://evil.example' })).status === 403);
    const me = await kari('POST', '/api/me', { name: 'Kari' });
    check('picking a name works', me.json?.participant?.name === 'Kari');
    const beer = await kari('POST', '/api/beers', { name: 'Nisseøl', brewery: 'Aass', abv: '6.5', description: 'Mørk og krydret' });
    check('adding a beer works (D1 write)', beer.status === 201, String(beer.status));
    check('the beer keeps its description', beer.json?.description === 'Mørk og krydret');
    const scores = { utseende: 7.345, lyd: 9, rase: 8, fylde: 10.5, smak: 11, wok: 1 };
    check('scoring works', (await kari('PUT', `/api/ratings/${beer.json.id}`, { scores })).status === 200);
    check('too many decimals rejected', (await kari('PUT', `/api/ratings/${beer.json.id}`, { scores: { smak: 7.1234 } })).status === 400);
    const view = await kari('GET', '/api/tasting');
    check('own scores are visible', view.json?.beers?.[0]?.mine?.utseende === 7.345);
    check('results hidden before reveal', (await kari('GET', '/api/results')).status === 403);

    await jon('POST', '/api/login', { code: ADMIN_CODE });
    await jon('POST', '/api/me', { name: 'Jon' });
    check('member cannot reveal', (await kari('POST', '/api/admin/reveal', { year: view.json.year, revealed: true })).status === 403);
    check('admin can reveal', (await jon('POST', '/api/admin/reveal', { year: view.json.year, revealed: true })).status === 200);
    const results = await kari('GET', '/api/results');
    const top = results.json?.ranking?.[0];
    const expected = (7.345 + 9 + 8 + 10.5 + 11 + 1) / 6;
    check('results show the overall score', top && Math.abs(top.overall - expected) < 1e-9, top && String(top.overall));
    const hist = await kari('GET', '/api/history');
    check('revealed year shows up in history', hist.json?.years?.some((y) => y.year === view.json.year && y.beers.length === 1));
    check('locked after reveal', (await kari('PUT', `/api/ratings/${beer.json.id}`, { scores: { smak: 5 } })).status === 409);
  }
} finally {
  // On Windows npx runs through a shell, so kill the whole process tree.
  if (server && process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else server?.kill();
  if (stateDir) try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
}

console.log(failures ? `\n${failures} of ${count} checks failed` : `\nAll ${count} checks passed against ${BASE}`);
process.exit(failures ? 1 : 0);
