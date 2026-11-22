// PALM HARBOR: HEATLINE — emergency services: tow trucks + ambulances.
// Tow: hook 3.5s, drag to the depot, car returns with full hp and 50% fuel.
// Ambulance: treat 5s, revive. A downed player gets a 10s rescue grace before
// the clinic respawn. Written from the design memo, in my own words.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});
  var clamp = PH.clamp, dist = PH.dist;

  var TOW_DEPOT = { x: 170, z: 190 };
  var MAX_TOW = 3, MAX_AMB = 2;
  var HOOK_TIME = 3.5, TREAT_TIME = 5, RESCUE_GRACE = 10;

  function EmergencySystem(game) {
    this.game = game;
    this.units = []; // {kind:'tow'|'ambulance', x,z,yaw,speed,state,target,timer,car}
    this.rescueTimer = 0;
    this.rescueActive = false;
  }

  EmergencySystem.prototype.reportDown = function () {
    // Player is down: an ambulance has 10 seconds to reach them.
    this.rescueActive = true;
    this.rescueTimer = RESCUE_GRACE;
  };
  EmergencySystem.prototype.reportTow = function (car, reason) {
    car.towJob = reason || 'abandoned';
    car.towAt = this.game.time;
  };
  EmergencySystem.prototype.finishTow = function (car) {
    car.x = TOW_DEPOT.x + (Math.random() - 0.5) * 8;
    car.z = TOW_DEPOT.z + (Math.random() - 0.5) * 8;
    car.hp = 100;
    car.fuel = 50;
    car.speed = 0;
    car.parked = true;
    car.driver = false;
    car.towJob = null;
    car.idle = 0;
    this.game.events.push({ kind: 'notify', text: 'TOW / your car was collected and returned to the depot — hp restored, tank at 50%.', t: this.game.time });
  };

  EmergencySystem.prototype.spawnUnit = function (kind, x, z) {
    var u = {
      kind: kind, x: x, z: z, yaw: 0, speed: 0, state: 'idle',
      target: null, timer: 0, car: null, color: kind === 'tow' ? 0xeeb54e : 0xf2f3e9
    };
    this.units.push(u);
    return u;
  };
  EmergencySystem.prototype.count = function (kind) {
    var n = 0;
    for (var i = 0; i < this.units.length; i++) if (this.units[i].kind === kind) n++;
    return n;
  };

  EmergencySystem.prototype.update = function (dt) {
    var g = this.game;
    // Rescue grace: count down while the player is down.
    if (this.rescueActive && g.dead) {
      this.rescueTimer -= dt;
      if (this.rescueTimer <= 0) {
        this.rescueActive = false;
        g.respawn();
      }
    }
    // Flag abandoned cars for tow.
    for (var ci = 0; ci < g.cars.length; ci++) {
      var car = g.cars[ci];
      if (car.id === g.player.vehicle) continue;
      if (car.parked && car.towJob) continue;
      if (Math.abs(car.speed) < 0.2) car.idle = (car.idle || 0) + dt;
      else car.idle = 0;
      // Never tow cars properly parked in a lot (offset > 6 from road centre).
      var offRoad = Math.abs(car.x % 64) > 6 && Math.abs(car.z % 64) > 6;
      var parkedInLot = car.parked && offRoad;
      if (parkedInLot) continue;
      if (!car.towJob) {
        var limit = car.owned ? 45 : 22;
        if (car.idle > limit) this.reportTow(car, 'abandoned');
      }
    }
    // Dispatch tows.
    var needTow = null;
    for (var ti = 0; ti < g.cars.length; ti++) if (g.cars[ti].towJob) { needTow = g.cars[ti]; break; }
    if (needTow && this.count('tow') < MAX_TOW) {
      var has = false;
      for (var ui = 0; ui < this.units.length; ui++) if (this.units[ui].kind === 'tow' && this.units[ui].car === needTow) has = true;
      if (!has) {
        var t = this.spawnUnit('tow', TOW_DEPOT.x, TOW_DEPOT.z);
        t.car = needTow; t.state = 'drive';
      }
    }
    // Dispatch ambulances to downed peds / officers / enemies.
    var casualty = null;
    for (var pi = 0; pi < g.peds.length; pi++) if (g.peds[pi].down) { casualty = g.peds[pi]; break; }
    if (!casualty) for (var oi = 0; oi < g.police.length; oi++) {
      var off = g.police[oi];
      if (off.foot && off.state === 'down') { casualty = off; break; }
    }
    if (!casualty) for (var ei = 0; ei < g.enemies.length; ei++) if (g.enemies[ei].down) { casualty = g.enemies[ei]; break; }
    if (g.dead && this.rescueActive) casualty = { x: g.player.x, z: g.player.z, player: true };
    if (casualty && this.count('ambulance') < MAX_AMB) {
      var busy = false;
      for (var aj = 0; aj < this.units.length; aj++) if (this.units[aj].kind === 'ambulance' && this.units[aj].target === casualty) busy = true;
      if (!busy) {
        var a = this.spawnUnit('ambulance', 141, 141);
        a.target = casualty; a.state = 'drive';
      }
    }
    // Drive the units.
    for (var k = this.units.length - 1; k >= 0; k--) {
      var u = this.units[k];
      var dest = null;
      if (u.kind === 'tow' && u.car) dest = { x: u.car.x, z: u.car.z };
      else if (u.kind === 'ambulance' && u.target) dest = { x: u.target.x, z: u.target.z };
      if (u.state === 'drive' && dest) {
        var d = dist(u.x, u.z, dest.x, dest.z);
        var want = Math.atan2(dest.z - u.z, dest.x - u.x);
        u.yaw += PH.angle(u.yaw, want) * Math.min(1, dt * 2.2);
        u.speed = Math.min(24, u.speed + 14 * dt);
        u.x += Math.cos(u.yaw) * u.speed * dt;
        u.z += Math.sin(u.yaw) * u.speed * dt;
        if (d < 4) { u.state = u.kind === 'tow' ? 'hook' : 'treat'; u.timer = u.kind === 'tow' ? HOOK_TIME : TREAT_TIME; u.speed = 0; }
      } else if (u.state === 'hook') {
        u.timer -= dt;
        if (u.timer <= 0 && u.car) {
          u.state = 'return';
          u.car.hooked = true;
        }
      } else if (u.state === 'treat') {
        u.timer -= dt;
        if (u.timer <= 0) {
          if (u.target) {
            if (u.target.player) {
              if (g.dead) {
                g.player.money = Math.max(0, g.player.money - 100);
                g.player.hp = 50; g.dead = false;
                this.rescueActive = false;
                g.events.push({ kind: 'notify', text: 'RESCUE / the medics got to you in time — $100.', t: g.time });
              }
            } else {
              u.target.down = false;
              u.target.recovering = true;
              u.target.recoverT = 8;
            }
          }
          u.state = 'return';
        }
      } else if (u.state === 'return') {
        var home = u.kind === 'tow' ? TOW_DEPOT : { x: 141, z: 141 };
        var hd = dist(u.x, u.z, home.x, home.z);
        var hw = Math.atan2(home.z - u.z, home.x - u.x);
        u.yaw += PH.angle(u.yaw, hw) * Math.min(1, dt * 2.2);
        u.speed = Math.min(24, u.speed + 14 * dt);
        u.x += Math.cos(u.yaw) * u.speed * dt;
        u.z += Math.sin(u.yaw) * u.speed * dt;
        if (u.car && u.car.hooked) { u.car.x = u.x - Math.cos(u.yaw) * 6; u.car.z = u.z - Math.sin(u.yaw) * 6; u.car.yaw = u.yaw; }
        if (hd < 5) {
          if (u.car && u.car.hooked) { u.car.hooked = false; this.finishTow(u.car); u.car = null; }
          this.units.splice(k, 1);
        }
      }
    }
    // Recovering casualties stand back up after a while.
    for (var ri = 0; ri < g.peds.length; ri++) {
      var ped = g.peds[ri];
      if (ped.recovering) {
        ped.recoverT -= dt;
        if (ped.recoverT <= 0) ped.recovering = false;
      }
    }
  };

  EmergencySystem.prototype.casualtyCount = function () {
    var g = this.game, n = 0;
    for (var i = 0; i < g.peds.length; i++) if (g.peds[i].down) n++;
    for (var j = 0; j < g.enemies.length; j++) if (g.enemies[j].down) n++;
    for (var k = 0; k < g.police.length; k++) if (g.police[k].foot && g.police[k].state === 'down') n++;
    return n;
  };

  // Wire into the Game: emergency runs every tick once attached.
  var prevUpdate = PH.Game.prototype.update;
  PH.Game.prototype.update = function (dt, input) {
    var out = prevUpdate.call(this, dt, input);
    if (this.emergency) this.emergency.update(dt);
    return out;
  };

  PH.EmergencySystem = EmergencySystem;
  PH.TOW_DEPOT = TOW_DEPOT;
})();
