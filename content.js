// Flow Content Script v3.1

if (window.location.href.startsWith(chrome.runtime.getURL(''))) {
  throw new Error('skip');
}

const hostname = window.location.hostname.replace(/^www\./, '');

const SOCIAL_SITES = [
  'youtube.com','twitter.com','x.com','instagram.com',
  'facebook.com','tiktok.com','reddit.com','twitch.tv','snapchat.com','linkedin.com'
];

const isSocial = SOCIAL_SITES.some(s => hostname === s || hostname.endsWith('.' + s));

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

// ── BLOCK CHECK ──────────────────────────────────────
(async () => {
  const r = await safeSend({ type: 'CHECK_BLOCKED', url: window.location.href });
  if (r && r.blocked) {
    const p = new URLSearchParams({
      site: hostname,
      mode: r.mode || 'focus',
      ...(r.blockedUntil ? { until: r.blockedUntil } : {}),
      ...(r.strictMode ? { strict: 'true' } : {}),
    });
    window.location.replace(chrome.runtime.getURL('blocked.html') + '?' + p);
  }
})();

// ── SCREEN TIME ──────────────────────────────────────
let screenSecs = 0;

setInterval(() => { if (!document.hidden) screenSecs += 1; }, 1000);

setInterval(async () => {
  if (screenSecs > 0) {
    const s = screenSecs; screenSecs = 0;
    await safeSend({ type: 'TRACK_SCREEN_TIME', domain: hostname, seconds: s });
  }
}, 10000);

const flushScreen = () => {
  if (screenSecs > 0) {
    safeSend({ type: 'TRACK_SCREEN_TIME', domain: hostname, seconds: screenSecs });
    screenSecs = 0;
  }
};
window.addEventListener('beforeunload', flushScreen);
window.addEventListener('pagehide', flushScreen);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    flushScreen();
    // Hide float while tab is in background (performance)
    if (floatEl) floatEl.style.display = 'none';
  } else {
    // Restore float when tab becomes active again
    if (floatEl) floatEl.style.display = '';
    else if (session?.active) showFloat();
  }
});

// ── DOOMSCROLL ───────────────────────────────────────
if (isSocial) {
  let doomSecs = 0, scrolling = false, scrollTimer = null, doomBlocked = false;

  setInterval(() => { if (!document.hidden && scrolling && !doomBlocked) doomSecs += 1; }, 1000);
  // Flush every 2 seconds so the limit triggers within ~2s of the threshold
  setInterval(async () => {
    if (doomSecs > 0 && !doomBlocked) {
      const d = doomSecs; doomSecs = 0;
      const resp = await safeSend({ type: 'TRACK_DOOMSCROLL_TIME', domain: hostname, seconds: d });
      if (resp && resp.exceeded) { doomBlocked = true; await safeSend({ type: 'DOOMSCROLL_EXCEEDED', domain: hostname }); }
    }
  }, 2000);

  function onScroll() {
    if (doomBlocked) return;
    scrolling = true; clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { scrolling = false; }, 2000);
  }
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('scroll', onScroll, { passive: true });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'FLUSH_NOW') {
      Promise.all([
        screenSecs > 0 ? safeSend({ type: 'TRACK_SCREEN_TIME', domain: hostname, seconds: screenSecs }) : null,
        doomSecs > 0 ? safeSend({ type: 'TRACK_DOOMSCROLL_TIME', domain: hostname, seconds: doomSecs }) : null,
      ]).then(() => { screenSecs = 0; doomSecs = 0; sendResponse({ ok: true }); });
      return true;
    }
    // Pass to shared listener below
  });

  safeSend({ type: 'GET_DOOMSCROLL_TIME', domain: hostname }).then(r => {
    if (r && r.seconds >= r.limitSeconds) doomBlocked = true;
  });
} else {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'FLUSH_NOW') {
      if (screenSecs > 0) { safeSend({ type: 'TRACK_SCREEN_TIME', domain: hostname, seconds: screenSecs }); screenSecs = 0; }
      sendResponse({ ok: true });
    }
  });
}

// ══════════════════════════════════════════════════════
// FLOATING TIMER — works on ALL websites, both focus & break
// ══════════════════════════════════════════════════════
let floatEl = null, shadow = null, tickTimer = null, session = null;
let dragging = false, dX = 0, dY = 0;

async function initFloat() {
  const state = await safeSend({ type: 'GET_STATE' });
  if (state?.session?.active) { session = state.session; showFloat(); }
}

