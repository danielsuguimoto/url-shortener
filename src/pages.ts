import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
  * { box-sizing: border-box; margin: 0; }
  body {
    background: #0e0f11;
    color: #e8eaed;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .card {
    background: #16181d;
    border: 1px solid #262a31;
    border-radius: 6px;
    padding: 28px;
    width: 100%;
    max-width: 420px;
  }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
  .sub { color: #8a919b; font-size: 13px; margin-bottom: 20px; }
  .client { font-family: ui-monospace, monospace; color: #ffd21f; }
  label { display: block; font-size: 13px; color: #8a919b; margin-bottom: 6px; }
  input[type=password] {
    width: 100%;
    background: #0e0f11;
    border: 1px solid #262a31;
    border-radius: 4px;
    color: #e8eaed;
    font-size: 15px;
    padding: 10px 12px;
    margin-bottom: 16px;
  }
  input[type=password]:focus { outline: 2px solid #ffd21f; outline-offset: -1px; }
  button {
    font: inherit;
    font-weight: 600;
    border: 0;
    border-radius: 4px;
    padding: 10px 16px;
    cursor: pointer;
  }
  .approve { background: #ffd21f; color: #0e0f11; width: 100%; }
  .deny { background: transparent; color: #8a919b; width: 100%; margin-top: 8px; }
  .error { color: #ff5a48; font-size: 13px; margin-bottom: 14px; }
  .scopes { list-style: none; padding: 0; margin: 0 0 20px; display: flex; gap: 8px; flex-wrap: wrap; }
  .scopes li {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    background: #0e0f11;
    border: 1px solid #262a31;
    border-radius: 4px;
    padding: 4px 8px;
  }
  .warn { color: #ff5a48; font-size: 12px; margin-top: 16px; }
  a { color: #ffd21f; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}

export function loginPage(action: string, error?: string): string {
  return page(
    'Sign in',
    `<div class="card">
  <h1>Sign in</h1>
  <p class="sub">Authorize access to continue.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="${escapeHtml(action)}">
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autocomplete="current-password" required autofocus>
    <button class="approve" type="submit">Sign in</button>
  </form>
</div>`,
  );
}

export function consentPage(desc: ConsentDescription, handle: string, action: string): string {
  const scopes = desc.scope.map((scope) => `<li>${escapeHtml(scope)}</li>`).join('');
  const domain = desc.clientDomain ? ` (<span class="client">${escapeHtml(desc.clientDomain)}</span>)` : '';
  const loopback = desc.redirectIsLoopback
    ? ''
    : `<p class="warn">This client redirects to a non-local address. Only approve clients you recognize.</p>`;
  return page(
    'Authorize application',
    `<div class="card">
  <h1>Authorize <span class="client">${escapeHtml(desc.clientName)}</span>${domain}</h1>
  <p class="sub">This application is requesting access to manage short links.</p>
  <ul class="scopes">${scopes}</ul>
  <form method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="handle" value="${escapeHtml(handle)}">
    <button class="approve" type="submit" name="decision" value="approve">Allow</button>
    <button class="deny" type="submit" name="decision" value="deny">Deny</button>
  </form>
  ${loopback}
</div>`,
  );
}

export function notFoundPage(): string {
  return page(
    'Not found',
    `<div class="card">
  <h1>404 — nothing here</h1>
  <p class="sub">This short link does not exist or was deleted.</p>
</div>`,
  );
}

export function errorPage(message: string): string {
  return page(
    'Error',
    `<div class="card">
  <h1>Request failed</h1>
  <p class="sub">${escapeHtml(message)}</p>
</div>`,
  );
}
