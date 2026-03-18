// Flow Popup v2.1

let state = null;
let localFocus = 25, localBreak = 5, localDoom = 10, localPunish = 3;
let tickLoop = null;

// ── BOOT ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Tell all social-media tabs to flush pending screen time NOW
  //    before we read state, so the popup sees fresh data immediately.
  await bg({ type: 'FLUSH_TABS' });

  // 2. Load fresh state (includes just-flushed screen time)
  state = await bg({ type: 'GET_STATE' });
  // Load from saved preferences (persisted across opens)
  // Fall back to session values, then hardcoded defaults
  localFocus  = state.preferences?.focusDuration ?? state.session.focusDuration ?? 25;
  localBreak  = state.preferences?.breakDuration ?? state.session.breakDuration ?? 5;
  localDoom   = state.doomscroll?.limitMinutes ?? 10;
  localPunish = state.doomscroll?.punishmentMinutes ?? 3;

  setupTabs();
  wire();
  syncSliders();   // restore slider positions from saved preferences
  render();
  startTick();
  startDataPoll();   // keep all data fresh while popup is open

  chrome.runtime.onMessage.addListener(onBgMessage);
});

function onBgMessage(msg) {
  if (msg.type === 'SESSION_UPDATE') {
    state.session = msg.session;
    if (msg.stats) state.stats = msg.stats;
    renderFocus();
    renderBlockerStatus();
    renderStats();
  }
  if (msg.type === 'TICK') {
    renderTimerDisplay();
  }
}

// ── TABS ──────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.nav-item').forEach(t => {
    t.addEventListener('click', async () => {
      document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('panel-' + t.dataset.tab).classList.add('active');
      movePill(t);

      // On switching to screen time or stats — flush tabs and refresh immediately
      if (t.dataset.tab === 'screentime' || t.dataset.tab === 'stats') {
        await bg({ type: 'FLUSH_TABS' });
        const fresh = await bg({ type: 'GET_STATE' });
        if (fresh) { state = fresh; renderScreenTime(); renderStats(); }
      }
    });
  });

  // Position pill on initial load
  const activeTab = document.querySelector('.nav-item.active');
  if (activeTab) {
    // Use rAF so layout is settled before measuring
    requestAnimationFrame(() => movePill(activeTab, true));
  }
}

function movePill(tab, instant) {
  const pill = document.getElementById('nav-pill');
  if (!pill || !tab) return;
  const nav     = tab.closest('.nav');
  const navRect = nav.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();

  const left   = tabRect.left  - navRect.left;
  const top    = tabRect.top   - navRect.top;
  const width  = tabRect.width;
  const height = tabRect.height;

  if (instant) {
    pill.style.transition = 'none';
    pill.style.left   = left   + 'px';
    pill.style.top    = top    + 'px';
    pill.style.width  = width  + 'px';
    pill.style.height = height + 'px';
    requestAnimationFrame(() => { pill.style.transition = ''; });
  } else {
    pill.style.left   = left   + 'px';
    pill.style.top    = top    + 'px';
    pill.style.width  = width  + 'px';
    pill.style.height = height + 'px';
  }
}

// ── WIRE ALL LISTENERS ────────────────────────────────
function wire() {
  // Focus
  document.getElementById('btn-start').addEventListener('click', startSession);
  document.getElementById('btn-stop').addEventListener('click', stopSession);
  // Focus & Break sliders
  setupSlider('focus-slider',  'focus-fill',   'focus-tooltip',   'focus-val',   'focus-ticks',
    [5,15,25,45,60,90,120], v => {
      localFocus = v;
      renderTimerDisplay();
      bg({ type: 'SAVE_PREFERENCES', preferences: { focusDuration: v } });
    });
  setupSlider('break-slider',  'break-fill',   'break-tooltip',   'break-val',   'break-ticks',
    [1,5,10,15,20,30], v => {
      localBreak = v;
      bg({ type: 'SAVE_PREFERENCES', preferences: { breakDuration: v } });
    });

  // Doomscroll sliders
  setupSlider('doom-slider',   'doom-fill',    'doom-tooltip',    'doom-val',    'doom-ticks',
    [1,5,10,20,30,45,60], async v => {
      localDoom = v;
      await bg({ type: 'UPDATE_DOOMSCROLL_SETTINGS', limitMinutes: localDoom, punishmentMinutes: localPunish });
    });
  setupSlider('punish-slider', 'punish-fill',  'punish-tooltip',  'punish-val',  'punish-ticks',
    [1,3,5,10,15,20,30], async v => {
      localPunish = v;
      await bg({ type: 'UPDATE_DOOMSCROLL_SETTINGS', limitMinutes: localDoom, punishmentMinutes: localPunish });
    });

  // Blocker
  document.getElementById('btn-add-site').addEventListener('click', addSite);
  document.getElementById('site-input').addEventListener('keydown', e => { if (e.key === 'Enter') addSite(); });
  document.getElementById('site-list').addEventListener('click', e => {
    const btn = e.target.closest('.site-del');
    if (btn) removeSite(+btn.dataset.i);
  });
  // Chip buttons
  document.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => addPreset(c.dataset.site));
  });

  // Doomscroll
  // (doomscroll sliders wired above in focus section)

  // Stats
  document.getElementById('btn-reset').addEventListener('click', resetData);
}

