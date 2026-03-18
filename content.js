// Flow Content Script v2.3

if (window.location.href.startsWith(chrome.runtime.getURL(''))) {
  throw new Error('skip');
}

const hostname = window.location.hostname.replace(/^www\./, '');

const SOCIAL_SITES = [
  'youtube.com','twitter.com','x.com','instagram.com',
  'facebook.com','tiktok.com','reddit.com','twitch.tv','snapchat.com','linkedin.com'
];

const isSocial = SOCIAL_SITES.some(s => hostname === s || hostname.endsWith('.' + s));

// ─── MESSAGING ──────────────────────────────────────
function safeSend(msg) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, r => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(r || null);
      });
    } catch { resolve(null); }
  });
}

// ─── BLOCK CHECK ON LOAD ────────────────────────────
(async () => {
  const r = await safeSend({ type: 'CHECK_BLOCKED', url: window.location.href });
  if (r && r.blocked) {
    const p = new URLSearchParams({
      site: hostname, mode: r.mode || 'focus',
      ...(r.blockedUntil ? { until: r.blockedUntil } : {})
    });
    window.location.replace(chrome.runtime.getURL('blocked.html') + '?' + p);
  }
})();

// ─── SCREEN TIME + DOOMSCROLL ────────────────────────
if (isSocial) {
  let screenSecs  = 0;
  let doomSecs    = 0;
  let doomBlocked = false;
  let scrollActive = false;
  let scrollTimer  = null;

  // Count 1 second of visibility every tick
  setInterval(() => {
    if (document.hidden || doomBlocked) return;
    screenSecs += 1;
    if (scrollActive) doomSecs += 1;
  }, 1000);

  // Flush to background every 5 seconds (reduced from 10)
  async function flush() {
    if (screenSecs > 0) {
      const s = screenSecs;
      screenSecs = 0;
      await safeSend({ type: 'TRACK_SCREEN_TIME', domain: hostname, seconds: s });
    }
    if (doomSecs > 0 && !doomBlocked) {
      const d = doomSecs;
      doomSecs = 0;
      const resp = await safeSend({ type: 'TRACK_DOOMSCROLL_TIME', domain: hostname, seconds: d });
      if (resp && resp.exceeded) {
        doomBlocked = true;
        await safeSend({ type: 'DOOMSCROLL_EXCEEDED', domain: hostname });
      }
    }
  }

  setInterval(flush, 5000);

  // Flush on page leave
  window.addEventListener('beforeunload', flush);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  // Scroll detection — capture phase catches all scroll containers (Twitter, Instagram, TikTok)
  function onScroll() {
    if (doomBlocked) return;
    scrollActive = true;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { scrollActive = false; }, 2000);
  }

  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('scroll', onScroll, { passive: true });

  // Touch for mobile-style feeds
  let touchStartY = 0;
  document.addEventListener('touchstart', e => { touchStartY = e.touches[0]?.clientY ?? 0; }, { passive: true, capture: true });
  document.addEventListener('touchmove', e => {
    if (Math.abs((e.touches[0]?.clientY ?? 0) - touchStartY) > 10) onScroll();
  }, { passive: true, capture: true });

  // Restore doomscroll state on reload
  safeSend({ type: 'GET_DOOMSCROLL_TIME', domain: hostname }).then(r => {
    if (r && r.seconds >= r.limitSeconds) doomBlocked = true;
  });

  // ── Listen for flush request from popup ──────────
  // When the popup opens it tells all tabs to flush immediately
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'FLUSH_NOW') {
      flush().then(() => sendResponse({ ok: true }));
      return true; // async response
    }
  });
}

// ─── FLOATING TIMER ─────────────────────────────────
let floatEl   = null;
let shadow    = null;
let tickTimer = null;
let session   = null;
let dragging  = false;
let dX = 0, dY = 0;

