// Flow Background Service Worker v3.0

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
    paused: false,
    pausedAt: null,
  },
  blocklist: [
    'youtube.com','twitter.com','x.com','instagram.com',
    'facebook.com','tiktok.com','reddit.com','netflix.com','twitch.tv',
  ],
  blockingEnabled: false, // manual blocker toggle (independent of focus session)
  doomscroll: {
    limitMinutes: 10,
    punishmentMinutes: 3,
    blocked: {},
  },
  screenTime: {},
  stats: {
    heatmap: {},
    streakDays: 0,
    lastVictoryDate: null,
    totalSessions: 0,
    totalFocusMinutes: 0,
    lastPipsResetDate: null,
    pipsCompleted: 0,
    // Daily KPIs (reset each day)
    dailySessions: 0,
    dailyFocusMinutes: 0,
    lastKpiResetDate: null,
  },
};

// ── INIT ──────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const { flowState } = await chrome.storage.local.get('flowState');
  if (!flowState) {
    await chrome.storage.local.set({ flowState: DEFAULT_STATE });
    // Also init sync storage for streak
    await chrome.storage.sync.set({ streak: { streakDays: 0, lastVictoryDate: null } });
  }
  resetAlarms();
});

chrome.runtime.onStartup.addListener(resetAlarms);

function resetAlarms() {
  chrome.alarms.clearAll(() => {
    chrome.alarms.create('flowTick',   { periodInMinutes: 1/60 });
    chrome.alarms.create('keepAlive',  { periodInMinutes: 0.4 });
    chrome.alarms.create('dailyReset', { periodInMinutes: 60 });
  });
}

// ── ALARMS ────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepAlive') return;

  if (alarm.name === 'dailyReset') {
    const state = await getState();
    const cutoff = dateKey(-30);
    let pruned = false;
    for (const k of Object.keys(state.screenTime || {})) {
      if (k < cutoff) { delete state.screenTime[k]; pruned = true; }
    }
    // Reset pips if it's a new day
    const today = dateKey();
    if (state.stats.lastPipsResetDate !== today) {
      state.stats.pipsCompleted = 0;
      state.stats.lastPipsResetDate = today;
      pruned = true;
    }
    if (pruned) await setState(state);
    return;
  }

  if (alarm.name !== 'flowTick') return;
  const state = await getState();
  if (!state.session.active) return;

  const elapsed = Math.floor((Date.now() - state.session.startTime) / 1000);
  const durationSec = state.session.mode === 'focus'
    ? state.session.focusDuration * 60
    : state.session.breakDuration * 60;

  // Freeze timer while paused
  if (state.session.paused) return;

  if (elapsed >= durationSec) {
    await handleSessionComplete(state);
  } else {
    broadcast({ type: 'TICK', elapsed, durationSec, mode: state.session.mode, session: state.session });
    broadcastToTabs({ type: 'TICK', elapsed, durationSec, mode: state.session.mode, session: state.session });
  }
});

