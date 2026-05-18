// Flow — Google Tasks v2.0
// Uses launchWebAuthFlow so user just pastes their Client ID — no manifest editing needed

const TASKS_BASE = 'https://www.googleapis.com/tasks/v1';
let _accessToken = null;

// ── CLIENT ID STORAGE ────────────────────────────────
async function getClientId() {
  const { gtasks_client_id } = await chrome.storage.local.get('gtasks_client_id');
  return gtasks_client_id || null;
}
async function saveClientId(id) {
  await chrome.storage.local.set({ gtasks_client_id: id.trim() });
}

// ── AUTH via launchWebAuthFlow ───────────────────────
async function tasksAuth(interactive = true) {
  const clientId = await getClientId();
  if (!clientId) throw new Error('NO_CLIENT_ID');

  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const scope       = 'https://www.googleapis.com/auth/tasks';

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&response_type=token` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&prompt=consent`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive },
      (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(chrome.runtime.lastError?.message || 'Auth cancelled');
          return;
        }
        // Extract access_token from URL fragment
        const params = new URLSearchParams(new URL(responseUrl).hash.slice(1));
        const token  = params.get('access_token');
        if (!token) { reject('No token in response'); return; }
        _accessToken = token;
        // Store expiry (tokens last 1h)
        const expiresIn = parseInt(params.get('expires_in') || '3600', 10);
        chrome.storage.local.set({ gtasks_token: { token, expiresAt: Date.now() + expiresIn * 1000 } });
        resolve(token);
      }
    );
  });
}

// Get stored token or re-auth if expired
async function getToken(interactive = false) {
  if (_accessToken) return _accessToken;
  const { gtasks_token } = await chrome.storage.local.get('gtasks_token');
  if (gtasks_token && gtasks_token.expiresAt > Date.now() + 30000) {
    _accessToken = gtasks_token.token;
    return _accessToken;
  }
  // Need fresh token
  return tasksAuth(interactive);
}

async function tasksRevokeToken() {
  _accessToken = null;
  await chrome.storage.local.remove(['gtasks_token', 'gtasks_cache', 'gtasks_active', 'gtasks_client_id']);
}

// ── API FETCH ────────────────────────────────────────
async function tasksApiFetch(url, options = {}, retry = true) {
  const token = await getToken(false);
  const res   = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 && retry) {
    _accessToken = null;
    await chrome.storage.local.remove('gtasks_token');
    // Try re-auth non-interactively first, then interactively
    try { await tasksAuth(false); } catch { await tasksAuth(true); }
    return tasksApiFetch(url, options, false);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── CACHE ────────────────────────────────────────────
async function saveTaskCache(lists, tasks, activeListId) {
  await chrome.storage.local.set({ gtasks_cache: { lists, tasks, activeListId, ts: Date.now() } });
}
async function loadTaskCache() {
  const { gtasks_cache } = await chrome.storage.local.get('gtasks_cache');
  return gtasks_cache || null;
}
async function saveTaskActive(task, listId) {
  await chrome.storage.local.set({ gtasks_active: task ? { task, listId } : null });
}
async function loadTaskActive() {
  const { gtasks_active } = await chrome.storage.local.get('gtasks_active');
  return gtasks_active || null;
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
