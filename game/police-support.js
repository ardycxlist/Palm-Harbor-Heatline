// PALM HARBOR: HEATLINE — wanted level + police.
// Caps per star, foot disembark gate (EXIT_RANGE 18), chase speeds, tactics
// at 3+ stars, search decay. Replaces the base updatePolice in core.js.
// Written from the design memo, in my own words.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});
  var clamp = PH.clamp, dist = PH.dist;

  var FOOT_CAPS = [0, 3, 3, 7, 8, 8];
  var CAR_CAPS = [0, 2, 3, 5, 7, 7];
  var FOOT_PACE = [1, 1, 1.15, 1.35, 1.5, 1.65];
  var CAR_FIRE_DAMAGE = 1;
  var EXIT_RANGE = 18;
  var OFFICER_HP = 100;
  var FOOT_SPEED = 3.1;
  var CAR_HP = 140;

  function hasLOS(game, x1, z1, x2, z2) {
    var d = dist(x1, z1, x2, z2);
    var steps = Math.max(1, Math.floor(d / 4));
    for (var i = 1; i < steps; i++) {
      var t = i / steps;
      if (game.blocked(x1 + (x2 - x1) * t, z1 + (z2 - z1) * t)) return false;
    }
    return true;
  }

  // A witnessed kill heats the player up: one star even without a kill count.
  PH.Game.prototype.addHeat = function () { this.heat = 1; };
  var prevRegisterKill = PH.Game.prototype.registerKill;
  PH.Game.prototype.registerKill = function (kind) {
    this.addHeat();
    return prevRegisterKill.call(this, kind);
  };

  PH.Game.prototype.policeCarApproach = function (unit, dt) {
    var p = this.player;
    var d = dist(unit.x, unit.z, p.x, p.z);
    var lane = unit.approachLane || 0;
    var tx = p.x + Math.cos(p.yaw + Math.PI / 2) * lane;
    var tz = p.z + Math.sin(p.yaw + Math.PI / 2) * lane;
    var want = Math.atan2(tz - unit.z, tx - unit.x);
    unit.yaw += PH.angle(unit.yaw, want) * Math.min(1, dt * 2.2);
    var target = clamp(d * 0.9, 9, 26);
    unit.speed = clamp(unit.speed + (target - unit.speed) * Math.min(1, dt * 1.4), 0, 26);
    unit.x += Math.cos(unit.yaw) * unit.speed * dt;
    unit.z += Math.sin(unit.yaw) * unit.speed * dt;
    if (d <= EXIT_RANGE - 1 && unit.speed < 2) this.policeDoor(unit);
    if (unit.speed < 0.5 && d > EXIT_RANGE) {
      unit.idleT = (unit.idleT || 0) + dt;
      if (unit.idleT > 0.8) {
        unit.approachLane = (unit.approachLane === 3.4 ? -3.4 : 3.4);
        unit.idleT = 0;
        unit.waitT = 1.2;
      }
    }
  };
  PH.Game.prototype.policeCarChase = function (unit, dt) {
    var p = this.player;
    var d = dist(unit.x, unit.z, p.x, p.z);
    var want = Math.atan2(p.z - unit.z, p.x - unit.x);
    unit.yaw += PH.angle(unit.yaw, want) * Math.min(1, dt * 2.2);
    var target = clamp(d * 0.9, 9, 26);
    unit.speed = clamp(unit.speed + (target - unit.speed) * Math.min(1, dt * 1.6), 0, 26);
    unit.x += Math.cos(unit.yaw) * unit.speed * dt;
    unit.z += Math.sin(unit.yaw) * unit.speed * dt;
    // Fire from the car at close range.
    unit.fireT = (unit.fireT || 0) - dt;
    if (d < 30 && unit.fireT <= 0) {
      unit.fireT = 1.1;
      this.damage(CAR_FIRE_DAMAGE, 'police-car');
      this.shots.push({ x: unit.x, y: 1.35, z: unit.z, tx: p.x, tz: p.z, life: 0.14, foe: true });
    }
  };
  PH.Game.prototype.policeCarTactic = function (unit, dt) {
    // 3+ stars: intercept / block / flank the player's heading.
    var p = this.player;
    var mode = unit.tactic || 'intercept';
    var lead = mode === 'intercept' ? 44 : mode === 'block' ? 30 : 3;
    var off = mode === 'flank' ? 6.2 : 0;
    var tx = p.x + Math.cos(p.yaw) * lead + Math.cos(p.yaw + Math.PI / 2) * off;
    var tz = p.z + Math.sin(p.yaw) * lead + Math.sin(p.yaw + Math.PI / 2) * off;
    var want = Math.atan2(tz - unit.z, tx - unit.x);
    unit.yaw += PH.angle(unit.yaw, want) * Math.min(1, dt * 2.2);
    unit.speed = clamp(unit.speed + 4 * dt, 0, 26);
    unit.x += Math.cos(unit.yaw) * unit.speed * dt;
    unit.z += Math.sin(unit.yaw) * unit.speed * dt;
  };
  PH.Game.prototype.policeDoor = function (unit) {
    // An officer steps out of the car, through the door.
    if (unit.footOut) return;
    unit.footOut = true;
    var stars = this.getWantedStars();
    var cap = FOOT_CAPS[stars] || 0;
    var onFoot = 0;
    for (var i = 0; i < this.police.length; i++) if (this.police[i].foot) onFoot++;
    if (onFoot >= cap) return;
    var role = this.r() < 0.5 ? 'melee' : 'shooter';
    this.police.push({
      foot: true, role: role, x: unit.x + Math.cos(unit.yaw + Math.PI / 2) * 1.5,
      z: unit.z + Math.sin(unit.yaw + Math.PI / 2) * 1.5,
      yaw: unit.yaw, speed: 0, hp: OFFICER_HP, state: 'approach',
      cooldown: 0, car: unit, down: false
    });
  };
  PH.Game.prototype.policeOfficerFootUpdate = function (off, dt) {
    var p = this.player;
    var stars = this.getWantedStars();
    var d = dist(off.x, off.z, p.x, p.z);
    var pace = FOOT_PACE[stars] || 1;
    if (off.state === 'down' || off.state === 'neutralized') return;
    if (off.state === 'returning') {
      var car = off.car;
      if (!car) { off.state = 'down'; return; }
      var cd = dist(off.x, off.z, car.x, car.z);
      var cw = Math.atan2(car.z - off.z, car.x - off.x);
      off.yaw += PH.angle(off.yaw, cw) * Math.min(1, dt * 3);
      off.x += Math.cos(off.yaw) * FOOT_SPEED * pace * dt;
      off.z += Math.sin(off.yaw) * FOOT_SPEED * pace * dt;
      if (cd < 2) {
        off.state = 'recovering';
        off.recoverT = 4;
        car.footOut = false;
      }
      return;
    }
    if (off.state === 'recovering') {
      off.recoverT -= dt;
      if (off.recoverT <= 0) off.state = (this.getWantedStars() === 0) ? 'done' : 'approach';
      return;
    }
    if (d < 40 && hasLOS(this, off.x, off.z, p.x, p.z)) {
      // Seen: lock search.
      this.search = 1;
      this.heatCooldown = 0.8;
    }
    if (d > 2.2) {
      var w = Math.atan2(p.z - off.z, p.x - off.x);
      off.yaw += PH.angle(off.yaw, w) * Math.min(1, dt * 3);
      off.x += Math.cos(off.yaw) * FOOT_SPEED * pace * dt;
      off.z += Math.sin(off.yaw) * FOOT_SPEED * pace * dt;
      off.state = 'approach';
    } else {
      off.state = 'fight';
      off.cooldown -= dt;
      if (off.cooldown <= 0) {
        off.cooldown = off.role === 'melee' ? 0.9 : 1.4;
        this.damage(off.role === 'melee' ? 8 : 6, 'officer');
        if (off.role === 'shooter') {
          this.shots.push({ x: off.x, y: 1.35, z: off.z, tx: p.x, tz: p.z, life: 0.14, foe: true });
        }
      }
    }
  };
  PH.Game.prototype.returnPoliceOfficer = function (off) {
    off.state = 'returning';
  };

  PH.Game.prototype.updatePolice = function (dt) {
    var stars = this.getWantedStars();
    var p = this.player;
    // Episode bookkeeping: foot cap at 1 star is 2 or 3, rolled once per episode.
    if (stars === 0) {
      this.footCap1 = undefined;
      this.search = Math.max(0, this.search - dt / 12);
      for (var i = this.police.length - 1; i >= 0; i--) {
        var u = this.police[i];
        if (u.foot) {
          if (u.state !== 'returning' && u.state !== 'recovering' && u.state !== 'done') this.returnPoliceOfficer(u);
          this.policeOfficerFootUpdate(u, dt);
          if (u.state === 'done') this.police.splice(i, 1);
        } else {
          u.speed = Math.max(0, u.speed - 10 * dt);
          if (u.speed < 0.5) this.police.splice(i, 1);
        }
      }
      return;
    }
    if (this.footCap1 === undefined) this.footCap1 = this.r() < 0.5 ? 2 : 3;
    // Decay search while unseen; standing >= 50 in this district speeds it up.
    var decayMult = 1;
    if (PH.standingDecayMult) decayMult = PH.standingDecayMult(this.districtAt());
    if (this.heatCooldown > 0) this.search = 1;
    else this.search = Math.max(0, this.search - dt / (12 + stars * 3) * decayMult);
    // Spawn cars up to the cap.
    var cars = 0, feet = 0;
    for (var j = 0; j < this.police.length; j++) {
      if (this.police[j].foot) feet++;
      else cars++;
    }
    var wantCars = Math.min(CAR_CAPS[stars], 9 - feet);
    while (cars < wantCars) {
      var a = this.r() * Math.PI * 2;
      var d0 = 60 + this.r() * 30;
      this.police.push({
        foot: false, x: clamp(p.x + Math.cos(a) * d0, -200, 200),
        z: clamp(p.z + Math.sin(a) * d0, -200, 200),
        yaw: a, speed: 8, hp: CAR_HP, state: 'chase', footOut: false,
        tactic: stars >= 3 ? (this.r() < 0.4 ? 'intercept' : this.r() < 0.5 ? 'block' : 'flank') : 'chase',
        approachLane: 3.4, idleT: 0, waitT: 0, fireT: 0
      });
      cars++;
    }
    // Drive / fight every unit.
    for (var k = this.police.length - 1; k >= 0; k--) {
      var unit = this.police[k];
      if (unit.foot) {
        this.policeOfficerFootUpdate(unit, dt);
        if (unit.hp <= 0 && unit.state !== 'down') { unit.state = 'down'; unit.down = true; }
        continue;
      }
      if (unit.hp <= 0) { this.police.splice(k, 1); continue; }
      var dd = dist(unit.x, unit.z, p.x, p.z);
      // Car officers see the player inside 55 with line of sight.
      if (dd < 55 && hasLOS(this, unit.x, unit.z, p.x, p.z)) {
        this.search = 1;
        this.heatCooldown = 0.8;
      }
      if (stars >= 3 && unit.tactic && unit.tactic !== 'chase') this.policeCarTactic(unit, dt);
      else if (dd > EXIT_RANGE) this.policeCarChase(unit, dt);
      else this.policeCarApproach(unit, dt);
      // Prune cars that got stuck far away.
      if (dd > 260) this.police.splice(k, 1);
    }
    // Foot cap at 1 star uses the rolled value.
    if (stars === 1) {
      var footCount = 0;
      for (var f = 0; f < this.police.length; f++) if (this.police[f].foot) footCount++;
      if (footCount > this.footCap1) {
        for (var g = this.police.length - 1; g >= 0 && footCount > this.footCap1; g--) {
          if (this.police[g].foot && this.police[g].state !== 'fight') { this.returnPoliceOfficer(this.police[g]); footCount--; }
        }
      }
    }
    // Total cap: 9 units.
    while (this.police.length > 9) {
      var removed = false;
      for (var m = this.police.length - 1; m >= 0; m--) {
        if (!this.police[m].foot) { this.police.splice(m, 1); removed = true; break; }
      }
      if (!removed) break;
    }
  };

  PH.FOOT_CAPS = FOOT_CAPS; PH.CAR_CAPS = CAR_CAPS; PH.FOOT_PACE = FOOT_PACE;
  PH.CAR_FIRE_DAMAGE = CAR_FIRE_DAMAGE; PH.EXIT_RANGE = EXIT_RANGE;
  PH.OFFICER_HP = OFFICER_HP;
})();
