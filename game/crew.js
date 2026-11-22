// PALM HARBOR: HEATLINE — crew abilities.
// Mara lookout (passive) + Mara search cut ($50), Nico quick fix ($35, +40hp),
// Clean Plate (drop exactly 1 star). Outermost in the interact chain.
// Written from the design memo, in my own words.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});
  var clamp = PH.clamp, dist = PH.dist;

  var CREW = {
    lookoutRadius: 55, lookoutCooldown: 20,
    maraCutCost: 50,
    nicoCost: 35, nicoHeal: 40, nicoTime: 2, nicoCooldown: 90,
    plateTime: 3, plateCooldown: 180, plateRadius: 3.5
  };
  // wantedKills band tops: star -> kills at the top of the band below it.
  var BAND_TOP = { 5: 11, 4: 8, 3: 5, 2: 2 };

  function hasLOS(game, x1, z1, x2, z2) {
    var d = dist(x1, z1, x2, z2);
    var steps = Math.max(1, Math.floor(d / 4));
    for (var i = 1; i < steps; i++) {
      var t = i / steps;
      if (game.blocked(x1 + (x2 - x1) * t, z1 + (z2 - z1) * t)) return false;
    }
    return true;
  }

  PH.Game.prototype.crewMaraCut = function () {
    if (this.getWantedStars() < 1 || this.search <= 0) return false;
    if (this.player.money < CREW.maraCutCost) return false;
    this.player.money -= CREW.maraCutCost;
    this.search *= 0.5;
    this.events.push({ kind: 'money', text: 'MARA / search cut in half — $50.', t: this.time });
    return true;
  };
  PH.Game.prototype.crewStartFix = function () {
    var car = this.getCar();
    if (!car || car.hp >= 100 || car.hp <= 0) return false;
    if (Math.abs(car.speed) > 1) return false;
    if (this.player.money < CREW.nicoCost) return false;
    if ((this.extras.crew.nico || 0) > 0) return false;
    this.crewChannel = { kind: 'fix', t: 0 };
    return true;
  };
  PH.Game.prototype.crewStartPlate = function () {
    if (this.getWantedStars() < 1 || this.search <= 0) return false;
    if ((this.extras.crew.plate || 0) > 0) return false;
    if (this.player.vehicle !== null) return false;
    if (this.seenByPolice()) return false;
    var car = this.playerCar();
    if (!car) return false;
    if (dist(this.player.x, this.player.z, car.x, car.z) > CREW.plateRadius) return false;
    this.crewChannel = { kind: 'plate', t: 0 };
    return true;
  };
  PH.Game.prototype.seenByPolice = function () {
    var p = this.player;
    for (var i = 0; i < this.police.length; i++) {
      var u = this.police[i];
      if (u.foot) {
        if (dist(u.x, u.z, p.x, p.z) < 40) return true;
      } else if (dist(u.x, u.z, p.x, p.z) < 55 && hasLOS(this, u.x, u.z, p.x, p.z)) return true;
    }
    return false;
  };
  PH.Game.prototype.crewTimerText = function () {
    if (!this.crewChannel) return '';
    var total = this.crewChannel.kind === 'fix' ? CREW.nicoTime : CREW.plateTime;
    return (this.crewChannel.kind === 'fix' ? 'FIX ' : 'PLATE ') + Math.max(0, total - this.crewChannel.t).toFixed(1);
  };
  PH.Game.prototype.crewContextLine = function () {
    var p = this.player;
    var stars = this.getWantedStars();
    // Mara search cut, at Mara while wanted.
    var mara = this.nearContact('contact', 9);
    if (mara && stars >= 1 && this.search > 0) {
      return { key: 'E', label: 'ACT — MARA / cut search 50% · $50' };
    }
    // Nico quick fix, in a stopped damaged car.
    var car = this.getCar();
    if (car && car.hp > 0 && car.hp < 100 && Math.abs(car.speed) <= 1) {
      if ((this.extras.crew.nico || 0) > 0) {
        return { key: 'E', label: 'ACT — NICO / quick fix recharging (' + Math.ceil(this.extras.crew.nico) + 's)' };
      }
      if (p.money < CREW.nicoCost) {
        return { key: 'E', label: 'ACT — NICO / quick fix +40 hp · $35 (need $35)' };
      }
      return { key: 'E', label: 'ACT — NICO / quick fix +40 hp · $35' };
    }
    // Clean plate, on foot beside your own car, unseen.
    if (p.vehicle === null && stars >= 1 && this.search > 0) {
      var own = this.playerCar();
      if (own && dist(p.x, p.z, own.x, own.z) <= CREW.plateRadius) {
        if ((this.extras.crew.plate || 0) > 0) {
          return { key: 'E', label: 'ACT — CLEAN PLATE / recharging (' + Math.ceil(this.extras.crew.plate) + 's)' };
        }
        if (this.seenByPolice()) {
          return { key: 'E', label: 'ACT — CLEAN PLATE / the cops see you — break line of sight' };
        }
        return { key: 'E', label: 'ACT — CLEAN PLATE / drop 1 star · 3s' };
      }
    }
    return null;
  };
  // Fix must not steal older claims: chop, race, fuel, garage, clinic,
  // safehouse, Coast Run, Mara, active contract objective all come first.
  PH.Game.prototype.fixBlocked = function () {
    var p = this.player;
    var car = this.getCar();
    if (car && car.stolen && dist(p.x, p.z, 150, 180) < 10) return true;
    for (var i = 0; i < PH.ACTIVITIES.races.length; i++) {
      var r = PH.ACTIVITIES.races[i];
      if (dist(p.x, p.z, r.x, r.z) < 8) return true;
    }
    if (this.nearestStation && this.nearestStation(10)) return true;
    if (this.nearContact('garage', 9) || this.nearContact('shop', 9) || this.nearContact('home', 8)) return true;
    if (dist(p.x, p.z, 205, 77) < 8) return true;
    if (this.nearContact('contact', 9)) return true;
    var obj = this.objective();
    if (obj && this.mission.active && obj.dist <= 6) return true;
    return false;
  };

  var prevInteract = PH.Game.prototype.interact;
  PH.Game.prototype.interact = function () {
    var p = this.player;
    // Mara search cut takes priority at Mara while wanted.
    var mara = this.nearContact('contact', 9);
    if (mara && this.getWantedStars() >= 1 && this.search > 0) {
      if (this.crewMaraCut()) return true;
    }
    // Nico quick fix: stopped damaged car, nothing else claiming ACT.
    var car = this.getCar();
    if (car && car.hp > 0 && car.hp < 100 && Math.abs(car.speed) <= 1 && !this.fixBlocked()) {
      if (this.crewStartFix()) return true;
    }
    // Clean plate: on foot beside your own car.
    if (p.vehicle === null && this.getWantedStars() >= 1 && this.search > 0) {
      var own = this.playerCar();
      if (own && dist(p.x, p.z, own.x, own.z) <= CREW.plateRadius) {
        if (this.crewStartPlate()) return true;
      }
    }
    // At Mara while not wanted: start the next Mara contract.
    if (mara && this.getWantedStars() < 1 && !this.mission.active) {
      if (this.startMission()) return true;
    }
    return prevInteract.call(this);
  };

  var prevUpdate = PH.Game.prototype.update;
  PH.Game.prototype.update = function (dt, input) {
    var out = prevUpdate.call(this, dt, input);
    // Cooldowns tick down (and are saved).
    if ((this.extras.crew.nico || 0) > 0) this.extras.crew.nico = Math.max(0, this.extras.crew.nico - dt);
    if ((this.extras.crew.plate || 0) > 0) this.extras.crew.plate = Math.max(0, this.extras.crew.plate - dt);
    // Mara lookout: a police unit newly inside radius 55 triggers one toast.
    if (this.getWantedStars() >= 1) {
      this.lookoutT = (this.lookoutT || 0) - dt;
      if (this.lookoutT <= 0) {
        for (var i = 0; i < this.police.length; i++) {
          var u = this.police[i];
          if (!u.warned && dist(u.x, u.z, this.player.x, this.player.z) < CREW.lookoutRadius) {
            u.warned = true;
            this.events.push({ kind: 'notify', text: 'MARA / cops inside the radius — break line of sight, don\'t drive straight.', t: this.time });
            this.lookoutT = CREW.lookoutCooldown;
            break;
          }
        }
      }
    }
    // Channels: fix (2s) and plate (3s).
    if (this.crewChannel) {
      var ch = this.crewChannel;
      ch.t += dt;
      if (ch.kind === 'fix') {
        var c2 = this.getCar();
        var cancel = !c2 || Math.abs(c2.speed) > 1 || this.player.vehicle === null || this.dead;
        if (cancel) { this.crewChannel = null; }
        else if (ch.t >= CREW.nicoTime) {
          this.player.money -= CREW.nicoCost;
          c2.hp = Math.min(100, c2.hp + CREW.nicoHeal);
          this.extras.crew.nico = CREW.nicoCooldown;
          this.events.push({ kind: 'notify', text: 'NICO / quick fix done — +40 hp. $35.', t: this.time });
          this.crewChannel = null;
        }
      } else if (ch.kind === 'plate') {
        var ownCar = this.playerCar();
        var cancelP = !ownCar || this.player.vehicle !== null || this.seenByPolice() ||
          dist(this.player.x, this.player.z, ownCar.x, ownCar.z) > 4 ||
          this.getWantedStars() === 0;
        if (cancelP) { this.crewChannel = null; }
        else if (ch.t >= CREW.plateTime) {
          var stars = this.getWantedStars();
          if (stars === 1) {
            this.wantedKills = 0; this.heat = 0; this.search = 0;
          } else {
            this.wantedKills = BAND_TOP[stars];
            this.heat = BAND_TOP[stars] >= 12 ? 1 : this.heat;
            this.search = Math.min(this.search, 0.5);
          }
          this.extras.crew.plate = CREW.plateCooldown;
          this.events.push({ kind: 'notify', text: 'CLEAN PLATE / wanted down 1 star.', t: this.time });
          this.crewChannel = null;
        }
      }
    }
    return out;
  };

  PH.CREW = CREW;
})();
