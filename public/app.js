const $ = (selector) => document.querySelector(selector);

const loginSection = $('#login');
const appSection = $('#app');
const loginForm = $('#login-form');
const loginError = $('#login-error');
const createForm = $('#create-form');
const createUrl = $('#create-url');
const createSlug = $('#create-slug');
const createError = $('#create-error');
const listError = $('#list-error');
const linksList = $('#links');
const emptyState = $('#empty');
const moreButton = $('#more');
const rowTemplate = $('#link-row');

let nextCursor = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (response.status === 401) {
    showLogin();
    throw new Error('Session expired. Sign in again.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response;
}

function reportListError(error) {
  showError(listError, error.message);
}

function showLogin() {
  appSection.hidden = true;
  loginSection.hidden = false;
  $('#login-password').focus();
}

function showApp() {
  loginSection.hidden = true;
  appSection.hidden = false;
}

function showError(el, error) {
  el.textContent = error;
  el.hidden = false;
}

function formatDate(epochMs) {
  if (!epochMs) return '';
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function renderRow(link) {
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  const slugButton = row.querySelector('.slug');
  const dest = row.querySelector('.dest');
  const created = row.querySelector('.created');
  const editButton = row.querySelector('.edit');
  const deleteButton = row.querySelector('.delete');

  slugButton.textContent = `/${link.slug}`;
  dest.textContent = link.url;
  dest.title = link.url;
  created.textContent = formatDate(link.createdAt);
  created.dateTime = new Date(link.createdAt).toISOString();

  slugButton.addEventListener('click', async () => {
    await navigator.clipboard.writeText(`${location.origin}/${link.slug}`);
    slugButton.textContent = 'Copied';
    slugButton.classList.add('copied');
    setTimeout(() => {
      slugButton.textContent = `/${link.slug}`;
      slugButton.classList.remove('copied');
    }, 1200);
  });

  let input = null;

  const closeEditor = () => {
    input = null;
    dest.textContent = link.url;
    dest.title = link.url;
    editButton.textContent = 'Edit';
  };

  const save = async () => {
    listError.hidden = true;
    try {
      const response = await api(`/api/links/${encodeURIComponent(link.slug)}`, {
        method: 'PATCH',
        body: JSON.stringify({ url: input.value }),
      });
      link.url = (await response.json()).url;
      closeEditor();
    } catch (error) {
      reportListError(error);
    }
  };

  editButton.addEventListener('click', () => {
    if (input) return save();
    input = document.createElement('input');
    input.type = 'url';
    input.value = link.url;
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') save();
      if (event.key === 'Escape') closeEditor();
    });
    dest.textContent = '';
    dest.appendChild(input);
    input.focus();
    editButton.textContent = 'Save';
  });

  deleteButton.addEventListener('click', async () => {
    if (!confirm(`Delete /${link.slug}?`)) return;
    listError.hidden = true;
    try {
      await api(`/api/links/${encodeURIComponent(link.slug)}`, { method: 'DELETE' });
      row.remove();
      if (!linksList.children.length) emptyState.hidden = false;
    } catch (error) {
      reportListError(error);
    }
  });

  return row;
}

async function loadLinks(cursor) {
  listError.hidden = true;
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await api(`/api/links${query}`);
  const page = await response.json();
  if (!cursor) {
    linksList.textContent = '';
    emptyState.hidden = page.links.length > 0;
  }
  nextCursor = page.cursor;
  moreButton.hidden = !nextCursor;
  for (const link of page.links) linksList.appendChild(renderRow(link));
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  const password = $('#login-password').value;
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      showError(loginError, response.status === 401 ? 'Wrong password.' : 'Sign-in failed.');
      return;
    }
  } catch {
    showError(loginError, 'Network error. Try again.');
    return;
  }
  loginForm.reset();
  showApp();
  loadLinks().catch(reportListError);
});

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  createError.hidden = true;
  const body = { url: createUrl.value };
  if (createSlug.value.trim()) body.slug = createSlug.value.trim();
  try {
    await api('/api/links', { method: 'POST', body: JSON.stringify(body) });
    createForm.reset();
    await loadLinks();
  } catch (error) {
    showError(createError, error.message);
  }
});

$('#signout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

moreButton.addEventListener('click', () => loadLinks(nextCursor).catch(reportListError));

(async () => {
  const response = await fetch('/api/me').catch(() => null);
  if (response?.ok) {
    showApp();
    loadLinks().catch(reportListError);
  } else {
    showLogin();
  }
})();
