// PALM HARBOR: HEATLINE — weather + day cycle.
// Storms roll in at phase changes (22%), last 1-4 phases, cut grip by up
// to 32%, hide beachgoers, and throw occasional lightning. The weather
// stream (seed+31337) is separate so storms never shift traffic or police.
// Written from the design memo, in my own words.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});
  var clamp = PH.clamp;

  var WEATHER = {
    startChance: 0.22,
    durationWeights: [[0.46, 1], [0.77, 2], [0.92, 3], [1, 4]],
    gripLoss: 0.32,
    dayStart: 6, nightStart: 18.5,
    phaseOf: function (clock) { return (clock >= 6 && clock < 18.5) ? 'day' : 'night'; }
  };

  PH.Game.prototype.ensureWeather = function () {
    if (this.weatherRng) return;
    this.weatherRng = PH.rng(this.seed + 31337);
    if (!this.extras.weather) this.extras.weather = { active: false, phasesLeft: 0, intensity: 0 };
    this.lastPhase = WEATHER.phaseOf(this.clock);
    this.lightningT = 0;
    this.lightning = null;
  };
  PH.Game.prototype.stormAmp = function () {
    var w = this.extras.weather;
    return (w && w.active) ? w.intensity : 0;
  };
  PH.Game.prototype.weatherPhaseBoundary = function () {
    return WEATHER.phaseOf(this.clock) !== this.lastPhase;
  };
  PH.Game.prototype.weatherGrip = function () {
    var w = this.extras.weather;
    if (!w || !w.active) return 1;
    return 1 - WEATHER.gripLoss * clamp(w.intensity, 0, 1);
  };

  var prevUpdate = PH.Game.prototype.update;
  PH.Game.prototype.update = function (dt, input) {
    var out = prevUpdate.call(this, dt, input);
    this.ensureWeather();
    var w = this.extras.weather;
    var phase = WEATHER.phaseOf(this.clock);
    if (phase !== this.lastPhase) {
      // A phase just changed: spend one storm phase, or roll a new storm.
      if (w.active) {
        w.phasesLeft--;
        if (w.phasesLeft <= 0) {
          w.active = false; w.intensity = 0;
          this.events.push({ kind: 'notify', text: 'WEATHER / Storm over — skies are clear again.', t: this.time });
        }
      } else if (this.weatherRng() < WEATHER.startChance) {
        var roll = this.weatherRng();
        var dur = 1;
        for (var i = 0; i < WEATHER.durationWeights.length; i++) {
          if (roll <= WEATHER.durationWeights[i][0]) { dur = WEATHER.durationWeights[i][1]; break; }
        }
        w.active = true;
        w.phasesLeft = dur;
        this.events.push({ kind: 'notify', text: 'WEATHER / Storm rolling in — slick roads, empty beach.', t: this.time });
      }
      this.lastPhase = phase;
    }
    // Intensity ramps toward its target at 0.3/s.
    var target = w.active ? 1 : 0;
    if (w.intensity < target) w.intensity = Math.min(target, w.intensity + 0.3 * dt);
    else if (w.intensity > target) w.intensity = Math.max(target, w.intensity - 0.3 * dt);
    // Lightning: a random 0.25s slot, 1.2% chance, only in a real storm.
    this.lightningT -= dt;
    this.lightning = null;
    if (w.active && w.intensity > 0.35 && this.lightningT <= 0) {
      this.lightningT = 0.25;
      if (this.weatherRng() < 0.012) {
        this.lightning = {
          x: this.player.x + (this.weatherRng() - 0.5) * 120,
          z: this.player.z + (this.weatherRng() - 0.5) * 120,
          t: 0.18
        };
      }
    }
    return out;
  };

  PH.WEATHER = WEATHER;
})();
