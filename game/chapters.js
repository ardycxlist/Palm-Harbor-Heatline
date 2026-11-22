// PALM HARBOR: HEATLINE — story chapters + dialog.
// Missions 1-2: CHAPTER 1 "THE PORT SOL FILE". 3-4: CHAPTER 2
// "THE PRICE OF A NAME". 5-6: CHAPTER 3 "HEATLINE". Chapter banners on
// open/close, Kai/Mara/Nico dialog at contract start and finish.
// Written from the design memo, in my own words.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});

  var CHAPTERS = [
    { name: 'THE PORT SOL FILE', missions: [0, 1], close: 'The file is open. Port Sol doesn\'t know it yet.' },
    { name: 'THE PRICE OF A NAME', missions: [2, 3], close: 'Names cost more than money in this city. Yours just went up.' },
    { name: 'HEATLINE', missions: [4, 5], close: 'Heatline. The city never sits still — and neither do you.' }
  ];
  var DIALOG = [
    {
      start: ['Mara: Meet me at the coral phone. Your courier car is parked by the road.', 'Kai: A favor in the sun. Sure. What\'s the catch?', 'Mara: The catch is the ledger. Don\'t drop it.'],
      finish: ['Mara: Ledger\'s in hand. You\'re officially on the payroll, Kai.', 'Kai: Payroll. I like the sound of that.']
    },
    {
      start: ['Nico: I need wheels with a spine. The yellow coupe at 5, -84.', 'Kai: Borrowed. Right. For how long?', 'Nico: Until the garage says otherwise. Bring it here.'],
      finish: ['Nico: She purrs. You drive like you mean it. We\'re good.', 'Kai: Keep the compliments coming, Nico.']
    },
    {
      start: ['Mara: Three guards between you and the drive in Port Sol.', 'Kai: Three guards. One me. Fair odds.', 'Mara: Make it quiet. Or don\'t. Just make it done.'],
      finish: ['Mara: The drive is ours. Port Sol won\'t know what hit it.', 'Kai: They\'ll know. They just won\'t know who.']
    },
    {
      start: ['Mara: A transmitter in the Glass District is painting the whole crew.', 'Kai: So I kill the light and vanish. Classic.', 'Mara: Classic is what keeps you alive. Go dark.'],
      finish: ['Mara: Dark. Clean. They\'ll spend a week looking for a ghost.', 'Kai: Let them look. I\'m already gone.']
    },
    {
      start: ['Nico: Three drops, 180 seconds, one sunset.', 'Kai: 180 seconds? You want a miracle.', 'Nico: I want a driver. You\'re the closest thing.'],
      finish: ['Nico: Three drops, time to spare. You\'re a legend with a deadline.', 'Kai: Legend. Put it on the invoice.']
    },
    {
      start: ['Mara: Last one. Hold the safehouse, push the relay, meet me on the beach.', 'Kai: Last one. Then what?', 'Mara: Then we\'re done. Then you\'re free.'],
      finish: ['Mara: It\'s over. The archive is ours, the city is yours.', 'Kai: Drive into the sunset, Kai. — Yeah. I will.']
    }
  ];

  PH.Game.prototype.chapterProgress = function () {
    return 'CHAPTER ' + (this.chapterOf(this.mission.index) ? CHAPTERS.indexOf(this.chapterOf(this.mission.index)) + 1 : 1) +
      ' — ' + this.mission.index + '/6 CONTRACTS';
  };
  PH.Game.prototype.showChapter = function (kicker, name) {
    this.chapterBanner = { kicker: kicker, name: name, until: this.time + 3.2 };
  };
  PH.Game.prototype.chapterOf = function (missionIndex) {
    for (var i = 0; i < CHAPTERS.length; i++) {
      if (CHAPTERS[i].missions.indexOf(missionIndex) >= 0) return CHAPTERS[i];
    }
    return null;
  };

  var prevStart = PH.Game.prototype.startMission;
  PH.Game.prototype.startMission = function () {
    var out = prevStart.call(this);
    if (out) {
      var ch = this.chapterOf(this.mission.index);
      if (ch && ch.missions[0] === this.mission.index) {
        this.showChapter('CHAPTER ' + (CHAPTERS.indexOf(ch) + 1), ch.name);
      }
      var dlg = DIALOG[this.mission.index];
      if (dlg) {
        for (var i = 0; i < dlg.start.length; i++) {
          this.events.push({ kind: 'dialog', text: dlg.start[i], t: this.time + i * 0.01 });
        }
      }
    }
    return out;
  };

  PH.Game.prototype.onMissionComplete = function (m) {
    var idx = PH.MISSIONS.indexOf(m);
    var dlg = DIALOG[idx];
    if (dlg) {
      for (var i = 0; i < dlg.finish.length; i++) {
        this.events.push({ kind: 'dialog', text: dlg.finish[i], t: this.time + i * 0.01 });
      }
    }
    var ch = this.chapterOf(idx);
    if (ch && ch.missions[ch.missions.length - 1] === idx) {
      this.showChapter(ch.name + ' — COMPLETE', ch.close);
    }
  };

  PH.CHAPTERS = CHAPTERS;
  PH.DIALOG = DIALOG;
})();
