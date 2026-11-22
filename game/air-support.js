// PALM HARBOR: HEATLINE — air support: 3 helicopters.
// Patrol route, follow formation at 3+ stars, night spotlight. The visuals
// (body, rotor, beam) are drawn by world.js from the state kept here.
// Written from the design memo, in my own words.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});
  var clamp = PH.clamp, dist = PH.dist;

  var AIR_PATROL_ROUTE = [
    [-164, -164], [0, -186], [164, -164], [190, 0],
    [164, 164], [0, 186], [-164, 164], [-190, 0]
  ];
  var AIR_FORMATION_SLOTS = [
    { name: 'left', dx: -62, dz: 0 },
    { name: 'right', dx: 62, dz: 0 },
    { name: 'rear', dx: 0, dz: -72 }
  ];
  var BASE_HEIGHT = 31, ROTOR_RADIUS = 8, ROOF_CLEARANCE = 12;
  var FLY_BOUNDS = 338;

  PH.Game.prototype.ensureAirSupport = function () {
    if (this.helis) return;
    this.helis = [];
    for (var i = 0; i < 3; i++) {
      this.helis.push({
        id: 'air-patrol-' + (i + 1), slot: AIR_FORMATION_SLOTS[i].name,
        x: AIR_PATROL_ROUTE[i * 2][0], z: AIR_PATROL_ROUTE[i * 2][1],
        y: BASE_HEIGHT, yaw: 0, speed: 0, mode: 'patrol',
        rotorPhase: 0, tailPhase: 0, roll: 0, pitch: 0,
        routeI: i * 2, lit: false, active: i === 0
      });
    }
  };
  PH.Game.prototype.airWantedStars = function () { return this.getWantedStars(); };
  PH.Game.prototype.airIsNight = function () { return this.isNight(); };

  PH.Game.prototype.updateAirSupport = function (dt) {
    this.ensureAirSupport();
    var stars = this.getWantedStars();
    var p = this.player;
    var follow = stars >= 3 && !this.dead;
    var followCount = follow ? stars - 2 : 0;
    var night = this.isNight();
    for (var i = 0; i < this.helis.length; i++) {
      var h = this.helis[i];
      h.rotorPhase += 36 * dt;
      h.tailPhase += 57 * dt;
      var wantFollow = follow && i < followCount;
      h.mode = wantFollow ? 'follow' : 'patrol';
      h.active = wantFollow || (!follow && i === 0);
      if (!h.active) continue;
      var tx, tz, maxSpeed, turnRate;
      if (h.mode === 'follow') {
        var slot = AIR_FORMATION_SLOTS[i];
        var fx = Math.cos(p.yaw), fz = Math.sin(p.yaw);
        var sx = -Math.sin(p.yaw), sz = Math.cos(p.yaw);
        tx = p.x + fx * (slot.name === 'rear' ? -72 : 0) + sx * (slot.name === 'left' ? -62 : slot.name === 'right' ? 62 : 0);
        tz = p.z + fz * (slot.name === 'rear' ? -72 : 0) + sz * (slot.name === 'left' ? -62 : slot.name === 'right' ? 62 : 0);
        maxSpeed = 46; turnRate = 1.85;
      } else {
        var wp = AIR_PATROL_ROUTE[h.routeI];
        tx = wp[0]; tz = wp[1];
        maxSpeed = 22; turnRate = 1.35;
        if (dist(h.x, h.z, tx, tz) < 12) h.routeI = (h.routeI + 1) % AIR_PATROL_ROUTE.length;
      }
      tx = clamp(tx, -FLY_BOUNDS, FLY_BOUNDS);
      tz = clamp(tz, -FLY_BOUNDS, FLY_BOUNDS);
      var want = Math.atan2(tz - h.z, tx - h.x);
      var dyaw = PH.angle(h.yaw, want);
      h.yaw += clamp(dyaw, -turnRate * dt, turnRate * dt);
      var d = dist(h.x, h.z, tx, tz);
      h.speed = clamp(h.speed + (Math.min(maxSpeed, d * 0.6) - h.speed) * Math.min(1, dt * 0.8), 0, maxSpeed);
      h.x += Math.cos(h.yaw) * h.speed * dt;
      h.z += Math.sin(h.yaw) * h.speed * dt;
      // Height: rise at once if a roof ahead needs clearance, sink slowly.
      var needY = BASE_HEIGHT;
      var aheadX = h.x + Math.cos(h.yaw) * 20, aheadZ = h.z + Math.sin(h.yaw) * 20;
      var list = this.spatial.get(Math.floor(aheadX / 32) + ',' + Math.floor(aheadZ / 32)) || [];
      for (var b = 0; b < list.length; b++) {
        if (list[b].h + ROOF_CLEARANCE > needY) needY = list[b].h + ROOF_CLEARANCE;
      }
      if (needY > h.y) h.y = needY;
      else h.y += (BASE_HEIGHT - h.y) * (1 - Math.exp(-dt * 0.95));
      h.y = clamp(h.y, 28, 140); // 28-34 cruise band; taller when clearing roofs
      // Bank into turns.
      h.roll = clamp(-dyaw * 0.5, -0.28, 0.28);
      h.pitch = clamp(h.speed / maxSpeed * 0.16, -0.16, 0.16);
      // Spotlight: night + following + player alive. When 2-3 helis shine,
      // the light is shared between them (litShare).
      h.lit = night && h.mode === 'follow' && !this.dead;
      if (h.lit) {
        h.spotTarget = { x: p.x, y: p.y + 1.2, z: p.z };
        h.spotRadius = p.vehicle !== null ? 4.5 : 3.2;
      }
    }
    var litCount = 0;
    for (var li = 0; li < this.helis.length; li++) if (this.helis[li].lit) litCount++;
    this.litShare = litCount > 0 ? 1 / litCount : 0;
    for (var si = 0; si < this.helis.length; si++) this.helis[si].share = this.litShare;
  };

  // Wire into the Game update.
  var prevUpdate = PH.Game.prototype.update;
  PH.Game.prototype.update = function (dt) {
    var out = prevUpdate.call(this, dt);
    this.updateAirSupport(dt);
    return out;
  };

  PH.AIR_PATROL_ROUTE = AIR_PATROL_ROUTE;
  PH.AIR_FORMATION_SLOTS = AIR_FORMATION_SLOTS;
  PH.BASE_HEIGHT = BASE_HEIGHT; PH.ROTOR_RADIUS = ROTOR_RADIUS;
})();