// ── RENDER ALL ────────────────────────────────────────
function render() {
  renderFocus();
  renderBlockerTab();
  renderScreenTime();
  renderStats();
}

// ── FOCUS ─────────────────────────────────────────────
function renderFocus() {
  // Guard: all these elements live inside the Focus panel.
  // renderFocus() is called from the poll loop even on other tabs — bail early if not rendered.
  if (!el('btn-start')) return;

  const s = state.session;
  const active = s.active;

  el('btn-start').classList.toggle('hidden', active);
  el('btn-stop').classList.toggle('hidden', !active || s.strictMode);
  const strictEl = el('strict-toggle');
  if (strictEl) { strictEl.checked = s.strictMode; strictEl.disabled = active; }
  const fv = el('focus-val'); if (fv) fv.textContent = localFocus;
  const bv = el('break-val'); if (bv) bv.textContent = localBreak;

  // Disable duration sliders while session is running
  const focusSlider  = el('focus-slider');
  const breakSlider  = el('break-slider');
  if (focusSlider) focusSlider.disabled = active;
  if (breakSlider) breakSlider.disabled = active;
  // Dim the entire slider shell for focus + break
  ['focus-shell', 'break-shell'].forEach(id => {
    const shell = el(id);
    if (shell) {
      shell.style.opacity       = active ? '0.4' : '1';
      shell.style.pointerEvents = active ? 'none' : '';
    }
  });

  // Pips show round progress: filled = completed focus sessions in current cycle
  const pips = el('timer-pips');
  if (!pips) { return; }
  pips.innerHTML = '';
  const doneInCycle = (s.sessionsCompleted || 0) % 4;
  // If currently in a break, highlight the pip for the session we just finished
  const highlightUpTo = s.mode === 'break' ? doneInCycle : doneInCycle;
  for (let i = 0; i < 4; i++) {
    const d = document.createElement('span');
    d.className = 'pip' + (i < highlightUpTo ? ' done' : '');
    // Active focus session: pulse the current pip
    if (active && s.mode === 'focus' && i === doneInCycle) d.className += ' current';
    pips.appendChild(d);
  }

  renderTimerDisplay();
}

function renderTimerDisplay() {
  const s = state.session;
  let progress = 0, remaining;

  if (s.active && s.startTime) {
    const elapsed = Math.floor((Date.now() - s.startTime) / 1000);
    const total   = s.mode === 'focus' ? localFocus * 60 : localBreak * 60;
    remaining = Math.max(0, total - elapsed);
    progress  = Math.min(1, elapsed / total);
  } else {
    remaining = localFocus * 60;
  }

  const m = String(Math.floor(remaining / 60)).padStart(2, '0');
  const sec = String(remaining % 60).padStart(2, '0');
  const td = el('timer-digits'); if (!td) return;
  td.textContent = `${m}:${sec}`;

  const isBreak = s.active && s.mode === 'break';
  const tb = el('timer-badge'); if (tb) tb.textContent = isBreak ? 'BREAK' : 'FOCUS';

  const ring = el('ring-progress');
  if (ring) {
    ring.style.strokeDashoffset = 527.8 - (527.8 * progress);
    ring.classList.toggle('break-ring', isBreak);
  }
}

