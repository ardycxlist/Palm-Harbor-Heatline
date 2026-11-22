// PALM HARBOR: HEATLINE — night rhythm.
// At night, cars with id % 10 in {0,4,8} creep to the kerb (offset 6.8) and
// park until morning; night traffic cruises at 0.9x. Pedestrians stay out.
// Written from the design memo, in my own words.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});

  var RHYTHM = {
    nightCruise: 0.9, parkOffset: 6.8, laneOffset: 3.4,
    // Id rule: cars whose id ends in 0, 4 or 8 park at the kerb at night.
    idRule: function (id) { return [0, 4, 8].indexOf(id % 10) >= 0; },
    phaseOf: function (clock) { return (clock >= 6 && clock < 18.5) ? 'day' : 'night'; }
  };

  function nearestRoad(v) {
    var best = PH.ROADS[0];
    for (var i = 0; i < PH.ROADS.length; i++) {
      if (Math.abs(PH.ROADS[i] - v) < Math.abs(best - v)) best = PH.ROADS[i];
    }
    return best;
  }
  function distToJunction(car) {
    // Distance along the driving axis to the nearest crossroad.
    var along = Math.abs(Math.cos(car.yaw)) > 0.7 ? car.x : car.z;
    var best = 1e9;
    for (var i = 0; i < PH.ROADS.length; i++) {
      best = Math.min(best, Math.abs(PH.ROADS[i] - along));
    }
    return best;
  }

  PH.Game.prototype.ensureRhythm = function () {
    if (this.rhythmReady) return;
    this.rhythmReady = true;
  };
  PH.Game.prototype.rhythmTargetMul = function (car) {
    if (RHYTHM.phaseOf(this.clock) === 'night') return RHYTHM.nightCruise;
    return 1;
  };
  PH.Game.prototype.rhythmParkedCount = function () {
    var n = 0;
    for (var i = 0; i < this.cars.length; i++) if (this.cars[i].rhythmParked) n++;
    return n;
  };

  var prevUpdate = PH.Game.prototype.update;
  PH.Game.prototype.update = function (dt, input) {
    var out = prevUpdate.call(this, dt, input);
    this.ensureRhythm();
    var night = RHYTHM.phaseOf(this.clock) === 'night';
    for (var i = 0; i < this.cars.length; i++) {
      var c = this.cars[i];
      if (c.type === 'boat') continue;
      if (c.owned || c.claimed || c.missionCar) continue;
      if (c.id === this.player.vehicle) continue;
      if (!RHYTHM.idRule(c.id)) continue;
      if (night) {
        if (!c.driver && c.parked && c.rhythmParked) continue; // already parked for the night
        if (c.driver) {
          // Creep sideways to the kerb offset while rolling forward slowly,
          // then stop — clear of junctions.
          var horizontal = Math.abs(Math.cos(c.yaw)) > 0.7;
          var road = horizontal ? nearestRoad(c.z) : nearestRoad(c.x);
          var off = horizontal ? (c.z - road) : (c.x - road);
          var want = off >= 0 ? RHYTHM.parkOffset : -RHYTHM.parkOffset;
          var cur = horizontal ? c.z : c.x;
          var target = road + want;
          var step = 2.4 * dt;
          if (horizontal) c.x += Math.cos(c.yaw) * 2.4 * dt;
          else c.z += Math.sin(c.yaw) * 2.4 * dt;
          if (Math.abs(target - cur) > step) {
            if (horizontal) c.z += (target > cur ? step : -step);
            else c.x += (target > cur ? step : -step);
          } else {
            if (horizontal) c.z = target; else c.x = target;
            if (distToJunction(c) > 13) {
              c.driver = false; c.parked = true; c.rhythmParked = true; c.speed = 0;
            }
          }
        }
      } else if (c.rhythmParked) {
        // Morning: back to the lane and back to work.
        c.rhythmParked = false;
        c.parked = false;
        c.driver = true;
        var h = Math.abs(Math.cos(c.yaw)) > 0.7;
        var r2 = h ? nearestRoad(c.z) : nearestRoad(c.x);
        if (h) c.z = r2 + RHYTHM.laneOffset; else c.x = r2 + RHYTHM.laneOffset;
      }
    }
    return out;
  };

  PH.RHYTHM = RHYTHM;
})();