async function initFloat() {
  const state = await safeSend({ type: 'GET_STATE' });
  if (state?.session?.active) { session = state.session; showFloat(); }
}

function showFloat() {
  if (floatEl) { updateFloat(); return; }

  floatEl = document.createElement('div');
  floatEl.id = '__flow_float__';
  Object.assign(floatEl.style, {
    position: 'fixed', bottom: '24px', right: '24px',
    zIndex: '2147483647', userSelect: 'none',
  });
  document.documentElement.appendChild(floatEl);
  shadow = floatEl.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .pill {
      display:flex; align-items:center; gap:8px;
      background:rgba(255,255,255,0.95);
      border:1px solid rgba(63,109,133,0.18);
      border-radius:50px;
      padding:9px 17px 9px 13px;
      box-shadow:0 4px 20px rgba(63,109,133,0.18);
      font-family:-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;
      -webkit-font-smoothing:antialiased;
      cursor:grab;
    }
    .pill:hover{opacity:0.88;}
    .pill:active{cursor:grabbing;}
    .dot{width:7px;height:7px;border-radius:50%;background:#3F6D85;flex-shrink:0;animation:p 2s ease-in-out infinite;}
    .dot.brk{background:#34A853;}
    @keyframes p{0%,100%{opacity:1}50%{opacity:0.4}}
    .mode{font-size:10px;font-weight:700;letter-spacing:.9px;color:#7F9AAA;}
    .time{font-size:15px;font-weight:700;letter-spacing:-.4px;color:#1A2B35;font-variant-numeric:tabular-nums;min-width:42px;}
  `;

  const pill = document.createElement('div');
  pill.className = 'pill';
  const dot  = Object.assign(document.createElement('span'), { className:'dot', id:'fd' });
  const mode = Object.assign(document.createElement('span'), { className:'mode', id:'fm', textContent:'FOCUS' });
  const time = Object.assign(document.createElement('span'), { className:'time', id:'ft', textContent:'--:--' });
  pill.append(dot, mode, time);
  shadow.append(style, pill);

  pill.addEventListener('mousedown', e => {
    dragging = true;
    const r = floatEl.getBoundingClientRect();
    dX = e.clientX - r.left; dY = e.clientY - r.top;
    floatEl.style.cssText += ';bottom:auto;right:auto;left:' + r.left + 'px;top:' + r.top + 'px';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    floatEl.style.left = (e.clientX - dX) + 'px';
    floatEl.style.top  = (e.clientY - dY) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  tickTimer = setInterval(updateFloat, 1000);
  updateFloat();
}

function hideFloat() {
  clearInterval(tickTimer); tickTimer = null;
  floatEl?.remove(); floatEl = null; shadow = null;
}

function updateFloat() {
  if (!shadow || !session) return;
  const s = session;
  const elapsed = s.startTime ? Math.floor((Date.now() - s.startTime) / 1000) : 0;
  const total   = (s.mode === 'focus' ? s.focusDuration : s.breakDuration) * 60;
  const rem     = Math.max(0, total - elapsed);
  const mm = String(Math.floor(rem / 60)).padStart(2, '0');
  const ss = String(rem % 60).padStart(2, '0');
  const isBreak = s.mode === 'break';
  const ft = shadow.getElementById('ft');
  const fm = shadow.getElementById('fm');
  const fd = shadow.getElementById('fd');
  if (ft) ft.textContent = `${mm}:${ss}`;
  if (fm) fm.textContent = isBreak ? 'BREAK' : 'FOCUS';
  if (fd) fd.className = 'dot' + (isBreak ? ' brk' : '');
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'SESSION_STARTED' || msg.type === 'SESSION_UPDATE') {
    if (msg.session) { session = msg.session; showFloat(); }
  }
  if (msg.type === 'SESSION_ENDED') { session = null; hideFloat(); }
  if (msg.type === 'TICK' && msg.session) { session = msg.session; updateFloat(); }
});

initFloat();
