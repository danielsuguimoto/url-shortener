import { handleApi } from './api';
import { handleAuthorize } from './consent';
import { isReservedSlug } from './links';
import { notFoundPage } from './pages';

const STATIC_PATHS = new Set(['/app.css', '/app.js', '/favicon.ico']);
const SLUG_PATH = /^\/([A-Za-z0-9_-]{1,64})$/;

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/authorize') {
      return handleAuthorize(request, env);
    }
    if (path.startsWith('/api/')) {
      return handleApi(request, env);
    }
    if (path === '/' || STATIC_PATHS.has(path)) {
      return env.ASSETS.fetch(request);
    }
    if (request.method === 'GET') {
      const slug = SLUG_PATH.exec(path)?.[1];
      if (slug && !isReservedSlug(slug)) {
        const destination = await env.LINKS.get(slug);
        if (destination !== null) {
          return Response.redirect(destination, 302);
        }
      }
    }
    return html(notFoundPage(), 404);
  },
} satisfies ExportedHandler<Env>;
