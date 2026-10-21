import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

const BASE = 'https://short.test';

async function login(): Promise<string> {
  const response = await SELF.fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' }),
    redirect: 'manual',
  });
  expect(response.status).toBe(204);
  const cookie = response.headers.get('Set-Cookie');
  expect(cookie).toBeTruthy();
  return cookie!.split(';')[0];
}

let cookie: string;
beforeAll(async () => {
  cookie = await login();
});

function authed(path: string, options: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    redirect: 'manual',
    ...options,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...options.headers },
  });
}

describe('auth endpoints', () => {
  it('rejects a wrong password', async () => {
    const response = await SELF.fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    });
    expect(response.status).toBe(401);
  });

  it('returns 400 for malformed JSON', async () => {
    const login = await SELF.fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(login.status).toBe(400);
    const create = await authed('/api/links', { method: 'POST', body: '[]' });
    expect(create.status).toBe(400);
  });

  it('gates the API behind the session', async () => {
    expect((await SELF.fetch(`${BASE}/api/links`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/me`)).status).toBe(401);
    expect((await authed('/api/me')).status).toBe(204);
  });

  it('logs out', async () => {
    const response = await SELF.fetch(`${BASE}/api/logout`, { method: 'POST' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});

describe('link CRUD', () => {
  it('creates a link with a custom slug and redirects', async () => {
    const created = await authed('/api/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/target', slug: 'mytarget' }),
    });
    expect(created.status).toBe(201);
    const link = (await created.json()) as { slug: string };
    expect(link.slug).toBe('mytarget');

    const redirect = await SELF.fetch(`${BASE}/mytarget`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('Location')).toBe('https://example.com/target');
  });

  it('creates a link with a random slug', async () => {
    const created = await authed('/api/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/random' }),
    });
    expect(created.status).toBe(201);
    const link = (await created.json()) as { slug: string };
    expect(link.slug).toMatch(/^[A-Za-z0-9]{7}$/);
  });

  it('rejects duplicates, bad URLs, and reserved slugs', async () => {
    await authed('/api/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com', slug: 'dupe' }),
    });
    const duplicate = await authed('/api/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://other.com', slug: 'dupe' }),
    });
    expect(duplicate.status).toBe(409);

    const badUrl = await authed('/api/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'javascript:alert(1)', slug: 'xss' }),
    });
    expect(badUrl.status).toBe(400);

    const self = await authed('/api/links', {
      method: 'POST',
      body: JSON.stringify({ url: `${BASE}/dupe`, slug: 'selfref' }),
    });
    expect(self.status).toBe(400);

    const reserved = await authed('/api/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com', slug: 'api' }),
    });
    expect(reserved.status).toBe(400);
  });

  it('lists links', async () => {
    const response = await authed('/api/links');
    expect(response.status).toBe(200);
    const page = (await response.json()) as { links: { slug: string; url: string }[] };
    expect(page.links.length).toBeGreaterThan(0);
    expect(page.links[0]).toHaveProperty('slug');
    expect(page.links[0]).toHaveProperty('url');
  });

  it('updates a destination', async () => {
    await authed('/api/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://old.example.com', slug: 'editable' }),
    });
    const response = await authed('/api/links/editable', {
      method: 'PATCH',
      body: JSON.stringify({ url: 'https://new.example.com/updated' }),
    });
    expect(response.status).toBe(200);

    const redirect = await SELF.fetch(`${BASE}/editable`, { redirect: 'manual' });
    expect(redirect.headers.get('Location')).toBe('https://new.example.com/updated');
  });

  it('deletes a link', async () => {
    await authed('/api/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://gone.example.com', slug: 'gone' }),
    });
    expect((await authed('/api/links/gone', { method: 'DELETE' })).status).toBe(204);
    expect((await SELF.fetch(`${BASE}/gone`, { redirect: 'manual' })).status).toBe(404);
    expect((await authed('/api/links/gone', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('mcp endpoint', () => {
  it('rejects requests without a bearer token', async () => {
    const response = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata');
  });
});
