// PALM HARBOR: HEATLINE — motorcycles.
// Seven traffic riders (sedan/taxi drivers with id % 6 == 2) plus three
// parked bikes taken from the unowned pool. Riding a bike shows the hero
// seated instead of hidden in a cabin. Written from the design memo.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});

  var BIKE = { acc: 27, max: 34, steer: 2.4 };

  PH.Game.prototype.ensureBikes = function () {
    if (this.bikesReady) return;
    this.bikesReady = true;
    // Traffic riders: sedan/taxi cars whose id % 6 == 2 become bikes.
    for (var i = 0; i < this.cars.length; i++) {
      var c = this.cars[i];
      if (c.id >= 2 && c.id % 6 === 2 && c.type === 'sedan') {
        c.type = 'bike';
        c.name = 'BIKE';
        c.cruise = 12 + this.r() * 5;
      }
    }
    // Three parked bikes, taken from the unowned parked pool (indices 2, 7, 12).
    var pool = [];
    for (var j = 0; j < this.cars.length; j++) {
      var p = this.cars[j];
      if (p.parked && !p.owned && !p.claimed && p.type === 'sedan') pool.push(p);
    }
    var picks = [2, 7, 12];
    for (var k = 0; k < picks.length; k++) {
      var car = pool[picks[k]];
      if (car) {
        car.type = 'bike';
        car.name = 'BIKE';
        car.driver = false;
        car.parked = true;
      }
    }
  };

  // Track which bike the player rides, for the seated-hero render.
  var prevToggleCar = PH.Game.prototype.toggleCar;
  PH.Game.prototype.toggleCar = function () {
    var out = prevToggleCar.call(this);
    var car = this.getCar();
    this.player.bike = (car && car.type === 'bike') ? car.id : null;
    return out;
  };

  var prevUpdate = PH.Game.prototype.update;
  PH.Game.prototype.update = function (dt, input) {
    var out = prevUpdate.call(this, dt, input);
    this.ensureBikes();
    return out;
  };

  PH.BIKE = BIKE;
})();
