// PALM HARBOR: HEATLINE — core simulation.
// Written from the design memo: city seed 74017, 7x7 road grid, 720 citizens,
// 78 vehicles, 6 story contracts, combat, shops, save. No code copied from any
// other implementation; all behaviour re-derived here in my own words.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});

  // ---------- small helpers ----------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function dist(ax, az, bx, bz) {
    if (ax !== null && typeof ax === 'object') { // dist(a, b) with {x,z} points
      var b = az;
      var dx = b.x - ax.x, dz = b.z - ax.z;
      return Math.sqrt(dx * dx + dz * dz);
    }
    var dx2 = bx - ax, dz2 = bz - az;
    return Math.sqrt(dx2 * dx2 + dz2 * dz2);
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  // Shortest signed turn from angle a toward angle b.
  function angle(a, b) {
    var d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  // mulberry32-style deterministic rng (constant 0x6D2B79F5).
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- city ----------
  var ROADS = [-192, -128, -64, 0, 64, 128, 192];
  function district(x, z) {
    if (x > 175) return 'SUNSTRAND BEACH';
    if (z > 124) return 'PORT SOL';
    if (x < -110) return 'LITTLE PALM';
    if (z < -110) return 'GLASS DISTRICT';
    if (x > 60) return 'CORAL HEIGHTS';
    return 'OLD QUARTER';
  }
  // Building body palette (pastel hangat, reference §3), used in order per building.
  var PALETTE = [0xf0b89a, 0xe7c6a7, 0xc5ddd0, 0xf1d5b1, 0xe4a3ad, 0xb2c6d3, 0xe7e0ca, 0xb6d5ca];
  var DISTRICT_ACCENT = {
    'OLD QUARTER': 0xd88145, 'GLASS DISTRICT': 0x3eaaa5, 'CORAL HEIGHTS': 0xe47271,
    'LITTLE PALM': 0x72b45c, 'PORT SOL': 0x48678d, 'SUNSTRAND BEACH': 0xf4bb45
  };

  function makeCity(seed) {
    var r = rng(seed), buildings = [], blocks = [], parks = [], props = [];
    var bi = 0;
    for (var gz = 0; gz < 6; gz++) {
      for (var gx = 0; gx < 6; gx++) {
        var x0 = ROADS[gx] + 9, x1 = ROADS[gx + 1] - 9;
        var z0 = ROADS[gz] + 9, z1 = ROADS[gz + 1] - 9;
        var cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        var d = district(cx, cz);
        var isPark = r() < 0.08;
        blocks.push({ x0: x0, x1: x1, z0: z0, z1: z1, cx: cx, cz: cz, district: d, park: isPark });
        if (isPark) { parks.push({ cx: cx, cz: cz, district: d }); continue; }
        // Four buildings per block (2x2 quadrants, reference §3). Block kind
        // fixes the height band: towers 27-78, residential 8-28, Port Sol
        // warehouses 7-13. Footprint 13-16.2.
        var kind = d === 'PORT SOL' ? 'warehouse' : (d === 'GLASS DISTRICT' || r() < 0.22) ? 'tower' : 'house';
        // Mission steps and contacts must stay reachable on foot: never let
        // a building footprint cover one (2 units of clearance).
        var PROTECTED = [];
        for (var mi = 0; mi < MISSIONS.length; mi++)
          for (var si = 0; si < MISSIONS[mi].steps.length; si++)
            PROTECTED.push(MISSIONS[mi].steps[si]);
        for (var ci = 0; ci < CONTACTS.length; ci++) PROTECTED.push(CONTACTS[ci]);
        // The air patrol route (air-support.js) must stay clear of roofs too.
        var route = PH.AIR_PATROL_ROUTE || [];
        for (var ri = 0; ri < route.length; ri++) PROTECTED.push({ x: route[ri][0], z: route[ri][1] });
        var midX = (x0 + x1) / 2, midZ = (z0 + z1) / 2;
        var quads = [[x0, midX, z0, midZ], [midX, x1, z0, midZ], [x0, midX, midZ, z1], [midX, x1, midZ, z1]];
        for (var k = 0; k < 4; k++) {
          var q = quads[k];
          var w = 13 + r() * 3.2, dep = 13 + r() * 3.2;
          var bx = 0, bz = 0, placed = false;
          for (var attempt = 0; attempt < 10 && !placed; attempt++) {
            bx = (q[0] + q[1]) / 2 - w / 2 + (r() * 5 - 2.5);
            bz = (q[2] + q[3]) / 2 - dep / 2 + (r() * 5 - 2.5);
            placed = true;
            for (var pi = 0; pi < PROTECTED.length; pi++) {
              var pp = PROTECTED[pi];
              if (pp.x > bx - 2 && pp.x < bx + w + 2 && pp.z > bz - 2 && pp.z < bz + dep + 2) { placed = false; break; }
            }
          }
          if (!placed) continue;
          var h = kind === 'tower' ? 27 + r() * 51 : kind === 'warehouse' ? 7 + r() * 6 : 8 + r() * 20;
          var idx = bi++;
          var b = {
            index: idx, x: bx + w / 2, z: bz + dep / 2, w: w, d: dep, h: h,
            minX: bx, maxX: bx + w, minZ: bz, maxZ: bz + dep,
            color: PALETTE[idx % PALETTE.length], district: d,
            tower: h > 33, warehouse: kind === 'warehouse',
            lit: 0.18 + r() * 0.22, roof: r(),
            crown: h > 33 ? 2.4 + r() * 6 : 0,
            antenna: h > 33 && r() < 0.5,
            tank: r() < 0.4
          };
          buildings.push(b);
        }
        // Four palms per block: two corners + two sides. Each leans a little
        // (reference §7) and usually sits in a square planter. The fourth
        // palm appears on ~3 of 4 blocks, so the city carries 3-4 per block
        // (±130 total, reference §7).
        props.push({ kind: 'palm', x: x0 + 3, z: z0 + 3, h: 5.05 + r() * 1.9, lean: 0.26 + r() * 0.31, planter: r() < 0.8 });
        props.push({ kind: 'palm', x: x1 - 3, z: z1 - 3, h: 5.05 + r() * 1.9, lean: 0.26 + r() * 0.31, planter: r() < 0.8 });
        props.push({ kind: 'palm', x: (x0 + x1) / 2, z: z0 + 3, h: 5.05 + r() * 1.9, lean: 0.26 + r() * 0.31, planter: r() < 0.8 });
        if (r() < 0.75) props.push({ kind: 'palm', x: x0 + 3, z: (z0 + z1) / 2, h: 5.05 + r() * 1.9, lean: 0.26 + r() * 0.31, planter: r() < 0.8 });
      }
    }
    // The Sunstrand lot is demolished on the FIRST TICK by parking.js, not
    // here: a fresh Game must stay untouched (hash pin, live collision).
    return { seed: seed, buildings: buildings, blocks: blocks, parks: parks, props: props };
  }

  // ---------- contacts & missions ----------
  var CONTACTS = [
    { id: 'mara', kind: 'contact', label: 'MARA', x: 19, z: 12 },
    { id: 'clinic', kind: 'shop', label: 'CLINIC', x: -30, z: 30 },
    { id: 'garage', kind: 'garage', label: 'NICO GARAGE', x: 90, z: -30 },
    { id: 'home', kind: 'home', label: 'SAFEHOUSE', x: -90, z: 90 },
    { id: 'fuel-oq', kind: 'fuel', type: 'fuel', label: 'FUEL / OLD QUARTER', x: -51, z: 13 },
    { id: 'fuel-gd', kind: 'fuel', type: 'fuel', label: 'FUEL / GLASS DISTRICT', x: 13, z: -179 },
    { id: 'fuel-ps', kind: 'fuel', type: 'fuel', label: 'FUEL / PORT SOL', x: 141, z: 141 },
    { id: 'fuel-ss', kind: 'fuel', type: 'fuel', label: 'FUEL / SUNSTRAND', x: 205, z: 42 },
    { id: 'chop', kind: 'chop', label: 'CHOP SHOP', x: 150, z: 180 },
    { id: 'race-av', kind: 'race', label: 'AVENIDA SPRINT', x: 0, z: -100 },
    { id: 'race-pr', kind: 'race', label: 'PORT RUN', x: 100, z: 160 },
    { id: 'coast', kind: 'coast', label: 'COAST RUN', x: 205, z: 77 }
  ];
  var CHECKPOINT_COLORS = [0xf77f80, 0xf1ad5e, 0x72e5bb, 0x8bbcff, 0xf8cf69];
  var MISSIONS = [
    {
      name: 'A favor in the sun', giver: 'MARA', pay: 450, chapter: 1,
      intro: 'Mara: Meet me at the coral phone. Your courier car is parked by the road.',
      outro: 'Mara: Ledger\'s in hand. You\'re officially on the payroll, Kai.',
      steps: [
        { kind: 'goto', x: 19, z: 12, text: 'Go to the coral phone marker and press INTERACT.' },
        { kind: 'goto', x: -150, z: 40, text: 'Pick up the ledger in Little Palm.' },
        { kind: 'goto', x: 120, z: -40, text: 'Deliver the ledger to the Coral Heights drop.' }
      ]
    },
    {
      name: 'Borrowed horsepower', giver: 'NICO', pay: 700, chapter: 1,
      intro: 'Nico: I need wheels with a spine. The yellow coupe at 5, -84. Bring it here, no scratches. Well — few scratches.',
      outro: 'Nico: She purrs. You drive like you mean it. We\'re good.',
      steps: [
        { kind: 'goto', x: 5, z: -84, text: 'Steal the yellow sport coupe.' },
        { kind: 'deliver', x: 90, z: -30, text: 'Bring the coupe to Nico\'s garage.' }
      ]
    },
    {
      name: 'Port of no return', giver: 'MARA', pay: 950, chapter: 2,
      intro: 'Mara: Three guards between you and the drive in Port Sol. Make it quiet. Or don\'t.',
      outro: 'Mara: The drive is ours. Port Sol won\'t know what hit it.',
      steps: [
        { kind: 'goto', x: 141, z: 160, text: 'Reach the Port Sol yard.' },
        { kind: 'kill', count: 3, x: 141, z: 160, text: 'Neutralize 3 Port Sol guards.' },
        { kind: 'goto', x: 19, z: 12, text: 'Take the drive back to Mara.' }
      ]
    },
    {
      name: 'Off the grid', giver: 'MARA', pay: 1100, chapter: 2,
      intro: 'Mara: A transmitter in the Glass District is painting the whole crew. Kill it, then vanish.',
      outro: 'Mara: Dark. Clean. They\'ll spend a week looking for a ghost.',
      steps: [
        { kind: 'goto', x: -40, z: -150, text: 'Disable the transmitter in the Glass District.' },
        { kind: 'evade', x: -90, z: 90, text: 'Lose the police, then reach the safehouse.' }
      ]
    },
    {
      name: 'Last light run', giver: 'NICO', pay: 1500, chapter: 3, timer: 180,
      intro: 'Nico: Three drops, 180 seconds, one sunset. Don\'t brake for anything with a pulse.',
      outro: 'Nico: Three drops, time to spare. You\'re a legend with a deadline.',
      steps: [
        { kind: 'timed', x: 150, z: 40, text: 'Drop 1 of 3 — Sunstrand.' },
        { kind: 'timed', x: -150, z: -40, text: 'Drop 2 of 3 — Little Palm.' },
        { kind: 'timed', x: 100, z: 160, text: 'Drop 3 of 3 — Port Sol.' }
      ]
    },
    {
      name: 'The clean getaway', giver: 'MARA', pay: 1800, chapter: 3,
      intro: 'Mara: Last one. Hold the safehouse, push the relay, meet me on the beach. Then we\'re done.',
      outro: 'Mara: It\'s over. The archive is ours, the city is yours. Drive into the sunset, Kai.',
      steps: [
        { kind: 'goto', x: -90, z: 90, text: 'Reach the safehouse.' },
        { kind: 'channel', secs: 6, x: -90, z: 90, text: 'Hold position — uploading the relay.' },
        { kind: 'goto', x: 210, z: 42, text: 'Rendezvous on the Sunstrand beach.' }
      ]
    }
  ];

  // ---------- vehicle geometry ----------
  function vehicleHalfExtents(type) {
    if (type === 'bike') return { w: 0.55, l: 1.35 };
    if (type === 'tow') return { w: 1.55, l: 4.2 };
    if (type === 'ambulance') return { w: 1.55, l: 3.5 };
    if (type === 'service') return { w: 1.55, l: 2.65 };
    return { w: 1.25, l: 2.65 };
  }
  function vehicleShape(car) {
    // Forward axis (cos yaw, sin yaw), side axis (-sin yaw, cos yaw).
    var e = vehicleHalfExtents(car.type);
    var c = Math.cos(car.yaw), s = Math.sin(car.yaw);
    function corner(lf, wf) {
      return { x: car.x + lf * c - wf * s, z: car.z + lf * s + wf * c };
    }
    return [corner(-e.l, -e.w), corner(e.l, -e.w), corner(e.l, e.w), corner(-e.l, e.w)];
  }
  function vehiclesOverlap(a, b) {
    // Cheap circle test on the rotated rectangles' extents.
    var ea = vehicleHalfExtents(a.type), eb = vehicleHalfExtents(b.type);
    var ra = Math.sqrt(ea.w * ea.w + ea.l * ea.l), rb = Math.sqrt(eb.w * eb.w + eb.l * eb.l);
    return dist(a.x, a.z, b.x, b.z) < (ra + rb) * 0.82;
  }
  // Axis-aligned route over the road grid, from (fx,fz) toward (tx,tz).
  function gridRoute(fx, fz, tx, tz) {
    var pts = [];
    var nx = ROADS.reduce(function (best, r) { return Math.abs(r - fx) < Math.abs(best - fx) ? r : best; }, ROADS[0]);
    var nz = ROADS.reduce(function (best, r) { return Math.abs(r - fz) < Math.abs(best - fz) ? r : best; }, ROADS[0]);
    pts.push({ x: nx, z: fz });
    pts.push({ x: nx, z: tz });
    pts.push({ x: tx, z: tz });
    return pts;
  }

  // ---------- the Game ----------
  var SAVE_KEY = 'palm-harbor-save-v1';
  var WEAPONS = [
    { name: 'SIDEARM', clip: 12, reload: 1.35, cooldown: 0.27, range: 58, damage: 38 },
    { name: 'BATON', clip: Infinity, reload: 0, cooldown: 0.5, range: 3.1, damage: 40 }
  ];

  function Game(seed) {
    seed = seed === undefined ? 74017 : seed;
    this.seed = seed;
    this.r = rng(seed + 1);
    this.city = makeCity(seed);
    this.spatial = new Map();
    for (var bi = 0; bi < this.city.buildings.length; bi++) {
      var b = this.city.buildings[bi];
      for (var ix = Math.floor(b.minX / 32); ix <= Math.floor(b.maxX / 32); ix++) {
        for (var iz = Math.floor(b.minZ / 32); iz <= Math.floor(b.maxZ / 32); iz++) {
          var k = ix + ',' + iz;
          if (!this.spatial.has(k)) this.spatial.set(k, []);
          this.spatial.get(k).push(b);
        }
      }
    }
    this.player = {
      x: 5, z: 15, y: 0, yaw: Math.PI / 2, hp: 100, armor: 40, ammo: 72, clip: 12,
      weapon: 0, stamina: 100, vehicle: null, speed: 0, money: 300, vy: 0, grounded: true
    };
    this.cars = []; this.peds = []; this.police = []; this.enemies = [];
    this.effects = []; this.shots = []; this.events = [];
    this.clock = 16.4; this.time = 0; this.day = 1;
    this.heat = 0; this.search = 0; this.heatCooldown = 0;
    this.paused = false; this.dead = false;
    this.mission = { index: 0, active: false, step: 0, progress: 0, timer: 0 };
    this.settings = { volume: 0.55, music: true, quality: 0, population: 720 };
    this.stats = { distance: 0, missions: 0, earned: 0, crashes: 0, shots: 0, races: 0, kills: 0 };
    this.fireCooldown = 0; this.reloadTimer = 0; this.hurtCooldown = 0;
    this.notifyCooldown = 0; this.saveTimer = 0; this.policeTimer = 0; this.enemyShot = 0;
    this.race = null; this.bestRace = 0; this.lastMissionCar = null;
    this.wantedKills = 0; this.casualties = 0;
    this.extras = { standing: null, crew: { nico: 0, plate: 0 }, shells: 0, races: {}, weather: null, tow: [] };
    this.emergency = null; this.waypoint = null;
    this.spawnPopulation(720, 78);
  }

  Game.prototype.spawnPopulation = function (nPeds, nCars) {
    var r = this.r;
    // The player's own courier sedan, teal, parked by the road.
    this.cars.push({
      id: 0, type: 'sedan', name: 'COURIER SEDAN', color: 0x28cad2, x: 19, z: 6.5, yaw: Math.PI / 2,
      speed: 0, hp: 100, owned: true, claimed: false, stolen: false, missionCar: false,
      driver: false, parked: true, fuel: 100, throttle: 0
    });
    // The mission coupe, yellow sport, waiting to be borrowed.
    this.cars.push({
      id: 1, type: 'sport', name: 'SPORT COUPE', color: 0xf5c449, x: 5, z: -84, yaw: 0,
      speed: 0, hp: 100, owned: false, claimed: false, stolen: false, missionCar: true,
      driver: false, parked: true, fuel: 100, throttle: 0
    });
    var types = ['sedan', 'sedan', 'sedan', 'sport', 'van', 'sedan', 'taxi', 'sedan'];
    // PAINT palette (reference §8.1) — shared by car paint and citizen clothes.
    var colors = [0x3cc8cf, 0xf4bb45, 0xe46c70, 0xede4cf, 0x567eb8, 0x4d6967, 0x9c72b0, 0xccd0d3, 0x353b46];
    // Circulating traffic first (ids 2-61, 60 cars): on a road lane (±3.4),
    // driver aboard, cruising. Parked stock last (ids 62+, the rest): at the
    // roadside offset (±6.8, reference §2.1), no driver — so the parked pool
    // carries the high ids.
    for (var i = 2; i < nCars; i++) {
      var circulating = i < 62;
      var road = ROADS[Math.floor(r() * ROADS.length)];
      var along = -192 + r() * 384;
      var horizontal = r() < 0.5;
      var type = types[Math.floor(r() * types.length)];
      var off = circulating ? 3.4 : 6.8;
      var side = r() < 0.5 ? -off : off;
      this.cars.push({
        id: i, type: type === 'taxi' ? 'sedan' : type, taxi: type === 'taxi',
        name: type.toUpperCase(), color: type === 'taxi' ? 0xfebd46 : colors[Math.floor(r() * colors.length)],
        x: horizontal ? along : road + side,
        z: horizontal ? road + side : along,
        yaw: horizontal ? (r() < 0.5 ? 0 : Math.PI) : (r() < 0.5 ? Math.PI / 2 : -Math.PI / 2),
        speed: 0, hp: 100, owned: false, claimed: false, stolen: false, missionCar: false,
        driver: circulating, parked: !circulating, fuel: 100, throttle: 0,
        cruise: 11 + r() * 3, lane: side, route: null, routeI: 0
      });
    }
    for (var j = 0; j < nPeds; j++) {
      var roadX = ROADS[Math.floor(r() * ROADS.length)];
      var roadZ = ROADS[Math.floor(r() * ROADS.length)];
      var onXRoad = r() < 0.5;
      this.peds.push({
        id: j, x: onXRoad ? roadX + (r() < 0.5 ? -12 : 12) : -210 + r() * 420,
        z: onXRoad ? -210 + r() * 420 : roadZ + (r() < 0.5 ? -12 : 12),
        yaw: r() * Math.PI * 2, speed: 0.49, fear: 0, size: 0.91 + (j % 5) * 0.041,
        color: colors[Math.floor(r() * colors.length)],
        skin: [0xc68c66, 0x734933, 0xe2b38d, 0xa66b46][j % 4],
        pants: [0x314157, 0x434958, 0x676477, 0x385c64, 0x8f775f][j % 5],
        hair: [0x34313d, 0x543a3c, 0x84624f, 0x272d36, 0xcc925e][j % 5],
        down: false, wait: r() * 3
      });
    }
  };

  // Whether a point is on a sidewalk: the 9.5-17 unit band from the nearest
  // road centreline, along either axis — the ring around each block
  // (reference §5/§10: pedestrians walk the sidewalk, inset 12).
  Game.prototype.onSidewalk = function (x, z) {
    function dRoad(v) {
      var best = 1e9;
      for (var i = 0; i < ROADS.length; i++) { var d = Math.abs(v - ROADS[i]); if (d < best) best = d; }
      return best;
    }
    var ux = dRoad(x), uz = dRoad(z);
    return (ux >= 9.5 && ux <= 17) || (uz >= 9.5 && uz <= 17);
  };

  Game.prototype.phaseOf = function (clock) {
    clock = clock === undefined ? this.clock : clock;
    return (clock >= 6 && clock < 18.5) ? 'day' : 'night';
  };
  Game.prototype.isNight = function () { return this.phaseOf() === 'night'; };
  Game.prototype.weatherGrip = function () { return 1; };
  Game.prototype.addHeat = function () { this.heat = 1; };
  Game.prototype.getWantedStars = function () {
    if (this.wantedKills >= 12) return 5;
    if (this.wantedKills >= 9) return 4;
    if (this.wantedKills >= 6) return 3;
    if (this.wantedKills >= 3) return 2;
    if (this.wantedKills >= 1 || this.heat > 0) return 1;
    return 0;
  };
  Game.prototype.districtAt = function (x, z) { return district(x === undefined ? this.player.x : x, z === undefined ? this.player.z : z); };

  Game.prototype.blocked = function (x, z) {
    if (Math.abs(x) > 216 || Math.abs(z) > 216) return true;
    var ix = Math.floor(x / 32), iz = Math.floor(z / 32);
    var list = this.spatial.get(ix + ',' + iz) || [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (x > b.minX - 0.4 && x < b.maxX + 0.4 && z > b.minZ - 0.4 && z < b.maxZ + 0.4) return true;
    }
    return false;
  };
  Game.prototype.collides = function (x, z) { return this.blocked(x, z); };
  // Whether a ground entity is blocked at a point (buildings + island edge).
  Game.prototype.entityBlocked = function (x, z) { return this.blocked(x, z); };

  Game.prototype.resolveFootOverlap = function () {
    var p = this.player;
    for (var i = 0; i < this.peds.length; i++) {
      var ped = this.peds[i];
      if (ped.down) continue;
      var d = dist(p.x, p.z, ped.x, ped.z);
      if (d < 0.9 && d > 0.001) {
        var push = (0.9 - d) / 2;
        var nx = (ped.x - p.x) / d, nz = (ped.z - p.z) / d;
        ped.x += nx * push; ped.z += nz * push;
      }
    }
  };

  // ---------- movement ----------
  Game.prototype.footMove = function (dt, input) {
    var p = this.player;
    var fwd = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    var strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    var sprinting = input.sprint && p.stamina > 1 && fwd > 0;
    var speed = sprinting ? 7.5 : 4.1;
    if (sprinting) p.stamina = Math.max(0, p.stamina - 20 * dt);
    else p.stamina = Math.min(100, p.stamina + 16 * dt);
    var mx = Math.cos(p.yaw) * fwd - Math.sin(p.yaw) * strafe;
    var mz = Math.sin(p.yaw) * fwd + Math.cos(p.yaw) * strafe;
    var len = Math.sqrt(mx * mx + mz * mz) || 1;
    var nx = p.x + (mx / len) * speed * dt * (fwd || strafe ? 1 : 0);
    var nz = p.z + (mz / len) * speed * dt * (fwd || strafe ? 1 : 0);
    if (!this.blocked(nx, p.z)) p.x = nx;
    if (!this.blocked(p.x, nz)) p.z = nz;
    p.speed = (fwd || strafe) ? speed : 0;
    this.stats.distance += p.speed * dt;
    if (input.jump && p.grounded) { p.vy = 6.3; p.grounded = false; }
    if (!p.grounded) {
      p.vy -= 18 * dt; p.y += p.vy * dt;
      if (p.y <= 0) { p.y = 0; p.vy = 0; p.grounded = true; }
    }
  };

  Game.prototype.move = function (dt, input) {
    var p = this.player;
    if (p.vehicle === null || p.vehicle === undefined) { this.footMove(dt, input); return; }
    var car = this.cars[p.vehicle];
    if (!car) { p.vehicle = null; this.footMove(dt, input); return; }
    var top = car.type === 'sport' ? 38 : car.type === 'bike' ? 34 : 29;
    var acc = car.type === 'sport' ? 24 : car.type === 'bike' ? 27 : car.type === 'van' ? 14 : 19;
    var steerRate = car.type === 'bike' ? 2.4 : 1.65;
    var grip = this.weatherGrip();
    var throttle = (input.forward ? 1 : 0) - (input.back ? 0.6 : 0);
    if (car.fuel !== undefined && car.fuel <= 0) throttle = 0; // out of fuel: engine dead
    car.throttle = throttle;
    car.speed = clamp(car.speed + throttle * acc * grip * dt, -top * 0.4, top * grip);
    if (input.handbrake) car.speed *= Math.max(0, 1 - 3.2 * dt);
    else if (throttle === 0) car.speed *= Math.max(0, 1 - 0.6 * dt);
    var steer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    var dir = car.speed >= 0 ? 1 : -1;
    car.yaw += steer * steerRate * dt * dir * clamp(Math.abs(car.speed) / 6, 0, 1);
    var nx = car.x + Math.cos(car.yaw) * car.speed * dt;
    var nz = car.z + Math.sin(car.yaw) * car.speed * dt;
    // Axis-separated: slide along a wall instead of bouncing off it. The
    // car stops moving but keeps its speed while pressed against a wall
    // (full throttle against a wall still reads flat-out).
    var ox = car.x, oz = car.z, moved = false;
    if (!this.blocked(nx, car.z)) { car.x = nx; moved = true; }
    if (!this.blocked(car.x, nz)) { car.z = nz; moved = true; }
    if (!moved) { this.effects.push({ kind: 'crash', x: car.x, z: car.z, t: 0.2 }); this.stats.crashes++; }
    p.x = car.x; p.z = car.z; p.yaw = car.yaw; p.speed = car.speed;
    this.stats.distance += Math.abs(car.x - ox) + Math.abs(car.z - oz);
  };

  // ---------- vehicles: enter / exit ----------
  Game.prototype.nearestCar = function (maxD) {
    var p = this.player, best = null, bd = maxD || 4.5;
    for (var i = 0; i < this.cars.length; i++) {
      var c = this.cars[i];
      if (c.driver && c.id !== 0 && c.id !== 1 && !c.parked) continue;
      var d = dist(p.x, p.z, c.x, c.z);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };
  Game.prototype.toggleCar = function () {
    var p = this.player;
    if (this.paused) return false;
    if (p.vehicle !== null && p.vehicle !== undefined) {
      var car = this.cars[p.vehicle];
      if (car && Math.abs(car.speed) > 5) return false; // cannot bail out of a moving car
      if (car) { car.driver = false; }
      p.vehicle = null; p.speed = 0;
      this.events.push({ kind: 'exit', t: this.time });
      return true;
    }
    var car = this.nearestCar(4.5);
    if (!car) return false;
    if (car.parked) { car.parked = false; }
    if (!car.owned && !car.claimed) { car.claimed = true; car.stolen = true; this.heat = Math.max(this.heat, 1); }
    car.driver = true;
    p.vehicle = car.id; p.yaw = car.yaw; p.speed = 0;
    if (car.fuel === undefined) car.fuel = 100;
    this.events.push({ kind: 'enter', t: this.time });
    return true;
  };
  Game.prototype.getCar = function () {
    if (this.player.vehicle === null || this.player.vehicle === undefined) return null;
    return this.cars[this.player.vehicle] || null;
  };
  Game.prototype.playerCar = function () {
    var car = this.getCar();
    if (car) return car;
    for (var i = 0; i < this.cars.length; i++) if (this.cars[i].claimed) return this.cars[i];
    return this.cars[0];
  };
  Game.prototype.getBoat = function () { return null; }; // beach.js replaces this

  // ---------- combat ----------
  Game.prototype.shoot = function () {
    var p = this.player;
    if (this.paused) return false;
    var w = WEAPONS[p.weapon];
    if (this.fireCooldown > 0 || this.reloadTimer > 0) return false;
    if (p.weapon === 0) {
      if (p.clip <= 0) { this.reload(); return false; }
      p.clip--;
    }
    this.fireCooldown = w.cooldown;
    this.stats.shots++;
    var range = w.range;
    // Walls stop bullets: march the ray and clamp the range at the first
    // blocked point, so a target behind a building is never hit and the
    // tracer stops at the wall.
    var stepX = Math.cos(p.yaw), stepZ = Math.sin(p.yaw);
    for (var s = 1; s < range; s += 0.5) {
      if (this.blocked(p.x + stepX * s, p.z + stepZ * s)) { range = s; break; }
    }
    // Find the nearest hittable target along the facing ray.
    var hx = p.x + Math.cos(p.yaw), hz = p.z + Math.sin(p.yaw);
    var best = null, bd = range;
    var consider = function (x, z, obj) {
      var d = dist(p.x, p.z, x, z);
      if (d < bd && d < range) {
        var dx = x - p.x, dz = z - p.z;
        var dot = (dx * Math.cos(p.yaw) + dz * Math.sin(p.yaw)) / (d || 1);
        if (dot > 0.86) { bd = d; best = obj; }
      }
    };
    for (var i = 0; i < this.enemies.length; i++) consider(this.enemies[i].x, this.enemies[i].z, { kind: 'enemy', ref: this.enemies[i] });
    for (var j = 0; j < this.police.length; j++) {
      var off = this.police[j];
      if (off.foot) consider(off.x, off.z, { kind: 'officer', ref: off });
    }
    for (var k = 0; k < this.peds.length; k++) {
      var ped = this.peds[k];
      if (!ped.down) consider(ped.x, ped.z, { kind: 'ped', ref: ped });
    }
    this.shots.push({ x: p.x, y: 1.35, z: p.z, tx: p.x + Math.cos(p.yaw) * range, tz: p.z + Math.sin(p.yaw) * range, life: 0.14, foe: false });
    if (best) this.hitTarget(best, w.damage);
    else this.effects.push({ kind: 'shot', x: p.x + Math.cos(p.yaw) * 6, z: p.z + Math.sin(p.yaw) * 6, t: 0.1 });
    this.effects = this.effects.slice(-24);
    return true;
  };
  Game.prototype.hitTarget = function (target, damage) {
    if (target.kind === 'enemy') {
      target.ref.hp -= damage;
      if (target.ref.hp <= 0 && !target.ref.down) {
        target.ref.down = true;
        this.registerKill('enemy');
        this.missionProgress('kill');
      }
    } else if (target.kind === 'officer') {
      target.ref.hp -= damage;
      if (target.ref.hp <= 0 && target.ref.state !== 'down') {
        target.ref.state = 'down';
        this.registerKill('officer');
      }
    } else if (target.kind === 'ped') {
      target.ref.down = true;
      this.registerKill('ped');
    }
    this.events.push({ kind: 'hit', t: this.time });
  };
  Game.prototype.reload = function () {
    var p = this.player;
    if (p.weapon !== 0 || this.reloadTimer > 0) return false;
    if (p.clip >= 12 || p.ammo <= 0) return false;
    this.reloadTimer = 1.35;
    return true;
  };
  // Test-driver verbs: thin delegates over the shell's own actions.
  Game.prototype.action = function (name) {
    if (this.paused) return false;
    if (name === 'enter') return this.toggleCar();
    if (name === 'interact') return this.interact();
    if (name === 'reload') return this.reload();
    if (name === 'jump') {
      var p = this.player;
      if (p.vehicle !== null && p.vehicle !== undefined) return false;
      if (!p.grounded) return false;
      p.vy = 6.3; p.grounded = false;
      return true;
    }
    return false;
  };
  Game.prototype.fire = function () { return this.shoot(); };
  Game.prototype.damage = function (amount, source) {
    var p = this.player;
    if (this.dead || this.hurtCooldown > 0) return;
    this.hurtCooldown = 0.35;
    var rest = amount;
    if (p.armor > 0) { var absorbed = Math.min(p.armor, rest); p.armor -= absorbed; rest -= absorbed; }
    p.hp -= rest;
    this.effects.push({ kind: 'hurt', x: p.x, z: p.z, t: 0.3 });
    if (p.hp <= 0) {
      p.hp = 0; this.dead = true;
      if (this.emergency && this.emergency.reportDown) this.emergency.reportDown(this);
    }
  };
  Game.prototype.respawn = function () {
    var p = this.player;
    p.money = Math.max(0, p.money - 100);
    p.hp = 100; p.armor = 20; p.clip = 12;
    p.x = -30; p.z = 30; p.y = 0; p.yaw = Math.PI / 2; p.vehicle = null; p.speed = 0;
    this.dead = false; this.heat = 0; this.search = 0; this.wantedKills = 0;
    this.events.push({ kind: 'respawn', t: this.time });
  };
  Game.prototype.registerKill = function (kind) {
    this.wantedKills++;
    this.casualties++;
    this.stats.kills++;
    if (this.standingAdd) this.standingAdd(-4);
  };

  // ---------- enemies ----------
  Game.prototype.updateEnemies = function (dt) {
    var p = this.player;
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (e.down) continue;
      var d = dist(p.x, p.z, e.x, e.z);
      if (d > 14 && d < 55) {
        var dx = (p.x - e.x) / (d || 1), dz = (p.z - e.z) / (d || 1);
        var nx = e.x + dx * 1.2 * dt, nz = e.z + dz * 1.2 * dt;
        if (!this.blocked(nx, e.z)) e.x = nx;
        if (!this.blocked(e.x, nz)) e.z = nz;
      }
      if (d < 38) {
        e.cooldown -= dt;
        if (e.cooldown <= 0) {
          e.cooldown = 1.9 + this.r();
          var hitChance = p.speed > 5 ? 0.35 : 0.7;
          if (this.r() < hitChance) this.damage(p.vehicle !== null ? 4 : 9, 'enemy');
          this.shots.push({ x: e.x, y: 1.35, z: e.z, tx: p.x, tz: p.z, life: 0.14, foe: true });
        }
      }
    }
  };
  Game.prototype.spawnEnemies = function (count, x, z) {
    for (var i = 0; i < count; i++) {
      this.enemies.push({
        x: x + (this.r() - 0.5) * 12, z: z + (this.r() - 0.5) * 12,
        hp: 100, cooldown: 1 + this.r(), down: false
      });
    }
  };

  // ---------- police (base; police-support.js replaces updatePolice) ----------
  Game.prototype.updatePolice = function (dt) {
    // Base version: decay search when unseen, no units. The full system
    // (cars + foot officers + tactics) lives in police-support.js.
    var stars = this.getWantedStars();
    if (stars === 0) { this.search = Math.max(0, this.search - dt / 12); return; }
    if (this.search > 0) this.search = Math.max(0, this.search - dt / (12 + stars * 3));
  };
  Game.prototype.policeCarApproach = function () { };
  Game.prototype.policeCarChase = function () { };
  Game.prototype.policeCarTactic = function () { };
  Game.prototype.policeDoor = function () { };
  Game.prototype.policeOfficerFootUpdate = function () { };
  Game.prototype.returnPoliceOfficer = function () { };

  // ---------- missions ----------
  Game.prototype.raceObjective = function () { return this.race; };
  Game.prototype.activityGuide = function () { return null; }; // activities.js replaces this
  Game.prototype.objective = function () {
    var m = MISSIONS[this.mission.index];
    if (!m) return null;
    var step = m.steps[Math.min(this.mission.step, m.steps.length - 1)];
    if (!step) return null;
    var d = step.x !== undefined ? Math.round(dist(this.player.x, this.player.z, step.x, step.z)) : 0;
    return {
      tag: 'STORY / ' + String(this.mission.index + 1).padStart(2, '0'),
      title: m.name, text: step.text, x: step.x, z: step.z, dist: d,
      timer: this.mission.timer > 0 ? this.mission.timer : 0,
      chapter: m.chapter, giver: m.giver, pay: m.pay
    };
  };
  Game.prototype.missionProgress = function (kind) {
    var m = MISSIONS[this.mission.index];
    if (!m || !this.mission.active) return;
    var step = m.steps[this.mission.step];
    if (!step) return;
    if (step.kind === 'kill' && kind === 'kill') {
      this.mission.progress++;
      if (this.mission.progress >= (step.count || 1)) this.advanceMission();
    }
  };
  Game.prototype.advanceMission = function () {
    var m = MISSIONS[this.mission.index];
    this.mission.step++;
    this.mission.progress = 0;
    if (this.mission.step >= m.steps.length) this.completeMission();
  };
  Game.prototype.completeMission = function () {
    var m = MISSIONS[this.mission.index];
    this.player.money += m.pay;
    this.stats.missions++;
    this.stats.earned += m.pay;
    this.events.push({ kind: 'mission', text: m.name + ' complete — $' + m.pay, t: this.time });
    if (this.standingAdd) this.standingAdd(15);
    if (this.onMissionComplete) this.onMissionComplete(m);
    this.mission.index++;
    this.mission.step = 0; this.mission.progress = 0; this.mission.timer = 0;
    this.mission.active = this.mission.index < MISSIONS.length;
  };
  Game.prototype.startMission = function () {
    var m = MISSIONS[this.mission.index];
    if (!m) return false;
    this.mission.active = true;
    this.mission.step = 0; this.mission.progress = 0;
    this.mission.timer = m.timer || 0;
    if (m.name === 'Port of no return') this.spawnEnemies(3, 141, 160);
    this.events.push({ kind: 'mission', text: m.intro, t: this.time });
    return true;
  };

  // ---------- shops / interact ----------
  Game.prototype.nearContact = function (kind, maxD) {
    var p = this.player, best = null, bd = maxD || 9;
    for (var i = 0; i < CONTACTS.length; i++) {
      var c = CONTACTS[i];
      if (kind && c.kind !== kind) continue;
      var d = dist(p.x, p.z, c.x, c.z);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };
  Game.prototype.purchase = function (what) {
    var p = this.player;
    var price = what === 'heal' ? 60 : what === 'armor' ? 90 : what === 'ammo' ? 70 : 0;
    if (!price) return false;
    var disc = 0;
    if (PH.standingDiscountAt) disc = PH.standingDiscountAt(this.districtAt());
    price = Math.max(0, Math.round(price * (1 - disc)));
    if (p.money < price) return false;
    p.money -= price;
    if (what === 'heal') p.hp = 100;
    if (what === 'armor') p.armor = 100;
    if (what === 'ammo') p.ammo = Math.min(9999, p.ammo + 48);
    this.events.push({ kind: 'money', text: 'Bought ' + what + ' — $' + price, t: this.time });
    return true;
  };
  Game.prototype.interact = function () {
    var p = this.player;
    var obj = this.objective();
    if (obj && this.mission.active && obj.dist <= 6) {
      var m = MISSIONS[this.mission.index];
      var step = m.steps[this.mission.step];
      if (step.kind === 'goto' || step.kind === 'timed' || step.kind === 'deliver') {
        if (step.kind === 'deliver' && p.vehicle === null) return false;
        this.advanceMission();
        return true;
      }
      if (step.kind === 'channel') { this.mission.channel = (this.mission.channel || 0); return true; }
    }
    var shop = this.nearContact('shop', 9);
    if (shop) { if (this.openShop) this.openShop(); return true; }
    var garage = this.nearContact('garage', 9);
    if (garage) {
      var car = this.getCar();
      if (car && car.hp < 100) {
        var cost = 100;
        if (PH.standingDiscountAt) cost = Math.round(cost * (1 - PH.standingDiscountAt(this.districtAt())));
        if (p.money >= cost) { p.money -= cost; car.hp = 100; this.events.push({ kind: 'money', text: 'Nico repaired your car — $' + cost, t: this.time }); }
      }
      return true;
    }
    var home = this.nearContact('home', 8);
    if (home) { this.save(); this.events.push({ kind: 'notify', text: 'Progress saved at the safehouse.', t: this.time }); return true; }
    return false;
  };
  Game.prototype.contextLine = function () {
    var p = this.player;
    var obj = this.objective();
    if (obj && this.mission.active && obj.dist <= 6) return { key: 'E', label: 'ACT — ' + obj.title.toUpperCase() };
    if (this.nearContact('shop', 9)) return { key: 'E', label: 'ACT — SUPPLIES / buy heal, armor, ammo' };
    if (this.nearContact('garage', 9)) return { key: 'E', label: 'ACT — NICO / repair car $100' };
    if (this.nearContact('home', 8)) return { key: 'E', label: 'ACT — SAFEHOUSE / save progress' };
    var car = this.nearestCar(4.5);
    if (p.vehicle === null && car) return { key: 'F', label: 'CAR — enter ' + (car.name || car.type).toUpperCase() };
    if (p.vehicle !== null) return { key: 'F', label: 'CAR — exit vehicle' };
    return null;
  };

  // ---------- traffic ----------
  Game.prototype.updateTraffic = function (dt) {
    var r = this.r;
    for (var i = 0; i < this.cars.length; i++) {
      var c = this.cars[i];
      if (!c.driver || c.parked || c.id === 0 || c.id === 1) continue;
      if (c.id === this.player.vehicle) continue;
      var target = this.rhythmTargetMul ? this.rhythmTargetMul(c) : 1;
      var cruise = (c.cruise || 12) * target;
      c.speed = lerp(c.speed, cruise, Math.min(1, dt * 0.5));
      var nx = c.x + Math.cos(c.yaw) * c.speed * dt;
      var nz = c.z + Math.sin(c.yaw) * c.speed * dt;
      if (this.blocked(nx, nz)) {
        c.yaw += Math.PI / 2;
      } else {
        // Slow down if another car is right ahead.
        var blockedAhead = false;
        for (var j = 0; j < this.cars.length; j++) {
          if (i === j) continue;
          var o = this.cars[j];
          var d = dist(nx, nz, o.x, o.z);
          if (d < 7) {
            var dot = ((o.x - nx) * Math.cos(c.yaw) + (o.z - nz) * Math.sin(c.yaw)) / (d || 1);
            if (dot > 0.7) { blockedAhead = true; break; }
          }
        }
        if (blockedAhead) c.speed = Math.max(0, c.speed - 20 * dt);
        else { c.x = nx; c.z = nz; }
      }
      if (Math.abs(c.x) > 205 || Math.abs(c.z) > 205) c.yaw += Math.PI;
    }
    for (var k = 0; k < this.peds.length; k++) {
      var ped = this.peds[k];
      if (ped.down) continue;
      if (ped.wait > 0) { ped.wait -= dt; continue; }
      var fear = 0;
      for (var s = 0; s < this.shots.length; s++) {
        if (dist(ped.x, ped.z, this.shots[s].x, this.shots[s].z) < 30) { fear = 1; break; }
      }
      ped.fear = fear;
      var sp = fear ? 0.82 : 0.49;
      var px = ped.x + Math.cos(ped.yaw) * sp * dt;
      var pz = ped.z + Math.sin(ped.yaw) * sp * dt;
      // Pedestrians walk the sidewalks: they stay on the sidewalk ring
      // around their block and turn when the next step would leave it; only
      // a scared pedestrian may cross the road to flee.
      if (this.blocked(px, pz) || Math.abs(px) > 214 || Math.abs(pz) > 214 ||
          (!fear && !this.onSidewalk(px, pz))) {
        ped.yaw += (r() - 0.5) * 2.4;
      } else {
        ped.x = px; ped.z = pz;
        if (r() < dt * 0.06) ped.yaw += (r() - 0.5) * 1.8;
      }
    }
  };

  // ---------- main update ----------
  Game.prototype.update = function (dt, input) {
    dt = Math.min(dt, 0.05);
    if (this.paused) return;
    // Drive movement from an input object. The shell passes its live input;
    // a test driver passes world-axis moveX/moveZ (translated here into the
    // yaw-relative frame move() reads). With no input, move with an empty
    // one so gravity, stamina and vehicle drag still tick.
    var src = input || {};
    var p = this.player;
    var t = {
      forward: !!src.forward, back: !!src.back, left: !!src.left, right: !!src.right,
      sprint: !!src.sprint, jump: !!src.jump, handbrake: !!src.handbrake
    };
    if (src.moveX || src.moveZ) {
      // Test-driver frame: moveZ is forward/back, moveX is strafe right/left.
      if (src.moveZ > 0.5) t.forward = true; else if (src.moveZ < -0.5) t.back = true;
      if (src.moveX > 0.5) t.right = true; else if (src.moveX < -0.5) t.left = true;
    }
    this.move(dt, t);
    if (src.fire) this.shoot();
    this.time += dt;
    this.clock += dt / 70;
    if (this.clock >= 24) { this.clock -= 24; this.day++; }
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        var need = 12 - this.player.clip;
        var take = Math.min(need, this.player.ammo);
        this.player.clip += take; this.player.ammo -= take;
      }
    }
    if (this.hurtCooldown > 0) this.hurtCooldown -= dt;
    if (this.notifyCooldown > 0) this.notifyCooldown -= dt;
    if (this.heatCooldown > 0) this.heatCooldown -= dt;
    if (this.policeTimer > 0) this.policeTimer -= dt;
    this.updateTraffic(dt);
    this.updateEnemies(dt);
    this.updatePolice(dt);
    this.resolveFootOverlap();
    // Mission timer (Last light run).
    if (this.mission.active && this.mission.timer > 0) {
      this.mission.timer -= dt;
      if (this.mission.timer <= 0) {
        this.mission.timer = 0;
        this.events.push({ kind: 'mission', text: 'Out of time — the run is blown.', t: this.time });
        this.mission.active = false;
      }
    }
    // Mission channel (upload at the safehouse).
    var m = MISSIONS[this.mission.index];
    if (m && this.mission.active && m.steps[this.mission.step] && m.steps[this.mission.step].kind === 'channel') {
      var step = m.steps[this.mission.step];
      var near = dist(this.player.x, this.player.z, step.x, step.z) <= 8;
      if (near && this.player.vehicle === null) {
        this.mission.channel = (this.mission.channel || 0) + dt;
        if (this.mission.channel >= (step.secs || 6)) { this.mission.channel = 0; this.advanceMission(); }
      } else this.mission.channel = 0;
    }
    // Evade step (Off the grid): reach the safehouse with no wanted stars.
    if (m && this.mission.active && m.steps[this.mission.step] && m.steps[this.mission.step].kind === 'evade') {
      var ev = m.steps[this.mission.step];
      if (this.getWantedStars() === 0 && dist(this.player.x, this.player.z, ev.x, ev.z) <= 8) this.advanceMission();
    }
    // Shots fade.
    for (var i = this.shots.length - 1; i >= 0; i--) {
      this.shots[i].life -= dt;
      if (this.shots[i].life <= 0) this.shots.splice(i, 1);
    }
    for (var e = this.effects.length - 1; e >= 0; e--) {
      this.effects[e].t -= dt;
      if (this.effects[e].t <= 0) this.effects.splice(e, 1);
    }
    this.effects = this.effects.slice(-24);
    // Autosave every 20s.
    this.saveTimer += dt;
    if (this.saveTimer >= 20) { this.saveTimer = 0; this.save(); this.events.push({ kind: 'save', t: this.time }); }
  };

  // ---------- save / snapshot ----------
  Game.prototype.snapshot = function () {
    return {
      version: 2, seed: this.seed, day: this.day, clock: this.clock, time: this.time,
      player: {
        x: this.player.x, z: this.player.z, y: this.player.y, yaw: this.player.yaw,
        hp: this.player.hp, armor: this.player.armor, ammo: this.player.ammo, clip: this.player.clip,
        weapon: this.player.weapon, stamina: this.player.stamina, money: this.player.money,
        vehicle: this.player.vehicle, speed: this.player.speed
      },
      mission: { index: this.mission.index, active: this.mission.active, step: this.mission.step, progress: this.mission.progress, timer: this.mission.timer },
      stats: this.stats, wantedKills: this.wantedKills, casualties: this.casualties,
      heat: this.heat, search: this.search, bestRace: this.bestRace,
      car: (function () {
        var vc = this.getCar();
        if (!vc) return null;
        return {
          id: vc.id, type: vc.type, x: vc.x, z: vc.z, yaw: vc.yaw, hp: vc.hp, color: vc.color,
          claimed: !!vc.claimed, missionCar: !!vc.missionCar, owned: !!vc.owned, stolen: !!vc.stolen,
          parked: !!vc.parked, fuel: vc.fuel === undefined ? 100 : vc.fuel, name: vc.name
        };
      }).call(this),
      cars: this.cars.map(function (c) {
        return {
          id: c.id, type: c.type, x: c.x, z: c.z, yaw: c.yaw, hp: c.hp, color: c.color,
          claimed: !!c.claimed, missionCar: !!c.missionCar, owned: !!c.owned, stolen: !!c.stolen,
          parked: !!c.parked, fuel: c.fuel === undefined ? 100 : c.fuel, name: c.name
        };
      }),
      extras: this.extras
    };
  };
  Game.prototype.save = function () {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(SAVE_KEY, JSON.stringify(this.snapshot()));
      return true;
    } catch (err) { return false; }
  };
  Game.prototype.restore = function (data) {
    if (!data || (data.version !== 1 && data.version !== 2) || !data.player) return false;
    var p = data.player;
    if (Math.abs(p.x) > 218 || Math.abs(p.z) > 218) return false;
    if (this.blocked(p.x, p.z)) return false;
    this.day = data.day || 1; this.clock = data.clock || 16.4; this.time = data.time || 0;
    this.player.x = p.x; this.player.z = p.z; this.player.y = 0;
    this.player.yaw = p.yaw || 0; this.player.speed = 0; this.player.vehicle = null;
    this.player.stamina = 100;
    this.player.hp = clamp(p.hp === undefined ? 100 : p.hp, 1, 100);
    this.player.armor = clamp(p.armor || 0, 0, 100);
    this.player.clip = clamp(p.clip === undefined ? 12 : p.clip, 0, 12);
    this.player.ammo = clamp(p.ammo || 0, 0, 9999);
    this.player.money = clamp(p.money || 0, 0, 9999999);
    this.player.weapon = p.weapon || 0;
    this.heat = 0; this.search = 0; this.dead = false;
    this.wantedKills = 0;
    if (data.wantedKills !== undefined) this.wantedKills = data.wantedKills;
    if (data.casualties !== undefined) this.casualties = data.casualties;
    if (data.heat !== undefined) this.heat = data.heat;
    if (data.mission) {
      this.mission.index = data.mission.index || 0;
      this.mission.active = !!data.mission.active;
      this.mission.step = data.mission.step || 0;
      this.mission.progress = data.mission.progress || 0;
      this.mission.timer = data.mission.timer || 0;
    }
    if (data.stats) this.stats = data.stats;
    if (data.bestRace) this.bestRace = data.bestRace;
    if (data.extras) this.extras = data.extras;
    if (data.cars) {
      for (var i = 0; i < data.cars.length; i++) {
        var sc = data.cars[i], car = this.cars[sc.id];
        if (!car) continue;
        car.x = sc.x; car.z = sc.z; car.yaw = sc.yaw;
        car.hp = clamp(sc.hp === undefined ? 100 : sc.hp, 10, 100);
        car.claimed = !!sc.claimed; car.missionCar = !!sc.missionCar;
        car.owned = !!sc.owned; car.stolen = !!sc.stolen;
        car.parked = !!sc.parked; car.fuel = sc.fuel === undefined ? 100 : sc.fuel;
      }
    }
    // Seat the player in the saved vehicle again (if that car still exists).
    if (p.vehicle !== null && p.vehicle !== undefined && this.cars[p.vehicle]) {
      this.player.vehicle = p.vehicle;
    }
    return true;
  };
  Game.prototype.loadSave = function () {
    try {
      if (typeof localStorage === 'undefined') return false;
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      return this.restore(JSON.parse(raw));
    } catch (err) { return false; }
  };

  // ---------- exports ----------
  PH.clamp = clamp; PH.dist = dist; PH.lerp = lerp; PH.angle = angle; PH.rng = rng;
  PH.ROADS = ROADS; PH.district = district; PH.PALETTE = PALETTE;
  PH.DISTRICT_ACCENT = DISTRICT_ACCENT;
  PH.makeCity = makeCity; PH.CONTACTS = CONTACTS; PH.MISSIONS = MISSIONS;
  PH.CHECKPOINT_COLORS = CHECKPOINT_COLORS; PH.WEAPONS = WEAPONS;
  PH.vehicleHalfExtents = vehicleHalfExtents; PH.vehicleShape = vehicleShape;
  PH.vehiclesOverlap = vehiclesOverlap; PH.gridRoute = gridRoute;
  PH.Game = Game; PH.SAVE_KEY = SAVE_KEY;
})();