function startTick() {
  clearInterval(tickLoop);
  tickLoop = setInterval(() => {
    if (state && state.session.active) {
      renderTimerDisplay();
    }
  }, 1000);
}

// Poll fresh state every 3 seconds so screen time, stats, and
// session data stay live without needing a manual refresh.
let pollLoop = null;
function startDataPoll() {
  clearInterval(pollLoop);
  pollLoop = setInterval(async () => {
    const fresh = await bg({ type: 'GET_STATE' });
    if (!fresh) return;
    state = fresh;
    // Always re-render screen time (changes most often)
    renderScreenTime();
    // Re-render stats if they changed
    renderStats();
    // Re-render focus ring and session bar too
    renderTimerDisplay();
  }, 3000);
}

async function startSession() {
  const strict = el('strict-toggle')?.checked ?? false;
  await bg({ type: 'START_SESSION', focusDuration: localFocus, breakDuration: localBreak, strictMode: strict });
  state = await bg({ type: 'GET_STATE' });
  renderFocus();
  renderBlockerStatus();
}

async function stopSession() {
  const res = await bg({ type: 'STOP_SESSION' });
  if (res?.error) {
    const btn = el('btn-stop');
    const orig = btn.textContent;
    btn.textContent = '🔒 Strict Mode';
    setTimeout(() => { btn.textContent = orig; }, 1500);
    return;
  }
  state = await bg({ type: 'GET_STATE' });
  renderFocus();
  renderBlockerStatus();
}

// ── SLIDER HELPER ─────────────────────────────────────
// ═══════════════════════════════════════════════════
// SLIDER SYSTEM — pill track, floating tooltip, snap on release
// ═══════════════════════════════════════════════════

function setupSlider(sliderId, fillId, tooltipId, valId, ticksId, tickValues, onChange) {
  const input   = el(sliderId);
  const fill    = el(fillId);
  const tooltip = el(tooltipId);
  if (!input) return;

  const min = +input.min;
  const max = +input.max;

  // Update CSS gradient fill, compensating for thumb radius so the fill
  // exactly tracks the thumb center at both min and max extremes.
  function updateFill(v) {
    const thumbR = 12; // half of 24px thumb
    const rawPct = (v - min) / (max - min);          // 0 → 1
    const trackW = input.offsetWidth;
    let adjustedPct;
    if (trackW > 0) {
      // Map logical 0-1 onto the thumb-center travel range (thumbR … W-thumbR)
      adjustedPct = ((thumbR + rawPct * (trackW - 2 * thumbR)) / trackW) * 100;
    } else {
      adjustedPct = rawPct * 100;
    }
    input.style.setProperty('--pct', adjustedPct + '%');
  }

  // Position tooltip horizontally above the thumb
  function positionTooltip(v) {
    if (!tooltip) return;
    const pct = (v - min) / (max - min);
    const inputEl  = input;
    const shellEl  = input.closest('.slider-shell');
    if (!shellEl) return;
    const iRect = inputEl.getBoundingClientRect();
    const sRect = shellEl.getBoundingClientRect();
    const thumbR  = 12; // half of 24px thumb
    const trackW  = iRect.width - thumbR * 2;
    const thumbCx = thumbR + pct * trackW;
    const leftFromShell = (iRect.left - sRect.left) + thumbCx;
    tooltip.style.left = leftFromShell + 'px';
    tooltip.textContent = v + ' min';
  }

  // Full sync
  function sync(v, showTip) {
    updateFill(v);
    if (el(valId)) el(valId).textContent = v;
    input.setAttribute('aria-valuenow', v);
    if (tooltip) {
      if (showTip) { positionTooltip(v); tooltip.classList.remove('hidden'); }
      else         { tooltip.classList.add('hidden'); }
    }
  }

  // Initial sync
  sync(+input.value, false);

  // Show tooltip on drag start
  function onDragStart() {
    if (tooltip) { tooltip.classList.remove('hidden'); positionTooltip(+input.value); }
  }
  input.addEventListener('mousedown',  onDragStart);
  input.addEventListener('touchstart', onDragStart, { passive: true });

  // Live update while dragging
  input.addEventListener('input', () => { const v = +input.value; sync(v, true); onChange(v); });

  // Hide tooltip on release (no snapping)
  function onRelease() {
    const v = +input.value;
    sync(v, false);
    onChange(v);
  }
  input.addEventListener('change',    onRelease);
  input.addEventListener('mouseleave', () => { if (tooltip) tooltip.classList.add('hidden'); });

  // Keyboard
  input.addEventListener('keyup', () => { sync(+input.value, false); onChange(+input.value); });
}

