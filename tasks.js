// Flow — Google Tasks Integration v1.0
// Handles OAuth, fetching, caching and completing tasks

const TASKS_BASE = 'https://www.googleapis.com/tasks/v1';
const CACHE_KEY  = 'gtasks_cache';

// ── AUTH ────────────────────────────────────────────
async function getToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError || !token) {
        reject(chrome.runtime.lastError?.message || 'No token');
      } else {
        resolve(token);
      }
    });
  });
}

async function revokeToken() {
  return new Promise(resolve => {
    chrome.identity.getAuthToken({ interactive: false }, token => {
      if (!token) return resolve();
      chrome.identity.removeCachedAuthToken({ token }, () => {
        fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`).finally(resolve);
      });
    });
  });
}

// Retry once with a fresh token if the first request gets 401
async function apiFetch(url, options = {}, retry = true) {
  const token = await getToken(false);
  const res   = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 401 && retry) {
    // Token expired — revoke cached, get fresh one, retry once
    await new Promise(r => chrome.identity.removeCachedAuthToken({ token }, r));
    return apiFetch(url, options, false);
  }
  return res;
}

// ── TASK LISTS ────────────────────────────────────────
async function fetchTaskLists() {
  const res  = await apiFetch(`${TASKS_BASE}/users/@me/lists?maxResults=20`);
  const data = await res.json();
  return data.items || [];
}

// ── TASKS ─────────────────────────────────────────────
async function fetchTasks(listId) {
  const res  = await apiFetch(`${TASKS_BASE}/lists/${listId}/tasks?showCompleted=false&maxResults=30`);
  const data = await res.json();
  return (data.items || []).filter(t => t.status !== 'completed');
}

async function completeTask(listId, taskId) {
  const res = await apiFetch(
    `${TASKS_BASE}/lists/${listId}/tasks/${taskId}`,
    { method: 'PATCH', body: JSON.stringify({ status: 'completed', completed: new Date().toISOString() }) }
  );
  return res.ok;
}

// ── CACHE ─────────────────────────────────────────────
async function saveCache(lists, tasks, activeListId) {
  await chrome.storage.local.set({
    [CACHE_KEY]: { lists, tasks, activeListId, ts: Date.now() }
  });
}

async function loadCache() {
  const { [CACHE_KEY]: c } = await chrome.storage.local.get(CACHE_KEY);
  return c || null;
}

async function clearCache() {
  await chrome.storage.local.remove(CACHE_KEY);
}

// ── ACTIVE TASK (persisted across sessions) ────────────
async function saveActiveTask(task, listId) {
  await chrome.storage.local.set({ gtasks_active: task ? { task, listId } : null });
}

async function loadActiveTask() {
  const { gtasks_active } = await chrome.storage.local.get('gtasks_active');
  return gtasks_active || null;
}
