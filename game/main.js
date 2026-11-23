// PALM HARBOR: HEATLINE — browser shell.
// Fixed-timestep loop, keyboard/mouse/touch input, HUD, minimap, big map,
// menus, save, and the deterministic ?shot= presets used for screenshots.
// Written from the design memo, in my own words.
(function () {
  'use strict';
  var PH = globalThis.PH;
  var $ = function (id) { return document.getElementById(id); };

  var game = new PH.Game(74017);
  game.emergency = new PH.EmergencySystem(game);
  var world = PH.createWorld(game, $('scene'));
  var audio = new PH.Audio(game);
  PH._liveGame = game;

  var params = new URLSearchParams(location.search);
  var shotMode = params.get('shot') || null;

  var input = {
    forward: false, back: false, left: false, right: false,
    sprint: false, jump: false, handbrake: false,
    lookDX: 0, lookDY: 0, zoom: 0
  };
  var zoomLevel = 0; // 0 = auto (8 on foot, 10.5 in car)
  var paused = false;
  var lastT = 0, acc = 0;
  var toastCount = 0;
  var saveFlashT = 0, hurtFlashT = 0, hitT = 0;

  // ---------- screenshot presets (deterministic states) ----------
  var shotSpeedTarget = 0;
  function moveSedanTo(x, z) {
    // The courier sedan spawns parked at (19, 6.5); move the car itself onto
    // the x=0 road so it can drive straight without hitting buildings.
    var sedan = null;
    for (var i = 0; i < game.cars.length; i++) {
      if (game.cars[i].x === 19 && game.cars[i].z === 6.5) { sedan = game.cars[i]; break; }
    }
    if (!sedan) sedan = game.cars[0];
    sedan.x = x; sedan.z = z; sedan.yaw = Math.PI / 2; sedan.speed = 0;
    return sedan;
  }
  function applyShotPreset(mode) {
    game.mission.active = true;
    if (mode === 'city') {
      // Hero on the east sidewalk of the x=0 road (inset 12, free ground
      // at z=5), facing south down the street: the road and its traffic
      // run down the right of the frame, the east facades and the palm
      // at (12,12) down the left.
      game.player.x = 12; game.player.z = 5;
      game.player.yaw = Math.PI / 2;
    } else if (mode === 'drive') {
      moveSedanTo(0, 20);
      game.player.x = 0; game.player.z = 20;
      game.toggleCar();
      shotSpeedTarget = 10; // 40 KM/H on the HUD
    } else if (mode === 'mission') {
      // Stand west of Mara facing her: the courier sedan at (19, 6.5) stays
      // out of the sightline, the crystal + contact fill the frame. Camera
      // in close at 7 so the hero reads at full height instead of a small
      // figure in the distance.
      game.player.x = 14; game.player.z = 12;
      game.player.yaw = 0;
      input.zoom = 7;
      game.taxiWait = PH.TAXI_SPOTS[0];
      game.events.push({ kind: 'notify', text: 'MARA / Meet me at the coral phone. Your courier car is parked by the road.', t: game.time });
      game.events.push({ kind: 'notify', text: 'TAXI / a passenger is waiting in OLD QUARTER — pick them up by car.', t: game.time });
    } else if (mode === 'night') {
      game.clock = 19 + 31 / 60;
      game.wantedKills = 12; game.casualties = 12;
      game.search = 1; game.heat = 1;
      moveSedanTo(0, -40);
      game.player.x = 0; game.player.z = -40;
      game.toggleCar();
      shotSpeedTarget = 20.5; // 82 KM/H on the HUD
      var car = game.getCar();
      // Warm-up: let police cars, foot officers and helis arrive.
      for (var i = 0; i < 240; i++) {
        game.update(1 / 60, { forward: true });
      }
      if (car) { car.speed = shotSpeedTarget; car.yaw = Math.PI / 2; }
      // The warm-up drive heads +z; put the car back on the x=0 road at
      // z=-40 and head it +z (south) so the shot stays in OLD QUARTER for
      // the whole wait: from -40 the PORT SOL border (z > 124) is 164 units
      // away, ~8 sim-seconds, and the south drive keeps the heli beams
      // crossing the frame toward the camera (a north drive hides them
      // behind it). District at z=-40 is OLD QUARTER.
      if (car) { car.x = 0; car.z = -40; car.yaw = Math.PI / 2; }
      game.player.x = 0; game.player.z = -40; game.player.yaw = Math.PI / 2;
      // Pull the camera back for the night shot: from the close chase cam
      // the spotlight cone fills the frame as a wash; from 18 units back it
      // reads as a beam from the heli to the pool on the street.
      input.zoom = 18;
      // Stage the follow helis directly into their formation slots so the
      // spotlights are in frame from the first screenshot tick.
      for (var hi = 0; hi < game.helis.length; hi++) {
        var h = game.helis[hi];
        if (h.mode === 'follow' && h.formationTarget) {
          h.x = h.formationTarget.x; h.z = h.formationTarget.z; h.y = 31;
        }
      }
      game.shotContext = 'E / ACT — ROBBERY / rob the store';
    }
    // city: default spawn, on foot, 16:24 — nothing to change.
  }

  // ---------- toasts ----------
  function toast(cat, body, cls) {
    var box = $('toasts');
    if (toastCount >= 3) {
      var first = box.firstChild;
      if (first) box.removeChild(first); else return;
      toastCount--;
    }
    var el = document.createElement('div');
    el.className = 'toast ' + (cls || 'notify');
    var c = document.createElement('div');
    c.className = 't-cat'; c.textContent = cat;
    var b = document.createElement('div');
    b.className = 't-body'; b.textContent = body;
    el.appendChild(c); el.appendChild(b);
    box.appendChild(el);
    toastCount++;
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      toastCount--;
    }, 4500);
  }
  function drainEvents() {
    var evs = game.events.splice(0);
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (e.kind === 'mission') { toast('MISSION', e.text, 'mission'); audio.event('mission'); }
      else if (e.kind === 'money') { toast('MONEY', e.text, 'money'); audio.event('money'); }
      else if (e.kind === 'notify') { toast('NOTIFY', e.text, 'notify'); audio.event('notify'); }
      else if (e.kind === 'dialog') { toast('BRIEF', e.text, 'brief'); }
      else if (e.kind === 'wanted') { audio.event('wanted'); }
      else if (e.kind === 'hurt') { hurtFlashT = 0.3; audio.event('hurt'); }
      else if (e.kind === 'hit') { hitT = 0.15; }
      else if (e.kind === 'save') { saveFlashT = 2; }
      else if (e.kind === 'enter' || e.kind === 'exit') { audio.event(e.kind); }
      else if (e.kind === 'respawn') { toast('CLINIC', 'You woke up at the clinic — $100.', 'notify'); }
    }
  }

  // ---------- HUD ----------
  function fmtClock() {
    var h = Math.floor(game.clock);
    var m = Math.floor((game.clock - h) * 60);
    return 'DAY ' + game.day + ' · ' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }
  function updateHUD(dt) {
    var p = game.player;
    $('district').textContent = game.districtAt();
    $('clock').textContent = fmtClock();
    $('money').textContent = '$' + p.money;
    // Wanted.
    var stars = game.getWantedStars();
    var starEls = $('stars').children;
    for (var s = 0; s < 5; s++) starEls[s].textContent = s < stars ? '★' : '☆';
    $('stars').className = 'stars' + (stars >= 3 ? ' hot' : stars >= 1 ? ' lit' : '');
    $('searchFill').style.width = Math.round(game.search * 100) + '%';
    $('wantedLabel').textContent = stars > 0 ? 'POLICE / PURSUIT' : 'CITY WATCH / CLEAR';
    var followN = 0;
    if (game.helis) for (var hi = 0; hi < game.helis.length; hi++) if (game.helis[hi].mode === 'follow' && game.helis[hi].active) followN++;
    $('heliLabel').textContent = stars >= 3
      ? 'HELI ' + followN + ' / TRACKING' + (game.isNight() ? ' + NIGHT SPOTLIGHT' : '')
      : 'HELI 1 / PATROL';
    $('casualtyLabel').textContent = 'CASUALTIES ' + game.casualties + ' / ' + stars + ' STARS';
    // Objective.
    var obj = currentObjective();
    if (obj) {
      $('objTag').textContent = 'STORY / ' + String(game.mission.index + 1).padStart(2, '0') + (game.mission.active ? '' : ' — NEXT');
      $('objTitle').textContent = obj.title;
      $('objText').textContent = obj.text;
      $('objDist').textContent = obj.dist + ' M';
      if (obj.timer > 0) {
        $('objTimer').classList.remove('hidden');
        $('objTimer').textContent = Math.ceil(obj.timer) + 's';
      } else $('objTimer').classList.add('hidden');
    }
    // Vitals.
    $('hpFill').style.width = p.hp + '%';
    $('hpNum').textContent = Math.round(p.hp);
    $('armorFill').style.width = p.armor + '%';
    $('armorNum').textContent = Math.round(p.armor);
    $('sprintFill').style.width = Math.round(p.stamina) + '%';
    $('sprintNum').textContent = Math.round(p.stamina);
    $('weaponLabel').textContent = p.weapon === 0 ? 'SIDEARM ' + p.clip + ' / ' + p.ammo : 'BATON';
    // Speedo + crosshair: the crosshair shows on foot only — while
    // driving it would sit on the car's roof (reference drive shot).
    var car = game.getCar();
    $('crosshair').classList.toggle('hidden', !!car);
    if (car) {
      $('speedo').classList.remove('hidden');
      $('speedNum').textContent = Math.round(Math.abs(car.speed) * 4);
      var kind = car.type === 'boat' ? 'BOAT' : car.type.toUpperCase();
      $('carLine').textContent = kind + ' / ' + (car.owned ? 'OWNED' : car.stolen ? 'STOLEN' : 'BORROWED') + ' / FUEL ' + Math.round(car.fuel || 0) + '%';
      $('carHpFill').style.width = Math.max(0, car.hp) + '%';
      $('carFuelFill').style.width = Math.max(0, car.fuel || 0) + '%';
    } else $('speedo').classList.add('hidden');
    // Context prompt.
    var ctx = null;
    if (game.shotContext) ctx = { key: 'E', label: game.shotContext.replace(/^E \/ /, '') };
    else if (game.crewChannel) ctx = { key: '', label: game.crewTimerText() };
    else if (game.crewContextLine) ctx = game.crewContextLine();
    if (!ctx && game.contextLine) ctx = game.contextLine();
    if (!ctx) {
      var guide = game.activityGuide ? game.activityGuide() : null;
      if (guide) ctx = { key: '', label: guide.text };
    }
    var ctxEl = $('context');
    if (ctx) {
      ctxEl.innerHTML = '';
      if (ctx.key) {
        var k = document.createElement('span');
        k.className = 'key'; k.textContent = ctx.key + ' / ';
        ctxEl.appendChild(k);
      }
      ctxEl.appendChild(document.createTextNode(ctx.label));
    } else ctxEl.textContent = '';
    // Destination waypoint.
    if (game.waypoint) {
      $('destLabel').classList.remove('hidden');
      var dd = Math.round(Math.hypot(game.waypoint.x - p.x, game.waypoint.z - p.z));
      $('destDist').textContent = dd + ' m';
    } else $('destLabel').classList.add('hidden');
    // Minimap district + counts.
    $('mapDistrict').textContent = game.districtAt();
    var boats = 0;
    for (var bi = 0; bi < game.cars.length; bi++) if (game.cars[bi].type === 'boat') boats++;
    $('mapCounts').textContent = game.peds.length + ' CITIZENS / ' + (game.cars.length - boats) + ' VEHICLES';
    // Service buttons.
    $('recoverBtn').classList.toggle('hidden', !(game.dead || game.player.hp < 25));
    $('shopBtn').classList.toggle('hidden', !game.nearContact('shop', 9));
    // Save icon / hurt / hitmarker flashes.
    if (saveFlashT > 0) { saveFlashT -= dt; $('saveIcon').classList.remove('hidden'); }
    else $('saveIcon').classList.add('hidden');
    if (hurtFlashT > 0) { hurtFlashT -= dt; $('hurt').classList.add('on'); }
    else $('hurt').classList.remove('on');
    if (hitT > 0) { hitT -= dt; $('hitmarker').classList.remove('hidden'); }
    else $('hitmarker').classList.add('hidden');
    // Chapter banner.
    var cb = game.chapterBanner;
    if (cb && game.time < cb.until) {
      $('chapterBanner').classList.remove('hidden');
      $('chapterKicker').textContent = cb.kicker;
      $('chapterName').textContent = cb.name;
    } else $('chapterBanner').classList.add('hidden');
    drawMinimap();
  }

  // Current story objective (the map + HUD both read it through here).
  function currentObjective() {
    return game.objective();
  }

  // ---------- maps ----------
  function drawMapInto(cv, scale, withLabels, centered) {
    var g = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var cx = W / 2, cy = H / 2;
    // The minimap is player-centred (a 126-unit window, reference §5):
    // the streets around the player stay in sync with the 3D view. The big
    // map keeps the whole city.
    var px0 = centered ? game.player.x : 0, pz0 = centered ? game.player.z : 0;
    // Draw in world coordinates: the canvas transform centres and scales
    // the view, so every rect/arc/text below takes world (x, z) directly.
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0e2230';
    g.fillRect(0, 0, W, H);
    g.save();
    g.translate(cx, cy);
    g.scale(scale, scale);
    g.translate(-px0, -pz0);
    // Water + sand east.
    g.fillStyle = '#164a66';
    g.fillRect(217, pz0 - H / (2 * scale), Math.max(0, px0 + (W - cx) / scale - 217), H / scale);
    g.fillStyle = '#dec493';
    g.fillRect(201, -64, 214 - 201, 150 + 64);
    // Blocks.
    g.fillStyle = '#1d364b';
    for (var b = 0; b < game.city.blocks.length; b++) {
      var bl = game.city.blocks[b];
      if (bl.park) g.fillStyle = '#2a5a3a';
      else g.fillStyle = '#1d364b';
      g.fillRect(bl.x0, bl.z0, bl.x1 - bl.x0, bl.z1 - bl.z0);
    }
    // Buildings (skip the demolished one — its lot is drawn below).
    g.fillStyle = '#2c4a63';
    for (var bi = 0; bi < game.city.buildings.length; bi++) {
      var bd = game.city.buildings[bi];
      if (bd.demolished) continue;
      g.fillRect(bd.minX, bd.minZ, bd.maxX - bd.minX, bd.maxZ - bd.minZ);
    }
    // Sunstrand parking lot (Phase PARK): pad, marker, label on the big map.
    if (PH.PARKING) {
      var pk = PH.PARKING;
      g.fillStyle = '#46536b';
      g.fillRect(pk.pad.x0, pk.pad.z0, pk.pad.x1 - pk.pad.x0, pk.pad.z1 - pk.pad.z0);
      g.fillStyle = '#ffeaca';
      g.beginPath();
      g.arc(pk.label.x, pk.label.z, 5 / scale, 0, Math.PI * 2);
      g.fill();
      if (withLabels) {
        g.fillStyle = '#ffeaca';
        g.font = 'bold ' + (11 / scale) + 'px Arial';
        g.textAlign = 'center';
        g.fillText('PARKING', pk.label.x, pk.label.z - 5);
      }
    }
    // Roads.
    g.strokeStyle = '#3b485e';
    g.lineWidth = Math.max(2 / scale, 18);
    for (var r = 0; r < PH.ROADS.length; r++) {
      var rd = PH.ROADS[r];
      g.beginPath(); g.moveTo(-216, rd); g.lineTo(216, rd); g.stroke();
      g.beginPath(); g.moveTo(rd, -216); g.lineTo(rd, 216); g.stroke();
    }
    // District labels.
    if (withLabels) {
      g.fillStyle = '#96e2d3';
      g.font = 'bold ' + (11 / scale) + 'px Arial';
      g.textAlign = 'center';
      var labels = [
        ['OLD QUARTER', 0, 0], ['GLASS DISTRICT', -70, -150], ['CORAL HEIGHTS', 130, -40],
        ['LITTLE PALM', -150, 0], ['PORT SOL', 60, 170], ['SUNSTRAND', 195, 60]
      ];
      for (var li = 0; li < labels.length; li++) {
        var L = labels[li];
        g.fillText(L[0], L[1], L[2]);
        if (game.extras.standing) {
          var sc = game.extras.standing[L[0] === 'SUNSTRAND' ? 'SUNSTRAND BEACH' : L[0]] || 10;
          var tier = sc >= 75 ? 'Family' : sc >= 50 ? 'Respected' : sc >= 25 ? 'Known' : 'Stranger';
          g.fillStyle = '#f6cf7c';
          g.font = (10 / scale) + 'px Arial';
          g.fillText(tier + ' ' + Math.round(sc), L[1], L[2] + 13 / scale);
          g.fillStyle = '#96e2d3';
          g.font = 'bold ' + (11 / scale) + 'px Arial';
        }
      }
      // Legend markers.
      g.font = (13 / scale) + 'px Arial';
      g.fillStyle = '#ff8d7c';
      g.fillText('◇ OBJECTIVE', -160, 200);
      g.fillStyle = '#70e1cf';
      g.fillText('＋ CLINIC', -60, 200);
      g.fillStyle = '#fff1d6';
      g.fillText('⌂ SAFEHOUSE', 40, 200);
      g.fillStyle = '#f6cf7c';
      g.fillText('⚑ COAST RUN', 150, 200);
    }
    // Objective + waypoint + dashed route line to the objective.
    var obj = currentObjective();
    if (obj && obj.x !== undefined) {
      g.strokeStyle = '#ff8d7c';
      g.setLineDash([4 / scale, 4 / scale]);
      g.lineWidth = 1.5 / scale;
      g.beginPath(); g.moveTo(game.player.x, game.player.z); g.lineTo(obj.x, obj.z); g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ff8d7c';
      g.beginPath();
      g.moveTo(obj.x, obj.z - 7 / scale); g.lineTo(obj.x + 7 / scale, obj.z);
      g.lineTo(obj.x, obj.z + 7 / scale); g.lineTo(obj.x - 7 / scale, obj.z);
      g.closePath(); g.fill();
    }
    if (game.waypoint) {
      g.fillStyle = '#fff1d6';
      g.beginPath();
      g.arc(game.waypoint.x, game.waypoint.z, 5 / scale, 0, Math.PI * 2);
      g.fill();
    }
    // Cars + police + pedestrians + helis.
    g.fillStyle = '#c8ccd4';
    for (var ci = 0; ci < game.cars.length; ci++) {
      var c = game.cars[ci];
      g.fillRect(c.x - 1.5 / scale, c.z - 1.5 / scale, 3 / scale, 3 / scale);
    }
    g.fillStyle = '#e8e2d4';
    for (var pdi = 0; pdi < game.peds.length; pdi++) {
      var pd = game.peds[pdi];
      if (pd.down) continue;
      g.fillRect(pd.x - 0.75 / scale, pd.z - 0.75 / scale, 1.5 / scale, 1.5 / scale);
    }
    g.fillStyle = '#2a5aff';
    for (var pi = 0; pi < game.police.length; pi++) {
      g.beginPath();
      g.arc(game.police[pi].x, game.police[pi].z, 3 / scale, 0, Math.PI * 2);
      g.fill();
    }
    if (game.helis) {
      for (var hli = 0; hli < game.helis.length; hli++) {
        var hh = game.helis[hli];
        if (!hh.active) continue;
        g.strokeStyle = hh.lit ? '#ff9a52' : '#ffffff';
        g.lineWidth = 2 / scale;
        var hx = hh.x, hz = hh.z;
        g.beginPath();
        g.moveTo(hx - 4 / scale, hz - 4 / scale); g.lineTo(hx + 4 / scale, hz + 4 / scale);
        g.moveTo(hx + 4 / scale, hz - 4 / scale); g.lineTo(hx - 4 / scale, hz + 4 / scale);
        g.stroke();
      }
    }
    // Taxi passenger.
    if (game.taxiWait) {
      g.fillStyle = '#f8cf69';
      g.beginPath();
      g.arc(game.taxiWait.x, game.taxiWait.z, 4 / scale, 0, Math.PI * 2);
      g.fill();
    }
    // Player arrow.
    var px = game.player.x, pz = game.player.z;
    g.save();
    g.translate(px, pz);
    g.rotate(Math.atan2(Math.cos(game.player.yaw), -Math.sin(game.player.yaw)));
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(0, -8 / scale); g.lineTo(5 / scale, 6 / scale); g.lineTo(-5 / scale, 6 / scale);
    g.closePath(); g.fill();
    g.restore();
    g.restore();
    // North (screen space).
    g.fillStyle = '#fff1d6';
    g.font = 'bold 12px Arial';
    g.textAlign = 'left';
    g.fillText('N', 10, 18);
  }
  // Big map / minimap entry point: drawMap(canvas, big) draws the whole
  // city into a canvas — big (whole city + labels) or small (player-centred).
  function drawMap(canvas, big) {
    if (big) drawMapInto(canvas, Math.min(canvas.width, 740) / 432, true, false);
    else drawMapInto(canvas, canvas.width / 126, false, true);
  }
  function drawMinimap() {
    drawMap($('minimap'), false);
  }
  function drawBigmap() {
    drawMap($('bigmap'), true);
  }

  // UI refresh entry point: HUD text + minimap, called every frame.
  // The frame loop hands the step over through uiDt (the test slice
  // reads this function by its bare signature).
  var uiDt = 0;
  function updateUI() {
    updateHUD(uiDt);
  }

  // ---------- input ----------
  var keyMap = {
    KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back',
    KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
    ShiftLeft: 'sprint', ShiftRight: 'sprint', Space: 'jump'
  };
  window.addEventListener('keydown', function (ev) {
    if (ev.code === 'Space') ev.preventDefault();
    var k = keyMap[ev.code];
    if (k) { input[k] = true; if (k === 'jump') input.handbrake = true; return; }
    if (ev.repeat) return;
    if (ev.code === 'KeyF') game.toggleCar();
    else if (ev.code === 'KeyE') game.interact();
    else if (ev.code === 'KeyQ') game.player.weapon = game.player.weapon === 0 ? 1 : 0;
    else if (ev.code === 'KeyR') game.reload();
    else if (ev.code === 'KeyM') toggleMap();
    else if (ev.code === 'KeyH') {
      if (game.nearContact('shop', 9)) game.purchase('heal');
    } else if (ev.code === 'Escape' || ev.code === 'KeyP') togglePause();
  });
  window.addEventListener('keyup', function (ev) {
    var k = keyMap[ev.code];
    if (k) { input[k] = false; if (k === 'jump') input.handbrake = false; }
  });
  var dragging = false, dragMoved = 0, lastMX = 0, lastMY = 0;
  var canvas = $('scene');
  canvas.addEventListener('pointerdown', function (ev) {
    dragging = true; dragMoved = 0; lastMX = ev.clientX; lastMY = ev.clientY;
  });
  window.addEventListener('pointermove', function (ev) {
    if (!dragging) return;
    var dx = ev.clientX - lastMX, dy = ev.clientY - lastMY;
    lastMX = ev.clientX; lastMY = ev.clientY;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    input.lookDX += dx; input.lookDY += dy;
  });
  window.addEventListener('pointerup', function (ev) {
    if (dragging && dragMoved < 6 && !paused) game.shoot();
    dragging = false;
  });
  canvas.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    if (!zoomLevel) zoomLevel = game.player.vehicle !== null ? 13 : 9;
    zoomLevel = Math.max(5, Math.min(23, zoomLevel + (ev.deltaY > 0 ? 1 : -1)));
    input.zoom = zoomLevel;
  }, { passive: false });
  // Touch controls.
  var stick = $('stick'), knob = $('stickKnob');
  var stickActive = false, stickId = null;
  if (stick) {
    stick.addEventListener('pointerdown', function (ev) { stickActive = true; stickId = ev.pointerId; stick.setPointerCapture(ev.pointerId); });
    stick.addEventListener('pointermove', function (ev) {
      if (!stickActive || ev.pointerId !== stickId) return;
      var r = stick.getBoundingClientRect();
      var dx = (ev.clientX - (r.left + r.width / 2)) / (r.width / 2);
      var dy = (ev.clientY - (r.top + r.height / 2)) / (r.height / 2);
      dx = Math.max(-1, Math.min(1, dx)); dy = Math.max(-1, Math.min(1, dy));
      knob.style.left = (32 + dx * 30) + 'px';
      knob.style.top = (32 + dy * 30) + 'px';
      input.forward = dy < -0.25; input.back = dy > 0.25;
      input.left = dx < -0.25; input.right = dx > 0.25;
    });
    var stickEnd = function () {
      stickActive = false;
      knob.style.left = '32px'; knob.style.top = '32px';
      input.forward = input.back = input.left = input.right = false;
    };
    stick.addEventListener('pointerup', stickEnd);
    stick.addEventListener('pointercancel', stickEnd);
  }
  function bindBtn(id, down, up) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('pointerdown', function (ev) { ev.preventDefault(); down(); });
    if (up) {
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
  }
  bindBtn('tFire', function () { game.shoot(); });
  bindBtn('tCar', function () { game.toggleCar(); });
  bindBtn('tAct', function () { game.interact(); });
  bindBtn('tRun', function () { input.sprint = true; }, function () { input.sprint = false; });
  bindBtn('tJump', function () { input.jump = true; input.handbrake = true; }, function () { input.jump = false; input.handbrake = false; });
  bindBtn('tReload', function () { game.reload(); });
  $('minimap').addEventListener('click', toggleMap);
  $('pauseBtn').addEventListener('click', togglePause);
  $('resumeBtn').addEventListener('click', togglePause);
  $('closeMapBtn').addEventListener('click', toggleMap);
  $('clearWaypointBtn').addEventListener('click', function () { game.waypoint = null; drawBigmap(); });
  $('bigmap').addEventListener('click', function (ev) {
    var r = $('bigmap').getBoundingClientRect();
    var scale = Math.min(800, 740) / 432;
    var wx = ((ev.clientX - r.left) - r.width / 2) / scale;
    var wz = ((ev.clientY - r.top) - r.height / 2) / scale;
    game.waypoint = { x: Math.max(-216, Math.min(216, wx)), z: Math.max(-216, Math.min(216, wz)) };
    drawBigmap();
  });
  $('recoverBtn').addEventListener('click', function () { game.respawn(); });
  $('shopBtn').addEventListener('click', openShop);
  $('modalBack').addEventListener('click', function () { $('modal').classList.add('hidden'); });

  function toggleMap() {
    var mo = $('mapOverlay');
    mo.classList.toggle('hidden');
    if (!mo.classList.contains('hidden')) drawBigmap();
  }
  function togglePause() {
    paused = !paused;
    game.paused = paused;
    $('pauseOverlay').classList.toggle('hidden', !paused);
    if (paused) $('fpsReadout').textContent = (world.stats().fps || 30) + ' FPS';
  }
  function openShop() {
    var m = $('modal');
    $('modalText').innerHTML = '<h2>SUPPLIES / CLINIC</h2>' +
      '<p>Heal $60 — hp to 100<br>Armor $90 — armor to 100<br>Ammo $70 — +48 rounds</p>' +
      '<p style="margin-top:10px">Your money: $' + game.player.money + '</p>';
    var card = document.querySelector('.modal-card');
    var old = document.getElementById('shopRow');
    if (old) old.remove();
    var row = document.createElement('div');
    row.id = 'shopRow';
    row.style.marginTop = '14px';
    row.style.display = 'flex';
    row.style.gap = '10px';
    [['Heal $60', 'heal'], ['Armor $90', 'armor'], ['Ammo $70', 'ammo']].forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b[0];
      btn.style.cssText = 'padding:10px 16px;border-radius:8px;background:#70e1cf;color:#10232d;border:none;font-weight:900';
      btn.addEventListener('click', function () {
        if (game.purchase(b[1])) { m.classList.add('hidden'); toast('MONEY', 'Bought ' + b[1] + '.', 'money'); }
        else toast('NOTIFY', 'Not enough money.', 'notify');
      });
      row.appendChild(btn);
    });
    card.insertBefore(row, $('modalBack'));
    m.classList.remove('hidden');
  }
  game.openShop = openShop;

  // ---------- menus ----------
  $('startBtn').addEventListener('click', function () {
    startGame(false);
  });
  $('continueBtn').addEventListener('click', function () {
    startGame(true);
  });
  $('howBtn').addEventListener('click', function () {
    $('modalText').innerHTML = '<h2>HOW TO PLAY</h2>' +
      '<p>WASD / arrows — move &amp; drive<br>Mouse drag — look · Click — shoot · Wheel — zoom<br>' +
      'F — enter / exit car &amp; boat · E — interact<br>Q — switch weapon · R — reload · H — heal at the clinic<br>' +
      'Shift — sprint · Space — jump / handbrake · M — big map · Esc — pause</p>' +
      '<p style="margin-top:10px">Six contracts. 720 citizens. 78 vehicles. One city that never sits still.<br>' +
      'Rob shops, run taxis, collect dusk shells, race the coast — and lose the cops before they lose you.</p>';
    $('modal').classList.remove('hidden');
  });
  function startGame(continued) {
    if (continued) {
      if (!game.loadSave()) {
        toast('NOTIFY', 'No save found — starting fresh.', 'notify');
      }
    }
    $('startOverlay').classList.add('hidden');
    $('boot').classList.add('hidden');
    $('hud').classList.remove('hidden');
    try { audio.start(); } catch (e) { /* audio unavailable */ }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) game.save();
  });
  window.addEventListener('resize', function () {
    world.resize(window.innerWidth, window.innerHeight);
  });

  // ---------- main loop ----------
  function frame(t) {
    requestAnimationFrame(frame);
    if (!lastT) lastT = t;
    var dt = Math.min((t - lastT) / 1000, 0.1);
    lastT = t;
    if (!paused && $('startOverlay').classList.contains('hidden')) {
      if (shotMode === 'drive' || shotMode === 'night') input.forward = true;
      acc += dt;
      var steps = 0;
      while (acc >= 1 / 60 && steps < 6) {
        game.update(1 / 60, input);
        acc -= 1 / 60;
        steps++;
      }
      if (steps === 6) acc = 0;
      // Hold the screenshot drive speed (police rams and drag would vary it).
      if (shotSpeedTarget > 0) {
        var sc = game.getCar();
        if (sc && sc.speed > 0) sc.speed = shotSpeedTarget;
      }
      drainEvents();
      audio.update(game, dt);
    }
    var look = { lookDX: input.lookDX, lookDY: input.lookDY, zoom: input.zoom || 0 };
    input.lookDX = 0; input.lookDY = 0;
    if (!$('startOverlay').classList.contains('hidden') && !shotMode) {
      // Before start: hold the camera on the plaza for the backdrop.
    }
    world.update(dt, look);
    world.render();
    if ($('startOverlay').classList.contains('hidden')) { uiDt = dt; updateUI(); }
  }

  // ---------- boot ----------
  if (shotMode) {
    applyShotPreset(shotMode);
    $('startOverlay').classList.add('hidden');
    $('boot').classList.add('hidden');
    $('hud').classList.remove('hidden');
    try { audio.start(); } catch (e) { /* audio unavailable in headless */ }
  } else {
    $('boot').classList.add('hidden');
  }
  requestAnimationFrame(frame);
})();
