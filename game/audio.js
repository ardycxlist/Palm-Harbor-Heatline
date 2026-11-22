// PALM HARBOR: HEATLINE — procedural audio.
// No sound files: radio "Low Tide Lights" (16 bars, F# minor, 94 BPM),
// ambience, engine, sirens, heli rotors, and all SFX are synthesized
// live with Web Audio. Written from the design memo, in my own words.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});

  var TABLE_SIZE = 2048;
  var BEAT = 60 / 94;
  var EVENT_GAP = {
    shot: 0.065, reload: 0.3, crash: 0.2, mission: 0.2, money: 0.15,
    notify: 0.34, wanted: 0.45, jump: 0.16, hurt: 0.16, enter: 0.2, exit: 0.2,
    step: 0.1, horn: 0.5, baton: 0.2, door: 0.2, chime: 0.2
  };
  // 16-bar radio cue in F# minor. Each bar: bass root, 4-note pad, lead phrase.
  // MIDI numbers (F#3=54). Roots walk F#m - D - A - E - Bm - D - F#m - E ...
  var SCORE = [
    { bass: 42, pad: [54, 57, 61, 66], lead: [66, 69, 71, 69] },
    { bass: 38, pad: [50, 54, 57, 62], lead: [64, 62, 61, 62] },
    { bass: 45, pad: [57, 61, 64, 69], lead: [69, 71, 73, 71] },
    { bass: 40, pad: [52, 56, 59, 64], lead: [66, 64, 62, 59] },
    { bass: 47, pad: [59, 62, 66, 71], lead: [71, 69, 66, 64] },
    { bass: 38, pad: [50, 54, 57, 62], lead: [62, 64, 66, 64] },
    { bass: 42, pad: [54, 57, 61, 66], lead: [66, 69, 73, 71] },
    { bass: 40, pad: [52, 56, 59, 64], lead: [64, 62, 61, 59] },
    { bass: 42, pad: [54, 57, 61, 66], lead: [69, 71, 69, 66] },
    { bass: 45, pad: [57, 61, 64, 69], lead: [71, 69, 66, 64] },
    { bass: 38, pad: [50, 54, 57, 62], lead: [64, 66, 69, 66] },
    { bass: 40, pad: [52, 56, 59, 64], lead: [62, 61, 59, 57] },
    { bass: 47, pad: [59, 62, 66, 71], lead: [71, 73, 74, 73] },
    { bass: 45, pad: [57, 61, 64, 69], lead: [69, 66, 64, 62] },
    { bass: 42, pad: [54, 57, 61, 66], lead: [66, 69, 71, 73] },
    { bass: 40, pad: [52, 56, 59, 64], lead: [64, 62, 61, 59] }
  ];
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  function Audio(game) {
    this.game = game;
    this.ctx = null;
    this.muted = false;
    this.volume = 0.55;
    this.music = true;
    this.started = false;
    this.lastEvent = {};
    this.activeTransients = 0;
    this.stepAcc = 0;
    this.hornT = 12;
    this.bar = -1;
    this.radioGain = null;
    this.engineOsc = null; this.engineFilter = null; this.engineGain = null;
    this.sirenOsc = null; this.sirenLfo = null; this.sirenGain = null; this.sirenPan = null;
    this.rotorNodes = [];
    this.ambienceOn = false;
  }

  Audio.prototype.start = function () {
    if (this.started) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var ctx = this.ctx = new AC({ sampleRate: 22050 });
    // Master chain: limiter (threshold -9, ratio 20) + waveshaper + gain.
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -9; comp.ratio.value = 20;
    comp.attack.value = 0.004; comp.release.value = 0.2;
    var shaper = ctx.createWaveShaper();
    var curve = new Float32Array(1024);
    for (var i = 0; i < 1024; i++) {
      var x = i / 512 - 1;
      curve[i] = Math.tanh(x * 1.4);
    }
    shaper.curve = curve;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    comp.connect(shaper); shaper.connect(this.master); this.master.connect(ctx.destination);
    this.bus = comp;
    // Wavetables.
    this.waves = {
      sine: ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])),
      saw: (function () {
        var re = new Float32Array(24), im = new Float32Array(24);
        for (var k = 1; k < 24; k++) { re[k] = 0; im[k] = 1 / k; }
        return ctx.createPeriodicWave(re, im);
      })(),
      square: (function () {
        var re2 = new Float32Array(24), im2 = new Float32Array(24);
        for (var k2 = 1; k2 < 24; k2 += 2) { re2[k2] = 0; im2[k2] = 1 / k2; }
        return ctx.createPeriodicWave(re2, im2);
      })()
    };
    // Radio bus (only while driving).
    this.radioGain = ctx.createGain();
    this.radioGain.gain.value = 0;
    this.radioGain.connect(this.bus);
    // Engine: oscillator + lowpass.
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 37;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass'; this.engineFilter.frequency.value = 320;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineOsc.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.bus);
    this.engineOsc.start();
    // Siren: 740Hz + sweep LFO.
    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'sine';
    this.sirenOsc.frequency.value = 740;
    this.sirenLfo = ctx.createOscillator();
    this.sirenLfo.frequency.value = 0.66;
    var lfoGain = ctx.createGain(); lfoGain.gain.value = 320;
    this.sirenLfo.connect(lfoGain); lfoGain.connect(this.sirenOsc.frequency);
    this.sirenGain = ctx.createGain(); this.sirenGain.gain.value = 0;
    this.sirenPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (this.sirenPan) {
      this.sirenOsc.connect(this.sirenGain); this.sirenGain.connect(this.sirenPan); this.sirenPan.connect(this.bus);
    } else { this.sirenOsc.connect(this.sirenGain); this.sirenGain.connect(this.bus); }
    this.sirenOsc.start(); this.sirenLfo.start();
    this.startAmbience();
    this.started = true;
    if (ctx.resume) ctx.resume();
  };
  Audio.prototype.startAmbience = function () {
    var ctx = this.ctx;
    // 5s loop: wind (noise + lowpass) + bustle + vocal swells.
    var len = ctx.sampleRate * 5;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    var windSrc = ctx.createBufferSource();
    windSrc.buffer = buf; windSrc.loop = true;
    var windF = ctx.createBiquadFilter();
    windF.type = 'lowpass'; windF.frequency.value = 320;
    var windG = ctx.createGain(); windG.gain.value = 0.045;
    windSrc.connect(windF); windF.connect(windG); windG.connect(this.bus);
    windSrc.start();
    // Vocal swells: a few detuned oscillators through formant-ish bandpass.
    for (var v = 0; v < 6; v++) {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 105 + v * 19;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 390 + v * 60; bp.Q.value = 2;
      var g = ctx.createGain(); g.gain.value = 0.006;
      var lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07 + v * 0.02;
      var lg = ctx.createGain(); lg.gain.value = 0.005;
      lfo.connect(lg); lg.connect(g.gain);
      o.connect(bp); bp.connect(g); g.connect(this.bus);
      o.start(); lfo.start();
    }
    this.ambienceOn = true;
  };
  Audio.prototype.setMuted = function (m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  };
  Audio.prototype.setVolume = function (v) {
    this.volume = v;
    if (this.master && !this.muted) this.master.gain.value = v;
  };

  Audio.prototype.tone = function (freq, dur, type, gain, when, dest) {
    if (!this.ctx || this.activeTransients >= 20) return;
    var ctx = this.ctx, t = when || ctx.currentTime;
    var o = ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.value = freq;
    var g = ctx.createGain();
    g.gain.setValueAtTime(gain || 0.12, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || this.bus);
    o.start(t); o.stop(t + dur + 0.02);
    this.activeTransients++;
    var self = this;
    setTimeout(function () { self.activeTransients--; }, dur * 1000 + 60);
  };
  Audio.prototype.noise = function (dur, filterFreq, gain, when) {
    if (!this.ctx || this.activeTransients >= 20) return;
    var ctx = this.ctx, t = when || ctx.currentTime;
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = filterFreq || 1200;
    var g = ctx.createGain();
    g.gain.value = gain || 0.2;
    src.connect(f); f.connect(g); g.connect(this.bus);
    src.start(t);
    this.activeTransients++;
    var self = this;
    setTimeout(function () { self.activeTransients--; }, dur * 1000 + 60);
  };

  Audio.prototype.event = function (name) {
    if (!this.ctx || !this.started) return;
    var now = this.game ? this.game.time : 0;
    var gap = EVENT_GAP[name] || 0.2;
    if (this.lastEvent[name] !== undefined && now - this.lastEvent[name] < gap) return;
    this.lastEvent[name] = now;
    switch (name) {
      case 'shot': this.noise(0.12, 2400, 0.3); this.tone(190, 0.09, 'square', 0.16); break;
      case 'baton': this.noise(0.08, 500, 0.25); break;
      case 'reload': this.tone(900, 0.05, 'square', 0.1); setTimeout(this.tone.bind(this, 620, 0.05, 'square', 0.1), 140); break;
      case 'crash': this.noise(0.35, 700, 0.4); break;
      case 'door': this.noise(0.09, 300, 0.3); this.tone(140, 0.08, 'sine', 0.2); break;
      case 'jump': this.tone(300, 0.18, 'sine', 0.08); break;
      case 'hurt': this.tone(110, 0.22, 'sine', 0.3); break;
      case 'step': this.noise(0.05, 900, 0.07); break;
      case 'horn': this.tone(370, 0.3, 'square', 0.06); this.tone(440, 0.3, 'square', 0.06); break;
      case 'enter': case 'exit': this.tone(520, 0.07, 'sine', 0.1); break;
      case 'mission': this.chime([72, 76, 79, 83, 84]); break;
      case 'money': this.chime([79, 83]); break;
      case 'wanted': this.chime([64, 60, 64]); break;
      case 'notify': this.chime([76, 79]); break;
      default: this.chime([76]);
    }
  };
  Audio.prototype.chime = function (notes) {
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    for (var i = 0; i < notes.length; i++) {
      this.tone(midiToFreq(notes[i]), 0.35, 'sine', 0.1, t + i * 0.09);
    }
  };

  Audio.prototype.scheduleBar = function (barIdx) {
    if (!this.ctx || !this.music) return;
    var ctx = this.ctx;
    var bar = SCORE[barIdx % SCORE.length];
    var t0 = ctx.currentTime + 0.05;
    // Bass root, whole bar.
    var bass = ctx.createOscillator();
    bass.type = 'triangle';
    bass.frequency.value = midiToFreq(bar.bass);
    var bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t0);
    bg.gain.linearRampToValueAtTime(0.16, t0 + 0.1);
    bg.gain.setValueAtTime(0.16, t0 + BEAT * 4 - 0.2);
    bg.gain.linearRampToValueAtTime(0.0001, t0 + BEAT * 4);
    bass.connect(bg); bg.connect(this.radioGain);
    bass.start(t0); bass.stop(t0 + BEAT * 4 + 0.05);
    // Pad: 4 notes, soft attack.
    for (var i = 0; i < bar.pad.length; i++) {
      var po = ctx.createOscillator();
      po.type = 'sawtooth';
      po.frequency.value = midiToFreq(bar.pad[i]);
      var pf = ctx.createBiquadFilter();
      pf.type = 'lowpass'; pf.frequency.value = 900;
      var pg = ctx.createGain();
      pg.gain.setValueAtTime(0.0001, t0);
      pg.gain.linearRampToValueAtTime(0.035, t0 + 0.4);
      pg.gain.setValueAtTime(0.035, t0 + BEAT * 4 - 0.3);
      pg.gain.linearRampToValueAtTime(0.0001, t0 + BEAT * 4);
      po.connect(pf); pf.connect(pg); pg.connect(this.radioGain);
      po.start(t0); po.stop(t0 + BEAT * 4 + 0.05);
    }
    // Lead plucks, one per beat.
    for (var b = 0; b < 4; b++) {
      var note = bar.lead[b];
      var lo = ctx.createOscillator();
      lo.type = 'square';
      lo.frequency.value = midiToFreq(note);
      var lg = ctx.createGain();
      var lt = t0 + b * BEAT;
      lg.gain.setValueAtTime(0.0001, lt);
      lg.gain.linearRampToValueAtTime(0.06, lt + 0.02);
      lg.gain.exponentialRampToValueAtTime(0.0001, lt + BEAT * 0.9);
      lo.connect(lg); lg.connect(this.radioGain);
      lo.start(lt); lo.stop(lt + BEAT);
    }
    // Kick on beats, snare on 2 & 4, hats on 8ths.
    for (var beat = 0; beat < 4; beat++) {
      var kt = t0 + beat * BEAT;
      var kick = ctx.createOscillator();
      kick.type = 'sine';
      kick.frequency.setValueAtTime(120, kt);
      kick.frequency.exponentialRampToValueAtTime(42, kt + 0.12);
      var kg = ctx.createGain();
      kg.gain.setValueAtTime(0.22, kt);
      kg.gain.exponentialRampToValueAtTime(0.0001, kt + 0.14);
      kick.connect(kg); kg.connect(this.radioGain);
      kick.start(kt); kick.stop(kt + 0.16);
      if (beat === 1 || beat === 3) {
        var sn = ctx.createBufferSource();
        var len = Math.floor(ctx.sampleRate * 0.12);
        var buf = ctx.createBuffer(1, len, ctx.sampleRate);
        var d = buf.getChannelData(0);
        for (var s = 0; s < len; s++) d[s] = (Math.random() * 2 - 1) * (1 - s / len);
        sn.buffer = buf;
        var sf = ctx.createBiquadFilter();
        sf.type = 'highpass'; sf.frequency.value = 1400;
        var sg = ctx.createGain(); sg.gain.value = 0.12;
        sn.connect(sf); sf.connect(sg); sg.connect(this.radioGain);
        sn.start(kt);
      }
    }
  };

  Audio.prototype.update = function (game, dt) {
    if (!this.ctx || !this.started) return;
    var p = game.player;
    var car = game.getCar();
    // Engine: base per type + 2.45 x speed.
    if (car && p.vehicle !== null) {
      var base = car.type === 'van' ? 31 : car.type === 'sport' ? 44 : 37;
      this.engineOsc.frequency.value = base + 2.45 * Math.abs(car.speed || 0);
      var rev = car.throttle ? Math.abs(car.throttle) : 0;
      this.engineGain.gain.value = 0.048 + rev * 0.067;
    } else {
      this.engineGain.gain.value = 0;
    }
    // Radio only while driving.
    var wantRadio = this.music && p.vehicle !== null;
    this.radioGain.gain.value += ((wantRadio ? 0.72 : 0) - this.radioGain.gain.value) * Math.min(1, dt * 2);
    if (wantRadio) {
      var barLen = BEAT * 4;
      var barIdx = Math.floor(this.ctx.currentTime / barLen);
      if (barIdx !== this.bar) {
        this.bar = barIdx;
        this.scheduleBar(barIdx);
      }
    }
    // Siren: nearest police car / ambulance.
    var nearest = null, nd = 1e9, isAmb = false;
    for (var i = 0; i < game.police.length; i++) {
      var u = game.police[i];
      if (u.foot) continue;
      var d = Math.hypot(u.x - p.x, u.z - p.z);
      if (d < nd) { nd = d; nearest = u; isAmb = false; }
    }
    if (game.emergency) {
      for (var j = 0; j < game.emergency.units.length; j++) {
        var eu = game.emergency.units[j];
        if (eu.kind !== 'ambulance') continue;
        var d2 = Math.hypot(eu.x - p.x, eu.z - p.z);
        if (d2 < nd) { nd = d2; nearest = eu; isAmb = true; }
      }
    }
    if (nearest && nd < 120) {
      this.sirenGain.gain.value = isAmb ? 0.07 : 0.105;
      if (this.sirenPan) {
        var dx = nearest.x - p.x;
        var pan = Math.max(-1, Math.min(1, dx / 60));
        this.sirenPan.pan.value = pan;
      }
    } else this.sirenGain.gain.value = 0;
    // Heli rotors, spatialized.
    var helis = game.helis || [];
    for (var h = 0; h < 3; h++) {
      var heli = helis[h];
      if (!this.rotorNodes[h]) {
        var o = this.ctx.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = 29;
        var lfo = this.ctx.createOscillator();
        lfo.frequency.value = 5.6;
        var lg2 = this.ctx.createGain(); lg2.gain.value = 0.5;
        lfo.connect(lg2);
        var rg = this.ctx.createGain(); rg.gain.value = 0;
        lg2.connect(rg.gain);
        var pan = this.ctx.createPanner ? this.ctx.createPanner() : null;
        if (pan) {
          pan.panningModel = 'HRTF';
          pan.refDistance = 20; pan.maxDistance = 220; pan.rolloffFactor = 0.18;
          o.connect(rg); rg.connect(pan); pan.connect(this.bus);
        } else { o.connect(rg); rg.connect(this.bus); }
        o.start(); lfo.start();
        this.rotorNodes[h] = { gain: rg, pan: pan, osc: o };
      }
      var node = this.rotorNodes[h];
      if (heli && heli.active) {
        var hd = Math.hypot(heli.x - p.x, heli.z - p.z);
        var atten = 1 / (1 + Math.pow(hd / 66, 2));
        var level = (heli.mode === 'follow' ? 0.235 : 0.125) * atten;
        node.gain.gain.value = level;
        if (node.pan) node.pan.positionX.value = heli.x - p.x;
        if (node.pan) node.pan.positionY.value = (heli.y || 31) - 1;
        if (node.pan) node.pan.positionZ.value = heli.z - p.z;
      } else node.gain.gain.value = 0;
    }
    // Footsteps: one step per stride while walking on the ground.
    if (p.vehicle === null && p.grounded && Math.abs(p.speed) > 0.5) {
      this.stepAcc += Math.abs(p.speed) * dt;
      var stride = 1.65 + Math.min(0.75, Math.abs(p.speed) * 0.1);
      if (this.stepAcc >= stride) {
        this.stepAcc = 0;
        this.event('step');
      }
    }
    // NPC horns: every 10-23s when an NPC car is near and moving.
    this.hornT -= dt;
    if (this.hornT <= 0) {
      this.hornT = 10 + Math.random() * 13;
      for (var k = 0; k < game.cars.length; k++) {
        var c = game.cars[k];
        if (c.driver && Math.abs(c.speed) > 2 && Math.hypot(c.x - p.x, c.z - p.z) < 43) {
          this.event('horn');
          break;
        }
      }
    }
  };
  Audio.prototype.dispose = function () {
    if (this.ctx) { try { this.ctx.close(); } catch (e) { /* already closed */ } }
    this.started = false;
  };

  PH.Audio = Audio;
})();
