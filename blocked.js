// Flow Blocked Page

const FOCUS_QUOTES = [
  '"Deep work is the superpower of the 21st century." — Cal Newport',
  '"The successful warrior is the average person with laser-like focus." — Bruce Lee',
  '"Discipline is choosing between what you want now and what you want most."',
  '"One hour of focused work equals four hours of distracted work."',
  '"Your future self is watching you through your memory."',
  '"Don\'t watch the clock. Do what it does — keep going." — Sam Levenson',
  '"Focus is not about saying yes. It\'s about saying no to everything else." — Steve Jobs',
  '"The ability to concentrate for long periods is the key distinguishing skill."',
];

const DOOM_QUOTES = [
  '"Your attention is your most valuable asset. Protect it."',
  '"The feed is infinite. Your time is not."',
  '"Every minute you scroll is a minute not building the life you want."',
  '"Boredom is a signal to create, not to consume."',
  '"You can\'t pour from an empty cup. But you also can\'t fill one with a firehose."',
  '"The cost of a thing is the amount of life exchanged for it." — Thoreau',
];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function init() {
  const p = new URLSearchParams(window.location.search);
  const site  = p.get('site') || 'this site';
  const mode  = p.get('mode') || 'focus';
  const until = parseInt(p.get('until') || '0', 10);

  mode === 'doomscroll' ? initDoom(site, until) : initFocus(site);
}

function initFocus(site) {
  document.getElementById('focus-card').classList.remove('hidden');
  document.getElementById('doom-card').classList.add('hidden');
  document.getElementById('focus-site').textContent = site;
  document.getElementById('focus-quote').textContent = rand(FOCUS_QUOTES);
  document.getElementById('btn-back').addEventListener('click', () => history.back());
  tick();
  setInterval(tick, 1000);
}

async function tick() {
  try {
    const state = await send({ type: 'GET_STATE' });
    if (!state || !state.session || !state.session.active) return;
    const s = state.session;
    const elapsed = Math.floor((Date.now() - s.startTime) / 1000);
    const total   = s.mode === 'focus' ? s.focusDuration * 60 : s.breakDuration * 60;
    const rem     = Math.max(0, total - elapsed);
    const mm = String(Math.floor(rem / 60)).padStart(2, '0');
    const ss = String(rem % 60).padStart(2, '0');
    document.getElementById('chip-time').textContent = `${mm}:${ss}`;
    document.getElementById('chip-mode').textContent = s.mode === 'break' ? 'BREAK' : 'FOCUS';
    const dot = document.getElementById('chip-dot');
    dot.className = 'chip-dot' + (s.mode === 'break' ? ' brk' : '');
  } catch {}
}

function initDoom(site, until) {
  document.getElementById('focus-card').classList.add('hidden');
  document.getElementById('doom-card').classList.remove('hidden');
  document.getElementById('doom-site').textContent = site;
  document.getElementById('doom-quote').textContent = rand(DOOM_QUOTES);

  function update() {
    const rem = Math.max(0, Math.floor((until - Date.now()) / 1000));
    const mm = String(Math.floor(rem / 60)).padStart(2, '0');
    const ss = String(rem % 60).padStart(2, '0');
    document.getElementById('punish-time').textContent = `${mm}:${ss}`;
    if (rem <= 0) {
      send({ type: 'RESET_DOOMSCROLL_TODAY', domain: site })
        .finally(() => { setTimeout(() => history.back(), 800); });
    }
  }
  update();
  setInterval(update, 1000);
}

function send(msg) {
  return new Promise((res, rej) => {
    try {
      chrome.runtime.sendMessage(msg, r => {
        chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res(r);
      });
    } catch(e) { rej(e); }
  });
}

init();
