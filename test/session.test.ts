import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { checkPassword, isAuthenticated, issueSessionCookie } from '../src/session';

function requestWithCookie(cookie: string): Request {
  return new Request('https://test.local/', {
    headers: { Cookie: cookie.split(';')[0] },
  });
}

describe('checkPassword', () => {
  it('accepts the configured password', async () => {
    expect(await checkPassword(env, 'test-password')).toBe(true);
  });

  it('rejects wrong passwords', async () => {
    expect(await checkPassword(env, 'wrong')).toBe(false);
    expect(await checkPassword(env, '')).toBe(false);
  });
});

describe('session cookie', () => {
  it('round-trips: issued cookie authenticates', async () => {
    const cookie = await issueSessionCookie(env);
    expect(cookie).toContain('__Host-session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(await isAuthenticated(requestWithCookie(cookie), env)).toBe(true);
  });

  it('rejects a tampered signature', async () => {
    const cookie = await issueSessionCookie(env);
    const tampered = cookie.replace(/__Host-session=(\d+)\./, '__Host-session=$1.AAAA');
    expect(await isAuthenticated(requestWithCookie(tampered), env)).toBe(false);
  });

  it('rejects a malformed base64 signature', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const cookie = `__Host-session=${future}.%%%not-base64%%%; Path=/`;
    expect(await isAuthenticated(requestWithCookie(cookie), env)).toBe(false);
  });

  it('rejects an expired session', async () => {
    const expired = Math.floor(Date.now() / 1000) - 3600;
    const cookie = `__Host-session=${expired}.AAAA; Path=/`;
    expect(await isAuthenticated(requestWithCookie(cookie), env)).toBe(false);
  });

  it('rejects a missing cookie', async () => {
    expect(await isAuthenticated(new Request('https://test.local/'), env)).toBe(false);
  });
});