function showFloat() {
  // Only render float on the active (visible) tab
  if (document.hidden) return;
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
      border:1px solid rgba(63,109,133,0.20);
      border-radius:50px;
      padding:9px 17px 9px 13px;
      box-shadow:0 4px 20px rgba(63,109,133,0.20);
      font-family:-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;
      -webkit-font-smoothing:antialiased;
      cursor:grab;
      transition: box-shadow 0.15s;
    }
    .pill:hover { box-shadow:0 6px 24px rgba(63,109,133,0.30); }
    .pill:active { cursor:grabbing; }
    .dot {
      width:7px; height:7px; border-radius:50%;
      background:#3F6D85; flex-shrink:0;
      animation:p 2s ease-in-out infinite;
    }
    .dot.brk { background:#34A853; animation-name:pb; }
    @keyframes p  { 0%,100%{opacity:1} 50%{opacity:0.35} }
    @keyframes pb { 0%,100%{opacity:1} 50%{opacity:0.35} }
    .mode { font-size:10px; font-weight:700; letter-spacing:.9px; color:#7F9AAA; }
    .time { font-size:15px; font-weight:700; letter-spacing:-.4px; color:#1A2B35; font-variant-numeric:tabular-nums; min-width:42px; }
  `;

  const pill = document.createElement('div'); pill.className = 'pill';
  const dot  = Object.assign(document.createElement('span'), { className:'dot', id:'fd' });
  const mode = Object.assign(document.createElement('span'), { className:'mode', id:'fm', textContent:'FOCUS' });
  const time = Object.assign(document.createElement('span'), { className:'time', id:'ft', textContent:'--:--' });
  pill.append(dot, mode, time);
  shadow.append(style, pill);

  pill.addEventListener('mousedown', e => {
    dragging = true;
    const r = floatEl.getBoundingClientRect();
    dX = e.clientX - r.left; dY = e.clientY - r.top;
    Object.assign(floatEl.style, { bottom:'auto', right:'auto', left: r.left+'px', top: r.top+'px' });
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    floatEl.style.left = (e.clientX - dX) + 'px';
    floatEl.style.top  = (e.clientY - dY) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  // Tick every second — keeps running through focus AND break
  clearInterval(tickTimer);
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
  const isBreak = s.mode === 'break';
  const ft = shadow.getElementById('ft');
  const fm = shadow.getElementById('fm');
  const fd = shadow.getElementById('fd');
  if (ft) ft.textContent = `${String(Math.floor(rem/60)).padStart(2,'0')}:${String(rem%60).padStart(2,'0')}`;
  if (fm) fm.textContent = isBreak ? 'BREAK' : 'FOCUS';
  if (fd) fd.className   = 'dot' + (isBreak ? ' brk' : '');
}

// ── TOAST BANNER — shown on any active tab when session phase changes ──
function showTabToast(emoji, title, sub) {
  // Only show toast on the currently visible tab
  if (document.hidden) return;
  const existing = document.getElementById('__flow_toast__');
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = '__flow_toast__';
  Object.assign(host.style, {
    position: 'fixed', bottom: '80px', left: '50%',
    transform: 'translateX(-50%) translateY(40px)',
    zIndex: '2147483647', pointerEvents: 'none',
    opacity: '0', transition: 'transform 0.35s cubic-bezier(0.34,1.56,0.64,1), opacity 0.25s ease',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
    webkitFontSmoothing: 'antialiased',
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    display: 'flex', alignItems: 'center', gap: '12px',
    background: 'rgba(26,43,53,0.96)',
    color: '#fff',
    borderRadius: '16px',
    padding: '12px 20px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.28)',
    minWidth: '220px', maxWidth: '320px',
    whiteSpace: 'nowrap',
  });

  const e = document.createElement('span');
  e.textContent = emoji;
  Object.assign(e.style, { fontSize: '22px', lineHeight: '1', flexShrink: '0' });

  const body = document.createElement('div');
  Object.assign(body.style, { display:'flex', flexDirection:'column', gap:'2px', overflow:'hidden' });

  const t = document.createElement('div');
  t.textContent = title;
  Object.assign(t.style, { fontSize:'13px', fontWeight:'700', letterSpacing:'-0.2px' });

  const s = document.createElement('div');
  s.textContent = sub;
  Object.assign(s.style, { fontSize:'11px', opacity:'0.65', overflow:'hidden', textOverflow:'ellipsis' });

  body.append(t, s);
  card.append(e, body);
  host.appendChild(card);
  document.documentElement.appendChild(host);

  // Animate in
  requestAnimationFrame(() => requestAnimationFrame(() => {
    host.style.transform = 'translateX(-50%) translateY(0)';
    host.style.opacity   = '1';
  }));

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    host.style.transform = 'translateX(-50%) translateY(40px)';
    host.style.opacity   = '0';
    host.addEventListener('transitionend', () => host.remove(), { once: true });
  }, 5000);
}

// ── MESSAGE LISTENER ─────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'SESSION_STARTED' || msg.type === 'SESSION_UPDATE') {
    if (msg.session) {
      const wasActive = session?.active;
      session = msg.session;
      if (msg.session.active) showFloat();
      else if (!msg.session.active && wasActive) hideFloat();
      else updateFloat(); // mode changed (focus→break or break→focus)
    }
  }
  if (msg.type === 'SESSION_ENDED') { session = null; hideFloat(); }
  if (msg.type === 'TICK') {
    // TICK carries session so we always have fresh mode/startTime
    if (msg.session) session = msg.session;
    updateFloat();
  }
  if (msg.type === 'TAB_TOAST') {
    showTabToast(msg.emoji, msg.title, msg.sub);
  }
});

initFloat();
