const COOKIE_NAME = '__Host-session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function sign(secret: string, expiry: number): Promise<string> {
  const key = await sessionKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`session:${expiry}`),
  );
  return toBase64Url(new Uint8Array(signature));
}

function sessionSecret(env: Env): string {
  return typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET.length > 0
    ? env.SESSION_SECRET
    : env.ADMIN_PASSWORD;
}

export async function checkPassword(env: Env, candidate: string): Promise<boolean> {
  if (typeof env.ADMIN_PASSWORD !== 'string' || env.ADMIN_PASSWORD.length === 0) {
    return false;
  }
  const [expected, given] = await Promise.all([
    sha256(env.ADMIN_PASSWORD),
    sha256(candidate),
  ]);
  return timingSafeEqual(expected, given);
}

export async function issueSessionCookie(env: Env): Promise<string> {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const signature = await sign(sessionSecret(env), expiry);
  return `${COOKIE_NAME}=${expiry}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  const header = request.headers.get('Cookie');
  if (!header) return false;
  const raw = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return false;
  const value = raw.slice(COOKIE_NAME.length + 1);
  const dot = value.indexOf('.');
  if (dot === -1) return false;
  const expiry = Number(value.slice(0, dot));
  if (!Number.isFinite(expiry) || expiry * 1000 <= Date.now()) return false;
  const expected = await sign(sessionSecret(env), expiry);
  const given = fromBase64Url(value.slice(dot + 1));
  const want = fromBase64Url(expected);
  if (!given || !want) return false;
  return timingSafeEqual(given, want);
}
