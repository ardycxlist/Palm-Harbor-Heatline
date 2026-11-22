// PALM HARBOR: HEATLINE — district standing.
// 6 districts, 0-100, start 10 (Stranger). Tiers unlock fuel/shop/garage
// discounts and faster wanted decay while hiding in a respected district.
// Written from the design memo, in my own words.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});
  var clamp = PH.clamp;

  var DISTRICTS = ['OLD QUARTER', 'GLASS DISTRICT', 'CORAL HEIGHTS', 'LITTLE PALM', 'PORT SOL', 'SUNSTRAND BEACH'];
  var START = 10;
  var TIERS = [
    { name: 'Stranger', min: 0, discount: 0 },
    { name: 'Known', min: 25, discount: 0.05 },
    { name: 'Respected', min: 50, discount: 0.10 },
    { name: 'Family', min: 75, discount: 0.20 }
  ];
  var CONTRACT_GAIN = 15, CASUALTY_LOSS = 4;
  var DECAY_MIN = 50, DECAY_BONUS = 1.25;

  function tierIndex(score) {
    var idx = 0;
    for (var i = 0; i < TIERS.length; i++) if (score >= TIERS[i].min) idx = i;
    return idx;
  }
  function tierOf(score) { return TIERS[tierIndex(score)].name; }

  var standing = {
    DISTRICTS: DISTRICTS, START: START, TIERS: TIERS,
    CONTRACT_GAIN: CONTRACT_GAIN, CASUALTY_LOSS: CASUALTY_LOSS,
    DECAY_MIN: DECAY_MIN, DECAY_BONUS: DECAY_BONUS,
    tierOf: tierOf, tierIndex: tierIndex,
    get: function (game, d) {
      game.ensureStanding();
      return game.extras.standing[d] === undefined ? START : game.extras.standing[d];
    },
    add: function (game, d, n) {
      game.ensureStanding();
      var before = game.extras.standing[d] === undefined ? START : game.extras.standing[d];
      var after = clamp(before + n, 0, 100);
      game.extras.standing[d] = after;
      if (tierIndex(after) > tierIndex(before)) {
        game.events.push({
          kind: 'notify',
          text: 'STANDING / ' + d + ' rises to ' + tierOf(after) + ' (' + Math.round(after) + ').',
          t: game.time
        });
      }
      return after;
    },
    discountAt: function (game, d) {
      return TIERS[tierIndex(standing.get(game, d))].discount;
    },
    decayMult: function (game, d) {
      return standing.get(game, d) >= DECAY_MIN ? DECAY_BONUS : 1;
    },
    ensure: function (game) { game.ensureStanding(); }
  };

  PH.Game.prototype.ensureStanding = function () {
    if (!this.extras.standing) {
      this.extras.standing = {};
      for (var i = 0; i < DISTRICTS.length; i++) this.extras.standing[DISTRICTS[i]] = START;
    }
  };
  PH.Game.prototype.standingAdd = function (n, districtName) {
    var d = districtName || this.districtAt();
    return standing.add(this, d, n);
  };

  // Standing API used by shops, fuel, and the police decay.
  PH.standing = standing;
  PH.standingDiscountAt = function (d) {
    // Called with a district name; needs a game — resolved via the live one.
    if (PH._liveGame) return standing.discountAt(PH._liveGame, d);
    return 0;
  };
  PH.standingDecayMult = function (d) {
    if (PH._liveGame) return standing.decayMult(PH._liveGame, d);
    return 1;
  };
  PH.killWantedStars = function (kills) {
    if (kills >= 12) return 5;
    if (kills >= 9) return 4;
    if (kills >= 6) return 3;
    if (kills >= 3) return 2;
    if (kills >= 1) return 1;
    return 0;
  };

  // Legacy saves without a standing slot start at 10 everywhere on first tick.
  var prevUpdate = PH.Game.prototype.update;
  PH.Game.prototype.update = function (dt, input) {
    var out = prevUpdate.call(this, dt, input);
    this.ensureStanding();
    PH._liveGame = this;
    return out;
  };
  // Make sure the standing discount resolves against this game even when
  // purchase is called before any update tick (e.g. from a test).
  var prevPurchase = PH.Game.prototype.purchase;
  PH.Game.prototype.purchase = function (what) {
    PH._liveGame = this;
    return prevPurchase.call(this, what);
  };
})();
