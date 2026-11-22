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

  PH.AIR_PATROL_ROUTE = AIR_PATROL_ROUTE;
  PH.AIR_FORMATION_SLOTS = AIR_FORMATION_SLOTS;
  // Kills-to-stars mapping (same thresholds as getWantedStars).
  PH.killWantedStars = function (kills) {
    if (kills >= 12) return 5;
    if (kills >= 9) return 4;
    if (kills >= 6) return 3;
    if (kills >= 3) return 2;
    if (kills >= 1) return 1;
    return 0;
  };

  // Fill any missing fields on a heli unit (new or adopted legacy).
  function fillHeli(h, i) {
    if (h.tailRotorPhase === undefined) h.tailRotorPhase = (h.tailPhase === undefined ? 0 : h.tailPhase);
    var d = {
      id: 'air-patrol-' + (i + 1), type: 'helicopter',
      slot: AIR_FORMATION_SLOTS[i].name,
      x: AIR_PATROL_ROUTE[i * 2][0], z: AIR_PATROL_ROUTE[i * 2][1],
      y: BASE_HEIGHT, yaw: 0, speed: 0, vx: 0, vz: 0, mode: 'patrol',
      rotorPhase: 0, tailPhase: 0, tailRotorPhase: 0, roll: 0, pitch: 0,
      routeI: i * 2, lit: false, active: i === 0, hidden: i !== 0,
      flightTime: 0, roofClearance: ROOF_CLEARANCE,
      spotlight: false, spotlightTarget: null, spotTarget: null,
      formationTarget: null, waypoint: null
    };
    for (var k in d) if (h[k] === undefined) h[k] = d[k];
    return h;
  }

  PH.Game.prototype.ensureAirSupport = function () {
    if (this.helis) {
      // Restore the aliases if a save/load dropped them, and adopt a
      // replaced singular lead ship instead of duplicating it.
      if (this.helicopter && this.helicopter !== this.helis[0] && typeof this.helicopter === 'object') {
        this.helis[0] = fillHeli(this.helicopter, 0);
      }
      this.helicopters = this.helis;
      this.helicopter = this.helis[0];
      return this.helis[0];
    }
    // A legacy save/session may carry only the singular lead ship: adopt
    // it as the first unit instead of duplicating it.
    var legacy = (this.helicopter && typeof this.helicopter === 'object') ? this.helicopter : null;
    this.helis = [];
    for (var i = 0; i < 3; i++) {
      if (i === 0 && legacy) { this.helis.push(fillHeli(legacy, 0)); continue; }
      this.helis.push(fillHeli({
        id: 'air-patrol-' + (i + 1), slot: AIR_FORMATION_SLOTS[i].name,
        x: AIR_PATROL_ROUTE[i * 2][0], z: AIR_PATROL_ROUTE[i * 2][1],
        y: BASE_HEIGHT, yaw: 0, speed: 0, mode: 'patrol',
        rotorPhase: 0, tailPhase: 0, roll: 0, pitch: 0,
        routeI: i * 2, lit: false, active: i === 0
      }, i));
    }
    // Aliases: the singular lead ship and the plural pool (same array).
    this.helicopters = this.helis;
    this.helicopter = this.helis[0];
    return this.helis[0];
  };
  // Static air-star count (also listed among the PH exports in the memo):
  // the displayed wanted stars, but a directly-set heat level (a float
  // star level) counts when higher; without a star function, fall back
  // to clamped heat only, and non-finite heat means zero stars.
  PH.airWantedStars = function (g) {
    if (g && typeof g.getWantedStars === 'function') {
      var s = g.getWantedStars();
      if (Number.isFinite(g.heat)) s = Math.max(s, Math.ceil(clamp(g.heat, 0, 5)));
      return s;
    }
    if (!g || !Number.isFinite(g.heat)) return 0;
    return Math.ceil(clamp(g.heat, 0, 5));
  };
  PH.Game.prototype.airWantedStars = function () { return PH.airWantedStars(this); };
  PH.Game.prototype.airIsNight = function () { return this.isNight(); };

  PH.Game.prototype.updateAirSupport = function (dt) {
    this.ensureAirSupport();
    // Paused: frozen. Zero, negative or NaN dt is inert: nothing moves,
    // spins or accrues.
    if (this.paused) return;
    if (!(dt > 0)) return;
    var stars = PH.airWantedStars(this);
    var p = this.player;
    var follow = stars >= 3 && !this.dead;
    var followCount = follow ? stars - 2 : 0;
    var night = this.isNight();
    for (var i = 0; i < this.helis.length; i++) {
      var h = this.helis[i];
      var wantFollow = follow && i < followCount;
      h.mode = wantFollow ? 'follow' : 'patrol';
      h.active = wantFollow || (!follow && i === 0);
      h.hidden = !h.active;
      // Light state is kept for every unit, active or not: a parked heli
      // never keeps a stale spotlight from its last follow run.
      h.lit = night && h.mode === 'follow' && !this.dead;
      h.spotlight = h.lit;
      if (h.mode === 'follow') h.spotlightTarget = { x: p.x, y: p.y + 1.2, z: p.z };
      else h.spotlightTarget = null;
      if (!h.active) continue;
      // Parked aircraft do not spin up or log flight time.
      h.rotorPhase += 36 * dt;
      h.tailPhase += 57 * dt;
      h.tailRotorPhase = h.tailPhase;
      h.flightTime += dt;
      var tx, tz, maxSpeed, turnRate;
      if (h.mode === 'follow') {
        var slot = AIR_FORMATION_SLOTS[i];
        var fx = Math.cos(p.yaw), fz = Math.sin(p.yaw);
        // Screen-space formation offsets (left/right 62, rear 72): the
        // heli flies to the same target it reports as formationTarget.
        if (slot.name === 'left') { tx = p.x + fx * 62; tz = p.z - fz * 62; }
        else if (slot.name === 'right') { tx = p.x - fx * 62; tz = p.z + fz * 62; }
        else { tx = p.x - fz * 72; tz = p.z - fx * 72; }
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
      h.vx = Math.cos(h.yaw) * h.speed;
      h.vz = Math.sin(h.yaw) * h.speed;
      h.waypoint = { x: tx, z: tz };
      h.formationTarget = { x: tx, z: tz };
      // Height: rise at once if a roof under or ahead needs clearance,
      // sink slowly otherwise. Read the live city.buildings list (the
      // spatial index is built once at construction) and count a building
      // when the point falls inside its footprint expanded by 8 (the
      // roofAt rule): the aircraft's own position and its look-ahead point.
      var needY = BASE_HEIGHT;
      var aheadX = h.x + Math.cos(h.yaw) * 20, aheadZ = h.z + Math.sin(h.yaw) * 20;
      var bl = this.city.buildings;
      for (var bi = 0; bi < bl.length; bi++) {
        var b = bl[bi];
        var bMinX = (b.minX !== undefined) ? b.minX : b.x - b.w / 2;
        var bMaxX = (b.maxX !== undefined) ? b.maxX : b.x + b.w / 2;
        var bMinZ = (b.minZ !== undefined) ? b.minZ : b.z - b.d / 2;
        var bMaxZ = (b.maxZ !== undefined) ? b.maxZ : b.z + b.d / 2;
        var over = (h.x >= bMinX - 8 && h.x <= bMaxX + 8 && h.z >= bMinZ - 8 && h.z <= bMaxZ + 8);
        var ahead = (aheadX >= bMinX - 8 && aheadX <= bMaxX + 8 && aheadZ >= bMinZ - 8 && aheadZ <= bMaxZ + 8);
        if ((over || ahead) && b.h + ROOF_CLEARANCE > needY) needY = b.h + ROOF_CLEARANCE;
      }
      if (needY > h.y) h.y = needY;
      else h.y += (needY - h.y) * (1 - Math.exp(-dt * 0.95));
      h.y = clamp(h.y, 28, 140); // 28-34 cruise band; taller when clearing roofs
      // Bank into turns.
      h.roll = clamp(-dyaw * 0.5, -0.28, 0.28);
      h.pitch = clamp(h.speed / maxSpeed * 0.16, -0.16, 0.16);
      // Spotlight: night + following + player alive. When 2-3 helis shine,
      // the light is shared between them (litShare). The tracking target
      // is kept whenever following, day or night.
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
  PH.Game.prototype.update = function (dt, input) {
    var out = prevUpdate.call(this, dt, input);
    this.updateAirSupport(dt);
    return out;
  };

  PH.AIR_PATROL_ROUTE = AIR_PATROL_ROUTE;
  PH.AIR_FORMATION_SLOTS = AIR_FORMATION_SLOTS;
  PH.BASE_HEIGHT = BASE_HEIGHT; PH.ROTOR_RADIUS = ROTOR_RADIUS;
})();
