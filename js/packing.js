/* Packlight packing engine — deterministic, transparent, no API key needed.
   Works in the browser (window.PackingEngine) and in Node (module.exports). */
(function (root, factory) {
  const engine = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = engine;
  else root.PackingEngine = engine;
})(typeof self !== 'undefined' ? self : this, function () {

  const ACTIVITY_GEAR = {
    hiking: [
      { name: 'Trail shoes', note: 'wear them on travel day, never pack the bulkiest pair', weight: 0, tag: 'wear' },
      { name: 'Quick-dry hiking shirt', qty: 1, weight: 150 },
      { name: 'Wool hiking socks', qty: 2, weight: 70 },
      { name: 'Packable daypack', weight: 250 },
      { name: 'Refillable water bottle', weight: 120, note: 'empty through security' },
      { name: 'Blister care + small first aid', weight: 80 },
    ],
    running: [
      { name: 'Running shoes', note: 'wear on travel day', weight: 0, tag: 'wear' },
      { name: 'Running outfit', qty: 2, weight: 180, note: 'synthetic, dries overnight' },
      { name: 'Running socks', qty: 2, weight: 40 },
    ],
    swimming: [
      { name: 'Swimsuit', qty: 1, weight: 120, note: 'one is enough, it dries' },
      { name: 'Quick-dry towel', weight: 250, optional: true, note: 'skip if the hotel or pool has them' },
    ],
    business: [
      { name: 'One versatile blazer or overshirt', weight: 450, note: 'wear it, don\'t fold it' , tag: 'wear'},
      { name: 'Collared shirt', qty: 2, weight: 200 },
      { name: 'One pair of trousers that pass for both meetings and dinner', weight: 350 },
    ],
    formal: [
      { name: 'One outfit that handles the event', weight: 600, note: 'wear it if the event is day one' },
    ],
    camping: [
      { name: 'Headlamp', weight: 60 },
      { name: 'Warm sleep layer', weight: 300 },
    ],
    photography: [
      { name: 'Camera + one lens', weight: 700, note: 'one body, one lens — minimalism applies to gear too' },
      { name: 'Spare battery + card', weight: 100 },
    ],
    gym: [
      { name: 'Workout outfit', qty: 2, weight: 180 },
    ],
  };

  const ACTIVITY_ALIASES = {
    hiking: ['hik', 'trail', 'trek', 'walk'],
    running: ['run', 'jog'],
    swimming: ['swim', 'pool', 'beach', 'snorkel', 'surf'],
    business: ['business', 'work', 'conference', 'meeting', 'office'],
    formal: ['formal', 'wedding', 'gala', 'fancy', 'dinner', 'suit'],
    camping: ['camp'],
    photography: ['photo', 'camera'],
    gym: ['gym', 'workout', 'fitness', 'lifting'],
  };

  function detectActivities(text) {
    const t = (text || '').toLowerCase();
    const found = [];
    for (const [key, words] of Object.entries(ACTIVITY_ALIASES)) {
      if (words.some(w => t.includes(w))) found.push(key);
    }
    return found;
  }

  /* --- weather summary from Open-Meteo daily arrays --- */
  function summarizeWeather(daily) {
    if (!daily || !daily.time || !daily.time.length) return null;
    const highs = daily.temperature_2m_max, lows = daily.temperature_2m_min,
          rain = daily.precipitation_probability_max || [];
    const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
    const s = {
      days: daily.time.length,
      avgHigh: Math.round(avg(highs)),
      avgLow: Math.round(avg(lows)),
      minLow: Math.round(Math.min(...lows)),
      maxHigh: Math.round(Math.max(...highs)),
      maxRain: rain.length ? Math.max(...rain) : 0,
      units: 'C',
    };
    s.cold = s.avgLow < 10;
    s.freezing = s.minLow < 2;
    s.hot = s.avgHigh > 27;
    s.mild = !s.cold && !s.hot;
    s.rainy = s.maxRain >= 40;
    s.maybeRain = s.maxRain >= 20;
    return s;
  }

  /* --- the core list builder --- */
  function buildList(trip) {
    // trip: { destination, days, activities[], laundry: 'yes'|'no'|'unknown', weather }
    const days = Math.max(1, Math.min(30, trip.days || 3));
    const w = trip.weather || null;
    const laundry = trip.laundry || 'unknown';
    const acts = (trip.activities || []).filter(a => ACTIVITY_GEAR[a]);
    const items = [];
    const add = (category, name, opts = {}) =>
      items.push(Object.assign({ category, name, id: slug(category + '-' + name + '-' + items.length) }, opts));

    /* Clothing — quantities driven by trip length and laundry access */
    const laundryYes = laundry === 'yes';
    const undies = laundryYes ? Math.min(days, 4) : Math.min(days, 8);
    add('Clothing', 'Underwear', { qty: undies, weight: 60 * undies,
      note: !laundryYes && days > 7 ? 'quick sink-wash covers the rest' : (laundryYes ? 'laundry means 4 is plenty for any length' : null) });
    const socks = laundryYes ? Math.min(days, 4) : Math.min(days, 8);
    add('Clothing', 'Socks', { qty: socks, weight: 50 * socks });
    const tops = laundryYes ? 3 : Math.min(Math.ceil(days / 2.5), 6);
    add('Clothing', 'Tops / t-shirts', { qty: tops, weight: 160 * tops,
      note: 'each one gets worn at least twice' });
    add('Clothing', 'Bottoms (pants/shorts)', { qty: days <= 3 ? 1 : 2, weight: 400, note: 'wear one, pack one at most' });
    add('Clothing', 'Sleep shirt', { qty: 1, weight: 120, optional: true, note: 'or sleep in a tee and cut this' });

    /* Weather-driven layers */
    if (w) {
      if (w.freezing) {
        add('Clothing', 'Warm jacket', { weight: 0, tag: 'wear', note: 'wear it in transit — jackets don\'t belong in the bag' });
        add('Clothing', 'Fleece or merino mid-layer', { weight: 300 });
        add('Clothing', 'Beanie + light gloves', { weight: 100 });
      } else if (w.cold) {
        add('Clothing', 'Light jacket or sweater', { weight: 0, tag: 'wear', note: 'wear on travel day' });
      } else if (w.mild) {
        add('Clothing', 'One light layer for evenings', { weight: 250, optional: true });
      }
      if (w.hot) {
        add('Clothing', 'Sun hat or cap', { weight: 80 });
        add('Toiletries', 'Sunscreen (100ml)', { weight: 100 });
      }
      if (w.rainy) {
        add('Clothing', 'Packable rain shell', { weight: 220, note: `rain probability up to ${w.maxRain}%` });
        if (w.maxRain >= 65) add('Extras', 'Compact umbrella', { weight: 250, optional: true });
      } else if (w.maybeRain) {
        add('Clothing', 'Packable rain shell', { weight: 220, optional: true, note: 'small chance of rain — your call' });
      }
    } else {
      add('Clothing', 'One layer that handles a surprise evening', { weight: 250, optional: true });
    }

    /* Footwear — the classic overpacking trap */
    const activityShoes = acts.some(a => ['hiking', 'running'].includes(a));
    add('Footwear', activityShoes ? 'The one pair your activities need' : 'One versatile pair of shoes', { weight: 0, tag: 'wear',
      note: 'one pair, worn. a second pair is where overpacking starts' });

    /* Toiletries — minimal kit */
    add('Toiletries', 'Toothbrush + travel toothpaste', { weight: 60 });
    add('Toiletries', 'Solid soap/shampoo bar', { weight: 90, note: 'no liquid limit, works for body and laundry' });
    add('Toiletries', 'Deodorant', { weight: 80 });
    add('Toiletries', 'Razor / grooming basics', { weight: 60, optional: true });
    add('Toiletries', 'Any meds you take', { weight: 100, note: 'plus a basic painkiller' });

    /* Tech */
    add('Tech', 'Phone charger + cable', { weight: 80 });
    add('Tech', 'Headphones', { weight: 60, optional: true });
    add('Tech', 'Universal power adapter', { weight: 120, optional: true, note: 'only if the country needs one' });

    /* Documents & money */
    add('Documents & Money', 'ID / passport', { weight: 40 });
    add('Documents & Money', 'Cards + a little cash', { weight: 30 });
    add('Documents & Money', 'Bookings offline on your phone', { weight: 0 });

    /* Extras */
    add('Extras', 'Reusable tote or stuff sack', { weight: 40, note: 'doubles as a laundry bag' });

    /* Activity packs */
    for (const a of acts) {
      for (const g of ACTIVITY_GEAR[a]) {
        add(title(a) + ' gear', g.name, { qty: g.qty, weight: g.weight, note: g.note, optional: g.optional, tag: g.tag });
      }
    }

    /* Weight math + minimalist verdict */
    const packed = items.filter(i => i.tag !== 'wear' && !i.optional);
    const packedWeight = packed.reduce((s, i) => s + (i.weight || 0), 0);
    const optWeight = items.filter(i => i.tag !== 'wear' && i.optional).reduce((s, i) => s + (i.weight || 0), 0);
    const budget = 9000; // ~one carry-on, comfortably
    const over = packedWeight > budget;

    const challenges = [];
    if (laundryYes && days > 5) challenges.push(`You said laundry — that means this ${days}-day list is identical to a 5-day list. Anything beyond that is overpacking.`);
    if (!laundryYes && days > 7) challenges.push(`${days} days with no laundry — a 10-minute sink wash halfway through cuts your clothing load in half.`);
    if (items.some(i => /second|2 pairs|Bottoms/.test(i.name))) challenges.push('Wear the heavier bottoms on travel day and the bag gets lighter for free.');
    if (acts.includes('swimming')) challenges.push('If the hotel or pool has towels, leave the quick-dry towel home.');
    challenges.push('Rule of thumb: if you packed something "just in case", that\'s the thing to leave behind.');
    if (over) challenges.unshift('This list is over the one-bag budget — start by cutting optional items, then one top.');

    return { items, packedWeight, optWeight, budget, over, challenges, days, laundryYes };
  }

  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
  function title(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  /* --- free-text trip parsing --- */
  function parseDestinationDays(text) {
    let t = (text || '').trim();
    let days = null, dest = null;
    const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const dMatch = t.match(/(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+\w+)?\s*(weekend|days?|nights?|weeks?)/i);
    if (dMatch) {
      const n = dMatch[1].toLowerCase();
      days = /^\d+$/.test(n) ? parseInt(n, 10) : WORDS[n];
      if (/weekend/i.test(dMatch[2])) days = 3;
      else if (/week/i.test(dMatch[2])) days *= 7;
      t = (t.slice(0, dMatch.index) + ' ' + t.slice(dMatch.index + dMatch[0].length)).replace(/\s{2,}/g, ' ').trim();
    }
    let m = t.match(/(?:to|in|for|at)\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?:\s*$|,)/i);
    if (m) dest = m[1].trim();
    if (!dest) {
      m = t.match(/^([A-Za-z][A-Za-z .'-]{1,40}?)(?:\s*,|\s*$)/);
      if (m && !/^(i'?m|my|a|the|we|yes|no)/i.test(m[1])) dest = m[1].trim();
    }
    if (dest) dest = dest.replace(/\s+(for|in|to|with)\s.*$/i, '').replace(/\s+(for|in|to|at|with)$/i, '').trim();
    if (dest && /^(going|traveling|travelling|flying|heading)$/i.test(dest)) dest = null;
    return { dest: dest || null, days };
  }

  return { ACTIVITY_GEAR, detectActivities, summarizeWeather, buildList, parseDestinationDays };
});
