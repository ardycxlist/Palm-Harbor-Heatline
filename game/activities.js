// PALM HARBOR: HEATLINE — side activities.
// Taxi fares, dusk shells, robberies, chop shop, street races, Coast Run.
// Written from the design memo, in my own words.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});
  var clamp = PH.clamp, dist = PH.dist;

  var TAXI_SPOTS = [
    { x: 0, z: 13, label: 'OLD QUARTER' }, { x: 64, z: -51, label: 'CORAL HEIGHTS' },
    { x: -64, z: 51, label: 'OLD QUARTER' }, { x: 128, z: 13, label: 'CORAL HEIGHTS' },
    { x: -128, z: -115, label: 'LITTLE PALM' }, { x: 13, z: 141, label: 'PORT SOL' },
    { x: 192, z: 51, label: 'SUNSTRAND BEACH' }, { x: -51, z: -179, label: 'GLASS DISTRICT' }
  ];
  var SHELL_SPOTS = [];
  for (var si = 0; si < 20; si++) {
    SHELL_SPOTS.push({ x: 203 + (si % 5) * 2.2, z: -50 + Math.floor(si / 5) * 46 + (si % 3) * 7 });
  }
  var SHOPS = [
    { x: 30, z: 13, label: 'OLD QUARTER' }, { x: -100, z: -51, label: 'LITTLE PALM' },
    { x: 100, z: -100, label: 'CORAL HEIGHTS' }, { x: 150, z: 150, label: 'PORT SOL' }
  ];
  var ACTIVITIES = {
    taxiSpots: TAXI_SPOTS, shellSpots: SHELL_SPOTS, shops: SHOPS,
    chop: { x: 150, z: 180 },
    races: [
      { name: 'Avenida Sprint', x: 0, z: -100, finish: { x: 0, z: 150 } },
      { name: 'Port Run', x: 100, z: 160, finish: { x: -150, z: -100 } }
    ],
    chopPay: { sedan: 80, taxi: 80, sport: 180, van: 120 },
    robberyHold: 4, robberyCooldown: 240
  };
  var COAST_GATES = [];
  for (var gi = 0; gi < 9; gi++) {
    COAST_GATES.push({ x: 208, z: -40 + gi * 22 });
  }

  PH.Game.prototype.ensureActivities = function () {
    if (this.activitiesReady) return;
    this.activitiesReady = true;
    if (!this.extras.shells) this.extras.shells = [];
    if (!this.extras.races) this.extras.races = {};
    this.taxi = null;
    this.taxiTimer = 0;
    this.robbery = { hold: 0, cooldown: 0, shop: null };
    this.raceState = null;
    this.coastState = null;
    // A passenger is already waiting somewhere.
    this.taxiWait = TAXI_SPOTS[Math.floor(this.r() * TAXI_SPOTS.length)];
  };
  PH.Game.prototype.activityGuide = function () {
    this.ensureActivities();
    var p = this.player;
    if (this.taxiWait) {
      return { kind: 'taxi', text: 'TAXI / a passenger is waiting in ' + this.taxiWait.label + ' — pick them up by car', x: this.taxiWait.x, z: this.taxiWait.z };
    }
    if (this.taxi) {
      return { kind: 'taxi', text: 'TAXI / drop the passenger at the marker', x: this.taxi.dest.x, z: this.taxi.dest.z };
    }
    return null;
  };
  PH.Game.prototype.shellBob = function (t) { return Math.sin(t * 2) * 0.08; };
  PH.Game.prototype.raceObjective = function () {
    if (this.raceState) return this.raceState;
    if (this.coastState) return this.coastState;
    return null;
  };

  function nearestShop(game, maxD) {
    var best = null, bd = maxD;
    for (var i = 0; i < SHOPS.length; i++) {
      var d = dist(game.player.x, game.player.z, SHOPS[i].x, SHOPS[i].z);
      if (d < bd) { bd = d; best = SHOPS[i]; }
    }
    return best;
  }

  var prevInteract = PH.Game.prototype.interact;
  PH.Game.prototype.interact = function () {
    this.ensureActivities();
    var p = this.player;
    // Taxi pickup: in a car, near the waiting passenger.
    if (this.taxiWait && p.vehicle !== null && dist(p.x, p.z, this.taxiWait.x, this.taxiWait.z) < 6) {
      var dest = TAXI_SPOTS[Math.floor(this.r() * TAXI_SPOTS.length)];
      var routeLen = dist(this.taxiWait.x, this.taxiWait.z, dest.x, dest.z);
      this.taxi = { from: this.taxiWait, dest: dest, fare: 40 + Math.floor(this.r() * 51) };
      this.taxiTimer = routeLen / 11 + 25;
      this.events.push({ kind: 'notify', text: 'TAXI / passenger aboard — drop them in ' + dest.label + ' before the timer runs out.', t: this.time });
      this.taxiWait = null;
      return true;
    }
    // Taxi drop-off.
    if (this.taxi && p.vehicle !== null && dist(p.x, p.z, this.taxi.dest.x, this.taxi.dest.z) < 8) {
      var bonus = this.taxiTimer > 0 ? 30 : 0;
      var pay = this.taxi.fare + bonus;
      p.money += pay;
      if (this.standingAdd) this.standingAdd(2, this.taxi.dest.label);
      this.events.push({ kind: 'money', text: 'TAXI / fare $' + this.taxi.fare + (bonus ? ' + $30 time bonus' : '') + '.', t: this.time });
      this.taxi = null;
      this.taxiWait = TAXI_SPOTS[Math.floor(this.r() * TAXI_SPOTS.length)];
      return true;
    }
    // Robbery: on foot, near a shop — hold 4s (progress runs in update).
    if (p.vehicle === null) {
      var shop = nearestShop(this, 5);
      if (shop) {
        if (this.robbery.cooldown > 0) return false;
        if (this.robbery.hold <= 0) this.robbery.shop = shop;
        return true;
      }
    }
    // Chop shop: sell a stolen car in the Port Sol south quay.
    var car = this.getCar();
    if (car && car.stolen && dist(p.x, p.z, ACTIVITIES.chop.x, ACTIVITIES.chop.z) < 10) {
      var pay2 = ACTIVITIES.chopPay[car.type] || ACTIVITIES.chopPay.sedan;
      p.money += pay2;
      if (this.standingAdd) this.standingAdd(3, 'PORT SOL');
      this.events.push({ kind: 'money', text: 'CHOP SHOP / sold the ' + car.type + ' for $' + pay2 + '.', t: this.time });
      car.hp = 0; car.parked = true; car.driver = false; car.stolen = false; car.claimed = false;
      p.vehicle = null;
      return true;
    }
    // Street races: start at a race marker while in a car.
    for (var ri = 0; ri < ACTIVITIES.races.length; ri++) {
      var race = ACTIVITIES.races[ri];
      if (p.vehicle !== null && dist(p.x, p.z, race.x, race.z) < 8) {
        var par = dist(race.x, race.z, race.finish.x, race.finish.z) / 12.5;
        this.raceState = { name: race.name, finish: race.finish, timer: par, par: par, won: (this.extras.races[race.name] || 0) > 0 };
        this.events.push({ kind: 'notify', text: 'RACE / ' + race.name + ' — reach the finish in ' + Math.round(par) + 's.', t: this.time });
        return true;
      }
    }
    // Coast Run: 9-gate time trial from the Sunstrand contact.
    if (p.vehicle !== null && dist(p.x, p.z, 205, 77) < 8) {
      this.coastState = { name: 'COAST RUN', gates: COAST_GATES.slice(), gate: 0, timer: 0 };
      this.events.push({ kind: 'notify', text: 'COAST RUN / 9 gates down the beach road — go!', t: this.time });
      return true;
    }
    return prevInteract.call(this);
  };

  var prevUpdate = PH.Game.prototype.update;
  PH.Game.prototype.update = function (dt) {
    var out = prevUpdate.call(this, dt);
    this.ensureActivities();
    var p = this.player;
    // Robbery hold: stay within 5 units on foot for 4s.
    if (this.robbery.cooldown > 0) this.robbery.cooldown -= dt;
    if (this.robbery.shop && p.vehicle === null) {
      var shop = this.robbery.shop;
      if (dist(p.x, p.z, shop.x, shop.z) <= 5) {
        this.robbery.hold += dt;
        if (this.robbery.hold >= ACTIVITIES.robberyHold) {
          var pay = 120 + Math.floor(this.r() * 81);
          p.money += pay;
          if (this.standingAdd) this.standingAdd(-8, shop.label);
          this.wantedKills = Math.max(this.wantedKills, 3);
          this.events.push({ kind: 'money', text: 'ROBBERY / $' + pay + ' — the cops are coming.', t: this.time });
          this.robbery.hold = 0;
          this.robbery.cooldown = ACTIVITIES.robberyCooldown;
          this.robbery.shop = null;
        }
      } else { this.robbery.hold = 0; this.robbery.shop = null; }
    }
    // Shells: walk over them on the beach.
    if (p.vehicle === null) {
      for (var si = 0; si < SHELL_SPOTS.length; si++) {
        if (this.extras.shells.indexOf(si) >= 0) continue;
        if (dist(p.x, p.z, SHELL_SPOTS[si].x, SHELL_SPOTS[si].z) < 2) {
          this.extras.shells.push(si);
          var n = this.extras.shells.length;
          if (n % 5 === 0) {
            var bonus = n >= 20 ? 500 : 150;
            p.money += bonus;
            this.events.push({ kind: 'money', text: 'DUSK SHELLS / ' + n + '/20 — +$' + bonus + '.', t: this.time });
          } else {
            this.events.push({ kind: 'notify', text: 'DUSK SHELLS / ' + n + '/20 collected.', t: this.time });
          }
        }
      }
    }
    // Taxi timer.
    if (this.taxi) {
      this.taxiTimer -= dt;
      if (this.taxiTimer <= 0) {
        this.taxi = null;
        this.taxiWait = TAXI_SPOTS[Math.floor(this.r() * TAXI_SPOTS.length)];
        this.events.push({ kind: 'notify', text: 'TAXI / the passenger gave up and walked away.', t: this.time });
      }
    }
    // Street race timing.
    if (this.raceState) {
      this.raceState.timer -= dt;
      if (dist(p.x, p.z, this.raceState.finish.x, this.raceState.finish.z) < 8) {
        var won = this.raceState.timer > 0;
        var prize = this.raceState.won ? 60 : 150;
        if (won) {
          p.money += prize;
          if (this.standingAdd) this.standingAdd(4);
          this.extras.races[this.raceState.name] = (this.extras.races[this.raceState.name] || 0) + 1;
          this.events.push({ kind: 'money', text: 'RACE / ' + this.raceState.name + ' won — $' + prize + '.', t: this.time });
        }
        this.raceState = null;
      } else if (this.raceState.timer <= 0) {
        this.events.push({ kind: 'notify', text: 'RACE / too slow — ' + this.raceState.name + ' lost.', t: this.time });
        this.raceState = null;
      }
    }
    // Coast Run gates.
    if (this.coastState) {
      this.coastState.timer += dt;
      var gate = this.coastState.gates[this.coastState.gate];
      if (gate && dist(p.x, p.z, gate.x, gate.z) < 8) {
        this.coastState.gate++;
        if (this.coastState.gate >= this.coastState.gates.length) {
          p.money += 350;
          if (!this.bestRace || this.coastState.timer < this.bestRace) this.bestRace = this.coastState.timer;
          this.events.push({ kind: 'money', text: 'COAST RUN / all 9 gates — $350. Best: ' + this.coastState.timer.toFixed(1) + 's.', t: this.time });
          this.coastState = null;
        }
      }
    }
    return out;
  };

  PH.ACTIVITIES = ACTIVITIES;
  PH.TAXI_SPOTS = TAXI_SPOTS;
  PH.SHELL_SPOTS = SHELL_SPOTS;
  PH.TAXI_PASSENGER = { id: 777, color: 0xf8cf69 };
})();
