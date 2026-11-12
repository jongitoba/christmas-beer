/**
 * Session cookie: a small JSON payload signed with HMAC-SHA256 (SESSION_SECRET).
 * Entering the shared group code gives role "member"; the admin code gives "admin".
 * Which participant you are is picked afterwards and stored in the same cookie.
 */

export type Role = 'member' | 'admin';

export interface Session {
  role: Role;
  participantId: number | null;
  /** Expiry, seconds since epoch. */
  exp: number;
}

export const SESSION_COOKIE = '__Host-juleol';
export const SESSION_DAYS = 60;

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (text: string) => {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function signSession(session: Session, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(session)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

export async function verifySession(token: string, secret: string, now = Date.now()): Promise<Session | null> {
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), enc.encode(payload));
    if (!ok) return null;
    const s = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Partial<Session>;
    if (s.role !== 'member' && s.role !== 'admin') return null;
    if (typeof s.exp !== 'number' || s.exp * 1000 < now) return null;
    if (s.participantId !== null && !Number.isInteger(s.participantId)) return null;
    return { role: s.role, participantId: s.participantId ?? null, exp: s.exp };
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export const newSession = (role: Role, participantId: number | null = null, now = Date.now()): Session => ({
  role,
  participantId,
  exp: Math.floor(now / 1000) + SESSION_DAYS * 86400,
});

export const sessionCookie = (value: string) =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;

export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** Compares two strings without leaking how many leading characters match. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const x = new Uint8Array(ha!);
  const y = new Uint8Array(hb!);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
