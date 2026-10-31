import { createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OAuthProvider,
  getOAuthApi,
  type OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider';
import worker, { oauthOptions } from '../src/index';
import { fetchOAuth, REFRESH_TOKEN_TTL_SECONDS } from '../src/oauth';
import { issueSessionCookie } from '../src/session';

const ORIGIN = 'https://short.test';
const REDIRECT = 'https://client.example/callback';
const VERIFIER = 'a'.repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;

type Method = 'client_secret_basic' | 'client_secret_post' | 'none';
type Client = { client_id: string; client_secret?: string };
type Tokens = { access_token: string; refresh_token: string; scope: string; expires_in: number };

class MemoryKV {
  entries = new Map<string, { value: string; expiration?: number; metadata?: unknown }>();

  async get(key: string, options?: string | { type?: string }) {
    const record = this.entries.get(key);
    if (!record || (record.expiration !== undefined && record.expiration <= Date.now() / 1000)) {
      this.entries.delete(key);
      return null;
    }
    return (typeof options === 'string' ? options : options?.type) === 'json'
      ? JSON.parse(record.value)
      : record.value;
  }

  async put(key: string, value: string, options?: KVNamespacePutOptions) {
    const expiration = options?.expiration ??
      (options?.expirationTtl === undefined
        ? undefined
        : Math.floor(Date.now() / 1000) + options.expirationTtl);
    this.entries.set(key, { value, expiration, metadata: options?.metadata });
  }

  async delete(key: string) {
    this.entries.delete(key);
  }

  async list({ prefix = '' } = {}) {
    const keys = [];
    for (const [name, record] of this.entries) {
      if (name.startsWith(prefix) && (await this.get(name)) !== null) {
        keys.push({ name, expiration: record.expiration, metadata: record.metadata });
      }
    }
    return { keys, list_complete: true, cacheStatus: null };
  }
}

function environment(): Env {
  return {
    OAUTH_KV: new MemoryKV() as unknown as KVNamespace,
    LINKS: new MemoryKV() as unknown as KVNamespace,
    ADMIN_PASSWORD: 'test-password',
  } as unknown as Env;
}

function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

async function challenge(): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

describe('oauth resilience', () => {
  let env: Env;
  let options: OAuthProviderOptions<Env>;
  let cookie: string;
  let warnings: ReturnType<typeof vi.spyOn>;

  async function fetchWorker(input: string | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(new URL(input, ORIGIN), init);
    return worker.fetch(
      request as unknown as Request<unknown, IncomingRequestCfProperties>,
      env,
      createExecutionContext(),
    );
  }

  function fetchLegacy(input: string | URL, init?: RequestInit): Promise<Response> {
    return new OAuthProvider(options).fetch(
      new Request(new URL(input, ORIGIN), init),
      env,
      createExecutionContext(),
    );
  }

  async function register(method?: Method): Promise<Client> {
    const response = await fetchWorker('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test MCP client',
        redirect_uris: [REDIRECT],
        ...(method ? { token_endpoint_auth_method: method } : {}),
      }),
    });
    expect(response.status).toBe(201);
    const client = await response.json() as Client & { token_endpoint_auth_method: string };
    expect(client.token_endpoint_auth_method).toBe(method ?? 'client_secret_basic');
    if (method === 'none') expect(client.client_secret).toBeUndefined();
    else expect(client.client_secret).toBeTruthy();
    return client;
  }

  function credentials(client: Client, method: Method, fields: Record<string, string>) {
    const body = new URLSearchParams(fields);
    const headers = new Headers();
    if (method === 'client_secret_basic') {
      const encoded = btoa(`${formEncode(client.client_id)}:${formEncode(client.client_secret ?? '')}`);
      headers.set('Authorization', `Basic ${encoded}`);
    } else {
      body.set('client_id', client.client_id);
      if (method === 'client_secret_post' && client.client_secret !== undefined) {
        body.set('client_secret', client.client_secret);
      }
    }
    return { method: 'POST', headers, body };
  }

  async function authorizeUrl(clientId: string): Promise<URL> {
    const url = new URL('/authorize', ORIGIN);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'links',
      state: 'test-state',
      resource: `${ORIGIN}/mcp`,
      code_challenge: await challenge(),
      code_challenge_method: 'S256',
    }).toString();
    return url;
  }

  async function authorize(clientId: string): Promise<string> {
    const url = await authorizeUrl(clientId);
    const page = await fetchWorker(url, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)![1]!;
    const consentCookies = page.headers.getSetCookie().map((value) => value.split(';')[0]);
    const response = await fetchWorker(url, {
      method: 'POST',
      headers: { Cookie: [cookie, ...consentCookies].join('; ') },
      body: new URLSearchParams({ handle, decision: 'approve' }),
    });
    expect(response.status).toBe(302);
    return new URL(response.headers.get('Location')!).searchParams.get('code')!;
  }

  async function codeFor(
    clientId: string,
    opts: OAuthProviderOptions<Env> = options,
  ): Promise<string> {
    const api = getOAuthApi(opts, env);
    const request = await api.parseAuthRequest(new Request(await authorizeUrl(clientId)));
    const { redirectTo } = await api.completeAuthorization({
      request,
      userId: 'admin',
      metadata: {},
      scope: request.scope,
      props: { userId: 'admin' },
    });
    return new URL(redirectTo).searchParams.get('code')!;
  }

  async function exchange(client: Client, method: Method, legacy = false): Promise<Tokens> {
    const code = legacy ? await codeFor(client.client_id) : await authorize(client.client_id);
    const request = credentials(client, method, {
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
    });
    const response = await (legacy ? fetchLegacy : fetchWorker)('/oauth/token', request);
    expect(response.status).toBe(200);
    return response.json() as Promise<Tokens>;
  }

  function refresh(client: Client, method: Method, token: string, legacy = false) {
    const request = credentials(client, method, {
      grant_type: 'refresh_token',
      refresh_token: token,
    });
    return (legacy ? fetchLegacy : fetchWorker)('/oauth/token', request);
  }

  function cimd() {
    const client: Client = { client_id: `https://cimd.example/${crypto.randomUUID()}.json` };
    const upstream: { state: number | 'network' | 'invalid' } = { state: 200 };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toBe(client.client_id);
      if (upstream.state === 'network') throw new TypeError('Test metadata network unavailable');
      if (upstream.state === 'invalid') return Response.json({ client_id: 'wrong-id' });
      return Response.json(
        {
          client_id: client.client_id,
          client_name: 'Test CIMD client',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        },
        { status: upstream.state, headers: { 'Cache-Control': 'no-store' } },
      );
    });
    return { client, upstream };
  }

  async function expectUnavailable(response: Response) {
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
  }

  beforeEach(async () => {
    warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    env = environment();
    options = oauthOptions(ORIGIN);
    cookie = (await issueSessionCookie(env)).split(';')[0]!;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reproduces the provider invalid_client response without the outage mapping', async () => {
    const { client, upstream } = cimd();
    const tokens = await exchange(client, 'none');
    upstream.state = 503;
    const response = await refresh(client, 'none', tokens.refresh_token, true);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'invalid_client',
      error_description: 'Client not found',
    });
  });

  it.each([503, 429, 'network', 'invalid', 404] as const)(
    'maps CIMD resolution failure (%s) to retryable 503 without consuming the grant',
    async (state) => {
      const { client, upstream } = cimd();
      const tokens = await exchange(client, 'none');
      const put = vi.spyOn(env.OAUTH_KV, 'put');
      const remove = vi.spyOn(env.OAUTH_KV, 'delete');
      upstream.state = state;
      await expectUnavailable(await refresh(client, 'none', tokens.refresh_token));
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      const diagnostics = JSON.stringify(
        warnings.mock.calls.filter(([message]: unknown[]) => message === 'OAuth request rejected'),
      );
      expect(diagnostics).toContain('metadata_resolution_failed');
      for (const secret of [tokens.refresh_token, tokens.access_token, client.client_id]) {
        expect(diagnostics).not.toContain(secret);
      }
      upstream.state = 200;
      const recovered = await refresh(client, 'none', tokens.refresh_token);
      expect(recovered.status).toBe(200);
      expect((await recovered.json() as Tokens).refresh_token).not.toBe(tokens.refresh_token);
    },
  );

  it('retries the same authorization code after a CIMD outage without consuming it', async () => {
    const { client, upstream } = cimd();
    const code = await authorize(client.client_id);
    const fields = {
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
    };
    upstream.state = 'network';
    await expectUnavailable(await fetchWorker('/oauth/token', credentials(client, 'none', fields)));
    upstream.state = 200;
    const response = await fetchWorker('/oauth/token', credentials(client, 'none', fields));
    expect(response.status).toBe(200);
  });

  it.each(['GET', 'POST'] as const)(
    'returns retryable 503 during %s authorize when CIMD is unavailable',
    async (method) => {
      const { client, upstream } = cimd();
      const url = await authorizeUrl(client.client_id);
      let request: () => Promise<Response>;
      if (method === 'GET') {
        request = () => fetchWorker(url, { headers: { Cookie: cookie } });
      } else {
        const page = await fetchWorker(url, { headers: { Cookie: cookie } });
        expect(page.status).toBe(200);
        const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)![1]!;
        const consentCookies = page.headers.getSetCookie().map((value) => value.split(';')[0]);
        request = () => fetchWorker(url, {
          method: 'POST',
          headers: { Cookie: [cookie, ...consentCookies].join('; ') },
          body: new URLSearchParams({ handle, decision: 'approve' }),
        });
      }
      upstream.state = 'network';
      const response = await request();
      expect(response.headers.get('Location')).toBeNull();
      await expectUnavailable(response);
    },
  );

  it.each(['client_secret_basic', 'client_secret_post'] as const)(
    'handles CIMD failure during the early %s compatibility lookup without downgrading',
    async (method) => {
      const { client, upstream } = cimd();
      const tokens = await exchange(client, 'none');
      const misconfigured = { ...client, client_secret: 'unregistered-secret' };
      upstream.state = 503;
      await expectUnavailable(await refresh(misconfigured, method, tokens.refresh_token));
      upstream.state = 200;
      const rejected = await refresh(misconfigured, method, tokens.refresh_token);
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toMatchObject({ error: 'invalid_client' });
      expect((await refresh(client, 'none', tokens.refresh_token)).status).toBe(200);
    },
  );

  it('prioritizes retryable CIMD errors over a custom diagnostic callback', async () => {
    const { client, upstream } = cimd();
    const tokens = await exchange(client, 'none');
    const callback = vi.fn(() => undefined);
    upstream.state = 503;
    const response = await fetchOAuth(
      new Request(`${ORIGIN}/oauth/token`, credentials(client, 'none', {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      })),
      env,
      createExecutionContext(),
      { ...options, onError: callback },
    );
    await expectUnavailable(response);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'reproduces absolute 30-day expiry; live grants renew on refresh (rolling: %s)',
    async (rolling) => {
      const client = await register('none');
      const tokens = await exchange(client, 'none', true);
      const start = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start + 20 * DAY_MS);
      const first = await refresh(client, 'none', tokens.refresh_token, !rolling);
      expect(first.status).toBe(200);
      const next = await first.json() as Tokens;
      clock.mockReturnValue(start + 31 * DAY_MS);
      const second = await refresh(client, 'none', next.refresh_token, !rolling);
      expect(second.status).toBe(rolling ? 200 : 400);
      if (!rolling) {
        expect(await second.json()).toMatchObject({ error: 'invalid_grant' });
      }
    },
  );

  it.each(['none', 'client_secret_basic', 'client_secret_post'] as const)(
    'keeps active %s grants alive past 145 days, then expires idle grants',
    async (method) => {
      expect(REFRESH_TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
      const client = await register(method);
      let tokens = await exchange(client, method);
      const start = Date.now();
      const clock = vi.spyOn(Date, 'now');
      for (const day of [29, 58, 87, 116, 145]) {
        clock.mockReturnValue(start + day * DAY_MS);
        const response = await refresh(client, method, tokens.refresh_token);
        expect(response.status).toBe(200);
        const rotated = await response.json() as Tokens;
        expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
        expect(rotated.expires_in).toBe(3600);
        tokens = rotated;
      }
      clock.mockReturnValue(start + 176 * DAY_MS);
      const expired = await refresh(client, method, tokens.refresh_token);
      expect(expired.status).toBe(400);
      expect(await expired.json()).toMatchObject({ error: 'invalid_grant' });
    },
  );

  it.each([
    ['client_secret_basic', 'client_secret_post'],
    ['client_secret_post', 'client_secret_basic'],
  ] as const)(
    'reproduces the transport mismatch for %s -> %s without normalization',
    async (registered, presented) => {
      const client = await register(registered);
      const tokens = await exchange(client, registered);
      const response = await refresh(client, presented, tokens.refresh_token, true);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      });
    },
  );

  it.each([
    ['client_secret_basic', 'client_secret_post'],
    ['client_secret_post', 'client_secret_basic'],
    ['client_secret_basic', 'client_secret_basic'],
    ['client_secret_post', 'client_secret_post'],
  ] as const)('refreshes a %s client presenting %s credentials', async (registered, presented) => {
    const client = await register(registered);
    const tokens = await exchange(client, registered);
    const response = await refresh(client, presented, tokens.refresh_token);
    expect(response.status).toBe(200);
    const rotated = await response.json() as Tokens;
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect(rotated.scope).toBe('links');
    expect((await refresh(client, presented, rotated.refresh_token)).status).toBe(200);
  });

  it.each([
    ['client_secret_basic', 'client_secret_post'],
    ['client_secret_post', 'client_secret_basic'],
  ] as const)(
    'normalizes the authorization code exchange for %s -> %s',
    async (registered, presented) => {
      const client = await register(registered);
      const tokens = await exchange(client, presented);
      expect((await refresh(client, presented, tokens.refresh_token)).status).toBe(200);
    },
  );

  it.each([
    ['client_secret_basic', 'client_secret_post'],
    ['client_secret_post', 'client_secret_basic'],
  ] as const)('still verifies the secret for %s -> %s', async (registered, presented) => {
    const client = await register(registered);
    const tokens = await exchange(client, registered);
    const response = await refresh(
      { ...client, client_secret: 'wrong-secret' },
      presented,
      tokens.refresh_token,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
    if (presented === 'client_secret_basic') {
      expect(response.headers.get('WWW-Authenticate')).toMatch(/^Basic /);
    }
    expect((await refresh(client, presented, tokens.refresh_token)).status).toBe(200);
  });

  it.each(['client_secret_basic', 'client_secret_post'] as const)(
    'never downgrades %s to a public client',
    async (registered) => {
      const client = await register(registered);
      const tokens = await exchange(client, registered);
      for (const presented of ['none', 'client_secret_basic', 'client_secret_post'] as const) {
        const response = await refresh(
          { client_id: client.client_id },
          presented,
          tokens.refresh_token,
        );
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: 'invalid_client' });
      }
      expect((await refresh(client, registered, tokens.refresh_token)).status).toBe(200);
    },
  );

  it.each(['client_secret_basic', 'client_secret_post'] as const)(
    'never converts a public client to %s',
    async (presented) => {
      const client = await register('none');
      const tokens = await exchange(client, 'none');
      warnings.mockClear();
      const response = await refresh(
        { ...client, client_secret: 'unregistered-secret' },
        presented,
        tokens.refresh_token,
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      });
      const logs = JSON.stringify(warnings.mock.calls);
      for (const value of [client.client_id, 'unregistered-secret', tokens.refresh_token]) {
        expect(logs).not.toContain(value);
      }
      expect((await refresh(client, 'none', tokens.refresh_token)).status).toBe(200);
    },
  );

  it('does not repair repeated or mixed authentication parameters', async () => {
    const client = await register('client_secret_basic');
    const tokens = await exchange(client, 'client_secret_basic');
    const init = credentials(client, 'client_secret_post', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    init.body.append('client_id', client.client_id);
    const repeated = await fetchWorker('/oauth/token', init);
    expect(repeated.status).toBe(400);
    expect(await repeated.json()).toMatchObject({ error: 'invalid_request' });

    const mixed = credentials(client, 'client_secret_post', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    mixed.headers.set(
      'Authorization',
      credentials(client, 'client_secret_basic', {}).headers.get('Authorization')!,
    );
    const response = await fetchWorker('/oauth/token', mixed);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });
});
