import { checkPassword, clearSessionCookie, isAuthenticated, issueSessionCookie } from './session';
import { LinkError, createLink, deleteLink, listLinks, updateLink } from './links';

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

const LINK_PATH = /^\/api\/links\/([A-Za-z0-9_-]{1,64})$/;

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new LinkError(400, 'Request body must be valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new LinkError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  try {
    return await route(request, env);
  } catch (error) {
    if (error instanceof LinkError) return json({ error: error.message }, error.status);
    console.error('API request failed', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const selfHost = url.host;

  if (path === '/api/login' && request.method === 'POST') {
    const body = await readBody(request);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!(await checkPassword(env, password))) {
      return json({ error: 'Invalid password' }, 401);
    }
    return new Response(null, {
      status: 204,
      headers: { 'Set-Cookie': await issueSessionCookie(env) },
    });
  }

  if (path === '/api/logout' && request.method === 'POST') {
    return new Response(null, { status: 204, headers: { 'Set-Cookie': clearSessionCookie() } });
  }

  if (!(await isAuthenticated(request, env))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  if (path === '/api/me' && request.method === 'GET') {
    return new Response(null, { status: 204 });
  }

  if (path === '/api/links' && request.method === 'GET') {
    const limit = Number(url.searchParams.get('limit')) || 50;
    const cursor = url.searchParams.get('cursor') ?? undefined;
    return json(await listLinks(env.LINKS, limit, cursor));
  }

  if (path === '/api/links' && request.method === 'POST') {
    const body = await readBody(request);
    const slug = typeof body.slug === 'string' && body.slug.length > 0 ? body.slug : undefined;
    return json(await createLink(env.LINKS, body.url, slug, selfHost, 'admin'), 201);
  }

  const linkPath = LINK_PATH.exec(path);
  if (linkPath && request.method === 'PATCH') {
    const body = await readBody(request);
    return json(await updateLink(env.LINKS, linkPath[1], body.url, selfHost));
  }

  if (linkPath && request.method === 'DELETE') {
    return (await deleteLink(env.LINKS, linkPath[1]))
      ? new Response(null, { status: 204 })
      : json({ error: 'Not found' }, 404);
  }

  return json({ error: 'Not found' }, 404);
}
