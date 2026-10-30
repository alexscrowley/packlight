/* Packlight web: describe the trip (screen 1), build a weather-aware checklist (screen 2).
   No login, no keys, no backend. State lives in localStorage. */
(function () {
  "use strict";
  var E = window.LeanEngine, P = window.LeanParse, V = window.LeanVoice;
  var $ = function (s) { return document.querySelector(s); };
  var KEY = "packlight-web-v1", MUTE_KEY = "packlight-muted";
  var GEO = "https://geocoding-api.open-meteo.com/v1/search";
  var FORECAST = "https://api.open-meteo.com/v1/forecast";
  var ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
  var CARRY_ON_KG = 7, CHECKED_KG = 15;
  var mobile = function () { return matchMedia("(max-width: 860px)").matches; };

  var state = blank();
  function blank() { return { view: "input", draft: { activities: [] }, utts: [], trip: null, packed: {}, removed: {}, custom: [], collapsed: {} }; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function restore() {
    try { var d = JSON.parse(localStorage.getItem(KEY) || "null"); if (d && d.view) state = Object.assign(blank(), d); } catch (e) {}
    if (state.view === "list" && !(state.trip && state.trip.items)) state.view = "input";
  }

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmtDate(s) { return P.fromIso(s).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); }
  var F = function (c) { return Math.round(c * 9 / 5 + 32); };
  function fetchJson(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  function shiftYear(s, n) { var p = s.split("-"); return (+p[0] + n) + "-" + p[1] + "-" + (p[1] === "02" && p[2] === "29" ? "28" : p[2]); }
  function placeLabel(p, fallback) { return p ? [p.name, p.region && p.region !== p.name ? p.region : "", p.country].filter(Boolean).join(", ") : fallback; }

  function geocode(name) {
    return fetchJson(GEO + "?count=1&language=en&format=json&name=" + encodeURIComponent(name.replace(/,.*$/, ""))).then(function (g) {
      var h = g.results && g.results[0];
      return h ? { name: h.name, region: h.admin1 || "", country: h.country || "", lat: h.latitude, lon: h.longitude } : null;
    });
  }
  /* Forecast covers today..today+15. Past that: last year's weather for the same dates. */
  function getWeather(place, start, nights) {
    var t = P.today(), horizon = P.addDays(t, 15), end = P.addDays(start, Math.min(nights, 15));
    var daily = "temperature_2m_max,temperature_2m_min,weather_code";
    if (start <= horizon) {
      var fs = start < t ? t : start, fe = end > horizon ? horizon : end;
      return fetchJson(FORECAST + "?latitude=" + place.lat + "&longitude=" + place.lon + "&timezone=auto&daily=" + daily + ",precipitation_probability_max&start_date=" + fs + "&end_date=" + fe).then(function (f) {
        var d = f.daily;
        return E.summarizeWeather(d.time.map(function (x, i) { return { date: x, tMax: d.temperature_2m_max[i], tMin: d.temperature_2m_min[i], precipProb: (d.precipitation_probability_max || [])[i] || 0, code: d.weather_code[i] }; }),
          P.addDays(start, nights) > horizon ? "partial" : "forecast");
      });
    }
    return fetchJson(ARCHIVE + "?latitude=" + place.lat + "&longitude=" + place.lon + "&timezone=auto&daily=" + daily + ",precipitation_sum&start_date=" + shiftYear(start, -1) + "&end_date=" + shiftYear(end, -1)).then(function (f) {
      var d = f.daily;
      return E.summarizeWeather(d.time.map(function (x, i) { return { date: x, tMax: d.temperature_2m_max[i], tMin: d.temperature_2m_min[i], precipSum: d.precipitation_sum[i] || 0, code: d.weather_code[i] }; })
        .filter(function (x) { return x.tMax != null && x.tMin != null; }), "last-year");
    });
  }
  function weatherWords(w) {
    if (!w || w.avgHigh == null) return "No weather data, so this is packed for mild and dry.";
    var sky = w.snow ? "snow possible" : w.needsRain ? (w.source === "last-year" ? "rainy last year" : "rain likely") : "mostly dry";
    var tail = w.source === "last-year" ? " (last year's weather for these dates)" : w.source === "partial" ? " (forecast covers the first 16 days)" : "";
    return F(w.avgLow) + "\u2013" + F(w.avgHigh) + "\u00b0F, " + sky + tail;
  }

  /* ---------- speech out ---------- */
  var muted = true;
  try { muted = localStorage.getItem(MUTE_KEY) !== "off"; } catch (e) {}
  V.enabled = !muted;
  function paintMute() { var b = $("#speaker"); b.setAttribute("aria-pressed", String(!muted)); b.textContent = muted ? "Voice replies off" : "Voice replies on"; }
  function say(text, after, shown) {
    var t = shown != null ? shown : text;
    if (state.view === "list") $("#cmd-reply").textContent = t; else $("#reply").textContent = t;
    V.speak(text, after);
  }

  /* ---------- the draft: what's known, what's missing ---------- */
  function hasBack(d) { return !!d.endDate || d.nights != null; }
  var NEEDS = [
    ["dest", "Where you're going", function (d) { return d.dest && !d.destBad; }],
    ["leave", "When you leave", function (d) { return !!d.startDate; }],
    ["back", "When you're back", hasBack],
    ["laundry", "Whether you'll have a washing machine", function (d) { return !!d.laundry; }],
    ["carryOn", "Carry-on only, or checking a bag", function (d) { return d.carryOn != null; }]
  ];
  function missing(d) { return NEEDS.filter(function (n) { return !n[2](d); }); }

  function merge(d, p) {
    if (p.dest && (!d.dest || d.destBad || p.dest !== d.dest)) {
      // a later utterance can correct the place only when it clearly names one
      if (!d.dest || d.destBad || p.destMarked) { d.dest = p.dest; delete d.destBad; delete d.place; }
    }
    if (p.startDate && !p.endDate && d.startDate && !hasBack(d)) { p.endDate = p.startDate; p.endWeekday = !!p.startWeekday; delete p.startDate; }
    if (p.startDate) d.startDate = p.startDate;
    if (p.endDate) { d.endDate = p.endDate; d.endWeekday = !!p.endWeekday; d.nights = null; }
    if (p.approxDate) d.approxDate = true;
    if (p.nights != null && !p.endDate) { d.nights = p.nights; d.endDate = null; }
    else if (p.bareNumber && !hasBack(d)) d.nights = p.bareNumber;
    if (p.laundry) d.laundry = p.laundry;
    if (p.carryOn != null) d.carryOn = p.carryOn;
    if (p.bareYesNo) {
      var open = missing(d).map(function (n) { return n[0]; }).filter(function (k) { return k === "laundry" || k === "carryOn"; });
      if (open.length === 1) { if (open[0] === "laundry") d.laundry = p.bareYesNo; else d.carryOn = p.bareYesNo === "yes"; }
    }
    if (p.meds) d.meds = true;
    (p.activities || []).forEach(function (a) { if (d.activities.indexOf(a) < 0) d.activities.push(a); });
  }
  function settle(d) {
    if (d.startDate && d.endDate) { d.endDate = P.rollEnd(d.startDate, d.endDate, d.endWeekday); d.nights = Math.max(1, P.diffDays(d.startDate, d.endDate)); }
    else if (d.startDate && d.nights != null) d.endDate = P.addDays(d.startDate, d.nights);
  }

  var busy = false;
  function setBusy(b) { busy = b; document.body.classList.toggle("busy", b); }

  /* Screen 1: every utterance (voice or typed) refines the same draft */
  function handleInput(text, via) {
    text = String(text || "").trim();
    if (!text) return;
    state.utts.push(text);
    var p = P.parseTrip(text);
    p.destMarked = /\b(to|in|visiting)\s+[a-z]/i.test(text) || (state.utts.length === 1);
    merge(state.draft, p);
    settle(state.draft);
    var d = state.draft;
    var check = d.dest && !d.place && !d.destBad ? geocode(d.dest).catch(function () { return "offline"; }) : Promise.resolve(null);
    setBusy(true); renderInput();
    return check.then(function (place) {
      setBusy(false);
      if (place === "offline") d.place = { name: d.dest, country: "", lat: null, lon: null };
      else if (place) d.place = place;
      else if (d.dest && !d.place) { d.destBad = d.dest; d.dest = null; }
      save(); renderInput();
      // the trip summary sits at the top of the window once he's done talking
      if (!mobile()) window.scrollTo(0, 0);
      else window.scrollTo(0, $("#trip-sum").getBoundingClientRect().top + window.scrollY - 8);
      var miss = missing(d);
      if (miss.length) {
        say((d.destBad ? "I couldn't find \u201c" + d.destBad + "\u201d. " : "") + "Still need: " + miss.map(function (n) { return n[1].toLowerCase(); }).join("; ") + ".", function () {
          if (via === "voice") autoListen();
        }, "Answer what's still needed in one go.");
      } else say("Got everything. Tap Build the list.");
    });
  }

  /* ---------- Screen 1 render ---------- */
  function renderInput() {
    var d = state.draft, sum = $("#trip-sum"), miss = $("#missing");
    var any = state.utts.length > 0;
    if (any) {
      var row = function (label, val, isMiss) { return "<div><dt>" + label + "</dt><dd" + (isMiss ? ' class="miss"' : "") + ">" + esc(val) + "</dd></div>"; };
      var nights = d.nights != null ? " \u00b7 " + d.nights + " night" + (d.nights === 1 ? "" : "s") : "";
      sum.innerHTML = '<div class="sum-h"><p>Your trip</p><button type="button" id="startover">Start over</button></div><dl class="pairs">' +
        row("Where", d.place ? placeLabel(d.place) : d.dest || "missing", !(d.dest && !d.destBad)) +
        row("Leave", d.startDate ? fmtDate(d.startDate) + (d.approxDate ? " (approx.)" : "") : "missing", !d.startDate) +
        row("Back", d.endDate ? fmtDate(d.endDate) + nights : d.nights != null ? d.nights + " nights" : "missing", !hasBack(d)) +
        row("Laundry", d.laundry ? (d.laundry === "yes" ? "Yes" : "No") : "missing", !d.laundry) +
        row("Bag", d.carryOn == null ? "missing" : d.carryOn ? "Carry-on only" : "Checked bag", d.carryOn == null) +
        row("Plans", d.activities.length ? d.activities.join(", ") : "Nothing special", false) +
        "</dl>";
      sum.hidden = false;
    } else sum.hidden = true;
    var m = missing(d);
    if (any && m.length) {
      miss.innerHTML = '<p class="mh">Still need ' + m.length + (m.length === 1 ? " thing" : " things") + "</p><ul>" +
        m.map(function (n) { return "<li>" + esc(n[0] === "dest" && d.destBad ? "Where you're going (couldn't find \u201c" + d.destBad + "\u201d)" : n[1]) + "</li>"; }).join("") +
        '</ul><p class="mhint">Answer them all at once by voice or text.</p>';
      miss.hidden = false;
    } else miss.hidden = true;
    $("#build").hidden = !(any && !m.length) || busy;
    renderUtts();
    dockH();
  }
  var live = "";
  function renderUtts() {
    var u = $("#utts");
    if (!state.utts.length && !live) { u.innerHTML = '<p class="t-empty">Tap the mic and describe the trip: where, when you leave and get back, laundry, carry-on or checked, plans. Say as much as you like.</p>'; return; }
    u.innerHTML = state.utts.map(function (t, i) { return '<p class="' + (i < state.utts.length - 1 || live ? "old" : "") + '">' + esc(t) + "</p>"; }).join("") + (live ? '<p class="live">' + esc(live) + "</p>" : "");
    if (live && mobile()) { var el = u.lastElementChild, r = el.getBoundingClientRect(), lim = innerHeight - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dock-h")) || 0) - 12; if (r.bottom > lim) window.scrollBy(0, r.bottom - lim); }
    if (live && !mobile()) { var tr = $("#transcript"); tr.scrollTop = tr.scrollHeight; }
  }

  /* ---------- Screen 2 ---------- */
  function buildTrip() {
    var d = state.draft;
    settle(d);
    var prev = state.trip;
    var trip = { dest: d.place ? d.place.name : d.dest, place: d.place, start: d.startDate, end: d.endDate || P.addDays(d.startDate, d.nights), nights: Math.max(1, Math.min(30, d.nights || 1)),
      approxDate: !!d.approxDate, activities: d.activities.slice(), meds: !!d.meds, laundry: d.laundry === "yes", carryOn: d.carryOn !== false, weather: null };
    if (!prev || prev.dest !== trip.dest) { state.packed = {}; state.removed = {}; state.custom = []; }
    $("#build").disabled = true; $("#build").textContent = "Checking the weather\u2026";
    var wx = trip.place && trip.place.lat != null ? getWeather(trip.place, trip.start, trip.nights).catch(function () { return null; }) : Promise.resolve(null);
    return wx.then(function (w) {
      $("#build").disabled = false; $("#build").textContent = "Build the list";
      trip.weather = w || E.summarizeWeather([], "none");
      state.trip = trip; regenerate();
      go("list");
    });
  }
  function regenerate() {
    var t = state.trip;
    t.items = E.buildList({ nights: t.nights, laundry: t.laundry, carryOn: t.carryOn, weather: t.weather, activities: t.activities, meds: t.meds });
  }
  function visibleItems() {
    if (!state.trip || !state.trip.items) return [];
    return state.trip.items.filter(function (i) { return !state.removed[i.id]; }).concat(state.custom);
  }

  function renderList() {
    var t = state.trip, vis = visibleItems(), done = vis.filter(function (i) { return state.packed[i.id]; }).length;
    var pc = vis.length ? Math.round(done / vis.length * 100) : 0;
    $("#list-top").innerHTML = '<h1><svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7.5V6a3 3 0 0 1 6 0v1.5"/><rect x="5" y="7.5" width="14" height="13.5" rx="4"/><path d="M5 12.5h14"/><rect x="9.2" y="14.5" width="5.6" height="3.6" rx="1.4"/></svg>Trip to ' + esc(t.dest) + "</h1>" +
      '<span class="progress" aria-live="polite"><span class="count">' + done + " of " + vis.length + ' packed</span><span class="prog" aria-hidden="true"><span style="width:' + pc + '%"></span></span></span>' +
      '<button type="button" class="pill" id="editTrip">Edit trip</button>';
    var col = state.collapsed || (state.collapsed = {});
    $("#list").innerHTML = E.CATEGORIES.map(function (c) {
      var its = vis.filter(function (i) { return i.category === c[0]; });
      if (!its.length) return "";
      its = its.filter(function (i) { return !state.packed[i.id]; }).concat(its.filter(function (i) { return state.packed[i.id]; }));
      var dn = its.filter(function (i) { return state.packed[i.id]; }).length, closed = !!col[c[0]];
      return '<section class="cat' + (closed ? " closed" : "") + (dn === its.length ? " alldone" : "") + '"><h3><button type="button" class="cat-h" data-cat="' + c[0] + '" aria-expanded="' + !closed + '">' + c[1] + '<span class="cn">' + dn + "/" + its.length + "</span></button></h3><ul>" + its.map(function (i) {
        var p = !!state.packed[i.id];
        return '<li class="item' + (p ? " done" : "") + '" data-row="' + esc(i.id) + '"><button type="button" class="box" data-id="' + esc(i.id) + '" role="checkbox" aria-checked="' + p + '" aria-label="' + esc(i.label) + '"></button>' +
          '<div class="ib"><span class="nm">' + esc(i.label) + (i.quantity > 1 ? ' <b class="q">\u00d7' + i.quantity + "</b>" : "") + (i.wear ? ' <em class="wear">wear it</em>' : "") + "</span>" +
          '<span class="why" title="' + esc(i.reason) + '">' + esc(i.reason) + "</span></div>" +
          '<button type="button" class="cut" data-cut="' + esc(i.id) + '" aria-label="Remove ' + esc(i.label) + '" title="Remove">\u00d7</button></li>';
      }).join("") + "</ul></section>";
    }).join("");
    var grams = E.bagGrams(vis), budget = t.carryOn ? CARRY_ON_KG : CHECKED_KG, pct = Math.min(100, Math.round(grams / (budget * 10)));
    $("#side-sum").innerHTML = '<dl class="pairs">' +
      "<div><dt>Where</dt><dd>" + esc(placeLabel(t.place, t.dest)) + "</dd></div>" +
      "<div><dt>Dates</dt><dd>" + esc(fmtDate(t.start) + " \u2192 " + fmtDate(t.end) + " \u00b7 " + t.nights + " night" + (t.nights === 1 ? "" : "s") + (t.approxDate ? " (approx.)" : "")) + "</dd></div>" +
      "<div><dt>Weather</dt><dd>" + esc(weatherWords(t.weather)) + "</dd></div>" +
      "<div><dt>Bag</dt><dd>" + (grams / 1000).toFixed(1) + " kg of " + budget + " kg " + (t.carryOn ? "carry-on" : "checked") + ' <span class="muted">(rough estimate)</span><span class="meter" aria-hidden="true"><span style="width:' + pct + '%"></span></span></dd></div>' +
      "</dl>" +
      '<p class="chips" style="margin-top:8px"><button type="button" data-toggle="laundry" aria-pressed="' + t.laundry + '">' + (t.laundry ? "Laundry: yes" : "Laundry: no") + "</button>" +
      '<button type="button" data-toggle="carry" aria-pressed="' + t.carryOn + '">' + (t.carryOn ? "Carry-on only" : "Checked bag") + "</button>" +
      (t.activities.length ? '<span class="chip">' + esc(t.activities.join(", ")) + "</span>" : "") + "</p>";
    $("#notes").innerHTML = E.coachNotes({ weather: t.weather, laundry: t.laundry, nights: t.nights, items: vis }).slice(0, 2).map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("");
    dockH();
  }

  /* commands on the checklist (leanpack's matcher + packlight's add/remove) */
  function listCommand(raw) {
    var lower = raw.toLowerCase().replace(/[\u2019]/g, "'").replace(/[.!?]+$/, "").trim(), m, items = visibleItems();
    if (/^(new trip|start over|reset|restart)$/.test(lower)) { startOver(); return; }
    if (/^(edit( the)? trip|change( the)? trip|go back)$/.test(lower)) return go("input");
    if (/\b(what'?s left|what is left|remaining|not packed|still to pack|progress)\b/.test(lower)) {
      var left = items.filter(function (i) { return !state.packed[i.id]; });
      if (!left.length) return say("Nothing left. You're packed.");
      return say(left.length + " left: " + left.slice(0, 4).map(function (i) { return i.label.toLowerCase(); }).join(", ") + (left.length > 4 ? ", and more." : "."));
    }
    if (/\b(weather|forecast|temperature)\b/.test(lower) && !/\bpacked\b/.test(lower)) return say(state.trip.dest + ": " + weatherWords(state.trip.weather) + ".");
    if (!/^add anyway\b/.test(lower)) for (var k = 0; k < E.PUSHBACK.length; k++) {
      if (E.PUSHBACK[k][0].test(raw) && /\b(add|bring|pack|need|should i|take)\b/i.test(raw)) return say(E.PUSHBACK[k][1] + " (Say \u201cadd anyway\u201d to keep it.)");
    }
    if ((m = raw.match(/^(?:please\s+)?(?:add anyway|add|put on|also bring|bring)\s+(?:the\s+|a\s+|an\s+|my\s+|some\s+)?(.+?)[.!]?$/i))) {
      var name = m[1].trim();
      state.custom.push({ id: "custom." + Date.now(), label: name.charAt(0).toUpperCase() + name.slice(1), aliases: [name.toLowerCase()], quantity: 1, category: "custom", reason: "You added this.", grams: 150 });
      save(); renderList(); return say("Added " + name + ".");
    }
    if ((m = lower.match(/^(?:please\s+)?(?:remove|drop|cut|delete|skip|leave)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:off the list|at home|home))?$/))) {
      var r = E.matchItem(m[1], items);
      if (!r) return say("I don't see " + m[1] + " on the list.");
      removeItem(r); return say("Cut " + r.label.toLowerCase() + ". Lighter already.");
    }
    if ((m = lower.match(/^(?:please\s+)?(?:uncheck|unpack|not packed|undo)\s+(?:the\s+|my\s+)?(.+)$/))) {
      var u = E.matchItem(m[1], items);
      if (!u) return say("I don't see " + m[1] + " on the list.");
      delete state.packed[u.id]; save(); renderList(); return say(u.label + " is back on the list.");
    }
    if ((m = lower.match(/^(?:please\s+)?(?:check(?:\s+off)?|checked|packed|i packed|pack|got|tick|mark|done(?: with)?)\s+(?:the\s+|my\s+|our\s+)?(.+)$/))) {
      if (/^(everything|all|it all)$/.test(m[1])) { items.forEach(function (i) { state.packed[i.id] = true; }); save(); renderList(); return say("Everything packed. Have a good trip."); }
      var c = E.matchItem(m[1], items);
      if (!c) return say("I don't have " + m[1] + " on the list. That's probably correct.");
      return markPacked(c);
    }
    var p = P.parseTrip(raw);
    if ((p.laundry || p.carryOn != null) && !p.dest) {
      if (p.laundry) state.trip.laundry = p.laundry === "yes";
      if (p.carryOn != null) state.trip.carryOn = p.carryOn;
      regenerate(); save(); renderList();
      return say("Updated: " + (state.trip.laundry ? "laundry mid-trip" : "no laundry") + ", " + (state.trip.carryOn ? "carry-on only" : "checked bag") + ".");
    }
    var bare = E.matchItem(raw, items);
    if (bare && raw.split(/\s+/).length <= 4) return markPacked(bare);
    say("Try \u201cpacked socks\u201d, \u201cadd sunglasses\u201d, \u201ccut sleepwear\u201d or \u201cwhat's left\u201d. To change the trip, tap Edit trip.");
  }
  function markPacked(i) {
    var was = state.packed[i.id]; state.packed[i.id] = true; save(); renderList();
    var left = visibleItems().filter(function (x) { return !state.packed[x.id]; }).length;
    say(was ? i.label + " was already packed." : "Packed " + i.label.toLowerCase() + ". " + (left ? left + " to go." : "That's everything."));
  }
  function removeItem(i) {
    if (i.category === "custom") state.custom = state.custom.filter(function (c) { return c.id !== i.id; });
    else state.removed[i.id] = true;
    delete state.packed[i.id]; save(); renderList();
  }
  function startOver() { stopDictation(true); state = blank(); save(); live = ""; $("#reply").textContent = ""; go("input", true); }

  /* ---------- views (hash routing so Back works; reload returns to the saved view) ---------- */
  function go(view, replace) {
    state.view = view; save();
    var h = view === "list" ? "#list" : "#trip";
    if (location.hash !== h) { if (replace) history.replaceState(null, "", h); else history.pushState(null, "", h); }
    show();
  }
  function show() {
    var v = state.view;
    document.body.dataset.view = v;
    $("#v-input").hidden = v !== "input"; $("#v-list").hidden = v !== "list";
    if (v === "list") { renderList(); $("#cmd-reply").textContent = ""; }
    else renderInput();
    // checklist opens with its top at the top of the screen
    requestAnimationFrame(function () {
      if (v === "list" && mobile()) window.scrollTo(0, $("#v-list").getBoundingClientRect().top + window.scrollY);
      else window.scrollTo(0, 0);
    });
  }
  window.addEventListener("popstate", function () {
    var want = location.hash === "#list" && state.trip && state.trip.items ? "list" : "input";
    if (want !== state.view) { stopDictation(true); state.view = want; save(); show(); }
  });

  /* ---------- dictation: keeps listening across pauses, shows the whole transcript ----------
     Each recognition round is short (iOS needs a fresh recognizer per utterance); rounds restart
     automatically (handsFree) and their finals accumulate until a ~2s silence or a second tap. */
  var dict = null, SILENCE_MS = 2200, autoStart = false;
  function target() { return state.view === "list" ? "cmd" : "input"; }
  function startDictation(isAuto) {
    if (dict) return true;
    if (!V.recognitionAvailable) return false;
    autoStart = !!isAuto;
    dict = { finals: [], interim: "", timer: null, where: target() };
    live = ""; V.handsFree = true;
    paintMic(true);
    if (!V.startListening()) { dict = null; paintMic(false); return false; }
    return true;
  }
  function liveText() { return dict ? (dict.finals.join(" ") + (dict.interim ? " " + dict.interim : "")).trim() : ""; }
  function armSilence() { if (!dict) return; clearTimeout(dict.timer); dict.timer = setTimeout(finishDictation, SILENCE_MS); }
  function finishDictation() {
    if (!dict) return;
    var text = liveText(), where = dict.where;
    stopDictation(false);
    if (!text) return;
    if (where === "cmd") { $("#cmd-text").value = ""; listCommand(text); }
    else handleInput(text, "voice");
  }
  function stopDictation(discard) {
    if (!dict) return;
    clearTimeout(dict.timer); dict = null; live = "";
    V.stopListening(); paintMic(false);
    if (discard && state.view === "input") renderUtts();
  }
  function paintMic(on) {
    ["#mic", "#cmd-mic"].forEach(function (s) { var b = $(s); b.classList.toggle("live", on); b.setAttribute("aria-pressed", String(on)); if (on) b.classList.remove("nudge"); });
    if (on) setNote(state.view === "list" ? "Listening\u2026" : "Listening\u2026 say as much as you like. Tap again when you're done.");
    else if (/^Listening/.test($("#mic-note").textContent)) setNote("Tap the mic to talk. Tap again when you're done.", true);
  }
  function setNote(t, quiet) { var n = $("#mic-note"); n.textContent = t; n.classList.toggle("quiet", !!quiet); if (state.view === "list" && !quiet) $("#cmd-reply").textContent = t; }
  function showLive() {
    var t = liveText();
    if (!dict) return;
    if (dict.where === "cmd") { $("#cmd-text").value = t; return; }
    live = t; renderUtts();
  }
  V.onInterim = function (t) { if (!dict) return; dict.interim = t; showLive(); armSilence(); };
  V.onResult = function (t) { if (!dict) return; dict.finals.push(t.trim()); dict.interim = ""; autoStart = false; showLive(); armSilence(); };
  V.onStateChange = function () {};
  V.onNoInput = function () { if (dict && !liveText()) { stopDictation(true); setNote("Not hearing anything. Check the browser's mic permission, or type."); } };
  V.onError = function (code) {
    if (!dict) return;
    if (code === "no-speech" || code === "aborted") { if (liveText()) finishDictation(); return; }
    var wasAuto = autoStart; stopDictation(true);
    if (wasAuto && code !== "audio-capture") return nudgeTap();
    var M = { "not-allowed": "The mic is blocked for this site. Allow it in the address bar, or type.", "service-not-allowed": "This browser blocks speech recognition. Typing works the same.",
      "network": "The browser's speech service had a hiccup. Try again, or type.", "audio-capture": "No microphone found. Typing works the same.", "timeout": "Voice stalled. Tap the mic to retry, or type." };
    setNote(M[code] || "Voice hit a snag in this browser. Typing works the same.");
  };
  /* After a voice answer leaves gaps, reopen the mic. iOS Safari may refuse a start that isn't
     from a tap; then ask for one tap instead of showing an error. */
  function autoListen() {
    if (state.view !== "input" || !V.recognitionAvailable) return;
    setTimeout(function () { if (!startDictation(true)) nudgeTap(); }, 300);
  }
  function nudgeTap() { autoStart = false; $("#mic").classList.add("nudge"); setNote("Tap the mic and answer everything at once."); }

  /* ---------- wiring ---------- */
  $("#mic").addEventListener("click", function () { if (dict) finishDictation(); else startDictation(false); });
  $("#cmd-mic").addEventListener("click", function () { if (dict) finishDictation(); else startDictation(false); });
  if (!V.recognitionAvailable) {
    ["#mic", "#cmd-mic"].forEach(function (s) { $(s).disabled = true; $(s).classList.add("off"); });
    setNote("Voice input needs Chrome, Edge or Safari. Typing does the same thing.");
  }
  var ta = $("#text");
  function grow() { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; dockH(); }
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#form").requestSubmit ? $("#form").requestSubmit() : $("#go").click(); } });
  $("#form").addEventListener("submit", function (e) { e.preventDefault(); stopDictation(true); var v = ta.value; ta.value = ""; grow(); handleInput(v, "text"); });
  $("#cmd-form").addEventListener("submit", function (e) { e.preventDefault(); stopDictation(true); var v = $("#cmd-text").value; $("#cmd-text").value = ""; if (v.trim()) listCommand(v); });
  $("#build").addEventListener("click", function () { stopDictation(true); buildTrip(); });
  $("#speaker").addEventListener("click", function () {
    muted = !muted; V.enabled = !muted; if (muted) V.stopSpeaking();
    try { localStorage.setItem(MUTE_KEY, muted ? "on" : "off"); } catch (e) {}
    paintMute();
  });
  document.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) {
      var row = e.target.closest(".item");
      if (row) { var rid = row.dataset.row; if (state.packed[rid]) delete state.packed[rid]; else state.packed[rid] = true; save(); renderList(); }
      return;
    }
    if (b.id === "startover") return startOver();
    if (b.id === "editTrip") { stopDictation(true); return go("input"); }
    if (b.dataset.cat) { state.collapsed[b.dataset.cat] = !state.collapsed[b.dataset.cat]; save(); renderList(); return; }
    if (b.dataset.id) { var id = b.dataset.id; if (state.packed[id]) delete state.packed[id]; else state.packed[id] = true; save(); renderList(); return; }
    if (b.dataset.cut) { var it = visibleItems().filter(function (i) { return i.id === b.dataset.cut; })[0]; if (it) { removeItem(it); say("Cut " + it.label.toLowerCase() + "."); } return; }
    if (b.dataset.toggle) {
      var t = state.trip;
      if (b.dataset.toggle === "laundry") t.laundry = !t.laundry; else t.carryOn = !t.carryOn;
      state.draft.laundry = t.laundry ? "yes" : "no"; state.draft.carryOn = t.carryOn;
      regenerate(); save(); renderList();
    }
  });

  /* mobile docks are fixed; keep the page padded above them */
  function dockH() {
    var el = state.view === "list" ? document.querySelector(".v-list .cmd") : $("#dock");
    var h = mobile() && el ? el.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty("--dock-h", h + "px");
  }
  if (window.ResizeObserver) { var ro = new ResizeObserver(dockH); ro.observe($("#dock")); ro.observe(document.querySelector(".v-list .cmd")); }
  window.addEventListener("resize", dockH);

  restore(); paintMute();
  if (location.hash === "#trip" && state.view === "list") state.view = "input";
  history.replaceState(null, "", state.view === "list" ? "#list" : "#trip");
  show();
  window.__packlight = { handle: function (t, via) { return state.view === "list" ? listCommand(t) : handleInput(t, via || "text"); }, state: function () { return state; },
    _dictate: function (parts) { startDictation(false); parts.forEach(function (p) { V.onInterim(p); }); if (parts.length) V.onResult(parts[parts.length - 1]); return liveText(); }, _finish: finishDictation };
})();