// Sync all sliders from state values (called after state loads)
function syncSliders() {
  const configs = [
    { id:'focus-slider',  fillId:'focus-fill',  valId:'focus-val',  ticks:[5,15,25,45,60,90,120], val: localFocus  },
    { id:'break-slider',  fillId:'break-fill',  valId:'break-val',  ticks:[1,5,10,15,20,30],       val: localBreak  },
    { id:'doom-slider',   fillId:'doom-fill',   valId:'doom-val',   ticks:[1,5,10,20,30,45,60],    val: localDoom   },
    { id:'punish-slider', fillId:'punish-fill', valId:'punish-val', ticks:[1,3,5,10,15,20,30],     val: localPunish },
  ];
  configs.forEach(({ id, fillId, valId, val }) => {
    const input = el(id);
    const fill  = el(fillId);
    if (!input) return;
    input.value = val;
    const thumbR  = 12;
    const rawPct  = (val - +input.min) / (+input.max - +input.min);
    const trackW  = input.offsetWidth;
    const adjPct  = trackW > 0
      ? ((thumbR + rawPct * (trackW - 2 * thumbR)) / trackW) * 100
      : rawPct * 100;
    input.style.setProperty('--pct', adjPct + '%');
    if (el(valId)) el(valId).textContent = val;
  });
}

// ── BLOCKER ───────────────────────────────────────────
function renderBlockerTab() {
  el('doom-val').textContent = localDoom;
  el('punish-val').textContent = localPunish;
  renderBlockerStatus();
  renderSiteList();
}

function renderBlockerStatus() {
  const locked = state.session.active && state.session.mode === 'focus';
  el('lock-banner').classList.toggle('hidden', !locked);
  const addField = el('add-field');
  addField.style.opacity = locked ? '0.35' : '1';
  addField.style.pointerEvents = locked ? 'none' : '';
  const qa = el('quick-add-wrap');
  qa.style.opacity = locked ? '0.35' : '1';
  qa.style.pointerEvents = locked ? 'none' : '';
}

