// PALM HARBOR: HEATLINE — Sunstrand parking lot.
// One low residential block (index 87) is demolished into a lot: 10 car bays
// + 3 bike bays. On the first tick the 3 parked bikes and the 5 nearest
// parked cars move into the bays. Written from the design memo.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});
  var clamp = PH.clamp, dist = PH.dist;

  var PARKING = {
    buildingIndex: 87,
    buildingAt: { x: 170, z: 42 },
    pad: { x0: 160, x1: 183, z0: 33, z1: 51 },
    entrance: { z0: 39, z1: 45 },
    // Reference §13: 10 car bays in two rows of 5 (each 3.4x6.6); the
    // north row (z 47.8) faces south and the south row (z 36.2) faces north.
    carBays: [
      { x: 166.7, z: 36.2, yaw: Math.PI / 2 }, { x: 170.1, z: 36.2, yaw: Math.PI / 2 },
      { x: 173.5, z: 36.2, yaw: Math.PI / 2 }, { x: 176.9, z: 36.2, yaw: Math.PI / 2 },
      { x: 180.3, z: 36.2, yaw: Math.PI / 2 },
      { x: 166.7, z: 47.8, yaw: -Math.PI / 2 }, { x: 170.1, z: 47.8, yaw: -Math.PI / 2 },
      { x: 173.5, z: 47.8, yaw: -Math.PI / 2 }, { x: 176.9, z: 47.8, yaw: -Math.PI / 2 },
      { x: 180.3, z: 47.8, yaw: -Math.PI / 2 }
    ],
    bikeBays: [
      { x: 161.9, z: 36.2, yaw: Math.PI / 2 }, { x: 161.9, z: 42, yaw: Math.PI / 2 },
      { x: 161.9, z: 47.8, yaw: Math.PI / 2 }
    ],
    centre: { x: 171.5, z: 42 },
    sign: { x: 181.5, z: 48.4, yaw: Math.PI / 2, label: 'PARKING / SUNSTRAND' }
  };

  PH.Game.prototype.ensureParking = function () {
    if (this.parkingReady) return;
    this.parkingReady = true;
    // Demolish building 87: out of the collision map. If no building carries
    // index 87 in this city, demolish the one nearest the lot instead.
    var b = null;
    for (var i = 0; i < this.city.buildings.length; i++) {
      if (this.city.buildings[i].index === PARKING.buildingIndex) { b = this.city.buildings[i]; break; }
    }
    if (!b) {
      var bd = 1e9;
      for (var j = 0; j < this.city.buildings.length; j++) {
        var cand = this.city.buildings[j];
        var d = dist((cand.minX + cand.maxX) / 2, (cand.minZ + cand.maxZ) / 2, PARKING.buildingAt.x, PARKING.buildingAt.z);
        if (d < bd) { bd = d; b = cand; }
      }
    }
    if (b) {
      b.demolished = true;
      for (var ix = Math.floor(b.minX / 32); ix <= Math.floor(b.maxX / 32); ix++) {
        for (var iz = Math.floor(b.minZ / 32); iz <= Math.floor(b.maxZ / 32); iz++) {
          var k = ix + ',' + iz;
          var list = this.spatial.get(k);
          if (list) {
            var at = list.indexOf(b);
            if (at >= 0) list.splice(at, 1);
          }
        }
      }
    }
    // 3 parked bikes into the bike bays.
    var bikes = [];
    for (var j = 0; j < this.cars.length; j++) {
      var c = this.cars[j];
      if (c.type === 'bike' && c.parked && !c.owned && !c.claimed) bikes.push(c);
    }
    bikes.sort(function (a, b2) { return a.id - b2.id; });
    for (var k = 0; k < Math.min(3, bikes.length); k++) {
      var bay = PARKING.bikeBays[k];
      bikes[k].x = bay.x; bikes[k].z = bay.z; bikes[k].yaw = bay.yaw;
    }
    // 5 nearest parked cars into the car bays.
    var parked = [];
    for (var m = 0; m < this.cars.length; m++) {
      var pc = this.cars[m];
      if (pc.parked && !pc.owned && !pc.claimed && pc.type !== 'bike' && pc.type !== 'boat') {
        parked.push({ car: pc, d: dist(pc.x, pc.z, PARKING.centre.x, PARKING.centre.z) });
      }
    }
    parked.sort(function (a, b2) { return a.d - b2.d; });
    for (var n = 0; n < Math.min(5, parked.length); n++) {
      var cb = PARKING.carBays[n];
      parked[n].car.x = cb.x; parked[n].car.z = cb.z; parked[n].car.yaw = cb.yaw;
    }
  };

  // Runs AFTER the inner updates (motorcycle's ensureBikes included), so the
  // parked bikes already exist when the bays are filled.
  var prevUpdate = PH.Game.prototype.update;
  PH.Game.prototype.update = function (dt, input) {
    var out = prevUpdate.call(this, dt, input);
    this.ensureParking();
    return out;
  };

  PH.PARKING = PARKING;
})();
