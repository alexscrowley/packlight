/* Packlight voice layer — Web Speech API, no keys, no dependencies.
   iOS Safari quirks handled: fresh recognition per utterance, forced stop
   after each result (Apple's recognizer stops delivering results without
   firing onend otherwise), and every failure path reports an error code. */
(function (root) {
  const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
  const synth = root.speechSynthesis || null;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const voice = {
    recognitionAvailable: !!SR,
    synthesisAvailable: !!synth,
    isIOS,
    listening: false,
    handsFree: false,
    onResult: null,      // (transcript) => {} - final transcript
    onInterim: null,     // (transcript) => {} - live partial transcript while speaking
    onNoInput: null,     // () => {} - listening for a while with zero audio recognized
    onStateChange: null, // (listening:boolean) => {}
    onError: null,       // (code:string) => {}  codes: not-allowed, service-not-allowed, network, no-speech, audio-capture, constructor, start-failed, timeout
    enabled: true,
    _rec: null,
    _watchdog: null,
    _noInputTimer: null,
    onEvent: null,       // (name, detail?) => {} - every lifecycle event, for ?debug mode

    speak(text) {
      if (!synth || !this.enabled) return;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05; u.pitch = 1;
      const voices = synth.getVoices();
      const pref = voices.find(v => /en[-_]US/i.test(v.lang) && /natural|neural|aria|samantha|google/i.test(v.name)) || voices.find(v => /^en/i.test(v.lang));
      if (pref) u.voice = pref;
      synth.speak(u);
    },

    stopSpeaking() { if (synth) synth.cancel(); },

    _clearWatchdog() { if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; } },
    _clearNoInput() { if (this._noInputTimer) { clearTimeout(this._noInputTimer); this._noInputTimer = null; } },
    _emit(name, detail) { if (this.onEvent) this.onEvent(name, detail); },

    startListening() {
      if (!SR) return false;
      this.stopSpeaking();
      this._clearWatchdog();
      if (this._rec) { try { this._rec.abort(); } catch (e) {} this._rec = null; }
      let rec;
      try { rec = new SR(); } catch (e) { this.onError && this.onError('constructor'); return false; }
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.continuous = false;
      this._rec = rec;
      rec.onstart = () => {
        this._emit('start');
        this.listening = true;
        this.onStateChange && this.onStateChange(true);
        // 10s of zero recognized audio across the WHOLE hands-free session (not
        // per recognition round - Safari auto-ends rounds on silence, which would
        // otherwise reset the timer forever) -> warn instead of sitting silent.
        if (!this._noInputTimer) {
          this._noInputTimer = setTimeout(() => {
            this._noInputTimer = null;
            this._emit('no-input');
            this.onNoInput && this.onNoInput();
          }, 10000);
        }
        // iOS Safari can hang silently: no result, no error, no end.
        this._watchdog = setTimeout(() => {
          if (this.listening) {
            this._emit('watchdog');
            try { rec.abort(); } catch (e) {}
            this.listening = false;
            this.onStateChange && this.onStateChange(false);
            if (this.handsFree && !isIOS) setTimeout(() => this.startListening(), 350);
            else { this.handsFree = false; this._clearNoInput(); this.onError && this.onError('timeout'); }
          }
        }, 20000);
      };
      rec.onend = () => {
        this._emit('end');
        this._clearWatchdog();
        const wasHandsFree = this.handsFree;
        this.listening = false;
        this.onStateChange && this.onStateChange(false);
        if (wasHandsFree && !this._stopHandsFree) setTimeout(() => this.startListening(), 350);
      };
      rec.onerror = (e) => {
        this._clearWatchdog();
        this._clearNoInput();
        this._emit('error', (e && e.error) || 'unknown');
        this.listening = false;
        this.onStateChange && this.onStateChange(false);
        const code = (e && e.error) || 'unknown';
        if (code === 'not-allowed' || code === 'service-not-allowed') this.handsFree = false;
        this.onError && this.onError(code);
      };
      rec.onresult = (ev) => {
        this._clearNoInput();
        const res = ev.results[ev.results.length - 1];
        if (!res.isFinal) {
          this._emit('interim', res[0].transcript);
          this.onInterim && this.onInterim(res[0].transcript);
          return;
        }
        this._emit('final', res[0].transcript);
        this._clearWatchdog();
        const t = res[0].transcript;
        // Force a clean end - iOS stops delivering results without firing onend.
        try { rec.stop(); } catch (e) {}
        this.onResult && this.onResult(t);
      };
      try { rec.start(); return true; } catch (e) {
        this._rec = null;
        this.onError && this.onError('start-failed');
        return false;
      }
    },

    stopListening() {
      this._stopHandsFree = true;
      this.handsFree = false;
      this._clearWatchdog();
      this._clearNoInput();
      if (this._rec) { try { this._rec.stop(); } catch (e) {} }
      this.listening = false;
      this.onStateChange && this.onStateChange(false);
      setTimeout(() => { this._stopHandsFree = false; }, 400);
    },
  };

  root.PackVoice = voice;
})(typeof self !== 'undefined' ? self : this);