function renderSiteList() {
  const ul = el('site-list');
  ul.innerHTML = '';
  (state.blocklist || []).forEach((site, i) => {
    const li = document.createElement('li');
    li.className = 'site-li';
    const name = document.createElement('span');
    name.textContent = site;
    const btn = document.createElement('button');
    btn.className = 'site-del';
    btn.dataset.i = i;
    btn.textContent = '−';
    li.appendChild(name);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

async function addSite() {
  if (state.session.active && state.session.mode === 'focus') return;
  const input = el('site-input');
  let site = input.value.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  if (!site) return;
  if (!state.blocklist.includes(site)) {
    state.blocklist.push(site);
    await bg({ type: 'UPDATE_BLOCKLIST', blocklist: state.blocklist });
    renderSiteList();
  }
  input.value = '';
}

async function removeSite(idx) {
  if (state.session.active && state.session.mode === 'focus') return;
  state.blocklist.splice(idx, 1);
  await bg({ type: 'UPDATE_BLOCKLIST', blocklist: state.blocklist });
  renderSiteList();
}

async function addPreset(site) {
  if (state.session.active && state.session.mode === 'focus') return;
  if (!state.blocklist.includes(site)) {
    state.blocklist.push(site);
    await bg({ type: 'UPDATE_BLOCKLIST', blocklist: state.blocklist });
    renderSiteList();
  }
}

async function stepDoom(type, delta) {
  if (type === 'limit') {
    localDoom = Math.max(1, Math.min(60, localDoom + delta));
    el('doom-val').textContent = localDoom;
  } else {
    localPunish = Math.max(1, Math.min(30, localPunish + delta));
    el('punish-val').textContent = localPunish;
  }
  await bg({ type: 'UPDATE_DOOMSCROLL_SETTINGS', limitMinutes: localDoom, punishmentMinutes: localPunish });
}

// ── SITE → CATEGORY MAP ─────────────────────────────
const SITE_CATEGORIES = {
  'youtube.com':    'Video',
  'twitch.tv':      'Video',
  'twitter.com':    'Social',
  'x.com':          'Social',
  'instagram.com':  'Social',
  'facebook.com':   'Social',
  'snapchat.com':   'Social',
  'linkedin.com':   'Social',
  'tiktok.com':     'Short Video',
  'reddit.com':     'Forums',
};

const CATEGORY_COLORS = {
  'Video':       '#84C0E9',
  'Social':      '#3F6D85',
  'Short Video': '#6ABFA3',
  'Forums':      '#A07FC0',
  'Other':       '#C0A07F',
};

// ── SCREEN TIME ───────────────────────────────────────
function renderScreenTime() {
  const today = todayKey();
  const raw   = (state.screenTime || {})[today] || {};

  // Sites (no ds: prefix)
  const sites = Object.entries(raw)
    .filter(([k]) => !k.startsWith('ds:'))
    .sort((a, b) => b[1] - a[1]);

  // Doom entries
  const totalDoomSec = Object.entries(raw)
    .filter(([k]) => k.startsWith('ds:'))
    .reduce((a, [, v]) => a + v, 0);

  const totalSec = sites.reduce((a, [, v]) => a + v, 0);

  // ── Hero ──
  el('today-total').textContent     = fmtDur(totalSec);
  el('today-doomscroll').textContent = fmtDur(totalDoomSec);

  // Date label
  const dateLabel = el('today-date');
  if (dateLabel) {
    const now = new Date();
    dateLabel.textContent = now.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
  }

  // ── Per-site breakdown ──
  const barsEl  = el('breakdown-bars');
  const emptyEl = el('breakdown-empty');
  barsEl.innerHTML = '';

  if (sites.length === 0) {
    emptyEl.style.display = 'block';
  } else {
    emptyEl.style.display = 'none';
    const maxSec = sites[0][1];
    sites.slice(0, 8).forEach(([domain, secs]) => {
      const pct = Math.max(3, (secs / maxSec) * 100);
      const category = SITE_CATEGORIES[domain] || 'Other';
      const color    = CATEGORY_COLORS[category] || CATEGORY_COLORS['Other'];
      barsEl.appendChild(makeBarRow(domain, secs, pct, color));
    });
  }

  // ── Category breakdown ──
  const catBars  = el('category-bars');
  const catEmpty = el('category-empty');
  catBars.innerHTML = '';

  const catTotals = {};
  sites.forEach(([domain, secs]) => {
    const cat = SITE_CATEGORIES[domain] || 'Other';
    catTotals[cat] = (catTotals[cat] || 0) + secs;
  });

  const catEntries = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);

  if (catEntries.length === 0) {
    catEmpty.style.display = 'block';
  } else {
    catEmpty.style.display = 'none';
    const maxCat = catEntries[0][1];
    catEntries.forEach(([cat, secs]) => {
      const pct   = Math.max(3, (secs / maxCat) * 100);
      const color = CATEGORY_COLORS[cat] || CATEGORY_COLORS['Other'];
      catBars.appendChild(makeBarRow(cat, secs, pct, color));
    });
  }

  renderWeekChart();
}

// Build one horizontal bar row — reused for both site and category
function makeBarRow(label, secs, pct, color) {
  const row = document.createElement('div');
  row.className = 'bar-row';

  const name = document.createElement('span');
  name.className = 'bar-domain';
  name.textContent = label;

  const track = document.createElement('div');
  track.className = 'bar-track';

  const fill = document.createElement('div');
  fill.className = 'bar-fill';
  fill.style.width = pct + '%';
  fill.style.background = color;
  track.appendChild(fill);

  const dur = document.createElement('span');
  dur.className = 'bar-dur';
  dur.textContent = fmtDur(secs);

  row.appendChild(name);
  row.appendChild(track);
  row.appendChild(dur);
  return row;
}

function renderWeekChart() {
  const container = el('week-chart');
  container.innerHTML = '';
  const screenTime = state.screenTime || {};
  const DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const today = new Date();

  const data = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key    = d.toISOString().split('T')[0];
    const dayRaw = screenTime[key] || {};
    const total  = Object.entries(dayRaw)
      .filter(([k]) => !k.startsWith('ds:'))
      .reduce((a, [, v]) => a + v, 0);
    data.push({ total, label: DAY_LABELS[d.getDay()], isToday: i === 0, key });
  }

  const max = Math.max(...data.map(d => d.total), 1);
  const weekTotal = data.reduce((a, d) => a + d.total, 0);

  // Week total footer
  const wtEl = el('week-total');
  if (wtEl) wtEl.textContent = fmtDur(weekTotal);

  // One shared tooltip — appended to the container (.week-bars) itself
  // so left:% positions are relative to the chart width, not the card.
  let tooltip = container.querySelector('.wk-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'wk-tooltip';
    container.appendChild(tooltip);
  }
  tooltip.style.display = 'none';

  data.forEach((d, idx) => {
    const col = document.createElement('div');
    col.className = 'wk-col';

    const wrap = document.createElement('div');
    wrap.className = 'wk-bwrap';

    const bar = document.createElement('div');
    const pct = d.total > 0 ? Math.max((d.total / max) * 100, 6) : 0;
    bar.className = 'wk-bar' + (d.total > 0 ? ' lit' : '') + (d.isToday ? ' today' : '');
    bar.style.height = pct + '%';

    // Hover tooltip — centered on the column using % of container width
    col.addEventListener('mouseenter', () => {
      const timeStr = d.total > 0 ? fmtDur(d.total) : 'No data';
      const dayStr  = d.isToday ? 'Today' : d.label;
      tooltip.textContent = `${dayStr}: ${timeStr}`;
      tooltip.style.display = 'block';

      // col center as % of container width → perfectly aligned
      const containerW = container.offsetWidth;
      const colLeft    = col.offsetLeft;
      const colCenter  = colLeft + col.offsetWidth / 2;
      const pctLeft    = (colCenter / containerW) * 100;

      tooltip.style.left      = pctLeft + '%';
      tooltip.style.transform = 'translateX(-50%)';
      tooltip.style.bottom    = 'auto';
      tooltip.style.top       = '0px';     // float at top of chart
    });
    col.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });

    wrap.appendChild(bar);

    const label = document.createElement('span');
    label.className = 'wk-day' + (d.isToday ? ' today' : '');
    label.textContent = d.isToday ? 'Today' : d.label.slice(0, 1);

    col.appendChild(wrap);
    col.appendChild(label);
    container.appendChild(col);
  });
}

