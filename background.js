// Flow Background Service Worker v2.1

const SOCIAL_SITES = [
  'youtube.com','twitter.com','x.com','instagram.com',
  'facebook.com','tiktok.com','reddit.com','twitch.tv','snapchat.com','linkedin.com'
];

const DEFAULT_STATE = {
  preferences: {
    focusDuration: 25,
    breakDuration: 5,
  },
  session: {
    active: false,
    mode: 'focus',
    startTime: null,
    focusDuration: 25,
    breakDuration: 5,
    sessionsCompleted: 0,
    strictMode: false,
  },
  blocklist: [
    'youtube.com','twitter.com','x.com','instagram.com',
    'facebook.com','tiktok.com','reddit.com','netflix.com','twitch.tv',
  ],
  doomscroll: {
    limitMinutes: 10,
    punishmentMinutes: 3,
    blocked: {},
  },
  screenTime: {},
  stats: {
    heatmap: {},
    streakDays: 0,
    lastActiveDate: null,
    totalSessions: 0,
    totalFocusMinutes: 0,
  },
};

// ── INIT ──────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const { flowState } = await chrome.storage.local.get('flowState');
  if (!flowState) await chrome.storage.local.set({ flowState: DEFAULT_STATE });
  resetAlarms();
});

chrome.runtime.onStartup.addListener(resetAlarms);

function resetAlarms() {
  chrome.alarms.clearAll(() => {
    chrome.alarms.create('flowTick',    { periodInMinutes: 1/60 });
    chrome.alarms.create('keepAlive',   { periodInMinutes: 0.4 });
    chrome.alarms.create('dailyReset',  { periodInMinutes: 60 }); // check every hour
  });
}

// Keep service worker alive
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepAlive') return;
  if (alarm.name === 'dailyReset') {
    // Prune screen time older than 30 days and store last-reset date
    const state = await getState();
    const cutoff = dateKey(-30);
    let pruned = false;
    for (const k of Object.keys(state.screenTime || {})) {
      if (k < cutoff) { delete state.screenTime[k]; pruned = true; }
    }
    if (pruned) await setState(state);
    return;
  }

  if (alarm.name !== 'flowTick') return;
  const state = await getState();
  if (!state.session.active) return;

  const now = Date.now();
  const elapsed = Math.floor((now - state.session.startTime) / 1000);
  const durationSec = state.session.mode === 'focus'
    ? state.session.focusDuration * 60
    : state.session.breakDuration * 60;

  if (elapsed >= durationSec) {
    await handleSessionComplete(state);
  } else {
    broadcast({ type: 'TICK', elapsed, durationSec, mode: state.session.mode });
  }
});

async function handleSessionComplete(state) {
  if (state.session.mode === 'focus') {
    // ── Focus session just ended ──
    const today = dateKey();
    const mins = state.session.focusDuration;
    state.stats.heatmap[today] = (state.stats.heatmap[today] || 0) + mins;
    state.stats.totalSessions  += 1;
    state.stats.totalFocusMinutes = (state.stats.totalFocusMinutes || 0) + mins;
    state.session.sessionsCompleted = (state.session.sessionsCompleted || 0) + 1;
    updateStreak(state);

    // Switch to break — always continue automatically
    state.session.mode = 'break';
    state.session.startTime = Date.now();

    const round = state.session.sessionsCompleted % 4 || 4; // 1-4
    const breakLabel = round === 4 ? 'long break coming — well done!' : `${state.session.breakDuration}m break`;
    notify(`Flow — Round ${round}/4 done ✓`, `${mins}m focused. ${breakLabel}`);

  } else {
    // ── Break just ended ──
    const completed = state.session.sessionsCompleted || 0;

    if (completed > 0 && completed % 4 === 0) {
      // Full Pomodoro loop (4 focus + 4 breaks) complete — stop the cycle
      state.session.active = false;
      state.session.mode = 'focus';
      state.session.startTime = null;
      state.session.sessionsCompleted = 0; // reset for next cycle
      notify('Flow — Cycle Complete 🎉', 'You finished 4 focus sessions. Great work!');
    } else {
      // More sessions remain — auto-start next focus immediately
      state.session.mode = 'focus';
      state.session.startTime = Date.now();
      notify('Flow — Break Over', `Session ${(completed % 4) + 1}/4 starting now.`);
    }
  }

  await setState(state);
  broadcast({ type: 'SESSION_UPDATE', session: state.session, stats: state.stats });
}

