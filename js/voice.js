/* Packlight voice layer — Web Speech API, no keys, no dependencies. */
(function (root) {
  const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
  const synth = root.speechSynthesis || null;

  const voice = {
    recognitionAvailable: !!SR,
    synthesisAvailable: !!synth,
    listening: false,
    handsFree: false,
    _rec: null,
    onResult: null,      // (transcript) => {}
    onStateChange: null, // (listening:boolean) => {}
    enabled: true,

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

    startListening() {
      if (!SR) return false;
      this.stopSpeaking();
      if (this._rec) { try { this._rec.abort(); } catch (e) {} }
      const rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      this._rec = rec;
      rec.onstart = () => { this.listening = true; this.onStateChange && this.onStateChange(true); };
      rec.onend = () => {
        this.listening = false; this.onStateChange && this.onStateChange(false);
        if (this.handsFree && !this._stopHandsFree) setTimeout(() => this.startListening(), 350);
      };
      rec.onerror = (e) => {
        this.listening = false; this.onStateChange && this.onStateChange(false);
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.handsFree = false;
      };
      rec.onresult = (ev) => {
        const t = ev.results[0][0].transcript;
        this.onResult && this.onResult(t);
      };
      try { rec.start(); return true; } catch (e) { return false; }
    },

    stopListening() {
      this._stopHandsFree = true;
      this.handsFree = false;
      if (this._rec) { try { this._rec.stop(); } catch (e) {} }
      this.listening = false;
      this.onStateChange && this.onStateChange(false);
      setTimeout(() => { this._stopHandsFree = false; }, 400);
    },
  };

  root.PackVoice = voice;
})(typeof self !== 'undefined' ? self : this);
