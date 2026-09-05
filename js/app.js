/* Packlight — voice-first minimalist packing. App orchestrator. */
(function () {
  const $ = s => document.querySelector(s);
  const E = window.PackingEngine;
  const V = window.PackVoice;

  const state = {
    step: 'destination', // destination -> dates -> activities -> laundry -> packing
    trip: { dest: null, days: null, activities: [], laundry: null, startDate: null, weather: null, place: null },
    list: null,
    checked: {},
    custom: [],
  };

  /* ---------- persistence ---------- */
  function save() {
    try { localStorage.setItem('packlight', JSON.stringify({ trip: state.trip, step: state.step, checked: state.checked, custom: state.custom })); } catch (e) {}
  }
  function restore() {
    try {
      const raw = localStorage.getItem('packlight');
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (!d || !d.trip || !d.trip.dest) return false;
      state.trip = d.trip; state.step = d.step === 'packing' ? 'packing' : 'destination';
      state.checked = d.checked || {}; state.custom = d.custom || [];
      return state.step === 'packing';
    } catch (e) { return false; }
  }

  /* ---------- conversation UI ---------- */
  function say(text, opts) {
    $('#assistant-line').textContent = text;
    if (!opts || !opts.silent) V.speak(text);
    pushLog('Packlight', text);
  }
  function heard(text) {
    $('#user-line').textContent = '“' + text + '”';
    pushLog('You', text);
  }
  function pushLog(who, text) {
    const el = document.createElement('div');
    el.className = 'log-entry';
    el.innerHTML = '<span class="log-who">' + who + '</span><span class="log-text"></span>';
    el.querySelector('.log-text').textContent = text;
    const log = $('#log');
    log.appendChild(el);
    while (log.children.length > 6) log.removeChild(log.firstChild);
  }

  /* ---------- date parsing (departure) ---------- */
  function parseDeparture(text) {
    const t = text.toLowerCase().trim();
    if (/skip|not sure|don'?t know|later|no date/.test(t)) return 'skip';
    const today = new Date(); today.setHours(0,0,0,0);
    const add = n => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
    if (/^today$/.test(t)) return today;
    if (/tomorrow/.test(t)) return add(1);
    let m = t.match(/in (\d+|a|an) (days?|weeks?)/);
    if (m) { const n = m[1] === 'a' || m[1] === 'an' ? 1 : parseInt(m[1], 10); return add(m[2].startsWith('week') ? n * 7 : n); }
    const DOW = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    for (let i = 0; i < 7; i++) {
      if (t.includes(DOW[i])) {
        let delta = (i - today.getDay() + 7) % 7;
        if (delta === 0 || /next/.test(t)) delta += 7;
        return add(delta);
      }
    }
    const MON = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    m = t.match(/([a-z]+)\s+(\d{1,2})/);
    if (m) {
      const mi = MON.findIndex(x => x.startsWith(m[1].slice(0, 3)));
      if (mi >= 0) {
        let d = new Date(today.getFullYear(), mi, parseInt(m[2], 10));
        if (d < today) d = new Date(today.getFullYear() + 1, mi, parseInt(m[2], 10));
        return d;
      }
    }
    m = t.match(/(?:the )?(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (m) {
      let d = new Date(today.getFullYear(), today.getMonth(), parseInt(m[1], 10));
      if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, parseInt(m[1], 10));
      return d;
    }
    return null;
  }

  /* ---------- weather ---------- */
  async function fetchWeather(dest, startDate, days) {
    const g = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(dest) + '&count=1').then(r => r.json());
    if (!g.results || !g.results.length) return { error: 'place' };
    const p = g.results[0];
    const today = new Date(); today.setHours(0,0,0,0);
    const start = startDate || today;
    const offset = Math.round((start - today) / 86400000);
    if (offset > 13) return { place: p, error: 'too-far' };
    const end = new Date(start); end.setDate(end.getDate() + Math.min(days, 16) - 1);
    const fmt = d => d.toISOString().slice(0, 10);
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + p.latitude + '&longitude=' + p.longitude +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&start_date=' + fmt(start) + '&end_date=' + fmt(end);
    const f = await fetch(url).then(r => r.json());
    if (!f.daily) return { place: p, error: 'weather' };
    return { place: p, summary: E.summarizeWeather(f.daily) };
  }

  const F = c => Math.round(c * 9 / 5 + 32);
  function weatherLine(w, place) {
    if (!w) return null;
    let s = 'In ' + (place.name + (place.country ? ', ' + place.country : '')) + ' expect highs near ' + F(w.avgHigh) + '°F and lows around ' + F(w.avgLow) + '°F';
    if (w.rainy) s += ', with real rain chances (' + w.maxRain + '% at worst)';
    else if (w.maybeRain) s += ', with a slight chance of rain';
    return s + '.';
  }

  /* ---------- conversation flow ---------- */
  async function handleInput(raw) {
    const text = raw.trim();
    if (!text) return;
    heard(text);
    const lower = text.toLowerCase();

    if (/^(new trip|start over|restart|reset)$/.test(lower)) return reset();

    switch (state.step) {
      case 'destination': {
        const { dest, days } = E.parseDestinationDays(text);
        if (dest) state.trip.dest = dest;
        if (days) state.trip.days = days;
        if (!state.trip.dest) return say('I didn\'t catch a place. Where are you headed?');
        if (!state.trip.days) { state.step = 'dates'; return say(state.trip.dest + '. How many days?'); }
        state.step = 'dates';
        return say(state.trip.dest + ' for ' + state.trip.days + ' days. When do you leave? Say a date, or "skip".');
      }
      case 'dates': {
        if (state.trip.days == null) {
          const { days } = E.parseDestinationDays(text);
          const n = days || parseInt(text, 10);
          if (!n) return say('Just a number works. How many days?');
          state.trip.days = n;
          return say(n + ' days. When do you leave? Say a date, or "skip".');
        }
        const d = parseDeparture(text);
        if (d === 'skip') state.trip.startDate = null;
        else if (d) state.trip.startDate = d.toISOString().slice(0, 10);
        else return say('I couldn\'t parse that date. Try "tomorrow", "next Friday", "September 20", or "skip".');
        state.step = 'activities';
        return say('Anything special planned — hiking, running, swimming, work, something fancy? Or say "no".');
      }
      case 'activities': {
        if (!/^(no|nope|nothing|nah)$/.test(lower)) {
          state.trip.activities = E.detectActivities(text);
          if (!state.trip.activities.length)
            return say('I didn\'t recognize an activity in that. Try hiking, running, swimming, business, formal, camping, photography, gym — or "no".');
        }
        state.step = 'laundry';
        return say('Last thing — will you have access to a washing machine? Yes, no, or not sure.');
      }
      case 'laundry': {
        if (/^y|yeah|yes|sure|probably/.test(lower)) state.trip.laundry = 'yes';
        else if (/not sure|don'?t know|maybe|unknown/.test(lower)) state.trip.laundry = 'unknown';
        else if (/^n|no|nope|nah/.test(lower)) state.trip.laundry = 'no';
        else return say('Yes, no, or not sure?');
        return generate();
      }
      case 'packing':
        return packingCommand(lower, text);
    }
  }

  async function generate() {
    say('One second — checking the weather for ' + state.trip.dest + '.', { silent: true });
    let weather = null, place = null, note = null;
    try {
      const r = await fetchWeather(state.trip.dest, state.trip.startDate ? new Date(state.trip.startDate + 'T12:00:00') : null, state.trip.days);
      place = r.place || null;
      if (r.summary) weather = r.summary;
      else if (r.error === 'too-far') note = 'Your trip is too far out for a forecast, so I packed for versatility. Re-check a few days before you leave.';
      else note = 'I couldn\'t get a forecast, so I packed for versatility.';
    } catch (e) { note = 'I couldn\'t reach the weather service, so I packed for versatility.'; }
    state.trip.weather = weather; state.trip.place = place;
    state.list = E.buildList({ destination: state.trip.dest, days: state.trip.days, activities: state.trip.activities, laundry: state.trip.laundry === 'unknown' ? 'no' : state.trip.laundry, weather });
    state.step = 'packing';
    state.checked = {}; state.custom = [];
    renderAll();
    save();
    const wLine = weather ? weatherLine(weather, place) : note;
    const n = state.list.items.length;
    const acts = state.trip.activities.length ? ' with ' + state.trip.activities.join(' and ') : '';
    say((wLine ? wLine + ' ' : '') + 'Here\'s your list: ' + n + ' items for ' + state.trip.days + ' days' + acts + '. Tap or say "check" plus an item as you pack it. Say "what\'s left" any time.');
  }

  /* ---------- packing mode ---------- */
  function findItem(q) {
    if (!state.list) return null;
    const items = allItems();
    q = q.toLowerCase().replace(/^(the|a|an|my)\s+/, '');
    let best = items.find(i => i.name.toLowerCase() === q);
    if (!best) best = items.find(i => i.name.toLowerCase().includes(q));
    if (!best) best = items.find(i => q.includes(i.name.toLowerCase().split(' ')[0]) && i.name.toLowerCase().split(' ')[0].length > 3);
    return best || null;
  }
  function allItems() { return state.list.items.concat(state.custom); }

  function packingCommand(lower, original) {
    let m;
    if (m = lower.match(/^(?:check|check off|checked|pack|packed|got|tick|done)\s+(?:off\s+)?(.+)/)) {
      if (/^(everything|all|it all)$/.test(m[1])) {
        allItems().forEach(i => state.checked[i.id] = true);
        renderChecklist(); save();
        return say('Everything checked. You\'re done — have a great trip.');
      }
      const it = findItem(m[1]);
      if (!it) return say('I don\'t see "' + m[1] + '" on the list.');
      state.checked[it.id] = true;
      renderChecklist(); save();
      const left = allItems().filter(i => !state.checked[i.id]).length;
      return say(it.name.replace(/\(.*\)/, '').trim() + ' — packed. ' + (left ? left + ' to go.' : 'That\'s everything. Have a great trip.'));
    }
    if (m = lower.match(/^(?:uncheck|un-pack|unpack|not yet)\s+(.+)/)) {
      const it = findItem(m[1]);
      if (!it) return say('I don\'t see "' + m[1] + '" on the list.');
      delete state.checked[it.id];
      renderChecklist(); save();
      return say('Unchecked ' + it.name.toLowerCase() + '.');
    }
    if (/what'?s left|what remains|remaining|progress/.test(lower)) {
      const left = allItems().filter(i => !state.checked[i.id]);
      if (!left.length) return say('Nothing left. You\'re packed.');
      const few = left.slice(0, 4).map(i => i.name.replace(/\(.*\)/, '').trim().toLowerCase()).join(', ');
      return say(left.length + ' left. Next up: ' + few + (left.length > 4 ? ', and a few more.' : '.'));
    }
    if (m = original.match(/^(?:add|put on)\s+(.+)/i)) {
      const name = m[1].trim().replace(/^(the|a|an|my)\s+/i, '');
      const item = { category: 'Added by you', name: name.charAt(0).toUpperCase() + name.slice(1), id: 'custom-' + Date.now(), weight: 100 };
      state.custom.push(item);
      renderChecklist(); save();
      return say('Added ' + name + '.');
    }
    if (m = lower.match(/^(?:remove|drop|cut|delete)\s+(.+)/)) {
      const it = findItem(m[1]);
      if (!it) return say('I don\'t see "' + m[1] + '" on the list.');
      state.list.items = state.list.items.filter(i => i.id !== it.id);
      state.custom = state.custom.filter(i => i.id !== it.id);
      delete state.checked[it.id];
      renderChecklist(); save();
      return say('Cut ' + it.name.toLowerCase() + '. Lighter already.');
    }
    if (/^(help|what can i say)$/.test(lower))
      return say('Say "check socks" to pack something, "uncheck" to undo, "add" something I missed, "remove" to cut it, "what\'s left" for status, or "new trip" to start over.');
    return say('Say "check" plus an item name as you pack it, or "what\'s left" for a status check. "help" lists commands.');
  }

  function reset() {
    localStorage.removeItem('packlight');
    state.step = 'destination';
    state.trip = { dest: null, days: null, activities: [], laundry: null, startDate: null, weather: null, place: null };
    state.list = null; state.checked = {}; state.custom = [];
    renderAll();
    say('Fresh start. Where are you headed? You can say it all at once — "Tokyo for 5 days".');
  }

  /* ---------- rendering ---------- */
  function renderAll() { renderTripBar(); renderStats(); renderChecklist(); renderChallenges(); }

  function renderTripBar() {
    const bar = $('#tripbar');
    if (!state.trip.dest) { bar.innerHTML = ''; return; }
    const chips = [state.trip.place ? state.trip.place.name + (state.trip.place.country ? ', ' + state.trip.place.country : '') : state.trip.dest,
      state.trip.days + ' days',
      state.trip.laundry === 'yes' ? 'laundry: yes' : state.trip.laundry === 'no' ? 'laundry: no' : 'laundry: unsure'];
    if (state.trip.weather) chips.push(F(state.trip.weather.avgHigh) + '°F / ' + F(state.trip.weather.avgLow) + '°F' + (state.trip.weather.rainy ? ' · rain likely' : ''));
    bar.innerHTML = chips.map(c => '<span class="chip"></span>').join('');
    bar.querySelectorAll('.chip').forEach((el, i) => el.textContent = chips[i]);
  }

  function renderStats() {
    const el = $('#stats');
    if (!state.list) { el.innerHTML = ''; return; }
    const items = allItems();
    const done = items.filter(i => state.checked[i.id]).length;
    const packedW = state.list.items.filter(i => i.tag !== 'wear' && !i.optional).reduce((s, i) => s + (i.weight || 0), 0) + state.custom.reduce((s, i) => s + (i.weight || 0), 0);
    const kg = (packedW / 1000).toFixed(1), budgetKg = (state.list.budget / 1000).toFixed(0);
    const pct = Math.min(100, Math.round(packedW / state.list.budget * 100));
    el.innerHTML =
      '<div class="stat"><div class="stat-num">' + done + '<span class="stat-dim">/' + items.length + '</span></div><div class="stat-label">packed</div></div>' +
      '<div class="stat"><div class="stat-num">' + kg + '<span class="stat-dim">kg</span></div><div class="stat-label">est. bag weight · one-bag budget ' + budgetKg + 'kg</div>' +
      '<div class="meter"><div class="meter-fill' + (packedW > state.list.budget ? ' over' : '') + '" style="width:' + pct + '%"></div></div></div>';
  }

  function renderChecklist() {
    const wrap = $('#checklist');
    if (!state.list) { wrap.innerHTML = ''; return; }
    const byCat = {};
    for (const i of allItems()) (byCat[i.category] = byCat[i.category] || []).push(i);
    wrap.innerHTML = '';
    for (const [cat, items] of Object.entries(byCat)) {
      const sec = document.createElement('section');
      sec.className = 'cat';
      const doneN = items.filter(i => state.checked[i.id]).length;
      sec.innerHTML = '<h3>' + cat + '<span class="cat-count">' + doneN + '/' + items.length + '</span></h3>';
      const ul = document.createElement('ul');
      for (const i of items) {
        const li = document.createElement('li');
        li.className = 'item' + (state.checked[i.id] ? ' done' : '');
        const box = document.createElement('button');
        box.className = 'box'; box.setAttribute('aria-label', 'toggle ' + i.name);
        box.onclick = () => { state.checked[i.id] ? delete state.checked[i.id] : state.checked[i.id] = true; renderChecklist(); renderStats(); save(); };
        const body = document.createElement('div'); body.className = 'item-body';
        body.innerHTML = '<span class="item-name"></span>' +
          (i.qty ? ' <span class="qty">×' + i.qty + '</span>' : '') +
          (i.tag === 'wear' ? ' <span class="tag">wear it</span>' : '') +
          (i.optional ? ' <span class="tag opt">optional</span>' : '') +
          (i.note ? '<div class="note"></div>' : '');
        body.querySelector('.item-name').textContent = i.name;
        if (i.note) body.querySelector('.note').textContent = i.note;
        li.appendChild(box); li.appendChild(body);
        ul.appendChild(li);
      }
      sec.appendChild(ul);
      wrap.appendChild(sec);
    }
    renderStats();
  }

  function renderChallenges() {
    const el = $('#challenges');
    if (!state.list || !state.list.challenges.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<h3>The minimalist in your ear</h3><ul>' +
      state.list.challenges.map(c => '<li></li>').join('') + '</ul>';
    el.querySelectorAll('li').forEach((li, i) => li.textContent = state.list.challenges[i]);
  }

  /* ---------- input wiring ---------- */
  function submitText() {
    const inp = $('#text-input');
    const v = inp.value.trim();
    if (v) { inp.value = ''; handleInput(v); }
  }
  $('#text-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitText(); });
  $('#send-btn').addEventListener('click', submitText);
  $('#reset-btn').addEventListener('click', reset);

  const micBtn = $('#mic-btn');
  const noteEl = $('#mic-note');
  const NOTE_DEFAULT = 'Tap the mic once and just talk — it keeps listening until you tap it again. Typing works too.';
  const NOTE_LISTENING = 'Listening… say where you\'re headed, or "check" plus an item while packing.';
  const ERROR_NOTES = {
    'not-allowed': 'The mic is blocked for this site. Allow it from the address-bar / browser settings, then tap the mic again — or just type, it does everything voice does.',
    'service-not-allowed': 'SERVICE_NOT_ALLOWED',
    'network': 'The browser\'s speech service had a connection hiccup. Try again, or type.',
    'no-speech': 'Didn\'t catch anything. Tap the mic and try again, or type.',
    'audio-capture': 'No microphone found on this device. Typing works the same.',
    'constructor': 'Voice couldn\'t start in this browser. If you\'re in an in-app browser, open the link in Safari or Chrome directly — typing also works.',
    'start-failed': 'Voice couldn\'t start in this browser. If you\'re in an in-app browser, open the link in Safari or Chrome directly — typing also works.',
    'timeout': 'Voice listening stalled (some mobile browsers do this). Tap the mic to retry — typing always works.',
    'unknown': 'Voice hit an error in this browser. Typing does everything voice does.',
  };
  function setNote(t) { noteEl.textContent = t; }

  if (!V.recognitionAvailable) {
    micBtn.classList.add('disabled');
    micBtn.disabled = true;
    setNote('Voice input isn\'t supported in this browser (Firefox, and most in-app browsers). Typing does everything voice does.');
  }
  micBtn.addEventListener('click', () => {
    if (V.listening || V.handsFree) { V.stopListening(); micBtn.classList.remove('live'); setNote(NOTE_DEFAULT); return; }
    V.handsFree = true;
    micBtn.classList.add('live');
    if (!V.startListening()) { V.handsFree = false; micBtn.classList.remove('live'); }
  });
  V.onResult = t => handleInput(t);
  V.onInterim = t => { $('#user-line').textContent = '\u201c' + t + '\u2026\u201d'; };
  V.onNoInput = () => {
    if (isMacSafariFn()) setNote('Not hearing anything yet. Check Safari menu \u2192 Settings for This Website \u2192 Microphone is Allow, and System Settings \u2192 Privacy & Security \u2192 Microphone has Safari on - then keep talking.');
    else setNote('Not hearing anything yet - check that your browser is allowed to use the microphone, then keep talking.');
  };
  V.onStateChange = on => {
    micBtn.classList.toggle('listening', on);
    if (on) setNote(NOTE_LISTENING);
    else if (!V.handsFree) { micBtn.classList.remove('live'); setNote(NOTE_DEFAULT); }
  };
  function isMacSafariFn() { return !V.isIOS && /^((?!chrome|chromium|android).)*safari/i.test(navigator.userAgent); }
  V.onError = code => {
    micBtn.classList.remove('live', 'listening');
    let msg = ERROR_NOTES[code] || ERROR_NOTES.unknown;
    if (code === 'service-not-allowed') {
      msg = isMacSafariFn()
        ? 'Safari needs two switches flipped for voice: System Settings → General → Keyboard → Dictation (on), and System Settings → Privacy & Security → Speech Recognition → Safari (on). Then reload. Chrome on this Mac also works out of the box.'
        : 'This browser is blocking speech recognition. If you opened this inside another app, try opening it in Safari or Chrome directly — or just type.';
    }
    setNote(msg);
  };

  /* ---------- boot ---------- */
  const params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    state.trip = { dest: 'Tokyo', days: 5, activities: ['hiking', 'swimming'], laundry: 'yes', startDate: null, weather: null, place: { name: 'Tokyo', country: 'Japan' } };
    state.trip.weather = E.summarizeWeather({ time: ['1','2','3','4','5'], temperature_2m_max: [24,25,23,22,24], temperature_2m_min: [16,17,16,15,16], precipitation_probability_max: [20,60,70,30,10] });
    state.list = E.buildList({ destination: 'Tokyo', days: 5, activities: ['hiking','swimming'], laundry: 'yes', weather: state.trip.weather });
    state.step = 'packing';
    ['Clothing-underwear', 'Tech-phone-charger'].forEach(prefix => {
      const it = state.list.items.find(i => i.id.startsWith(prefix.toLowerCase()));
      if (it) state.checked[it.id] = true;
    });
    renderAll();
    say(weatherLine(state.trip.weather, state.trip.place) + ' Here\'s your list — ' + state.list.items.length + ' items for 5 days.', { silent: true });
  } else if (restore()) {
    try {
      const w = state.trip.weather;
      if (w && state.trip.place) $('#assistant-line').textContent = weatherLine(w, state.trip.place) + ' List is ready.';
    } catch (e) {}
    state.list = E.buildList({ destination: state.trip.dest, days: state.trip.days, activities: state.trip.activities, laundry: state.trip.laundry === 'unknown' ? 'no' : state.trip.laundry, weather: state.trip.weather });
    renderAll();
    say('Welcome back. Still packing for ' + state.trip.dest + ' — say "what\'s left" for status.', { silent: true });
  } else {
    say('Where are you headed? You can say it all at once — "Tokyo for 5 days".');
  }
})();
