import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSession, readCookie, safeEqual, signSession, verifySession, SESSION_COOKIE } from '../worker/session.ts';

const SECRET = 's'.repeat(40);

test('a signed session verifies and round-trips', async () => {
  const s = newSession('admin', 7);
  assert.deepEqual(await verifySession(await signSession(s, SECRET), SECRET), s);
});

test('tampered, wrongly signed, expired and garbage sessions are rejected', async () => {
  const token = await signSession(newSession('member', 1), SECRET);
  const [, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...newSession('admin', 1) })).toString('base64url');
  assert.equal(await verifySession(`${forged}.${sig}`, SECRET), null);
  assert.equal(await verifySession(token, 'x'.repeat(40)), null);
  const expired = await signSession({ role: 'member', participantId: null, exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
  assert.equal(await verifySession(expired, SECRET), null);
  for (const junk of ['', 'abc', 'a.b', 'a.b.c', '!!!.???']) assert.equal(await verifySession(junk, SECRET), null, junk);
  const badRole = await signSession({ role: 'owner' as never, participantId: null, exp: 9e9 }, SECRET);
  assert.equal(await verifySession(badRole, SECRET), null);
});

test('readCookie finds the session cookie among others', () => {
  const req = new Request('https://x', { headers: { cookie: `a=1; ${SESSION_COOKIE}=abc.def; b=2` } });
  assert.equal(readCookie(req, SESSION_COOKIE), 'abc.def');
  assert.equal(readCookie(new Request('https://x'), SESSION_COOKIE), null);
});

test('safeEqual', async () => {
  assert.equal(await safeEqual('jul', 'jul'), true);
  assert.equal(await safeEqual('jul', 'Jul'), false);
  assert.equal(await safeEqual('', 'jul'), false);
});
