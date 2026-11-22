// PALM HARBOR: HEATLINE — Sunstrand beach + boats.
// Zone, wading limit, piers, 3 moored boats, beachgoers, sand drag.
// Wraps toggleCar / update / damage / snapshot so boats behave like cars
// on the water. Written from the design memo, in my own words.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});
  var clamp = PH.clamp, dist = PH.dist;

  var BEACH = {
    zone: { x0: 201, x1: 214, z0: -64, z1: 150 },
    wadeX: 222,
    piers: [42, 113],
    pierHalf: 1.7, pierX: 247,
    renderPiers: [-171, -100, -29, 42, 113, 184],
    sand: 0.55,
    // Reference §11: 3 moored boats at piers z 42 (two boats, one on each
    // side of the pier deck) and z 113 (one boat).
    boats: [
      { x: 243, z: 36.5, yaw: 1.35, color: 0xf2efe8 },
      { x: 243, z: 48.5, yaw: 1.75, color: 0x3cc8cf },
      { x: 243.5, z: 118.5, yaw: 1.5, color: 0xf4bb45 }
    ],
    umbrellas: [0xe47271, 0x3eaaa5, 0xdab55b, 0x42a9a2, 0xf17d6f],
    // Reference §11: 4 towels (colours below), each with a sunbather on it.
    // Towel spots match the umbrella line drawn in world.js (ux + 2.2).
    towels: [0xf17d6f, 0x42a9a2, 0xeac45f, 0x7197bc],
    towelSpots: [
      { x: 208.2, z: -30 }, { x: 209.7, z: 4 },
      { x: 211.2, z: 38 }, { x: 212.7, z: 72 }
    ],
    lifeguard: { x: 211, z: 22 }
  };

  PH.Game.prototype.ensureBeach = function () {
    if (this.beachReady) return;
    this.beachReady = true;
    // Moor the three boats (also listed as this.boats for direct access).
    // Boat ids follow the cars array so id === index everywhere.
    this.boats = [];
    for (var i = 0; i < BEACH.boats.length; i++) {
      var b = BEACH.boats[i];
      var boat = {
        id: this.cars.length, type: 'boat', name: 'BOAT', color: b.color,
        x: b.x, z: b.z, yaw: b.yaw, speed: 0, hp: 100,
        owned: false, claimed: false, stolen: false, missionCar: false,
        driver: false, parked: true, fuel: 100, throttle: 0
      };
      this.cars.push(boat);
      this.boats.push(boat);
    }
    // Eight beachgoers: 4 lounging on the towels, 4 strolling.
    this.beachgoers = [];
    for (var j = 0; j < 8; j++) {
      var lounge = j < 4;
      var spot = lounge ? BEACH.towelSpots[j] : null;
      this.beachgoers.push({
        id: j, lounge: lounge,
        x: lounge ? spot.x : 204 + this.r() * 8,
        z: lounge ? spot.z : -40 + this.r() * 160,
        yaw: lounge ? Math.PI / 2 : this.r() * Math.PI * 2,
        speed: 0.7 + this.r() * 0.3,
        dir: this.r() < 0.5 ? 1 : -1, hidden: false,
        color: [0xe47271, 0x3eaaa5, 0xdab55b, 0x42a9a2][j % 4]
      });
    }
  };
  PH.Game.prototype.getBoat = function () {
    var c = this.getCar();
    return (c && c.type === 'boat') ? c : null;
  };
  PH.Game.prototype.beachAllows = function (x, z) {
    // On foot you may wade to x=222; boats live in x 225.5-305, z +/-295.
    if (this.player.vehicle !== null) {
      var car = this.getCar();
      if (car && car.type === 'boat') return x > 225.5 && x < 305 && Math.abs(z) < 295;
    }
    return x <= BEACH.wadeX;
  };
  PH.Game.prototype.onSand = function (x, z) {
    return x >= 201 && x <= 215 && z >= -64 && z <= 215;
  };
  PH.Game.prototype.applySand = function (car) {
    if (!car) return;
    if (this.onSand(car.x, car.z) && car.type !== 'boat') {
      car.speed = clamp(car.speed, -29 * BEACH.sand, 29 * BEACH.sand);
    }
  };
  PH.Game.prototype.updateBoat = function (dt, input) {
    var p = this.player;
    var boat = this.getCar();
    if (!boat || boat.type !== 'boat') return false;
    var throttle = (input.forward ? 1 : 0) - (input.back ? 0.6 : 0);
    if (boat.fuel !== undefined && boat.fuel <= 0) throttle = 0;
    boat.throttle = throttle;
    boat.speed = clamp(boat.speed + throttle * 7 * dt, -5, 16);
    if (throttle === 0) boat.speed *= Math.max(0, 1 - 0.3 * dt);
    if (input.handbrake) boat.speed *= Math.max(0, 1 - 2.4 * dt);
    var steer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    boat.yaw += steer * 0.95 * dt * clamp(Math.abs(boat.speed) / 6, 0, 1);
    var nx = boat.x + Math.cos(boat.yaw) * boat.speed * dt;
    var nz = boat.z + Math.sin(boat.yaw) * boat.speed * dt;
    var hit = false;
    if (nx < 225.5 || nx > 305 || Math.abs(nz) > 295) hit = true;
    // Pier decks are hard stops.
    for (var i = 0; i < BEACH.renderPiers.length; i++) {
      var pz = BEACH.renderPiers[i];
      if (nz > pz - BEACH.pierHalf - 1 && nz < pz + BEACH.pierHalf + 1 && nx > 226 && nx < 252) hit = true;
    }
    if (hit) {
      boat.speed *= 0.25;
      this.effects.push({ kind: 'crash', x: boat.x, z: boat.z, t: 0.2 });
    } else { boat.x = nx; boat.z = nz; }
    p.x = boat.x; p.z = boat.z; p.yaw = boat.yaw; p.speed = boat.speed;
    return true;
  };
  PH.Game.prototype.updateBeachAmbient = function (dt) {
    this.ensureBeach();
    var storm = this.extras.weather && this.extras.weather.active;
    for (var i = 0; i < this.beachgoers.length; i++) {
      var g = this.beachgoers[i];
      g.hidden = !!storm;
      if (g.hidden || g.lounge) continue;
      g.z += g.dir * g.speed * dt;
      if (g.z > 145 || g.z < -60) g.dir *= -1;
    }
  };

  // Boarding a boat uses the same key as a car; exit needs speed <= 3.
  var prevToggleCar = PH.Game.prototype.toggleCar;
  PH.Game.prototype.toggleCar = function () {
    var p = this.player;
    if (p.vehicle !== null) {
      var car = this.getCar();
      if (car && car.type === 'boat') {
        if (Math.abs(car.speed) > 3) return false;
        if (car.x > 234 && !(car.fuel !== undefined && car.fuel <= 0)) return false;
        // Exit point: nearest pier, the shore, or the shallows.
        var pierZ = BEACH.renderPiers[0];
        for (var i = 0; i < BEACH.renderPiers.length; i++) {
          if (Math.abs(BEACH.renderPiers[i] - car.z) < Math.abs(pierZ - car.z)) pierZ = BEACH.renderPiers[i];
        }
        if (Math.abs(car.z - pierZ) < 20) { p.x = clamp(car.x - 8, 232, 246); p.z = pierZ; }
        else if (car.x <= 234) { p.x = 220; p.z = car.z; }
        else { p.x = 212; p.z = car.z; }
        car.driver = false;
        p.vehicle = null; p.speed = 0;
        this.events.push({ kind: 'exit', t: this.time });
        return true;
      }
    }
    // Board a boat within 7.5 units.
    if (p.vehicle === null) {
      this.ensureBeach();
      var best = null, bd = 7.5;
      for (var j = 0; j < this.cars.length; j++) {
        var b = this.cars[j];
        if (b.type !== 'boat') continue;
        var d = dist(p.x, p.z, b.x, b.z);
        if (d < bd) { bd = d; best = b; }
      }
      if (best) {
        best.parked = false; best.claimed = true; best.driver = true;
        p.vehicle = best.id; p.yaw = best.yaw; p.speed = 0;
        if (best.fuel === undefined) best.fuel = 100;
        this.events.push({ kind: 'enter', t: this.time });
        return true;
      }
    }
    return prevToggleCar.call(this);
  };

  // Death in a boat: the boat stops, the player washes up in the shallows.
  var prevDamage = PH.Game.prototype.damage;
  PH.Game.prototype.damage = function (amount, source) {
    var wasAlive = !this.dead;
    var out = prevDamage.call(this, amount, source);
    if (wasAlive && this.dead) {
      var boat = this.getCar();
      if (boat && boat.type === 'boat') {
        boat.speed = 0;
        this.player.x = 220; this.player.z = clamp(this.player.z, -60, 145);
      }
    }
    return out;
  };

  // Save in a boat or mid-wade: snapshot stores the player at the water line.
  var prevSnapshot = PH.Game.prototype.snapshot;
  PH.Game.prototype.snapshot = function () {
    var s = prevSnapshot.call(this);
    var car = this.getCar();
    if ((car && car.type === 'boat') || this.player.x > 214) {
      s.player.x = 210;
      s.player.z = clamp(s.player.z, -60, 145);
      s.player.vehicle = null;
      s.car = null;
    }
    return s;
  };

  // Per-tick: boats, sand drag, beachgoers, police stay out of the water.
  var prevUpdate = PH.Game.prototype.update;
  PH.Game.prototype.update = function (dt, input) {
    var out = prevUpdate.call(this, dt, input);
    this.ensureBeach();
    this.updateBeachAmbient(dt);
    var car = this.getCar();
    if (car && car.type !== 'boat') this.applySand(car);
    for (var i = 0; i < this.police.length; i++) {
      if (this.police[i].x > 214.3) this.police[i].x = 214.3;
    }
    return out;
  };
  // Boat physics take over move() when the player is in a boat.
  var prevMove = PH.Game.prototype.move;
  PH.Game.prototype.move = function (dt, input) {
    var car = this.getCar();
    if (car && car.type === 'boat') {
      if (this.updateBoat(dt, input)) return;
    }
    return prevMove.call(this, dt, input);
  };

  PH.BEACH = BEACH;
})();
