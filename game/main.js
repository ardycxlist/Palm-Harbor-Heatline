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
  var zoomLevel = 0; // 0 = auto (9 on foot, 13 in car)
  var paused = false;
  var lastT = 0, acc = 0;
  var toastCount = 0;
  var saveFlashT = 0, hurtFlashT = 0, hitT = 0;

  // ---------- screenshot presets (deterministic states) ----------
  function applyShotPreset(mode) {
    game.mission.active = true;
    if (mode === 'drive') {
      game.player.x = 19; game.player.z = 6.5;
      game.toggleCar();
    } else if (mode === 'mission') {
      game.player.x = 17; game.player.z = 10;
      game.player.yaw = Math.PI / 2;
      game.taxiWait = PH.TAXI_SPOTS[0];
      game.events.push({ kind: 'notify', text: 'MARA / Meet me at the coral phone. Your courier car is parked by the road.', t: game.time });
      game.events.push({ kind: 'notify', text: 'TAXI / a passenger is waiting in OLD QUARTER — pick them up by car.', t: game.time });
    } else if (mode === 'night') {
      game.clock = 19 + 31 / 60;
      game.wantedKills = 12; game.casualties = 12;
      game.search = 1; game.heat = 1;
      game.player.x = 19; game.player.z = 50;
      game.toggleCar();
      var car = game.getCar();
      if (car) { car.speed = 20.5; car.yaw = Math.PI / 2; game.player.yaw = Math.PI / 2; }
      // Warm-up: let police cars, foot officers and helis arrive.
      for (var i = 0; i < 240; i++) {
        game.move(1 / 60, { forward: true });
        game.update(1 / 60);
      }
      if (car) { car.speed = 20.5; }
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
    var obj = game.objective();
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
    // Speedo.
    var car = game.getCar();
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

  // ---------- maps ----------
  function drawMapInto(cv, scale, withLabels) {
    var g = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var cx = W / 2, cy = H / 2;
    function X(x) { return cx + x * scale; }
    function Z(z) { return cy + z * scale; }
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0e2230';
    g.fillRect(0, 0, W, H);
    // Water + sand east.
    g.fillStyle = '#164a66';
    g.fillRect(X(217), 0, W - X(217), H);
    g.fillStyle = '#dec493';
    g.fillRect(X(201), Z(-64), (214 - 201) * scale, (150 + 64) * scale);
    // Blocks.
    g.fillStyle = '#1d364b';
    for (var b = 0; b < game.city.blocks.length; b++) {
      var bl = game.city.blocks[b];
      if (bl.park) g.fillStyle = '#2a5a3a';
      else g.fillStyle = '#1d364b';
      g.fillRect(X(bl.x0), Z(bl.z0), (bl.x1 - bl.x0) * scale, (bl.z1 - bl.z0) * scale);
    }
    // Roads.
    g.strokeStyle = '#3b485e';
    g.lineWidth = Math.max(2, 18 * scale);
    for (var r = 0; r < PH.ROADS.length; r++) {
      var rd = PH.ROADS[r];
      g.beginPath(); g.moveTo(X(-216), Z(rd)); g.lineTo(X(216), Z(rd)); g.stroke();
      g.beginPath(); g.moveTo(X(rd), Z(-216)); g.lineTo(X(rd), Z(216)); g.stroke();
    }
    // District labels.
    if (withLabels) {
      g.fillStyle = '#96e2d3';
      g.font = 'bold 11px Arial';
      g.textAlign = 'center';
      var labels = [
        ['OLD QUARTER', 0, 0], ['GLASS DISTRICT', -70, -150], ['CORAL HEIGHTS', 130, -40],
        ['LITTLE PALM', -150, 0], ['PORT SOL', 60, 170], ['SUNSTRAND', 195, 60]
      ];
      for (var li = 0; li < labels.length; li++) {
        var L = labels[li];
        g.fillText(L[0], X(L[1]), Z(L[2]));
        if (game.extras.standing) {
          var sc = game.extras.standing[L[0] === 'SUNSTRAND' ? 'SUNSTRAND BEACH' : L[0]] || 10;
          var tier = sc >= 75 ? 'Family' : sc >= 50 ? 'Respected' : sc >= 25 ? 'Known' : 'Stranger';
          g.fillStyle = '#f6cf7c';
          g.font = '10px Arial';
          g.fillText(tier + ' ' + Math.round(sc), X(L[1]), Z(L[2]) + 13);
          g.fillStyle = '#96e2d3';
          g.font = 'bold 11px Arial';
        }
      }
      // Legend markers.
      g.font = '13px Arial';
      g.fillStyle = '#ff8d7c';
      g.fillText('◇ OBJECTIVE', X(-160), Z(200));
      g.fillStyle = '#70e1cf';
      g.fillText('＋ CLINIC', X(-60), Z(200));
      g.fillStyle = '#fff1d6';
      g.fillText('⌂ SAFEHOUSE', X(40), Z(200));
      g.fillStyle = '#f6cf7c';
      g.fillText('⚑ COAST RUN', X(150), Z(200));
    }
    // Objective + waypoint.
    var obj = game.objective();
    if (obj && obj.x !== undefined) {
      g.fillStyle = '#ff8d7c';
      g.beginPath();
      g.moveTo(X(obj.x), Z(obj.z) - 7); g.lineTo(X(obj.x) + 7, Z(obj.z));
      g.lineTo(X(obj.x), Z(obj.z) + 7); g.lineTo(X(obj.x) - 7, Z(obj.z));
      g.closePath(); g.fill();
    }
    if (game.waypoint) {
      g.fillStyle = '#fff1d6';
      g.beginPath();
      g.arc(X(game.waypoint.x), Z(game.waypoint.z), 5, 0, Math.PI * 2);
      g.fill();
    }
    // Cars + police.
    g.fillStyle = '#c8ccd4';
    for (var ci = 0; ci < game.cars.length; ci++) {
      var c = game.cars[ci];
      g.fillRect(X(c.x) - 1.5, Z(c.z) - 1.5, 3, 3);
    }
    g.fillStyle = '#2a5aff';
    for (var pi = 0; pi < game.police.length; pi++) {
      g.beginPath();
      g.arc(X(game.police[pi].x), Z(game.police[pi].z), 3, 0, Math.PI * 2);
      g.fill();
    }
    // Taxi passenger.
    if (game.taxiWait) {
      g.fillStyle = '#f8cf69';
      g.beginPath();
      g.arc(X(game.taxiWait.x), Z(game.taxiWait.z), 4, 0, Math.PI * 2);
      g.fill();
    }
    // Player arrow.
    var px = X(game.player.x), pz = Z(game.player.z);
    g.save();
    g.translate(px, pz);
    g.rotate(Math.atan2(Math.cos(game.player.yaw), -Math.sin(game.player.yaw)));
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(0, -8); g.lineTo(5, 6); g.lineTo(-5, 6);
    g.closePath(); g.fill();
    g.restore();
    // North.
    g.fillStyle = '#fff1d6';
    g.font = 'bold 12px Arial';
    g.textAlign = 'left';
    g.fillText('N', 10, 18);
  }
  function drawMinimap() {
    var cv = $('minimap');
    drawMapInto(cv, 220 / 432, false);
  }
  function drawBigmap() {
    var cv = $('bigmap');
    drawMapInto(cv, Math.min(800, 740) / 432, true);
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
      acc += dt;
      var steps = 0;
      while (acc >= 1 / 60 && steps < 6) {
        game.move(1 / 60, input);
        game.update(1 / 60);
        acc -= 1 / 60;
        steps++;
      }
      if (steps === 6) acc = 0;
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
    if ($('startOverlay').classList.contains('hidden')) updateHUD(dt);
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
