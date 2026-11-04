/* Packlight trip parser: one-shot sentence -> trip fields. Deterministic, no LLM.
   "Chicago next Thursday for 4 nights, some hiking, no laundry" ->
   { dest:"Chicago", startDate:"2026-11-05", nights:4, activities:["hiking"], laundry:"no" } */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LeanParse = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- dates (local, YYYY-MM-DD) ---------- */
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fromIso(s) { var p = s.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(s, n) { var d = fromIso(s); d.setDate(d.getDate() + n); return iso(d); }
  function diffDays(a, b) { return Math.round((fromIso(b) - fromIso(a)) / 86400000); }
  function today(now) { var d = new Date(now || Date.now()); return iso(d); }

  var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  var DOWS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  var MON_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  var ORD = "(?:st|nd|rd|th)?";
  var DOW_RE = "(?:(?:next|this|coming|on)\\s+(?:mon|tues?|wed|thur?s?|fri|sat|sun)\\b|(?:(?:next|this|coming)\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))";
  var DATE_RE = "(?:day after tomorrow|tomorrow|today|tonight|" + DOW_RE + "|" +
    MON_RE + "\\.?\\s+\\d{1,2}" + ORD + "(?:,?\\s+\\d{4})?|" +
    "\\d{1,2}" + ORD + "\\s+(?:of\\s+)?" + MON_RE + "|" +
    "\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?|" +
    "the\\s+\\d{1,2}" + ORD + "|" +
    "in\\s+\\d+\\s+(?:days?|weeks?)|next week)";

  function monthIdx(s) { return MONTHS.indexOf(s.slice(0, 3)); }
  function dowIdx(s) {
    s = s.toLowerCase();
    for (var i = 0; i < 7; i++) if (s.indexOf(DOWS[i].slice(0, 3)) === 0) return i;
    return -1;
  }
  function futureMD(t, m, d) {
    var y = fromIso(t).getFullYear(), c = iso(new Date(y, m, d));
    return c < t ? iso(new Date(y + 1, m, d)) : c;
  }

  /* one DATE_RE match -> YYYY-MM-DD (relative to today t) */
  function resolveDate(expr, t, refMonth) {
    var e = expr.toLowerCase().replace(/\s+/g, " ").trim(), m;
    if (e === "today" || e === "tonight") return t;
    if (e === "tomorrow") return addDays(t, 1);
    if (e === "day after tomorrow") return addDays(t, 2);
    if (e === "next week") { var dw = fromIso(t).getDay(); return addDays(t, ((8 - dw) % 7) || 7); }
    if ((m = e.match(/^in (\d+) (days?|weeks?)$/))) return addDays(t, +m[1] * (m[2][0] === "w" ? 7 : 1));
    if ((m = e.match(/^(?:(next|this|coming|on) )?([a-z]+)$/)) && dowIdx(m[2]) >= 0 && !/^(the|in)$/.test(m[2])) {
      var target = dowIdx(m[2]), cur = fromIso(t).getDay();
      var delta = (target - cur + 7) % 7;
      if (m[1] === "next") {
        // "next X" = X in the next calendar week (weeks start Monday)
        var curMon = (cur + 6) % 7, tgtMon = (target + 6) % 7;
        delta = 7 - curMon + tgtMon;
      } else if (delta === 0) delta = 7;
      return addDays(t, delta);
    }
    if ((m = e.match(new RegExp("^(" + MON_RE + ")\\.? (\\d{1,2})" + ORD + "(?:,? (\\d{4}))?$")))) {
      if (m[3]) return iso(new Date(+m[3], monthIdx(m[1]), +m[2]));
      return futureMD(t, monthIdx(m[1]), +m[2]);
    }
    if ((m = e.match(new RegExp("^(\\d{1,2})" + ORD + " (?:of )?(" + MON_RE + ")$")))) return futureMD(t, monthIdx(m[2]), +m[1]);
    if ((m = e.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/))) {
      if (m[3]) { var y = +m[3]; if (y < 100) y += 2000; return iso(new Date(y, +m[1] - 1, +m[2])); }
      return futureMD(t, +m[1] - 1, +m[2]);
    }
    if ((m = e.match(/^(?:the )?(\d{1,2})(?:st|nd|rd|th)?$/))) {
      var base = fromIso(t), mo = refMonth != null ? refMonth : base.getMonth();
      var c = iso(new Date(base.getFullYear(), mo, +m[1]));
      if (c < t) c = iso(new Date(base.getFullYear(), mo + 1, +m[1]));
      return c;
    }
    return null;
  }

  /* "next Thursday, back Monday": a weekday return date means the first one after departure */
  function rollEnd(start, end, weekday) {
    if (!start || !end || !weekday) return end;
    for (var i = 0; i < 6 && end <= start; i++) end = addDays(end, 7);
    return end;
  }

  /* ---------- words -> numbers ---------- */
  var NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, twenty: 20, thirty: 30 };
  function numerals(s) {
    s = s.replace(/\b(a couple(?: of)?|couple of)\s+(?=(nights?|days?|weeks?))/g, "2 ")
      .replace(/\ba few\s+(?=(nights?|days?|weeks?))/g, "3 ")
      .replace(/\b(?:a|an|one)\s+(?=(night|day|week)\b)/g, "1 ")
      .replace(/\ba fortnight\b|\bfortnight\b/g, "2 weeks")
      .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|twenty|thirty)\b/g, function (w) { return String(NUM[w]); });
    return s;
  }

  /* ---------- activities ---------- */
  var ACTS = [
    ["hiking", /\b(hik(e|es|ing)|trails?|trek(king)?|backpacking)\b/],
    ["running", /\b(run|runs|running|jog|jogging|marathon|5k|10k)\b/],
    ["swimming", /\b(swim|swims|swimming|pool|snorkel(ing)?|diving)\b/],
    ["beach", /\b(beach|beaches|surf(ing)?)\b/],
    ["formal", /\b(wedding|gala|formal|black tie|fancy dinner|nice dinner|fancy)\b/],
    ["work", /\b(work|business|conference|meetings?|client|offsite|onsite)\b/],
    ["cycling", /\b(bike|biking|cycling|cycle)\b/],
    ["skiing", /\b(ski|skiing|snowboard(ing)?)\b/],
    ["gym", /\b(gym|workouts?|lifting|fitness|yoga)\b/],
    ["camping", /\b(camp|camping|tent)\b/]
  ];

  var CITY_ALIASES = { nyc: "New York", "new york city": "New York", "n y c": "New York", la: "Los Angeles", "l a": "Los Angeles", sf: "San Francisco", "s f": "San Francisco", dc: "Washington DC", "d c": "Washington DC", "washington d c": "Washington DC", philly: "Philadelphia", vegas: "Las Vegas", saigon: "Ho Chi Minh City", hcmc: "Ho Chi Minh City" };

  var FILLER = /^(?:(?:no|nope|nah|not|wait|sorry|oops|i meant|i mean|i said|meant|wrong|make that|make it|change it to|change that to|change to|instead|so|ok|okay|um|uh|hey|well|alright|actually|i'?m|i am|we'?re|we are|i'?ll be|we'?ll be|i will be|i'?ve got|i have|we have|going|gonna|go|heading|headed|head|flying|fly|driving|drive|traveling|travelling|taking|take|off|out|over|down|up|on|a|an|my|our|the|trip|work trip|business trip|vacation|holiday|getaway|visit(?:ing)?|planning|plan|to|for|it'?s|its|there'?s|then|and|just)\s+)+/;
  var STOP = /\s+\b(?:for|on|from|with|and|next|this|leaving|leave|departing|until|till|through|thru|returning|return|back|over|during|starting|then|but|plus|some|no|doing|staying|via|by|around|after|before)\b.*$/;
  var NOT_PLACE = /^(yes|yeah|yep|no|nope|ok|okay|sure|please|thanks|it|there|home|here|nothing|none|carry|carry on|checked|laundry|some|just|trip|a|the|and|for|week|weekend|nights?|days?|go|be|see|stay|staying|work|working|fly|drive|head|hike|ski|surf|swim|camp|meet|get|do|have|pack|leave|bring|hotels?|(?:an? |the |my )?(?:hotel|airbnb|resort|hostel|conference|wedding|meeting|friends?(?:'s| house)?|family|parents|mom|dad|beach|mountains|city|town|office|school|lake|cabin)|i|we|me|us|that|this|then|there|it'?s|i'?ll|we'?ll|i'?ll have|i have)$/;
  var CORRECTION = /^\s*(?:no|nope|nah|not|wait|sorry|oops|actually|i meant|i mean|i said|wrong|make (?:it|that)|change)\b/;

  function cleanDest(s) {
    if (!s) return null;
    // "a hotel in kyoto" / "into reykjavik": keep what follows the last place marker
    s = s.replace(/^.*\b(?:in|to|at|into|near|visiting)\s+(?=[a-z])/, "");
    s = s.replace(/[.!?]+$/, "").replace(FILLER, "").replace(STOP, "").replace(/\s+(?:in|to|at)$/, "").replace(/[,\s]+$/, "").trim();
    if (!s || /\d/.test(s) || s.length < 2 || s.split(" ").length > 6 || NOT_PLACE.test(s)) return null;
    if (CITY_ALIASES[s]) return CITY_ALIASES[s];
    return s.replace(/\b([a-z])/g, function (c) { return c.toUpperCase(); }).replace(/\b(De|Del|Da|Di|Du|La|Le|Los|Las|Of|Upon|On|Am|Im)\b(?=\s)/g, function (w, x, i) { return i === 0 ? w : w.toLowerCase(); });
  }

  /* text -> partial trip. now: Date|number (for tests). */
  function parseTrip(text, now) {
    var t0 = today(now);
    var out = { activities: [] };
    // accents off (S\u00e3o Paulo, Reykjav\u00edk): the geocoder is accent-insensitive anyway
    var s = " " + numerals(String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u2013\u2014]/g, "-")) + " ";
    function cut(re, fn) { s = s.replace(re, function () { var r = fn.apply(null, arguments); return r == null ? " , " : r; }); }

    // laundry / carry-on / meds first (they contain words like "no" and "bag")
    cut(/\b(?:no|without|not|won'?t have|don'?t have|no access to|can'?t do)\s+(?:any\s+|a\s+)?(?:laundry|washer|washing machine)\b/g, function () { out.laundry = "no"; });
    cut(/\b(?:no|nope)\s*,?\s*(?:to\s+)?laundry\b|\blaundry\s*(?::|-)?\s*(?:no|nope)\b/g, function () { out.laundry = "no"; });
    cut(/\b(?:yes|yeah|yep)\s*,?\s*(?:to\s+)?laundry\b|\blaundry\s*(?::|-)?\s*(?:yes|yeah|yep)\b|\b(?:there'?s|has|have|with|got|i'?ll have|we'?ll have)\s+(?:a\s+)?(?:laundry|washer|washing machine)\b|\b(?:do|doing|can do)\s+(?:a\s+)?(?:laundry|wash)\b|\blaundry\b|\bwasher\b|\bwashing machine\b/g, function () { if (!out.laundry) out.laundry = "yes"; });
    cut(/\b(?:no|not|without)\s+(?:a\s+)?carry[- ]?ons?(?:\s+only)?\b|\bcheck(?:ing|ed)?\s+(?:a\s+)?(?:bag|luggage|suitcase)\b|\bchecked(?:\s+bag|\s+luggage)?\b|\bbig suitcase\b/g, function () { out.carryOn = false; });
    cut(/\bcarry[- ]?ons?(?:\s+only)?\b|\b(?:just\s+a|one|only\s+a)\s+(?:backpack|bag)\b|\bbackpack only\b|\bone bag\b/g, function () { out.carryOn = true; });
    cut(/\b(meds|medication|medicine|prescriptions?|pills|inhaler|insulin)\b/g, function () { out.meds = true; return " "; });

    // ranges: "nov 5 to nov 9", "nov 5-9", "from friday until sunday"
    var R = new RegExp("(?:from\\s+|between\\s+)?(" + DATE_RE + ")\\s*(?:-|to|through|thru|until|till|and)\\s*(" + DATE_RE + "|\\d{1,2}" + ORD + "\\b)", "g");
    cut(R, function (m, a, b) {
      var sd = resolveDate(a, t0), mm = a.match(new RegExp(MON_RE));
      var ed = resolveDate(b, t0, mm ? monthIdx(mm[0]) : (sd ? fromIso(sd).getMonth() : null));
      if (!sd || !ed) return m;
      if (ed <= sd && /^\d/.test(b.trim())) ed = null;
      if (ed && ed < sd) ed = futureMD(sd, fromIso(ed).getMonth(), fromIso(ed).getDate());
      if (!ed) return m;
      out.startDate = sd; out.endDate = ed;
    });
    // return date
    var E = new RegExp("\\b(?:until|till|through|thru|returning(?:\\s+on)?|return(?:ing)?\\s+on|return|coming back(?:\\s+on)?|back(?:\\s+on|\\s+home)?|fly(?:ing)? back(?:\\s+on)?|home(?:\\s+on)?|get(?:ting)? back(?:\\s+on)?)\\s+(" + DATE_RE + ")", "g");
    cut(E, function (m, a) { var d = resolveDate(a, t0); if (!d) return m; out.endDate = d; if (new RegExp("^" + DOW_RE + "$").test(a.trim())) out.endWeekday = true; });
    // weekends
    cut(/\b(this|next|a|the)?\s*(long\s+)?weekend\b/g, function (m, w, long) {
      out.nights = long ? 3 : 2;
      if (w === "this" || w === "next") {
        var cur = fromIso(t0).getDay(), toFri = (5 - cur + 7) % 7;
        if (cur === 6) toFri = -1; if (cur === 0) toFri = -2;
        if (w === "next") toFri += 7;
        out.startDate = addDays(t0, Math.max(0, toFri));
      }
    });
    // month only: "in december"
    cut(new RegExp("\\b(?:in|during|for|this|next)\\s+(" + MON_RE + ")\\b(?!\\.?\\s*\\d)", "g"), function (m, mo) {
      if (out.startDate) return m;
      var mi = monthIdx(mo), cur = fromIso(t0);
      if (mi === cur.getMonth()) return m;
      out.startDate = futureMD(t0, mi, 15); out.approxDate = true;
    });
    // start date
    var S = new RegExp("\\b(?:(?:leaving|leave|departing|depart|flying out|fly out|starting|start|arriving|arrive|getting there|from|on|going)\\s+(?:on\\s+)?)?(" + DATE_RE + ")");
    cut(S, function (m, a) { var d = resolveDate(a, t0); if (!d) return m; if (!out.startDate) { out.startDate = d; if (new RegExp("^" + DOW_RE + "$").test(a.trim())) out.startWeekday = true; } else if (!out.endDate && d > out.startDate) out.endDate = d; });

    // length
    cut(/\b(?:for\s+)?(\d+)\s*(?:-|\s)?\s*nights?\b/g, function (m, n) { out.nights = +n; });
    cut(/\b(?:for\s+)?(\d+)\s*(?:-|\s)?\s*weeks?\b/g, function (m, n) { out.nights = +n * 7; });
    cut(/\b(?:for\s+)?(\d+)\s*(?:-|\s)?\s*days?\b/g, function (m, n) { out.nights = Math.max(1, +n - 1); out.lengthWasDays = +n; });
    cut(/\b(overnight|one night)\b/g, function () { out.nights = 1; });
    cut(/\bday trip\b/g, function () { out.nights = 1; });

    // activities
    ACTS.forEach(function (a) {
      var re = new RegExp("(\\bno\\s+)?" + a[1].source, "g");
      cut(re, function (m, neg) { if (!neg && out.activities.indexOf(a[0]) < 0) out.activities.push(a[0]); });
    });

    out.endDate = rollEnd(out.startDate, out.endDate, out.endWeekday);
    if (out.startDate && out.endDate && out.nights == null) out.nights = Math.max(1, diffDays(out.startDate, out.endDate));
    if (out.startDate && !out.endDate && out.nights != null) out.endDate = addDays(out.startDate, out.nights);
    if (!out.startDate && out.endDate && out.nights != null) out.startDate = addDays(out.endDate, -out.nights);

    // destination: every marker phrase ("to X", "in X") in order, then the leftover chunks.
    // All plausible spans go out as dests[]; the geocoder takes the first that is a real place.
    // A country/state after a comma rides along: "bangkok, thailand" -> "bangkok thailand".
    var rest = s.replace(/\s+/g, " "), dests = [];
    var END = "(?=\\s*(?:,|$|\\.|;|\\b(?:for|on|from|with|and|next|this|leaving|then|until|till|through|returning|back|over|during|starting|some|no|but|plus|because|since|so)\\b))";
    var MK = new RegExp("\\b(?:to|in|visiting|visit|at|around|into|near|outside|out of)\\s+([a-z][a-z.'\\- ]*?)" + END + "(\\s*,\\s*([a-z][a-z.' ]*?)" + END + ")?", "g");
    function addDest(span, qual) {
      var d = cleanDest(span);
      if (!d) return;
      var q = qual && cleanDest(qual);
      if (q && q.split(" ").length <= 3 && !CITY_ALIASES[qual.trim()]) d = d + " " + q;
      if (dests.indexOf(d) < 0) dests.push(d);
    }
    var mm2;
    while ((mm2 = MK.exec(rest))) { addDest(mm2[1], mm2[3]); MK.lastIndex = mm2.index + 1; }
    var chunks = rest.split(/[.;!?]/).join(",").split(",");
    for (var i = 0; i < chunks.length; i++) addDest(chunks[i].trim(), chunks[i + 1] && chunks[i + 1].trim());
    for (i = 0; i < chunks.length; i++) addDest(chunks[i].trim());
    if (dests.length) { out.dest = dests[0]; out.dests = dests; }
    if (CORRECTION.test(s)) out.correction = true;
    var bare = String(text || "").trim().match(/^(\d{1,2})$/);
    if (bare) out.bareNumber = +bare[1];
    var yn = String(text || "").trim().toLowerCase().match(/^(yes|yeah|yep|sure|no|nope|nah)[.!]?$/);
    if (yn) out.bareYesNo = /^(y|s)/.test(yn[1]) ? "yes" : "no";
    return out;
  }

  return { rollEnd: rollEnd, parseTrip: parseTrip, resolveDate: resolveDate, iso: iso, fromIso: fromIso, addDays: addDays, diffDays: diffDays, today: today };
});
