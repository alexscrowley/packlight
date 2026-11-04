/* Packlight place resolver: spoken place span -> one Open-Meteo/GeoNames place.
   Open-Meteo's name search is a prefix match on one place name ("San" -> Sanaa, Yemen;
   "Bangkok Thailand" -> nothing), so we never send the raw span. We try sub-spans,
   longest first, use any trailing words ("Thailand", "Texas", "CA") as a country/state
   qualifier, keep only results whose name actually is the spoken name, and rank:
   qualifier match > name match > population. Browser + Node. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PackPlace = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var GEO = "https://geocoding-api.open-meteo.com/v1/search";

  function norm(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[\u2018\u2019']/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\bsaint\b/g, "st").replace(/\bmount\b/g, "mt").trim();
  }
  var US = { al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming", dc: "district of columbia", "d c": "district of columbia", cali: "california" };
  var CC = { usa: "US", us: "US", "u s": "US", "u s a": "US", america: "US", "united states": "US", "the states": "US", uk: "GB", "u k": "GB", england: "GB", scotland: "GB", wales: "GB", britain: "GB", "great britain": "GB", "united kingdom": "GB", "northern ireland": "GB", uae: "AE", emirates: "AE", "united arab emirates": "AE", holland: "NL", netherlands: "NL", "the netherlands": "NL", korea: "KR", "south korea": "KR", czechia: "CZ", "czech republic": "CZ", turkey: "TR", turkiye: "TR", vietnam: "VN", "viet nam": "VN", russia: "RU", "new zealand": "NZ", nz: "NZ", "south africa": "ZA", "ivory coast": "CI" };
  // regions people say that GeoNames has no populated place for: weather from the main town
  var REGION = { saigon: "Ho Chi Minh City", hawaii: "Honolulu", "big island": "Hilo", tuscany: "Florence, Italy", provence: "Avignon", patagonia: "El Calafate", "lake tahoe": "South Lake Tahoe", tahoe: "South Lake Tahoe", yosemite: "Yosemite Valley", "the alps": "Chamonix", "swiss alps": "Zermatt", "napa valley": "Napa", "the hamptons": "East Hampton", "costa brava": "Girona", "amalfi coast": "Amalfi", "cinque terre": "Monterosso al Mare" };
  // first words of multi-word names; alone they prefix-match junk (San -> Sanaa)
  var WEAK = /^(san|santa|santo|sao|st|new|old|los|las|el|la|le|les|de|del|di|du|da|port|porto|puerto|cape|fort|mt|lake|north|south|east|west|upper|lower|great|little|big|grand|city|island|beach|bay|valley|national|park|the|of|and|in|to|at|on|ho|chi|minh|hong|kong|tel|buenos|aires|rio|abu|kuala|ad|al|is|it|go|be|hotel|work|home)$/;
  // keep towns, islands, admin areas; drop airports, parks, mountains, statues
  var GOOD = /^(PPL|ISL|ADM|PCL|AREA|RGN|PEN|CST)/;

  function qualMatch(q, r) {
    var n = norm(q); if (!n) return false;
    var country = norm(r.country), a1 = norm(r.admin1), cc = String(r.country_code || "").toUpperCase();
    if (n === country || n === a1 || n === norm(r.admin2)) return true;
    if (CC[n] && CC[n] === cc) return true;
    if (n.length === 2 && n.toUpperCase() === cc) return true;
    if (cc === "US" && US[n] && US[n] === a1) return true;
    return false;
  }
  // does the whole utterance mention this result's country or state (as whole words)?
  function mentioned(text, r, cand) {
    // the place's own words don't count ("lagos" is not a mention of Lagos State)
    var t = (" " + norm(text) + " ").replace(" " + norm(cand) + " ", " | "), bits = [r.country, r.admin1].map(norm).filter(function (b) { return b && b !== norm(r.name); });
    for (var k in CC) if (CC[k] === String(r.country_code).toUpperCase()) bits.push(k);
    if (r.country_code === "US") for (var s in US) if (US[s] === norm(r.admin1) && s.length > 2) bits.push(s);
    return bits.some(function (b) { return t.indexOf(" " + b + " ") >= 0; });
  }
  function nameTier(cand, r) {
    var c = norm(cand), n = norm(r.name);
    if (n === c || n.replace(/ city$/, "") === c || c.replace(/ city$/, "") === n) return 2;
    if ((n + " ").indexOf(c + " ") === 0) return 1;              // "Ho Chi Minh" -> "Ho Chi Minh City", "Washington" -> "Washington D.C."
    return 0;
  }

  function makeFetch(fetchJson) {
    var cache = {};
    return function (name) {
      var key = name.toLowerCase();
      if (!cache[key]) cache[key] = fetchJson(GEO + "?count=10&language=en&format=json&name=" + encodeURIComponent(name))
        .then(function (g) { return (g && g.results) || []; }, function (e) { delete cache[key]; throw e; });
      return cache[key];
    };
  }

  /* candidate spans, longest first, left first; trailing words become the qualifier */
  function spans(span) {
    var w = norm(span).split(" ").filter(Boolean), out = [];
    for (var len = Math.min(w.length, 5); len >= 1; len--)
      for (var i = 0; i + len <= w.length; i++) {
        var name = w.slice(i, i + len).join(" ");
        if (len === 1 && (WEAK.test(name) || name.length < 3)) continue;
        out.push({ name: name, qual: w.slice(i + len).join(" ") });
      }
    return out;
  }

  function pick(results, cand, qual, text, loose) {
    var best = null, bestKey = null;
    results.forEach(function (r) {
      if (!GOOD.test(r.feature_code || "PPL")) return;
      var tier = nameTier(cand, r);
      if (!tier && !loose) return;
      var key = [qual && qualMatch(qual, r) ? 1 : 0, mentioned(text, r, cand) ? 1 : 0, tier, r.population || 0, /^(PPLC|PPLA|ISL)/.test(r.feature_code) ? 1 : 0];
      if (!bestKey || cmp(key, bestKey) > 0) { best = r; bestKey = key; }
    });
    return best ? { r: best, qualOk: !!bestKey[0] || !!bestKey[1], exact: bestKey[2] > 0 } : null;
  }
  function cmp(a, b) { for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

  function toPlace(r) {
    return { name: r.name, region: r.admin1 || "", country: r.country || "", countryCode: r.country_code || "", lat: r.latitude, lon: r.longitude, population: r.population || 0, id: r.id };
  }

  /* resolve(spans[], fullText, fetchJson) -> Promise<place|null>. Rejects only if the network fails. */
  function resolve(dests, text, fetchJson) {
    var search = makeFetch(fetchJson);
    dests = (Array.isArray(dests) ? dests : [dests]).filter(Boolean);
    var i = 0;
    function nextDest() {
      if (i >= dests.length) return Promise.resolve(null);
      var d = String(dests[i++]), nd = norm(d);
      if (REGION[nd]) d = REGION[nd];
      return one(d, text || d, search).then(function (p) { return p || nextDest(); });
    }
    return nextDest();
  }
  function one(span, text, search) {
    var full = norm(span), comma = String(span).split(",");
    var list = spans(span), j = 0, fallback = null, loose = null;
    // "Paris, France" typed with a comma: try the API's own qualifier form first
    var pre = comma.length > 1 ? search(comma[0].trim() + ", " + comma.slice(1).join(" ").trim()).then(function (rs) { var p = pick(rs, comma[0], comma.slice(1).join(" "), text); return p && p.r; }) : Promise.resolve(null);
    return pre.then(function (hit) { return hit ? toPlace(hit) : step(); });
    function done() { var r = fallback || loose; return r ? toPlace(r) : null; }
    function isArea(r) { return /^(PCL|ADM1)/.test(r.feature_code || "") || norm(r.name) === norm(r.country); }
    function step() {
      if (j >= list.length) return done();
      var c = list[j++], trailing = full !== c.name && full.slice(-c.name.length) === c.name;
      var q = c.qual ? search(c.name + ", " + c.qual).then(function (rs) { return pick(rs, c.name, c.qual, text); }) : Promise.resolve(null);
      return q.then(function (hit) {
        if (hit && hit.exact) return toPlace(hit.r);
        return search(c.name).then(function (rs) {
          var p = pick(rs, c.name, c.qual, text);
          if (!p) {
            // nothing by name; for the whole span keep the biggest prefix hit as a last resort
            if (c.name === full && full.length >= 5 && !loose) { var lp = pick(rs, c.name, c.qual, text, true); if (lp) loose = lp.r; }
            return step();
          }
          // "queenstown new zealand": the trailing country is a qualifier, not the destination
          if (trailing && isArea(p.r)) { fallback = fallback || p.r; return step(); }
          // a qualifier was spoken but nothing matched it: try shorter spans, remember this one
          if (c.qual && !p.qualOk) { fallback = fallback || p.r; return step(); }
          return toPlace(p.r);
        });
      });
    }
  }

  function label(p) {
    if (!p) return "";
    // "Bangkok, Thailand", "Paris, France"; states/provinces only where people say them
    var parts = [p.name];
    if (/^(US|CA|AU)$/.test(p.countryCode) && p.region && norm(p.region) !== norm(p.name)) parts.push(p.region);
    if (p.country) parts.push(p.countryCode === "US" ? "USA" : p.country);
    return parts.filter(Boolean).join(", ");
  }

  return { resolve: resolve, label: label, norm: norm, _spans: spans };
});
