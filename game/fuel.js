// PALM HARBOR: HEATLINE — fuel.
// Drains only on the driven vehicle, $1 per unit at 4 stations, warnings at
// 25/10/0%, engine dead at 0. A stalled claimed car left far away gets
// towed; the depot returns it with full hp and a 50% tank.
// Written from the design memo, in my own words.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});
  var clamp = PH.clamp, dist = PH.dist;

  var FUEL = {
    rate: 0.065, price: 1, strandDist: 60,
    stations: [
      { id: 'fuel-oq', x: -51, z: 13, label: 'FUEL / OLD QUARTER' },
      { id: 'fuel-gd', x: 13, z: -179, label: 'FUEL / GLASS DISTRICT' },
      { id: 'fuel-ps', x: 141, z: 141, label: 'FUEL / PORT SOL' },
      { id: 'fuel-ss', x: 205, z: 42, label: 'FUEL / SUNSTRAND' }
    ]
  };
  function topSpeed(type) {
    if (type === 'boat') return 16;
    if (type === 'sport') return 38;
    if (type === 'bike') return 34;
    return 29;
  }

  PH.Game.prototype.ensureFuel = function () {
    for (var i = 0; i < this.cars.length; i++) {
      if (this.cars[i].fuel === undefined) this.cars[i].fuel = 100;
    }
  };
  PH.Game.prototype.fuelCut = function (car) {
    if (!car) return;
    if (car.fuel <= 0) {
      car.fuel = 0;
      if (car.id === this.player.vehicle) {
        this.events.push({ kind: 'notify', text: 'OUT OF FUEL / engine dead — fill up at a gas station, or leave it far away and a tow will collect it.', t: this.time });
      }
    }
  };
  PH.Game.prototype.nearestStation = function (maxD) {
    var best = null, bd = maxD || 10;
    for (var i = 0; i < FUEL.stations.length; i++) {
      var s = FUEL.stations[i];
      var d = dist(this.player.x, this.player.z, s.x, s.z);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  };
  PH.Game.prototype.refuel = function () {
    var p = this.player;
    var car = this.getCar();
    if (!car) return false;
    var st = this.nearestStation(10);
    if (!st) return false;
    if (car.fuel >= 100) return false;
    var need = 100 - car.fuel;
    var disc = 0;
    if (PH.standingDiscountAt) disc = PH.standingDiscountAt(PH.district(st.x, st.z));
    var unitPrice = FUEL.price * (1 - disc);
    var cost = Math.round(need * unitPrice);
    if (p.money <= 0) return false;
    if (p.money < cost) {
      var afford = Math.floor(p.money / unitPrice);
      if (afford <= 0) return false;
      car.fuel = Math.min(100, car.fuel + afford);
      p.money -= Math.round(afford * unitPrice);
      this.events.push({ kind: 'money', text: 'Refueled ' + afford + ' units — $' + Math.round(afford * unitPrice) + ' (tank now ' + Math.round(car.fuel) + '%).', t: this.time });
    } else {
      p.money -= cost;
      car.fuel = 100;
      this.events.push({ kind: 'money', text: 'Tank full — $' + cost + '.', t: this.time });
    }
    return true;
  };

  // Refuelling happens through INTERACT at a station.
  var prevInteract = PH.Game.prototype.interact;
  PH.Game.prototype.interact = function () {
    var car = this.getCar();
    if (car && this.nearestStation(10)) {
      if (car.fuel < 100) { this.refuel(); return true; }
    }
    return prevInteract.call(this);
  };
  // Make sure the standing discount resolves against this game even when
  // refuel is called before any update tick (e.g. from a test).
  var prevRefuel = PH.Game.prototype.refuel;
  PH.Game.prototype.refuel = function () {
    PH._liveGame = this;
    return prevRefuel.call(this);
  };

  var prevUpdate = PH.Game.prototype.update;
  PH.Game.prototype.update = function (dt) {
    var out = prevUpdate.call(this, dt);
    this.ensureFuel();
    var car = this.getCar();
    if (car) {
      // Drain: rate * |throttle| * (0.4 + 0.6 * speed/top). Idle = no drain.
      if (Math.abs(car.speed) > 0.1 && car.throttle) {
        var top = topSpeed(car.type);
        var drain = FUEL.rate * Math.abs(car.throttle) * (0.4 + 0.6 * (Math.abs(car.speed) / top)) * dt;
        var before = car.fuel;
        car.fuel = Math.max(0, car.fuel - drain);
        car.warned25 = car.warned25 || false;
        car.warned10 = car.warned10 || false;
        if (before > 25 && car.fuel <= 25 && !car.warned25) {
          car.warned25 = true;
          this.events.push({ kind: 'notify', text: 'FUEL / 25% left — find a gas station.', t: this.time });
        }
        if (before > 10 && car.fuel <= 10 && !car.warned10) {
          car.warned10 = true;
          this.events.push({ kind: 'notify', text: 'FUEL CRITICAL / 10% left.', t: this.time });
        }
        if (car.fuel <= 0) this.fuelCut(car);
      }
      // A stalled claimed car left far away gets collected by a tow.
      if (car.claimed && car.fuel <= 0 && car.id !== this.player.vehicle) {
        if (dist(car.x, car.z, this.player.x, this.player.z) > 60) {
          if (this.emergency) this.emergency.reportTow(car, 'empty fuel');
        }
      }
    }
    return out;
  };

  PH.FUEL = FUEL;
})();