// ── SESSION COMPLETE ───────────────────────────────────
async function handleSessionComplete(state) {
  if (state.session.mode === 'focus') {
    const today = dateKey();
    const mins = state.session.focusDuration;
    state.stats.heatmap[today] = (state.stats.heatmap[today] || 0) + mins;
    state.stats.totalSessions += 1;
    state.stats.totalFocusMinutes = (state.stats.totalFocusMinutes || 0) + mins;
    // Daily KPI reset
    const todayForKpi = dateKey();
    if (state.stats.lastKpiResetDate !== todayForKpi) {
      state.stats.dailySessions = 0;
      state.stats.dailyFocusMinutes = 0;
      state.stats.lastKpiResetDate = todayForKpi;
    }
    state.stats.dailySessions = (state.stats.dailySessions || 0) + 1;
    state.stats.dailyFocusMinutes = (state.stats.dailyFocusMinutes || 0) + mins;
    state.session.sessionsCompleted = (state.session.sessionsCompleted || 0) + 1;

    // Daily pips: track completed sessions today (resets at midnight)
    if (state.stats.lastPipsResetDate !== today) {
      state.stats.pipsCompleted = 0;
      state.stats.lastPipsResetDate = today;
    }
    state.stats.pipsCompleted = (state.stats.pipsCompleted || 0) + 1;

    // ── STREAK (sync storage, proper logic) ──
    await updateStreak();

    state.session.mode = 'break';
    state.session.startTime = Date.now();
    const round = state.session.sessionsCompleted % 4 || 4;
    broadcastToTabs({ type: 'TAB_TOAST', emoji: '✓', title: `Round ${round}/4 done`, sub: `${mins}m focused · ${state.session.breakDuration}m break` });
    broadcast({ type: 'TOAST', emoji: '✓', title: `Round ${round}/4 done`, sub: `${mins}m focused · ${state.session.breakDuration}m break` });

  } else {
    const completed = state.session.sessionsCompleted || 0;
    if (completed > 0 && completed % 4 === 0) {
      state.session.active = false;
      state.session.mode = 'focus';
      state.session.startTime = null;
      state.session.sessionsCompleted = 0;
      broadcastToTabs({ type: 'TAB_TOAST', emoji: '🎉', title: 'Cycle complete!', sub: 'You finished 4 sessions. Great work!' });
      broadcast({ type: 'TOAST', emoji: '🎉', title: 'Cycle complete!', sub: 'You finished 4 sessions. Great work!' });
    } else {
      state.session.mode = 'focus';
      state.session.startTime = Date.now();
      broadcastToTabs({ type: 'TAB_TOAST', emoji: '▶', title: 'Break over', sub: `Session ${(completed % 4) + 1}/4 starting` });
      broadcast({ type: 'TOAST', emoji: '▶', title: 'Break over', sub: `Session ${(completed % 4) + 1}/4 starting` });
    }
  }

  await setState(state);
  broadcast({ type: 'SESSION_UPDATE', session: state.session, stats: state.stats });
  broadcastToTabs({ type: 'SESSION_UPDATE', session: state.session });
}

// ── STREAK (chrome.storage.sync) ──────────────────────
async function updateStreak() {
  const today = dateKey();
  const yesterday = dateKey(-1);
  let { streak } = await chrome.storage.sync.get('streak');
  if (!streak) streak = { streakDays: 0, lastVictoryDate: null };

  if (streak.lastVictoryDate === today) {
    // Already got credit today — nothing to do
  } else if (streak.lastVictoryDate === yesterday) {
    streak.streakDays += 1;
    streak.lastVictoryDate = today;
  } else {
    // Missed a day or first ever session
    streak.streakDays = 1;
    streak.lastVictoryDate = today;
  }
  await chrome.storage.sync.set({ streak });
  return streak;
}

// Compute the VISUAL streak (don't mutate storage)
async function getVisualStreak() {
  const today = dateKey();
  const yesterday = dateKey(-1);
  let { streak } = await chrome.storage.sync.get('streak');
  if (!streak) return 0;
  // If they haven't completed a session since yesterday, show 0
  if (streak.lastVictoryDate !== today && streak.lastVictoryDate !== yesterday) return 0;
  return streak.streakDays;
}

// ── MESSAGES ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch(e => sendResponse({ error: e.message }));
  return true;
});