function updateStreak(state) {
  const today = dateKey();
  const yesterday = dateKey(-1);
  if (state.stats.lastActiveDate === yesterday) state.stats.streakDays += 1;
  else if (state.stats.lastActiveDate !== today) state.stats.streakDays = 1;
  state.stats.lastActiveDate = today;
}

// ── MESSAGES ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch(e => sendResponse({ error: e.message }));
  return true;
});

async function handle(msg, sender) {
  const state = await getState();

  switch (msg.type) {
    case 'GET_STATE': return state;

    case 'START_SESSION':
      state.session.active = true;
      state.session.mode = 'focus';
      state.session.startTime = Date.now();
      state.session.focusDuration = msg.focusDuration ?? 25;
      state.session.breakDuration = msg.breakDuration ?? 5;
      state.session.strictMode = msg.strictMode ?? false;
      await setState(state);
      // Notify all tabs to show floating timer
      broadcastToTabs({ type: 'SESSION_STARTED', session: state.session });
      return { ok: true };

    case 'STOP_SESSION':
      if (state.session.strictMode) return { error: 'Strict Mode is active.' };
      state.session.active = false;
      state.session.mode = 'focus';
      state.session.startTime = null;
      await setState(state);
      broadcastToTabs({ type: 'SESSION_ENDED' });
      return { ok: true };

    case 'UPDATE_BLOCKLIST':
      state.blocklist = msg.blocklist;
      await setState(state);
      return { ok: true };

    case 'UPDATE_DOOMSCROLL_SETTINGS':
      state.doomscroll.limitMinutes = msg.limitMinutes;
      state.doomscroll.punishmentMinutes = msg.punishmentMinutes;
      await setState(state);
      return { ok: true };

    case 'CHECK_BLOCKED': {
      let hostname;
      try { hostname = new URL(msg.url).hostname.replace(/^www\./, ''); } catch { return { blocked: false }; }
      // Focus block
      if (state.session.active && state.session.mode === 'focus') {
        const hit = state.blocklist.some(s => hostname.endsWith(s.replace(/^www\./, '')));
        if (hit) return { blocked: true, mode: 'focus' };
      }
      // Doomscroll block
      const db = state.doomscroll.blocked[hostname];
      if (db && db.blockedUntil > Date.now()) return { blocked: true, mode: 'doomscroll', blockedUntil: db.blockedUntil };
      if (db && db.blockedUntil <= Date.now()) {
        delete state.doomscroll.blocked[hostname];
        await setState(state);
      }
      return { blocked: false };
    }

    case 'TRACK_SCREEN_TIME': {
      const { domain, seconds } = msg;
      if (!domain || seconds <= 0) return { ok: true };
      const today = dateKey();
      if (!state.screenTime[today]) state.screenTime[today] = {};
      state.screenTime[today][domain] = (state.screenTime[today][domain] || 0) + seconds;
      // Keep 30 days
      const cutoff = dateKey(-30);
      for (const k of Object.keys(state.screenTime)) { if (k < cutoff) delete state.screenTime[k]; }
      await setState(state);
      return { ok: true };
    }

    case 'GET_DOOMSCROLL_TIME': {
      const today = dateKey();
      const secs = ((state.screenTime[today] || {})['ds:' + msg.domain]) || 0;
      return { seconds: secs, limitSeconds: (state.doomscroll.limitMinutes || 10) * 60 };
    }

    case 'TRACK_DOOMSCROLL_TIME': {
      const { domain, seconds } = msg;
      if (!domain || seconds <= 0) return { exceeded: false };
      const today = dateKey();
      const key = 'ds:' + domain;
      if (!state.screenTime[today]) state.screenTime[today] = {};
      state.screenTime[today][key] = (state.screenTime[today][key] || 0) + seconds;
      await setState(state);
      const limit = (state.doomscroll.limitMinutes || 10) * 60;
      const total = state.screenTime[today][key];
      return { exceeded: total >= limit, total, limit };
    }

    case 'DOOMSCROLL_EXCEEDED': {
      const { domain } = msg;
      const punishMs = (state.doomscroll.punishmentMinutes || 3) * 60 * 1000;
      const until = Date.now() + punishMs;
      state.doomscroll.blocked[domain] = { blockedUntil: until };
      await setState(state);
      // Redirect tabs on this domain
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        try {
          const h = new URL(tab.url).hostname.replace(/^www\./, '');
          if (h === domain || h.endsWith('.' + domain) || domain.endsWith('.' + h)) {
            chrome.tabs.update(tab.id, {
              url: chrome.runtime.getURL('blocked.html') + `?site=${encodeURIComponent(domain)}&mode=doomscroll&until=${until}`
            });
          }
        } catch {}
      }
      return { ok: true, blockedUntil: until };
    }

    case 'RESET_DOOMSCROLL_TODAY': {
      const today = dateKey();
      const key = 'ds:' + msg.domain;
      if (state.screenTime[today]) delete state.screenTime[today][key];
      delete state.doomscroll.blocked[msg.domain];
      await setState(state);
      return { ok: true };
    }

    case 'CLEAR_STATS':
      state.stats = { heatmap: {}, streakDays: 0, lastActiveDate: null, totalSessions: 0, totalFocusMinutes: 0 };
      state.screenTime = {};
      await setState(state);
      return { ok: true };

    case 'FLUSH_TABS':
      // Ask all social-media tabs to flush their pending screen time right now
      try {
        const tabs = await chrome.tabs.query({ url: ['*://*.youtube.com/*','*://*.twitter.com/*','*://*.x.com/*',
          '*://*.instagram.com/*','*://*.facebook.com/*','*://*.tiktok.com/*',
          '*://*.reddit.com/*','*://*.twitch.tv/*','*://*.snapchat.com/*','*://*.linkedin.com/*'] });
        const flushes = tabs.map(tab =>
          chrome.tabs.sendMessage(tab.id, { type: 'FLUSH_NOW' }).catch(() => null)
        );
        await Promise.all(flushes);
      } catch {}
      return { ok: true };

    case 'SAVE_PREFERENCES':
      state.preferences = { ...state.preferences, ...msg.preferences };
      await setState(state);
      return { ok: true };

    default: return { error: 'Unknown message' };
  }
}

