/* Packlight packing engine: deterministic, transparent rules, no API key.
   Ported from leanpack's lib/packing-engine.ts (quantities, reasons, aliases, pushback)
   with packlight's rough weights and "wear it" tags. Runs in the browser and in Node. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LeanEngine = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var CATEGORIES = [
    ["clothes", "Clothes"], ["activity", "Activity"], ["toiletries", "Toiletries"],
    ["tech", "Tech"], ["docs", "Docs"], ["custom", "Added by you"]
  ];

  var RAIN_CODES = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99];

  function climateFromHigh(c) {
    if (c >= 28) return "hot";
    if (c >= 22) return "warm";
    if (c >= 15) return "mild";
    if (c >= 8) return "cool";
    return "cold";
  }

  /* days: [{date, tMax, tMin, precipProb?, precipSum?, code}] */
  function summarizeWeather(days, source) {
    if (!days || !days.length) {
      return { source: "none", climate: "mild", needsRain: false, avgHigh: null, avgLow: null, rainyDays: 0, days: [] };
    }
    var avg = function (k) { return days.reduce(function (s, d) { return s + d[k]; }, 0) / days.length; };
    var avgHigh = Math.round(avg("tMax")), avgLow = Math.round(avg("tMin"));
    var rainy = days.filter(function (d) {
      if (source === "last-year") return (d.precipSum || 0) >= 2;
      return (d.precipProb || 0) >= 45 || RAIN_CODES.indexOf(d.code) >= 0;
    });
    var needsRain = source === "last-year" ? rainy.length >= Math.max(1, Math.ceil(days.length * 0.25)) : rainy.length > 0;
    var snow = days.some(function (d) { return d.code >= 71 && d.code <= 77; });
    return {
      source: source, climate: climateFromHigh(avgHigh), needsRain: needsRain, snow: snow,
      avgHigh: avgHigh, avgLow: avgLow, minLow: Math.round(Math.min.apply(null, days.map(function (d) { return d.tMin; }))),
      rainyDays: rainy.length, wettest: rainy.length ? rainy.slice().sort(function (a, b) { return (b.precipProb || b.precipSum || 0) - (a.precipProb || a.precipSum || 0); })[0].date : null,
      days: days
    };
  }

  function halfClothes(n) { return Math.max(2, Math.ceil(n / 2)); }

  function I(id, label, aliases, qty, category, reason, grams, wear) {
    return { id: id, label: label, aliases: aliases, quantity: qty, category: category, reason: reason, grams: grams || 0, wear: !!wear };
  }

  function climateLayer(climate, needsRain, snow) {
    var L = [];
    if (climate === "cold") {
      L.push(I("clothes.sweater", "Warm sweater", ["sweater", "knit", "fleece", "jumper"], 1, "clothes", "Cold days. One warm layer, not three.", 450));
      L.push(I("clothes.coat", "Insulated coat", ["coat", "jacket", "parka", "puffer"], 1, "clothes", "Wear it on the plane. Don't pack a second.", 0, true));
      L.push(I("clothes.hat-gloves", "Hat + gloves", ["hat", "beanie", "gloves", "mittens"], 1, "clothes", snow ? "Snow in the forecast. These weigh nothing." : "Near freezing. These weigh nothing.", 120));
    } else if (climate === "cool") {
      L.push(I("clothes.sweater", "Sweater", ["sweater", "knit", "fleece", "jumper", "hoodie"], 1, "clothes", "Cool evenings. One is enough if weather holds.", 400));
      if (!needsRain) L.push(I("clothes.jacket", "Light jacket", ["jacket", "coat", "blazer"], 1, "clothes", "A single outer layer. Wear it in transit.", 0, true));
    } else if (climate === "mild") {
      L.push(I("clothes.layer", "Light layer", ["layer", "overshirt", "cardigan", "hoodie", "sweater"], 1, "clothes", "Mild and stable: one extra layer, not a wardrobe.", 300));
    }
    if (needsRain) {
      L.push(I("clothes.rain", "Packable rain shell", ["rain", "shell", "raincoat", "rain jacket", "umbrella"], 1, "clothes", "Rain is likely. The shell replaces a second jacket and the umbrella.", 250));
    }
    return L;
  }

  function activityGear(acts, climate) {
    var s = {}; acts.forEach(function (a) { s[a] = true; });
    var G = [];
    if (s.swimming || s.beach) {
      G.push(I("activity.swimsuit", "Swimsuit", ["suit", "swimsuit", "swim", "trunks", "bikini"], 1, "activity", "One suit. It dries. You don't need a spare.", 120));
      G.push(I("activity.towel", "Microfiber towel", ["towel", "microfiber"], 1, "activity", "Hotel towels stay at the hotel. This one packs flat.", 250));
    }
    if (s.hiking || s.camping) {
      G.push(I("activity.trail-shoes", "Trail shoes", ["trail", "hiking shoes", "hiking boots", "boots", "hikers"], 1, "activity", "Wear your dailies in transit. These are for the trail.", 800));
      if (climate === "hot" || climate === "warm") G.push(I("activity.sun-shirt", "Sun shirt", ["sun shirt", "hiking shirt"], 1, "activity", "One light shirt for the hike. Not a full outdoor kit.", 150));
    }
    if (s.camping) G.push(I("activity.headlamp", "Headlamp", ["headlamp", "torch", "flashlight"], 1, "activity", "Phone flashlights drain the battery you need.", 60));
    if (s.running) {
      G.push(I("activity.run-shoes", "Run shoes", ["run shoes", "running shoes", "trainers", "sneakers"], 1, "activity", "One pair for the run. Don't bring a third pair of shoes.", 600));
      G.push(I("activity.run-kit", "Athletic set", ["athletic", "run kit", "running clothes", "shorts"], 1, "activity", "One set. Wash it if you run more than twice.", 200));
    }
    if (s.gym && !s.running) {
      G.push(I("activity.gym-kit", "Gym set", ["gym", "workout", "athletic"], 1, "activity", "One set. Hotels have towels.", 200));
      G.push(I("activity.trainers", "Trainers", ["trainers", "gym shoes", "sneakers"], 1, "activity", "Only if you won't wear them as your daily pair.", 600));
    }
    if (s.cycling) G.push(I("activity.bike-shorts", "Bike shorts", ["bike", "cycling", "padded shorts"], 1, "activity", "The one piece you can't improvise. Rent the bike.", 150));
    if (s.skiing) {
      G.push(I("activity.ski-base", "Base layer set", ["base layer", "thermals", "ski"], 1, "activity", "Assume the ski kit is sorted. This is the next-to-skin set.", 300));
      G.push(I("activity.gloves", "Ski gloves", ["gloves", "mittens", "ski gloves"], 1, "activity", "Easy to forget. Everything else lives in the ski bag.", 200));
    }
    if (s.formal) G.push(I("activity.nice-outfit", "One nice outfit", ["outfit", "dress", "formal", "blazer", "suit"], 1, "activity", "One look. Not a rotation.", 700));
    if (s.work && !s.formal) G.push(I("activity.work-shirt", "Presentable shirt", ["work shirt", "button down", "blouse"], 1, "activity", "One shirt that photographs well. Rewear it.", 220));
    return G;
  }

  /* input: { nights, laundry:boolean, carryOn:boolean, weather (summary), activities[], meds:boolean } */
  function buildList(input) {
    var nights = Math.max(1, Math.min(30, input.nights || 3));
    var laundry = !!input.laundry, acts = input.activities || [];
    var w = input.weather || summarizeWeather([], "none");
    var climate = w.climate, items = [];
    var hot = climate === "hot", warmish = hot || climate === "warm";

    var underwear = laundry ? Math.min(nights + 1, Math.max(3, halfClothes(nights) + 1)) : nights + 1;
    var shirts = laundry ? halfClothes(nights) + (hot ? 1 : 0)
      : Math.min(nights, Math.max(2, nights - (nights >= 5 ? 1 : 0) + (hot ? 1 : 0)));
    var bottoms = nights >= 8 && !laundry ? 3 : nights >= 4 ? 2 : 1;
    if ((acts.indexOf("hiking") >= 0 || acts.indexOf("camping") >= 0) && bottoms < 2) bottoms = 2;
    if (hot) bottoms = Math.min(bottoms, 2);

    items.push(I("clothes.shirts", warmish ? "Tees" : "Shirts", ["shirt", "shirts", "tee", "tees", "t-shirt", "tshirts", "tops"], shirts, "clothes",
      laundry ? nights + " nights, laundry mid-trip: pack about half." : nights + " nights, no laundry. Rewear one. That's the point.", 170));
    items.push(I("clothes.underwear", "Underwear", ["underwear", "briefs", "boxers", "panties", "undies"], underwear, "clothes",
      laundry ? "Enough to reach a wash day, plus one." : "Nights plus one. Then you're done.", 60));
    items.push(I("clothes.socks", "Socks", ["socks", "sock"], underwear, "clothes", "Same count as underwear. No 'just in case' pairs.", 50));
    items.push(I("clothes.bottoms", warmish ? "Shorts / trousers" : "Trousers", ["pants", "trousers", "jeans", "shorts", "bottoms", "chinos"], bottoms, "clothes",
      bottoms === 1 ? "One pair, worn. Denim is heavy; don't bring a spare." : "Wear the heavier pair on travel day. A third pair is rarely worth it.", 450));
    var layers = climateLayer(climate, w.needsRain, w.snow);
    var hasWarm = layers.some(function (l) { return l.id === "clothes.sweater"; });
    if (!hasWarm && (w.minLow != null && w.minLow <= 3 || acts.indexOf("skiing") >= 0)) {
      layers = layers.filter(function (l) { return l.id !== "clothes.layer"; });
      layers.unshift(I("clothes.sweater", "Warm sweater", ["sweater", "knit", "fleece", "jumper", "hoodie"], 1, "clothes",
        acts.indexOf("skiing") >= 0 ? "Apr\u00e8s-ski and cold evenings. One is enough." : "Days are mild but nights drop near freezing. One warm layer.", 450));
      if (w.minLow != null && w.minLow <= -2) layers.push(I("clothes.hat-gloves", "Hat + gloves", ["hat", "beanie", "gloves", "mittens"], 1, "clothes", "Below-freezing nights. These weigh nothing.", 120));
    }
    items = items.concat(layers);
    if (nights >= 3) items.push(I("clothes.sleep", "Sleepwear", ["sleepwear", "pajamas", "pyjamas", "sleep", "pjs"], 1, "clothes", "One set. Or the oldest tee you already packed.", 200));
    items.push(I("clothes.shoes", "One everyday pair of shoes", ["shoes", "everyday shoes", "sneakers"], 1, "clothes", "Worn, not packed. A second pair is where overpacking starts.", 0, true));

    items.push(I("toiletries.brush", "Toothbrush + paste", ["toothbrush", "toothpaste", "brush"], 1, "toiletries", "Travel sizes. Leave the full bottles.", 80));
    items.push(I("toiletries.deodorant", "Deodorant", ["deodorant", "deo"], 1, "toiletries", "One solid. That's the toiletry bag.", 80));
    if (warmish || acts.indexOf("beach") >= 0 || acts.indexOf("hiking") >= 0 || acts.indexOf("skiing") >= 0) {
      items.push(I("toiletries.sunscreen", "Sunscreen", ["sunscreen", "spf", "sunblock"], 1, "toiletries", "A travel tube. Buy more there if you burn through it.", 100));
    }
    if (input.carryOn) items.push(I("toiletries.liquids", "Clear liquids bag", ["liquids", "liquids bag", "ziploc", "quart bag"], 1, "toiletries", "Carry-on only: 100 ml bottles, one quart bag.", 20));
    if (input.meds) items.push(I("toiletries.meds", "Medication", ["meds", "medication", "pills", "prescription", "medicine"], 1, "toiletries", "You mentioned it. This is the one thing you don't improvise.", 100));

    items.push(I("tech.charger", "Phone charger", ["charger", "cable", "cord", "phone charger"], 1, "tech", "One cable. The hotel clock is not your backup plan.", 90));
    if (acts.indexOf("work") >= 0 || nights >= 6) items.push(I("tech.brick", "Power brick", ["brick", "power bank", "battery", "battery pack"], 1, "tech",
      acts.indexOf("work") >= 0 ? "Meetings drain a phone. One brick, not a drawer of cables." : "A long trip. Still just one.", 200));
    if (acts.indexOf("work") >= 0) items.push(I("tech.laptop-charger", "Laptop charger", ["laptop charger", "mac charger", "computer charger"], 1, "tech", "The laptop rides in your carry. This is the piece people forget.", 300));

    items.push(I("docs.id", "Passport / ID", ["passport", "id", "license", "drivers license", "wallet"], 1, "docs", "Check it the night before. Then stop opening the drawer.", 50));
    items.push(I("docs.cards", "Cards + a little cash", ["cards", "card", "cash", "money"], 1, "docs", "One card, one backup.", 30));

    items = items.concat(activityGear(acts, climate));
    if (acts.indexOf("skiing") >= 0) {
      // ski gloves are already on the list: keep only the hat
      items.forEach(function (i) { if (i.id === "clothes.hat-gloves") { i.label = "Warm hat"; i.aliases = ["hat", "beanie"]; i.grams = 60; i.reason = "Cold nights. Gloves are covered by the ski pair."; } });
    }
    return items;
  }

  /* grams of everything packed (not worn) */
  function bagGrams(items) {
    return items.reduce(function (s, i) { return s + (i.wear ? 0 : (i.grams || 0) * (i.quantity || 1)); }, 0);
  }

  function coachNotes(t) {
    var n = [];
    if (t.weather && t.weather.source === "last-year") n.push("Too far out for a forecast. This list uses last year's weather for those dates. Check again a week before.");
    if (t.weather && t.weather.source === "partial") n.push("The forecast only covers the first part of the trip. The rest assumes the same pattern.");
    if (t.laundry) n.push("Laundry mid-trip, so the clothes are halved.");
    else if (t.nights >= 5) n.push(t.nights + " nights, no laundry: a 10-minute sink wash halfway would halve the clothes.");
    if (t.weather && !t.weather.needsRain && (t.weather.climate === "mild" || t.weather.climate === "warm")) n.push("Weather is steady. Leave the second jacket.");
    if (t.items.some(function (i) { return i.id === "clothes.bottoms" && i.quantity >= 2; })) n.push("Wear the heavier trousers on travel day and the bag gets lighter for free.");
    n.push("If you packed it 'just in case', that's the thing to leave behind.");
    return n;
  }

  var PUSHBACK = [
    [/\bhair ?dryers?\b/i, "Leave the hair dryer. Almost every place has one."],
    [/\bextra jeans\b|\banother pair of jeans\b|\bsecond (?:pair of )?jeans\b/i, "One pair of jeans. Denim is heavy and slow to dry."],
    [/\bumbrella\b/i, "If rain is coming, the shell is enough. Umbrellas fight you in wind."],
    [/\bextra shoes\b|\banother pair of shoes\b|\bthird pair\b|\bsecond pair of shoes\b/i, "Two pairs is already generous. A third pair is a packing failure."],
    [/\bmakeup\b|\btoiletry bag\b/i, "Travel sizes. If it doesn't earn a daily use, it stays home."],
    [/\bextra jacket\b|\bsecond (?:coat|jacket)\b/i, "One outer layer, plus a shell only if it rains. That's the rule."],
    [/\bbooks?\b|\bkindle\b/i, "Phone or one thin book. Paper is a luxury, not a need."],
    [/\biron\b|\bsteamer\b/i, "Hang it in the bathroom while you shower. Skip the iron."]
  ];

  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }

  /* leanpack's alias matcher */
  function matchItem(query, items) {
    var q = norm(query).replace(/^(the|my|our|a|an|some)\s+/, "");
    if (!q) return null;
    var best = null, bestScore = 0;
    items.forEach(function (item) {
      var hays = [item.label].concat(item.aliases || [], [String(item.id).split(".")[1] || ""]).map(norm);
      var score = 0;
      hays.forEach(function (h) {
        if (!h) return;
        if (h === q) score = Math.max(score, 100);
        else if (h.indexOf(q) >= 0 || q.indexOf(h) >= 0) score = Math.max(score, 80 - Math.abs(h.length - q.length));
        else if (h.split(" ").some(function (w) { return w.length > 2 && q.split(" ").indexOf(w) >= 0; })) score = Math.max(score, 40);
      });
      if (score > bestScore) { bestScore = score; best = item; }
    });
    return bestScore >= 40 ? best : null;
  }

  return { CATEGORIES: CATEGORIES, summarizeWeather: summarizeWeather, buildList: buildList, bagGrams: bagGrams,
    coachNotes: coachNotes, PUSHBACK: PUSHBACK, matchItem: matchItem, climateFromHigh: climateFromHigh };
});