async function handle(msg) {
  const state = await getState();

  switch (msg.type) {
    case 'GET_STATE': {
      const today = dateKey();
      // Migrate old states missing daily fields
      if (state.stats.dailySessions === undefined) state.stats.dailySessions = 0;
      if (state.stats.dailyFocusMinutes === undefined) state.stats.dailyFocusMinutes = 0;
      if (!state.stats.lastKpiResetDate) state.stats.lastKpiResetDate = today;
      // Visual pip reset
      if (state.stats.lastPipsResetDate !== today) state.stats.pipsCompleted = 0;
      // Visual daily KPI reset (read-only — don't persist here)
      if (state.stats.lastKpiResetDate !== today) {
        state.stats.dailySessions = 0;
        state.stats.dailyFocusMinutes = 0;
      }
      state.stats.streakDays = await getVisualStreak();
      return state;
    }

    case 'START_SESSION':
      state.session.active = true;
      state.session.mode = 'focus';
      state.session.startTime = Date.now();
      state.session.focusDuration = msg.focusDuration ?? 25;
      state.session.breakDuration = msg.breakDuration ?? 5;
      state.session.strictMode = msg.strictMode ?? false;
      await setState(state);
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

    case 'SKIP_STRICT': {
      // Emergency override — bypass strict mode
      state.session.active = false;
      state.session.mode = 'focus';
      state.session.startTime = null;
      state.session.strictMode = false;
      await setState(state);
      broadcastToTabs({ type: 'SESSION_ENDED' });
      return { ok: true };
    }

    case 'UPDATE_BLOCKLIST':
      state.blocklist = msg.blocklist;
      await setState(state);
      return { ok: true };

    case 'TOGGLE_BLOCKING':
      state.blockingEnabled = msg.enabled;
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

      // Focus session blocking
      if (state.session.active && state.session.mode === 'focus') {
        const hit = state.blocklist.some(s => hostname.endsWith(s.replace(/^www\./, '')));
        if (hit) return { blocked: true, mode: 'focus', strictMode: state.session.strictMode };
      }

      // Manual blocker toggle (always-on blocking independent of session)
      if (!state.session.active && state.blockingEnabled) {
        const hit = state.blocklist.some(s => hostname.endsWith(s.replace(/^www\./, '')));
        if (hit) return { blocked: true, mode: 'manual' };
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
      return { exceeded: state.screenTime[today][key] >= limit };
    }

    case 'DOOMSCROLL_EXCEEDED': {
      const { domain } = msg;
      const punishMs = (state.doomscroll.punishmentMinutes || 3) * 60 * 1000;
      const until = Date.now() + punishMs;
      state.doomscroll.blocked[domain] = { blockedUntil: until };
      await setState(state);
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
      state.stats = { heatmap: {}, streakDays: 0, lastVictoryDate: null, totalSessions: 0, totalFocusMinutes: 0, pipsCompleted: 0, lastPipsResetDate: null };
      state.screenTime = {};
      await chrome.storage.sync.set({ streak: { streakDays: 0, lastVictoryDate: null } });
      await setState(state);
      return { ok: true };

    case 'FLUSH_TABS':
      try {
        const tabs = await chrome.tabs.query({});
        await Promise.all(tabs.map(tab =>
          chrome.tabs.sendMessage(tab.id, { type: 'FLUSH_NOW' }).catch(() => null)
        ));
      } catch {}
      return { ok: true };

    case 'SET_PAUSE':
      state.session.paused    = msg.paused;
      state.session.pausedAt  = msg.pausedAt || null;
      if (msg.startTime) state.session.startTime = msg.startTime;
      await setState(state);
      broadcast({ type: 'SESSION_UPDATE', session: state.session, stats: state.stats });
      broadcastToTabs({ type: 'SESSION_UPDATE', session: state.session });
      return { ok: true };

    case 'SAVE_PREFERENCES':
      state.preferences = { ...state.preferences, ...msg.preferences };
      await setState(state);
      return { ok: true };

    default: return { error: 'Unknown message' };
  }
}

// ── NAVIGATION BLOCKING ────────────────────────────────
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (details.url.startsWith(chrome.runtime.getURL(''))) return;
  const state = await getState();
  let hostname;
  try { hostname = new URL(details.url).hostname.replace(/^www\./, ''); } catch { return; }

  // Session focus block
  if (state.session.active && state.session.mode === 'focus') {
    const hit = state.blocklist.some(s => hostname.endsWith(s.replace(/^www\./, '')));
    if (hit) {
      chrome.tabs.update(details.tabId, {
        url: chrome.runtime.getURL('blocked.html') + `?site=${encodeURIComponent(hostname)}&mode=focus&strict=${state.session.strictMode}`
      });
      return;
    }
  }

  // Manual blocker
  if (!state.session.active && state.blockingEnabled) {
    const hit = state.blocklist.some(s => hostname.endsWith(s.replace(/^www\./, '')));
    if (hit) {
      chrome.tabs.update(details.tabId, {
        url: chrome.runtime.getURL('blocked.html') + `?site=${encodeURIComponent(hostname)}&mode=manual`
      });
      return;
    }
  }

  // Doomscroll block
  const db = state.doomscroll.blocked[hostname];
  if (db && db.blockedUntil > Date.now()) {
    chrome.tabs.update(details.tabId, {
      url: chrome.runtime.getURL('blocked.html') + `?site=${encodeURIComponent(hostname)}&mode=doomscroll&until=${db.blockedUntil}`
    });
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const state = await getState();
  if (!state.session.active || state.session.mode !== 'focus') return;
  let hostname;
  try { hostname = new URL(details.url).hostname.replace(/^www\./, ''); } catch { return; }
  if (state.blocklist.some(s => hostname.endsWith(s.replace(/^www\./, '')))) {
    chrome.tabs.update(details.tabId, {
      url: chrome.runtime.getURL('blocked.html') + `?site=${encodeURIComponent(hostname)}&mode=focus&strict=${state.session.strictMode}`
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