// ── NAVIGATION BLOCKING ───────────────────────────────
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (details.url.startsWith(chrome.runtime.getURL(''))) return;
  const state = await getState();
  let hostname;
  try { hostname = new URL(details.url).hostname.replace(/^www\./, ''); } catch { return; }

  if (state.session.active && state.session.mode === 'focus') {
    const hit = state.blocklist.some(s => hostname.endsWith(s.replace(/^www\./, '')));
    if (hit) {
      chrome.tabs.update(details.tabId, {
        url: chrome.runtime.getURL('blocked.html') + `?site=${encodeURIComponent(hostname)}&mode=focus`
      });
      return;
    }
  }
  const db = state.doomscroll.blocked[hostname];
  if (db && db.blockedUntil > Date.now()) {
    chrome.tabs.update(details.tabId, {
      url: chrome.runtime.getURL('blocked.html') + `?site=${encodeURIComponent(hostname)}&mode=doomscroll&until=${db.blockedUntil}`
    });
  }
});

// Handle SPA navigation (YouTube, Twitter, etc.)
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  // Re-check blocking for new URL
  const state = await getState();
  if (!state.session.active || state.session.mode !== 'focus') return;
  let hostname;
  try { hostname = new URL(details.url).hostname.replace(/^www\./, ''); } catch { return; }
  const hit = state.blocklist.some(s => hostname.endsWith(s.replace(/^www\./, '')));
  if (hit) {
    chrome.tabs.update(details.tabId, {
      url: chrome.runtime.getURL('blocked.html') + `?site=${encodeURIComponent(hostname)}&mode=focus`
    });
  }
});

// ── HELPERS ───────────────────────────────────────────
async function getState() {
  const { flowState } = await chrome.storage.local.get('flowState');
  return flowState ? JSON.parse(JSON.stringify(flowState)) : JSON.parse(JSON.stringify(DEFAULT_STATE));
}
async function setState(s) { await chrome.storage.local.set({ flowState: s }); }

function broadcast(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

async function broadcastToTabs(msg) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
    }
  }
}

function dateKey(offset = 0) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return d.toISOString().split('T')[0];
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message }).catch(() => {});
}