// ── STATS ─────────────────────────────────────────────
function renderStats() {
  const st = state.stats;
  const totalMin = st.totalFocusMinutes || 0;
  const streak = st.streakDays || 0;

  el('k-sessions').textContent = st.totalSessions || 0;
  el('k-hours').textContent = totalMin >= 60 ? Math.floor(totalMin/60) + 'h' : totalMin + 'm';
  el('k-streak').textContent = streak;

  el('r-focus').textContent = fmtDur(totalMin * 60);
  el('r-sessions').textContent = st.totalSessions || 0;
  el('r-streak').textContent = streak + ' days';

  renderHeatmap();
}

function renderHeatmap() {
  const hm = state.stats.heatmap || {};
  const grid = el('heatmap');
  grid.innerHTML = '';
  const today = new Date();

  for (let i = 118; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    const min = hm[key] || 0;
    const cell = document.createElement('div');
    cell.className = 'hm-cell ' + hmLevel(min);
    cell.title = `${key}: ${min}m`;
    grid.appendChild(cell);
  }
}

function hmLevel(m) {
  if (m === 0) return '';
  if (m < 25) return 'l1';
  if (m < 60) return 'l2';
  if (m < 120) return 'l3';
  return 'l4';
}

async function resetData() {
  if (!confirm('Reset all focus and screen time data?')) return;
  await bg({ type: 'CLEAR_STATS' });
  state = await bg({ type: 'GET_STATE' });
  render();
}



// ── UTILS ─────────────────────────────────────────────
function bg(m) {
  return new Promise(res => {
    chrome.runtime.sendMessage(m, r => {
      if (chrome.runtime.lastError) { res(null); return; }
      res(r || null);
    });
  });
}

function el(id) { return document.getElementById(id); }

function todayKey() { return new Date().toISOString().split('T')[0]; }

function fmtDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return sec > 0 ? '<1m' : '0m';
}
