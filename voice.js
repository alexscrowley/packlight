/* Packlight voice: Web Speech API, no keys, no server of ours.
   One recognizer session per tap. No auto-restart loops: a session ends when you tap
   again, after a pause, on an error, or when the browser ends it, and then delivers
   its text exactly once.
   The transcript is rebuilt from the session's whole result list on every event (never
   appended), and merged so that the known repeat patterns don't double text:
   - Chrome/Edge: results are separate segments -> joined
   - Android Chrome, iOS Safari: a later final often repeats the earlier ones ("I'm going",
     "I'm going to San Diego") -> the longer one replaces the shorter
   - exact repeated finals -> dropped; overlapping tails ("to San Diego" + "San Diego next
     Friday") -> joined once. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PackVoice = api;
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";
  var SR = root && (root.SpeechRecognition || root.webkitSpeechRecognition);
  var synth = (root && root.speechSynthesis) || null;
  var nav = (root && root.navigator) || {};
  var isIOS = /iPad|iPhone|iPod/.test(nav.userAgent || "") || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);

  function words(s) { return String(s || "").trim().split(/\s+/).filter(Boolean); }
  function key(w) { return w.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f']/g, ""); }
  function startsWith(a, b) { // word array a starts with word array b
    if (b.length > a.length) return false;
    for (var i = 0; i < b.length; i++) if (key(a[i]) !== key(b[i])) return false;
    return true;
  }
  function endsWith(a, b) { return b.length <= a.length && startsWith(a.slice(a.length - b.length), b); }
  /* segments -> one transcript, without the repeat patterns above */
  function merge(segs) {
    var out = [];
    segs.forEach(function (seg) {
      var w = words(seg);
      if (!w.length) return;
      if (startsWith(w, out)) { out = w; return; }                 // cumulative: replaces
      if (endsWith(out, w) || startsWith(out, w)) return;          // repeat of what we have
      for (var k = Math.min(out.length, w.length - 1); k >= 2; k--) // overlap of 2+ words
        if (startsWith(w, out.slice(out.length - k))) { out = out.concat(w.slice(k)); return; }
      out = out.concat(w);
    });
    return out.join(" ");
  }

  var V = {
    recognitionAvailable: !!SR, isIOS: isIOS, enabled: false, merge: merge,
    SILENCE_MS: 2500,     // pause after speech -> done
    NOTHING_MS: 8000,     // nothing heard at all -> stop and say so
    MAX_MS: 90000,        // hard cap per session
    STOP_GRACE_MS: 1200,  // after stop(), wait this long for the last final, then finish anyway
    _s: null,

    /* listen({ onText(text, interim), onDone(text, reason), onState("listening"|"stopping"|"idle") })
       reason: "tap" | "pause" | "ended" | "nothing" | "max" | error code (not-allowed, ...) */
    listen: function (h) {
      if (!SR) return false;
      this.cancel();
      this.stopSpeaking();
      var rec;
      try { rec = new SR(); } catch (e) { h.onDone && h.onDone("", "start-failed"); return false; }
      rec.lang = (nav.language && /^en/i.test(nav.language)) ? nav.language : "en-US";
      rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
      var s = this._s = { rec: rec, h: h, finals: [], interim: "", text: "", state: "listening", timers: {}, done: false, heard: false };
      var self = this;
      function live() { return s === self._s && !s.done; }
      rec.onresult = function (ev) {
        if (!live()) return;
        var fin = [], intr = [];
        for (var i = 0; i < ev.results.length; i++) {
          var r = ev.results[i], t = r[0] && r[0].transcript;
          if (!t) continue;
          (r.isFinal ? fin : intr).push(t);
        }
        s.finals = fin; s.interim = merge(intr);
        var text = merge(fin.concat(intr.length ? [s.interim] : []));
        if (text) s.heard = true;
        if (text !== s.text) { s.text = text; h.onText && h.onText(text, merge(fin)); }
        self._arm(s);
      };
      rec.onerror = function (e) {
        if (!live()) return;
        var code = (e && e.error) || "unknown";
        if (code === "aborted") return;                                  // we caused it; onend follows
        if (code === "no-speech") return self._finish(s, s.text ? "pause" : "nothing");
        self._finish(s, code);
      };
      rec.onend = function () { if (live()) self._finish(s, s.state === "stopping" ? "tap" : "ended"); };
      s.timers.nothing = setTimeout(function () { if (live() && !s.heard) self._finish(s, "nothing"); }, this.NOTHING_MS);
      s.timers.max = setTimeout(function () { if (live()) self.stop("max"); }, this.MAX_MS);
      try { rec.start(); } catch (e) { this._s = null; h.onDone && h.onDone("", "start-failed"); return false; }
      h.onState && h.onState("listening");
      return true;
    },
    _arm: function (s) {
      var self = this;
      clearTimeout(s.timers.pause);
      if (s.text) s.timers.pause = setTimeout(function () { if (s === self._s && !s.done) self.stop("pause"); }, this.SILENCE_MS);
    },
    /* ask the browser to finish; it usually sends one last final, then onend */
    stop: function (why) {
      var s = this._s, self = this;
      if (!s || s.done || s.state === "stopping") return;
      s.state = "stopping"; s.why = why || "tap";
      clearTimeout(s.timers.pause);
      s.h.onState && s.h.onState("stopping");
      try { s.rec.stop(); } catch (e) {}
      // iOS sometimes never fires onend: finish with what we have
      s.timers.grace = setTimeout(function () { if (s === self._s && !s.done) self._finish(s, s.why); }, this.STOP_GRACE_MS);
    },
    _finish: function (s, reason) {
      if (s.done) return;
      s.done = true;
      for (var k in s.timers) clearTimeout(s.timers[k]);
      if (reason === "ended" && s.why) reason = s.why;
      if (s.state === "stopping" && reason === "tap" && s.why) reason = s.why;
      try { s.rec.onresult = s.rec.onerror = s.rec.onend = null; s.rec.abort(); } catch (e) {}
      if (this._s === s) this._s = null;
      s.h.onState && s.h.onState("idle");
      s.h.onDone && s.h.onDone(s.text, reason);
    },
    /* drop the session without delivering text (typing, leaving the screen) */
    cancel: function () {
      var s = this._s;
      if (!s) return;
      s.done = true; this._s = null;
      for (var k in s.timers) clearTimeout(s.timers[k]);
      try { s.rec.onresult = s.rec.onerror = s.rec.onend = null; s.rec.abort(); } catch (e) {}
      s.h.onState && s.h.onState("idle");
    },
    get listening() { return !!this._s; },

    speak: function (text, onDone) {
      if (!synth || !this.enabled) { if (onDone) onDone(); return; }
      synth.cancel();
      var u = new root.SpeechSynthesisUtterance(text), fired = false;
      var done = function () { if (!fired) { fired = true; if (onDone) onDone(); } };
      u.onend = done; u.onerror = done;
      setTimeout(done, Math.min(15000, 1500 + text.length * 70));
      u.rate = 1.05;
      var vs = synth.getVoices();
      var pref = vs.filter(function (v) { return /en[-_]US/i.test(v.lang) && /natural|neural|aria|samantha|google/i.test(v.name); })[0] || vs.filter(function (v) { return /^en/i.test(v.lang); })[0];
      if (pref) u.voice = pref;
      synth.speak(u);
    },
    stopSpeaking: function () { if (synth) synth.cancel(); }
  };
  return V;
});
