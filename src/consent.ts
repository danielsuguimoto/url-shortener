import { checkPassword, isAuthenticated, issueSessionCookie } from './session';
import { consentPage, errorPage, loginPage } from './pages';

function html(body: string, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  return new Response(body, { status, headers: responseHeaders });
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const url = new URL(request.url);

  if (request.method === 'GET') {
    let authRequest;
    try {
      authRequest = await oauth.parseAuthRequest(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid authorization request';
      return html(errorPage(message), 400);
    }
    if (!(await isAuthenticated(request, env))) {
      return html(loginPage(url.toString()));
    }
    let description, transaction;
    try {
      description = await oauth.describeConsent(authRequest);
      transaction = await oauth.beginConsent(authRequest);
    } catch (error) {
      console.error('OAuth consent setup failed', error);
      return html(errorPage('Unable to process the authorization request.'), 400);
    }
    transaction.headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(consentPage(description, transaction.handle, url.toString()), {
      headers: transaction.headers,
    });
  }

  if (request.method === 'POST') {
    const form = await request.formData();

    if (form.has('password')) {
      const password = String(form.get('password') ?? '');
      if (!(await checkPassword(env, password))) {
        return html(loginPage(url.toString(), 'Wrong password.'), 401);
      }
      const headers = new Headers({
        Location: url.toString(),
        'Set-Cookie': await issueSessionCookie(env),
      });
      return new Response(null, { status: 302, headers });
    }

    if (!(await isAuthenticated(request, env))) {
      return html(loginPage(url.toString()), 401);
    }

    const handle = String(form.get('handle') ?? '');
    try {
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        denied.headers.set('Location', denied.redirectTo);
        return new Response(null, { status: 302, headers: denied.headers });
      }

      const approved = await oauth.approveConsent(request, handle);
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: 'admin',
        metadata: { label: 'admin' },
        scope: approved.request.scope,
        props: { userId: 'admin' },
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (error) {
      console.error('OAuth consent completion failed', error);
      return html(errorPage('Unable to process the authorization request.'), 400);
    }
  }

  return new Response('Method not allowed', { status: 405 });
}
