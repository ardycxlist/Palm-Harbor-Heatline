// PALM HARBOR: HEATLINE — three.js renderer.
// Fixed look: ACES 1.12, 1024 shadows, pixel ratio cap 1.5, crowd range 190.
// Bakes the city once (instanced buildings/palms/lamps), syncs people,
// vehicles, helis, markers and weather every frame. Written from the memo.
(function () {
  'use strict';
  var PH = (globalThis.PH = globalThis.PH || {});
  var THREE = globalThis.THREE;
  var clamp = PH.clamp, dist = PH.dist;

  var CROWD_RANGE = 190, DETAIL_DIST = 45, RAIN_N = 700;
  var PRESENT_MIN = 1 / 30 - 0.0025;

  function smoothstep(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function hexLerp(a, b, t) {
    var ca = new THREE.Color(a), cb = new THREE.Color(b);
    return ca.lerp(cb, t);
  }

  // Window texture shared by all buildings: grey facade, grid of windows,
  // ~30% lit warm. A second canvas holds only the lit windows (emissive).
  // Pass a dark palette for tower glass (reference §3).
  function buildingTextures(darkPalette) {
    var c = document.createElement('canvas'); c.width = 128; c.height = 128;
    var g = c.getContext('2d');
    g.fillStyle = '#e8e2d4'; g.fillRect(0, 0, 128, 128);
    var e = document.createElement('canvas'); e.width = 128; e.height = 128;
    var ge = e.getContext('2d');
    ge.fillStyle = '#000'; ge.fillRect(0, 0, 128, 128);
    // Plain base: the window grid used to live in this texture and stretched
    // across tall facades. Windows are geometry now (baked below), so the
    // texture is a flat base colour and the emissive map stays black.
    var map = new THREE.CanvasTexture(c);
    var emissive = new THREE.CanvasTexture(e);
    return { map: map, emissive: emissive };
  }

  // Soft radial falloff texture for light pools (heli disk, lamp pools,
  // headlight pools): bright centre fading to transparent at the rim, so a
  // pool reads as light instead of a flat disc.
  function radialTexture() {
    var c = document.createElement('canvas'); c.width = c.height = 128;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  function districtBoardTexture(title, name) {
    var c = document.createElement('canvas'); c.width = 896; c.height = 128;
    var g = c.getContext('2d');
    g.fillStyle = '#1d364b'; g.fillRect(0, 0, 896, 128);
    g.strokeStyle = '#f4dcb9'; g.lineWidth = 4; g.strokeRect(6, 6, 884, 116);
    g.fillStyle = '#f4dcb9'; g.font = 'bold 48px Georgia'; g.textAlign = 'center';
    g.fillText(title, 448, 54);
    g.fillStyle = '#96e2d3'; g.font = '32px Arial';
    g.fillText(name, 448, 100);
    return new THREE.CanvasTexture(c);
  }

  function createWorld(game, canvas) {
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(canvas.clientWidth || 1280, canvas.clientHeight || 720, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
    else renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    var scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xe6c4b5, 0.0011);
    var camera = new THREE.PerspectiveCamera(56, 1280 / 720, 0.16, 720);
    var radialTex = radialTexture();

    var sun = new THREE.DirectionalLight(0xffd4aa, 2.04);
    sun.position.set(-80, 75, -38);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -48; sun.shadow.camera.right = 48;
    sun.shadow.camera.top = 48; sun.shadow.camera.bottom = -48;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 300;
    sun.shadow.bias = -0.00015; sun.shadow.normalBias = 0.3;
    scene.add(sun);
    scene.add(sun.target);
    var hemi = new THREE.HemisphereLight(0xfff2db, 0x8a8db1, 1.52);
    scene.add(hemi);

    // Sky dome: gradient horizon/zenith + sun disc.
    var skyUniforms = {
      topColor: { value: new THREE.Color(0x4ba6d6) },
      bottomColor: { value: new THREE.Color(0xbfe3da) },
      sunDir: { value: new THREE.Vector3(-0.5, 0.6, -0.3).normalize() },
      sunColor: { value: new THREE.Color(0xffe9c9) }
    };
    var sky = new THREE.Mesh(
      new THREE.SphereGeometry(600, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: skyUniforms,
        vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'varying vec3 vP; uniform vec3 topColor; uniform vec3 bottomColor; uniform vec3 sunDir; uniform vec3 sunColor;' +
          'void main(){ float h = normalize(vP).y; vec3 c = mix(bottomColor, topColor, smoothstep(-0.05, 0.5, h));' +
          'float s = max(dot(normalize(vP), normalize(sunDir)), 0.0); c += sunColor * pow(s, 220.0) * 1.4 + sunColor * pow(s, 8.0) * 0.18;' +
          'gl_FragColor = vec4(c, 1.0); }'
      })
    );
    scene.add(sky);

    // Water: big plane with animated waves, foam near the shore, glitter.
    var waterUniforms = {
      time: { value: 0 },
      deep: { value: new THREE.Color(0x063d52) },
      shallow: { value: new THREE.Color(0x0e878c) },
      storm: { value: 0 }
    };
    var water = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, 1200),
      new THREE.ShaderMaterial({
        transparent: true, fog: false, uniforms: waterUniforms,
        vertexShader: 'varying vec2 vUv; varying vec3 vP; void main(){ vUv = uv; vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'varying vec2 vUv; varying vec3 vP; uniform float time; uniform vec3 deep; uniform vec3 shallow; uniform float storm;' +
          'float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }' +
          'void main(){ vec2 p = vUv * 90.0;' +
          'float w = sin(p.x * 0.9 + time * 0.7) * 0.5 + sin(p.y * 1.3 - time * 0.5) * 0.5;' +
          'vec3 c = mix(deep, shallow, 0.5 + 0.5 * w * (0.4 + storm));' +
          'float foam = smoothstep(0.86, 0.9, sin(p.x * 2.0 + time) * 0.5 + 0.5) * 0.25;' +
          'float glit = step(0.985, h(floor(p * 6.0) + floor(time * 2.0))) * 0.35;' +
          'gl_FragColor = vec4(c + foam + glit, 0.92); }'
      })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.49;
    scene.add(water);

    var matCache = {};
    function mat(color, opts) {
      var key = color + '|' + JSON.stringify(opts || {});
      if (!matCache[key]) {
        var m = new THREE.MeshLambertMaterial({ color: color });
        if (opts) {
          if (opts.emissive !== undefined) m.emissive = new THREE.Color(opts.emissive);
          if (opts.emissiveIntensity !== undefined) m.emissiveIntensity = opts.emissiveIntensity;
          if (opts.transparent) m.transparent = true;
          if (opts.opacity !== undefined) m.opacity = opts.opacity;
        }
        matCache[key] = m;
      }
      return matCache[key];
    }
    function box(w, h, d, color, x, y, z, parent) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
      m.position.set(x, y, z);
      (parent || scene).add(m);
      return m;
    }

    // ---------- static bake ----------
    var stats = { builds: 0, presents: 0, drawCalls: 0, sceneObjects: 0, staticInstances: 0 };
    // Ground base + roads + sidewalks.
    var ground = new THREE.Mesh(new THREE.PlaneGeometry(448, 448), mat(0xba9c96));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    scene.add(ground);
    var asphalt = new THREE.Mesh(new THREE.PlaneGeometry(448, 448), mat(0x3b485e));
    asphalt.rotation.x = -Math.PI / 2; asphalt.position.y = 0.01; asphalt.receiveShadow = true;
    scene.add(asphalt);
    // Block sidewalks + roads markings.
    var blockGeo = new THREE.BoxGeometry(1, 0.12, 1);
    var blockMat = mat(0xcdad9f);
    var blockMesh = new THREE.InstancedMesh(blockGeo, blockMat, game.city.blocks.length);
    var dummy = new THREE.Object3D();
    game.city.blocks.forEach(function (b, i) {
      dummy.position.set((b.x0 + b.x1) / 2, 0.06, (b.z0 + b.z1) / 2);
      dummy.scale.set(b.x1 - b.x0, 1, b.z1 - b.z0);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      blockMesh.setMatrixAt(i, dummy.matrix);
    });
    blockMesh.instanceMatrix.needsUpdate = true;
    blockMesh.receiveShadow = true;
    scene.add(blockMesh);
    // Centre gold lines + dashed cream lines along every road.
    var lineMat = mat(0xffba62);
    var dashMat = mat(0xffeaca);
    PH.ROADS.forEach(function (r) {
      var hLine = new THREE.Mesh(new THREE.PlaneGeometry(420, 0.35), lineMat);
      hLine.rotation.x = -Math.PI / 2; hLine.position.set(0, 0.03, r);
      scene.add(hLine);
      var vLine = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 420), lineMat);
      vLine.rotation.x = -Math.PI / 2; vLine.position.set(r, 0.03, 0);
      scene.add(vLine);
      for (var a = -180; a < 180; a += 24) {
        var d1 = new THREE.Mesh(new THREE.PlaneGeometry(10, 0.25), dashMat);
        d1.rotation.x = -Math.PI / 2; d1.position.set(a, 0.03, r + 3.2);
        scene.add(d1);
        var d2 = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 10), dashMat);
        d2.rotation.x = -Math.PI / 2; d2.position.set(r + 3.2, 0.03, a);
        scene.add(d2);
      }
    });

    // Buildings: instanced bodies (window texture + instance color), roof
    // trims, AC crates, antennas on tall towers. The Sunstrand-lot building
    // (flagged demolished at city build) is skipped here.
    var tex = buildingTextures();
    var towerTex = buildingTextures([0x3e708a, 0x527794, 0x426286, 0x468b98]);
    var bodyGeo = new THREE.BoxGeometry(1, 1, 1);
    var bodyMat = new THREE.MeshLambertMaterial({ map: tex.map, emissiveMap: tex.emissive, emissive: 0xffc786, emissiveIntensity: 0 });
    var towerBodyMat = new THREE.MeshPhongMaterial({ map: towerTex.map, emissiveMap: towerTex.emissive, emissive: 0xffc786, emissiveIntensity: 0, specular: 0x3d5a66, shininess: 28 });
    var liveBuildings = game.city.buildings.filter(function (b) { return !b.demolished; });
    var lowB = liveBuildings.filter(function (b) { return !b.tower; });
    var towerB = liveBuildings.filter(function (b) { return b.tower; });
    var bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, Math.max(1, lowB.length));
    var towerMesh = new THREE.InstancedMesh(bodyGeo, towerBodyMat, Math.max(1, towerB.length));
    var trimMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.3, 1), mat(0xffffff), liveBuildings.length);
    var acMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.9, 1.6), mat(0x8a94a0), Math.max(1, lowB.length * 2));
    // Tower crowns (stepped), penthouse blocks, antennas, water tanks.
    var crownMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xffffff), Math.max(1, towerB.length));
    var crownTopMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xffffff), Math.max(1, towerB.length));
    var pentMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0x355673), Math.max(1, towerB.length));
    var antennaMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 5), mat(0x8a94a0), Math.max(1, towerB.length));
    var tankMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.0, 1.0, 1.4, 8), mat(0xb9a8a0), Math.max(1, liveBuildings.length));
    // Road-facing frame per building: the side toward the nearest road.
    function faceFrame(b) {
      var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      var nx = PH.ROADS[0], ndx = 1e9;
      for (var ri = 0; ri < PH.ROADS.length; ri++) { var ddx = Math.abs(cx - PH.ROADS[ri]); if (ddx < ndx) { ndx = ddx; nx = PH.ROADS[ri]; } }
      var nz = PH.ROADS[0], ndz = 1e9;
      for (var rj = 0; rj < PH.ROADS.length; rj++) { var ddz = Math.abs(cz - PH.ROADS[rj]); if (ddz < ndz) { ndz = ddz; nz = PH.ROADS[rj]; } }
      if (ndx <= ndz) return { axis: 'x', sign: cx >= nx ? 1 : -1, w: b.maxZ - b.minZ, cx: cx, cz: cz };
      return { axis: 'z', sign: cz >= nz ? 1 : -1, w: b.maxX - b.minX, cx: cx, cz: cz };
    }
    // District sign bands + light strips + awnings + ground-floor doors.
    var bandMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xffffff), liveBuildings.length);
    var bandStripMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xffe6b7, { emissive: 0xffe6b7, emissiveIntensity: 0.8 }), liveBuildings.length);
    var awnMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xffffff), liveBuildings.length);
    var awnStripMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xffffff), liveBuildings.length);
    var doorMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xffffff), liveBuildings.length);
    var shopWinMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xffffff), Math.max(1, liveBuildings.length * 2));
    var TOWER_GLASS = [0x3e708a, 0x527794, 0x426286, 0x468b98];
    var DARK_WIN = [0x385974, 0x467990, 0x668b9e, 0x506581, 0x397081];
    liveBuildings.forEach(function (b, i) {
      if (b.demolished) return;
      var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      var bw = b.maxX - b.minX, bd = b.maxZ - b.minZ;
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(cx, b.h / 2, cz);
      dummy.scale.set(bw, b.h, bd);
      dummy.updateMatrix();
      if (b.tower) {
        var ti = towerB.indexOf(b);
        towerMesh.setMatrixAt(ti, dummy.matrix);
        towerMesh.setColorAt(ti, new THREE.Color(TOWER_GLASS[i % TOWER_GLASS.length]));
      } else {
        var li = lowB.indexOf(b);
        bodyMesh.setMatrixAt(li, dummy.matrix);
        bodyMesh.setColorAt(li, new THREE.Color(b.color));
      }
      dummy.position.set(cx, b.h + 0.15, cz);
      dummy.scale.set(bw + 0.3, 1, bd + 0.3);
      dummy.updateMatrix();
      trimMesh.setMatrixAt(i, dummy.matrix);
      trimMesh.setColorAt(i, new THREE.Color(b.tower ? 0xb7d5db : 0xf4ddd0));
      if (!b.tower) {
        var ai = lowB.indexOf(b) * 2;
        dummy.position.set(cx - bw * 0.22, b.h + 0.7, cz - bd * 0.18);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        acMesh.setMatrixAt(ai, dummy.matrix);
        dummy.position.set(cx + bw * 0.24, b.h + 0.7, cz + bd * 0.2);
        dummy.updateMatrix();
        acMesh.setMatrixAt(ai + 1, dummy.matrix);
      }
      if (b.tower) {
        var ci = towerB.indexOf(b);
        dummy.position.set(cx, b.h + b.crown / 2, cz);
        dummy.scale.set(bw * 0.72, b.crown, bd * 0.72);
        dummy.updateMatrix();
        crownMesh.setMatrixAt(ci, dummy.matrix);
        crownMesh.setColorAt(ci, new THREE.Color(TOWER_GLASS[(i + 1) % TOWER_GLASS.length]));
        dummy.position.set(cx, b.h + b.crown * 0.85, cz);
        dummy.scale.set(bw * 0.45, b.crown * 0.5, bd * 0.45);
        dummy.updateMatrix();
        crownTopMesh.setMatrixAt(ci, dummy.matrix);
        crownTopMesh.setColorAt(ci, new THREE.Color(b.color));
        dummy.position.set(cx + bw * 0.2, b.h + 0.9, cz - bd * 0.2);
        dummy.scale.set(bw * 0.32, 1.8, bd * 0.32);
        dummy.updateMatrix();
        pentMesh.setMatrixAt(ci, dummy.matrix);
        if (b.antenna) {
          dummy.position.set(cx - bw * 0.2, b.h + b.crown + 1.2, cz + bd * 0.2);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          antennaMesh.setMatrixAt(ci, dummy.matrix);
        } else {
          dummy.position.set(cx, -50, cz);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          antennaMesh.setMatrixAt(ci, dummy.matrix);
        }
      }
      if (b.tank) {
        dummy.position.set(cx + bw * 0.28, b.h + 1.1, cz + bd * 0.28);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        tankMesh.setMatrixAt(i, dummy.matrix);
      } else {
        dummy.position.set(cx, -50, cz);
        dummy.updateMatrix();
        tankMesh.setMatrixAt(i, dummy.matrix);
      }
      // Sign band + strip + awning + door on the road-facing side.
      var f = faceFrame(b);
      var accent = PH.DISTRICT_ACCENT[b.district] || 0xd88145;
      var off = 0.14;
      if (f.axis === 'x') {
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(cx + f.sign * (bw / 2 + off), 3.3, cz);
        dummy.scale.set(0.18, 1.1, f.w * 0.9);
      } else {
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(cx, 3.3, cz + f.sign * (bd / 2 + off));
        dummy.scale.set(f.w * 0.9, 1.1, 0.18);
      }
      dummy.updateMatrix();
      bandMesh.setMatrixAt(i, dummy.matrix);
      bandMesh.setColorAt(i, new THREE.Color(accent));
      dummy.position.y = 2.68;
      dummy.scale.set(dummy.scale.x, 0.16, dummy.scale.z);
      if (f.axis === 'x') dummy.scale.set(0.1, 0.16, f.w * 0.9);
      dummy.updateMatrix();
      bandStripMesh.setMatrixAt(i, dummy.matrix);
      if (i % 2 === 0) {
        if (f.axis === 'x') {
          dummy.rotation.set(0, 0, -f.sign * 0.5);
          dummy.position.set(cx + f.sign * (bw / 2 + 0.85), 2.9, cz);
          dummy.scale.set(0.1, 1.5, f.w * 0.7);
        } else {
          dummy.rotation.set(f.sign * 0.5, 0, 0);
          dummy.position.set(cx, 2.9, cz + f.sign * (bd / 2 + 0.85));
          dummy.scale.set(f.w * 0.7, 1.5, 0.1);
        }
        dummy.updateMatrix();
        awnMesh.setMatrixAt(i, dummy.matrix);
        awnMesh.setColorAt(i, new THREE.Color(accent));
        dummy.rotation.set(0, 0, 0);
        if (f.axis === 'x') {
          dummy.position.set(cx + f.sign * (bw / 2 + 1.45), 2.62, cz);
          dummy.scale.set(0.08, 0.08, f.w * 0.7);
        } else {
          dummy.position.set(cx, 2.62, cz + f.sign * (bd / 2 + 1.45));
          dummy.scale.set(f.w * 0.7, 0.08, 0.08);
        }
        dummy.updateMatrix();
        awnStripMesh.setMatrixAt(i, dummy.matrix);
        awnStripMesh.setColorAt(i, new THREE.Color(i % 4 < 2 ? 0xff9b91 : 0x88eded));
      } else {
        dummy.position.set(cx, -50, cz);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        awnMesh.setMatrixAt(i, dummy.matrix);
        awnStripMesh.setMatrixAt(i, dummy.matrix);
      }
      if (f.axis === 'x') {
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(cx + f.sign * (bw / 2 + 0.08), 1.2, cz);
        dummy.scale.set(0.12, 2.4, 1.3);
      } else {
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(cx, 1.2, cz + f.sign * (bd / 2 + 0.08));
        dummy.scale.set(1.3, 2.4, 0.12);
      }
      dummy.updateMatrix();
      doorMesh.setMatrixAt(i, dummy.matrix);
      doorMesh.setColorAt(i, new THREE.Color(b.warehouse ? 0x62727d : 0x385565));
      for (var wi = 0; wi < 2; wi++) {
        var side = wi === 0 ? -3.4 : 3.4;
        if (f.axis === 'x') {
          dummy.position.set(cx + f.sign * (bw / 2 + 0.08), 1.4, cz + side);
          dummy.scale.set(0.1, 1.5, 1.8);
        } else {
          dummy.position.set(cx + side, 1.4, cz + f.sign * (bd / 2 + 0.08));
          dummy.scale.set(1.8, 1.5, 0.1);
        }
        dummy.updateMatrix();
        shopWinMesh.setMatrixAt(i * 2 + wi, dummy.matrix);
        shopWinMesh.setColorAt(i * 2 + wi, new THREE.Color(DARK_WIN[(i + wi) % DARK_WIN.length]));
      }
    });
    [bodyMesh, towerMesh, trimMesh, acMesh, crownMesh, crownTopMesh, pentMesh, antennaMesh, tankMesh,
     bandMesh, bandStripMesh, awnMesh, awnStripMesh, doorMesh, shopWinMesh].forEach(function (m) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    });
    bodyMesh.castShadow = true; bodyMesh.receiveShadow = true;
    towerMesh.castShadow = true; towerMesh.receiveShadow = true;
    scene.add(bodyMesh); scene.add(towerMesh); scene.add(trimMesh); scene.add(acMesh);
    scene.add(crownMesh); scene.add(crownTopMesh); scene.add(pentMesh); scene.add(antennaMesh); scene.add(tankMesh);
    scene.add(bandMesh); scene.add(bandStripMesh); scene.add(awnMesh); scene.add(awnStripMesh);
    scene.add(doorMesh); scene.add(shopWinMesh);

    // Windows as geometry on all four faces: pane 1.5 x 1.9 on a 2.9 x
    // 3.3 grid, first row at y 4.9 (above the band + awning). The lit
    // share of each building is its own b.lit (18-40%, deterministic
    // hash per pane); tower glass reads 1.3x brighter. Lit panes share
    // one material (winLitMat) that the frame loop fades from dark
    // glass by day to warm glass at night.
    var WIN_LIT = [0xffc786, 0x81dfed, 0xff9d94, 0xffe9bb];
    var winPaneGeo = new THREE.BoxGeometry(1, 1, 1);
    var winDarkMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    var winLitMat = new THREE.MeshBasicMaterial({ color: 0x17303b });
    function winRows(h) {
      var n = 0;
      for (var yy = 4.9; yy + 0.95 <= h - 0.8; yy += 3.3) n++;
      return n;
    }
    function winCols(fw) { return Math.max(1, Math.floor((fw - 1.0) / 2.9)); }
    var winTotal = 0;
    liveBuildings.forEach(function (b) {
      var bw4 = b.maxX - b.minX, bd4 = b.maxZ - b.minZ;
      winTotal += (winCols(bw4) + winCols(bd4)) * 2 * winRows(b.h);
    });
    var winDarkMesh = new THREE.InstancedMesh(winPaneGeo, winDarkMat, winTotal);
    var winLitMesh = new THREE.InstancedMesh(winPaneGeo, winLitMat, winTotal);
    var winDarkI = 0, winLitI = 0;
    liveBuildings.forEach(function (b, bi) {
      if (b.demolished) return;
      var cx4 = (b.minX + b.maxX) / 2, cz4 = (b.minZ + b.maxZ) / 2;
      var bw5 = b.maxX - b.minX, bd5 = b.maxZ - b.minZ;
      var faces = [
        { fw: bd5, px: b.maxX + 0.08, pz: cz4, rot: 1 },
        { fw: bd5, px: b.minX - 0.08, pz: cz4, rot: 1 },
        { fw: bw5, px: cx4, pz: b.maxZ + 0.08, rot: 0 },
        { fw: bw5, px: cx4, pz: b.minZ - 0.08, rot: 0 }
      ];
      faces.forEach(function (fc, fi) {
        var cols = winCols(fc.fw), rows = winRows(b.h);
        for (var ci = 0; ci < cols; ci++) {
          var along = (ci - (cols - 1) / 2) * 2.9;
          for (var ri = 0; ri < rows; ri++) {
            var wy = 4.9 + ri * 3.3;
            var hv = Math.abs(Math.sin(bi * 12.9898 + fi * 78.233 + ci * 37.719 + ri * 11.135) * 43758.5453) % 1;
            var lit = hv < b.lit;
            var px = fc.rot === 1 ? fc.px : fc.px + along;
            var pz = fc.rot === 1 ? fc.pz + along : fc.pz;
            dummy.position.set(px, wy, pz);
            dummy.rotation.set(0, fc.rot === 1 ? Math.PI / 2 : 0, 0);
            dummy.scale.set(1.5, 1.9, 0.12);
            dummy.updateMatrix();
            if (lit) {
              winLitMesh.setMatrixAt(winLitI, dummy.matrix);
              var lc = new THREE.Color(WIN_LIT[Math.floor(Math.abs(Math.sin(bi * 3.7 + ci * 13.1 + ri * 7.7) * 43758.5453) % 1 * WIN_LIT.length)]);
              if (b.tower) { lc.r = Math.min(1, lc.r * 1.3); lc.g = Math.min(1, lc.g * 1.3); lc.b = Math.min(1, lc.b * 1.3); }
              winLitMesh.setColorAt(winLitI, lc);
              winLitI++;
            } else {
              winDarkMesh.setMatrixAt(winDarkI, dummy.matrix);
              var dc = new THREE.Color(DARK_WIN[Math.floor(hv * DARK_WIN.length)]);
              if (b.tower) { dc.r = Math.min(1, dc.r * 1.3); dc.g = Math.min(1, dc.g * 1.3); dc.b = Math.min(1, dc.b * 1.3); }
              winDarkMesh.setColorAt(winDarkI, dc);
              winDarkI++;
            }
          }
        }
      });
    });
    winDarkMesh.instanceMatrix.needsUpdate = true;
    winLitMesh.instanceMatrix.needsUpdate = true;
    if (winDarkMesh.instanceColor) winDarkMesh.instanceColor.needsUpdate = true;
    if (winLitMesh.instanceColor) winLitMesh.instanceColor.needsUpdate = true;
    scene.add(winDarkMesh); scene.add(winLitMesh);
    stats.staticInstances += winTotal;
    stats.staticInstances += liveBuildings.length * 12;
    // Red beacon lights on tall towers (antenna tips when present).
    var beaconMat = new THREE.MeshBasicMaterial({ color: 0xf78495 });
    liveBuildings.forEach(function (b) {
      if (b.h > 33 && b.roof > 0.56) {
        var bc = new THREE.Mesh(new THREE.SphereGeometry(0.35, 6, 6), beaconMat);
        var bcx = (b.minX + b.maxX) / 2, bcz = (b.minZ + b.maxZ) / 2;
        var bcy = b.antenna ? b.h + b.crown + 2.5 : b.h + 1.4;
        bc.position.set(b.antenna ? bcx - (b.maxX - b.minX) * 0.2 : bcx, bcy, b.antenna ? bcz + (b.maxZ - b.minZ) * 0.2 : bcz);
        scene.add(bc);
      }
    });

    // Palms: leaning ringed trunks (3 stacked segments), 9-leaf crowns on a
    // base ball, square planters (reference §7).
    var palms = game.city.props.filter(function (p) { return p.kind === 'palm'; });
    var trunkMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.11, 1, 6), mat(0xffffff), Math.max(1, palms.length * 6));
    var leafColors = [0x196856, 0x2e8768, 0x53a66c, 0x3c925b];
    var leafMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.55, 1, 4), mat(0xffffff), Math.max(1, palms.length * 9));
    var crownMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 8, 6), mat(0x536843), Math.max(1, palms.length));
    var planterMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.5, 1.6), mat(0xedc4a5), Math.max(1, palms.length));
    var soilMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 0.12, 1.4), mat(0x695a61), Math.max(1, palms.length));
    var RING_COLS = [0xa47e65, 0xba9875];
    var TRUNK_BASE = 0x8e6556;
    palms.forEach(function (p, i) {
      var az = (i * 2.399) % (Math.PI * 2);
      var dx = Math.cos(az), dz = Math.sin(az);
      var lean = p.lean || 0.4;
      // lean is a HORIZONTAL OFFSET in units (0.26-0.57), not an angle:
      // the trunk is a straight post tilted atan2(lean, h) ~ 3-6.5 deg,
      // crown upright above it (reference §6 / play notes). A 0.57 rad
      // tilt would read as a tree about to fall over.
      var tilt = Math.atan2(lean, p.h);
      // Six trunk segments: dark brown base with alternating ring bands,
      // so the trunk reads as a palm trunk, not a flat orange plank.
      for (var sg = 0; sg < 6; sg++) {
        var fy = p.h * (sg + 0.5) / 6;
        dummy.position.set(p.x + dx * fy * Math.sin(tilt), fy * Math.cos(tilt), p.z + dz * fy * Math.sin(tilt));
        dummy.scale.set(1, p.h / 6, 1);
        dummy.rotation.set(dz * tilt, 0, -dx * tilt);
        dummy.updateMatrix();
        trunkMesh.setMatrixAt(i * 6 + sg, dummy.matrix);
        trunkMesh.setColorAt(i * 6 + sg, new THREE.Color(sg % 2 === 0 ? TRUNK_BASE : RING_COLS[Math.floor(sg / 2) % 2]));
      }
      var topX = p.x + dx * p.h * Math.sin(tilt), topZ = p.z + dz * p.h * Math.sin(tilt), topY = p.h * Math.cos(tilt);
      dummy.position.set(topX, topY, topZ);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      crownMesh.setMatrixAt(i, dummy.matrix);
      dummy.rotation.order = 'YXZ';
      for (var lf = 0; lf < 9; lf++) {
        var laz = (lf / 9) * Math.PI * 2 + i * 0.7;
        var len = 2.12 + (((i * 9 + lf) * 37) % 100) / 100 * 1.26;
        dummy.position.set(topX + Math.cos(laz) * 0.55, topY + 0.1, topZ + Math.sin(laz) * 0.55);
        dummy.scale.set(1, len, 0.5);
        dummy.rotation.set(1.9, laz, 0);
        dummy.updateMatrix();
        leafMesh.setMatrixAt(i * 9 + lf, dummy.matrix);
        leafMesh.setColorAt(i * 9 + lf, new THREE.Color(leafColors[(i * 9 + lf) % leafColors.length]));
      }
      dummy.rotation.order = 'XYZ';
      dummy.rotation.set(0, 0, 0);
      if (p.planter) {
        dummy.position.set(p.x, 0.25, p.z);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        planterMesh.setMatrixAt(i, dummy.matrix);
        dummy.position.set(p.x, 0.52, p.z);
        dummy.updateMatrix();
        soilMesh.setMatrixAt(i, dummy.matrix);
      } else {
        dummy.position.set(p.x, -50, p.z);
        dummy.updateMatrix();
        planterMesh.setMatrixAt(i, dummy.matrix);
        soilMesh.setMatrixAt(i, dummy.matrix);
      }
    });
    [trunkMesh, leafMesh, crownMesh, planterMesh, soilMesh].forEach(function (m) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    });
    scene.add(trunkMesh); scene.add(leafMesh); scene.add(crownMesh); scene.add(planterMesh); scene.add(soilMesh);
    stats.staticInstances += palms.length * 18;

    // Street lamps: 98 (2 per intersection, diagonal corners, reference §5).
    // Pole + arm + head + bulb, with a crossed halo card and a light pool
    // on the asphalt below, all driven by the one night factor (PLN).
    var lampPositions = [];
    PH.ROADS.forEach(function (rx) {
      PH.ROADS.forEach(function (rz) {
        lampPositions.push([rx + 10.2, rz + 14, rx, rz]);
        lampPositions.push([rx - 10.2, rz - 14, rx, rz]);
      });
    });
    var poleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.12, 5, 6), mat(0x42586a), lampPositions.length);
    var armMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.12, 1.32), mat(0x42586a), lampPositions.length);
    var headMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.45, 0.15, 0.66), mat(0x53687a), lampPositions.length);
    var bulbMat = new THREE.MeshBasicMaterial({ color: 0x49525c });
    var bulbMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.2, 8, 6), bulbMat, lampPositions.length);
    var haloMat = new THREE.MeshBasicMaterial({ color: 0xffd694, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    var haloMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.6, 2.6), haloMat, lampPositions.length * 2);
    var lampPoolMat = new THREE.MeshBasicMaterial({ color: 0xffc98a, map: radialTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    var lampPoolMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(6.5, 20), lampPoolMat, lampPositions.length);
    lampPositions.forEach(function (lp, i) {
      var lx = lp[0], lz = lp[1];
      var dx = lp[2] - lx, dz = lp[3] - lz;
      var dl = Math.sqrt(dx * dx + dz * dz);
      dx /= dl; dz /= dl;
      var yaw = Math.atan2(dx, dz);
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(lx, 2.5, lz);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      poleMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(lx + dx * 0.66, 5.0, lz + dz * 0.66);
      dummy.rotation.set(0, yaw, 0);
      dummy.updateMatrix();
      armMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(lx + dx * 1.32, 5.1, lz + dz * 1.32);
      dummy.updateMatrix();
      headMesh.setMatrixAt(i, dummy.matrix);
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(lx + dx * 1.32, 4.95, lz + dz * 1.32);
      dummy.updateMatrix();
      bulbMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(lx + dx * 1.32, 5.05, lz + dz * 1.32);
      dummy.rotation.set(0, yaw, 0);
      dummy.updateMatrix();
      haloMesh.setMatrixAt(i * 2, dummy.matrix);
      dummy.rotation.set(0, yaw + Math.PI / 2, 0);
      dummy.updateMatrix();
      haloMesh.setMatrixAt(i * 2 + 1, dummy.matrix);
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(lx + dx * 1.32, 0.05, lz + dz * 1.32);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.updateMatrix();
      lampPoolMesh.setMatrixAt(i, dummy.matrix);
    });
    [poleMesh, armMesh, headMesh, bulbMesh, haloMesh, lampPoolMesh].forEach(function (m) { m.instanceMatrix.needsUpdate = true; });
    scene.add(poleMesh); scene.add(armMesh); scene.add(headMesh); scene.add(bulbMesh); scene.add(haloMesh); scene.add(lampPoolMesh);
    // PLN per building face: light pool on the sidewalk + 2 wall fixtures.
    var facePoolMat = new THREE.MeshBasicMaterial({ color: 0xffbe78, map: radialTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    var facePoolMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), facePoolMat, Math.max(1, liveBuildings.length * 4));
    var fixtureMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0 });
    var fixtureMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.5, 0.15), fixtureMat, Math.max(1, liveBuildings.length * 8));
    liveBuildings.forEach(function (b, i) {
      var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      var bw = b.maxX - b.minX, bd = b.maxZ - b.minZ;
      var faces = [
        { x: cx + bw / 2 + 0.5, z: cz, w: bd, rot: 0, fx: 1, fz: 0 },
        { x: cx - bw / 2 - 0.5, z: cz, w: bd, rot: 0, fx: -1, fz: 0 },
        { x: cx, z: cz + bd / 2 + 0.5, w: bw, rot: 1, fx: 0, fz: 1 },
        { x: cx, z: cz - bd / 2 - 0.5, w: bw, rot: 1, fx: 0, fz: -1 }
      ];
      faces.forEach(function (fc, fi) {
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        dummy.position.set(fc.x, 0.13, fc.z);
        dummy.scale.set(fc.w * 0.92, 2.2, 1);
        dummy.updateMatrix();
        facePoolMesh.setMatrixAt(i * 4 + fi, dummy.matrix);
        for (var k = 0; k < 2; k++) {
          var along = (k === 0 ? -0.3 : 0.3) * fc.w;
          dummy.rotation.set(0, 0, 0);
          if (fc.rot === 0) dummy.position.set(fc.x, 2.8, fc.z + along);
          else dummy.position.set(fc.x + along, 2.8, fc.z);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          fixtureMesh.setMatrixAt(i * 8 + fi * 2 + k, dummy.matrix);
        }
      });
    });
    facePoolMesh.instanceMatrix.needsUpdate = true;
    fixtureMesh.instanceMatrix.needsUpdate = true;
    scene.add(facePoolMesh); scene.add(fixtureMesh);

    // Traffic lights at (almost) every intersection: red + green lit together
    // as fixed decoration (reference §6 — the traffic rhythm is simulated,
    // not driven by the lights).
    var tlHeads = [];
    PH.ROADS.forEach(function (rx) {
      PH.ROADS.forEach(function (rz) {
        var g = new THREE.Group();
        var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 4.6, 6), mat(0x485a72));
        pole.position.y = 2.3;
        g.add(pole);
        var head = box(0.57, 1.27, 0.45, 0x344355, 0, 4.9, 0, g);
        var red = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 6), new THREE.MeshBasicMaterial({ color: 0xf3717b }));
        red.position.set(0, 5.2, 0.28); g.add(red);
        var green = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 6), new THREE.MeshBasicMaterial({ color: 0x8ef0ad }));
        green.position.set(0, 4.65, 0.28); g.add(green);
        g.position.set(rx + 9.5, 0, rz + 9.5);
        scene.add(g);
        tlHeads.push({ red: red, green: green });
      });
    });

    // Parks: grass, paths, fountain, market stalls, benches, bushes.
    game.city.parks.forEach(function (park) {
      var w = 46, d = 46;
      var grass = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(0x719b78));
      grass.rotation.x = -Math.PI / 2; grass.position.set(park.cx, 0.04, park.cz);
      grass.receiveShadow = true;
      scene.add(grass);
      var path = new THREE.Mesh(new THREE.PlaneGeometry(6, d), mat(0xd6bc9c));
      path.rotation.x = -Math.PI / 2; path.position.set(park.cx, 0.05, park.cz);
      scene.add(path);
      var base = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.4, 0.7, 12), mat(0xe8d0ac));
      base.position.set(park.cx, 0.4, park.cz);
      scene.add(base);
      var fwater = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.2, 12), mat(0x64c3c7));
      fwater.position.set(park.cx, 0.75, park.cz);
      scene.add(fwater);
      var stallColors = [0xe47271, 0x3eaaa5, 0xdab55b];
      for (var s = 0; s < 6; s++) {
        box(3, 2.2, 2.4, 0x8a6a52, park.cx - 14 + s * 5.6, 1.1, park.cz + 14);
        box(3.4, 0.25, 2.8, stallColors[s % 3], park.cx - 14 + s * 5.6, 2.35, park.cz + 14);
      }
      box(2.4, 0.5, 0.8, 0x6a4a3a, park.cx - 8, 0.6, park.cz - 12);
      var bush = new THREE.Mesh(new THREE.SphereGeometry(1.4, 8, 6), mat(0x44816a));
      bush.position.set(park.cx + 16, 0.9, park.cz - 14);
      scene.add(bush);
    });

    // District boards (canvas panels on poles).
    var boards = [
      ['PALM HARBOR', 'OLD QUARTER • AVENIDA', 0, 17, Math.PI],
      ['PALM HARBOR', 'GLASS DISTRICT', -69, -147, 0],
      ['PALM HARBOR', 'CORAL HEIGHTS', 160, -83, 0],
      ['PALM HARBOR', 'LITTLE PALM', -165, -28, 0],
      ['PALM HARBOR', 'PORT SOL', 21, 163, Math.PI],
      ['PALM HARBOR', 'SUNSTRAND • BEACH', 213, 87, Math.PI]
    ];
    boards.forEach(function (bd) {
      var tex2 = districtBoardTexture(bd[0], bd[1]);
      var panel = new THREE.Mesh(new THREE.PlaneGeometry(21, 2.7),
        new THREE.MeshBasicMaterial({ map: tex2 }));
      panel.position.set(bd[2], 8.9, bd[3]);
      panel.rotation.y = bd[4];
      scene.add(panel);
      // Posts stand on the sidewalk outside the road edge (1.5 past the
      // 9-unit road half-width), never in the middle of the road.
      var post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 8.9, 6), mat(0x42586a));
      post.position.set(bd[2] - 10.5, 4.45, bd[3]);
      scene.add(post);
      var post2 = post.clone();
      post2.position.set(bd[2] + 10.5, 4.45, bd[3]);
      scene.add(post2);
    });

    // Beach: sand, shoreline, piers, umbrellas, towels, lifeguard stand.
    var sand = new THREE.Mesh(new THREE.PlaneGeometry(24, 230), mat(0xefe0cd));
    sand.rotation.x = -Math.PI / 2; sand.position.set(210, 0.05, 43);
    sand.receiveShadow = true;
    scene.add(sand);
    var shore = new THREE.Mesh(new THREE.PlaneGeometry(3, 230), mat(0xd2b08b));
    shore.rotation.x = -Math.PI / 2; shore.position.set(216.5, 0.06, 43);
    scene.add(shore);
    var pierCols = [0x87694e, 0x9b7858];
    PH.BEACH.renderPiers.forEach(function (pz, i) {
      var pier = box(26, 0.5, 3.4, pierCols[i % 2], 239, 0.6, pz);
      pier.castShadow = true;
      box(0.4, 1.1, 3.4, pierCols[(i + 1) % 2], 226, 0.8, pz);
    });
    PH.BEACH.umbrellas.forEach(function (col, i) {
      var ux = 206 + i * 1.5, uz = -30 + i * 34;
      var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6), mat(0x8a6a52));
      pole.position.set(ux, 1.2, uz);
      scene.add(pole);
      var top = new THREE.Mesh(new THREE.ConeGeometry(2.1, 0.9, 8), mat(col));
      top.position.set(ux, 2.7, uz);
      scene.add(top);
      var towel = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.9), mat(PH.BEACH.towels[i % 4]));
      towel.rotation.x = -Math.PI / 2; towel.position.set(ux + 2.2, 0.08, uz);
      scene.add(towel);
    });
    // Lifeguard tower at (211, 22): four posts + platform + cabin + roof.
    (function () {
      var lx = 211, lz = 22;
      [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]].forEach(function (o) {
        box(0.18, 3.0, 0.18, 0x8a6a52, lx + o[0], 1.5, lz + o[1]);
      });
      box(2.4, 0.2, 2.4, 0x9b7858, lx, 3.0, lz);
      box(2.0, 1.2, 2.0, 0xf2efe8, lx, 3.7, lz);
      box(2.4, 0.15, 2.4, 0xe47271, lx, 4.4, lz);
    })();

    // Sunstrand parking lot (Phase PARK): asphalt, bay lines, curb, sign.
    if (PH.PARKING) {
      var pk = PH.PARKING;
      var pad = pk.pad;
      var lot = new THREE.Mesh(new THREE.PlaneGeometry(pad.x1 - pad.x0, pad.z1 - pad.z0), mat(0x46536b));
      lot.rotation.x = -Math.PI / 2; lot.position.set((pad.x0 + pad.x1) / 2, 0.06, (pad.z0 + pad.z1) / 2);
      scene.add(lot);
      pk.carBays.forEach(function (bay) {
        var ln = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 6.6), mat(0xffeaca));
        ln.rotation.x = -Math.PI / 2; ln.position.set(bay.x - 1.7, 0.08, bay.z);
        scene.add(ln);
      });
      pk.bikeBays.forEach(function (bay) {
        var bl = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 3.4), mat(0xffeaca));
        bl.rotation.x = -Math.PI / 2; bl.position.set(bay.x - 1.1, 0.08, bay.z);
        scene.add(bl);
      });
      // "PARKING" painted on the asphalt at the pad centre (reference §14).
      var labelC = document.createElement('canvas'); labelC.width = 256; labelC.height = 64;
      var lg = labelC.getContext('2d');
      lg.fillStyle = '#ffeaca'; lg.font = 'bold 44px Arial'; lg.textAlign = 'center';
      lg.fillText('PARKING', 128, 46);
      var label = new THREE.Mesh(new THREE.PlaneGeometry(10, 2.5),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(labelC), transparent: true }));
      label.rotation.x = -Math.PI / 2;
      label.position.set(pk.centre.x, 0.08, pk.centre.z);
      scene.add(label);
      var signC = document.createElement('canvas'); signC.width = 256; signC.height = 96;
      var sg = signC.getContext('2d');
      sg.fillStyle = '#1d364b'; sg.fillRect(0, 0, 256, 96);
      sg.fillStyle = '#f4bb45'; sg.font = 'bold 26px Arial'; sg.textAlign = 'center';
      sg.fillText('PARKING', 128, 40); sg.fillText('SUNSTRAND', 128, 74);
      var sign = new THREE.Mesh(new THREE.PlaneGeometry(5, 1.9),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(signC) }));
      sign.position.set(pk.sign.x, 3.4, pk.sign.z);
      sign.rotation.y = pk.sign.yaw;
      scene.add(sign);
    }

    // Rain: 700 slanted streaks (color 0xcfe4ee) in a 92x30 box around the
    // camera (reference §13).
    var rainGeo = new THREE.BufferGeometry();
    var rainPos = new Float32Array(RAIN_N * 6);
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    var rainMat = new THREE.LineBasicMaterial({ color: 0xcfe4ee, transparent: true, opacity: 0 });
    var rain = new THREE.LineSegments(rainGeo, rainMat);
    rain.frustumCulled = false;
    scene.add(rain);
    var rainSeed = [];
    for (var ri = 0; ri < RAIN_N; ri++) rainSeed.push({ x: Math.random() * 92 - 46, y: Math.random() * 30, z: Math.random() * 30 - 15 });
    // Wet asphalt: Lambert sheen above the asphalt, below the markings
    // (y 0.015), and puddle discs — opacity exactly 0 when not raining.
    var wetMat = new THREE.MeshLambertMaterial({ color: 0x131a25, transparent: true, opacity: 0 });
    var wetPlane = new THREE.Mesh(new THREE.PlaneGeometry(430, 430), wetMat);
    wetPlane.rotation.x = -Math.PI / 2;
    wetPlane.position.y = 0.015;
    scene.add(wetPlane);
    var puddleMats = [];
    var puddleColors = [0x27384a, 0x2e4256, 0x22303f];
    for (var pu = 0; pu < 14; pu++) {
      var pm = new THREE.MeshBasicMaterial({ color: puddleColors[pu % 3], transparent: true, opacity: 0 });
      var pd = new THREE.Mesh(new THREE.CircleGeometry(1, 14), pm);
      pd.rotation.x = -Math.PI / 2;
      var pr = PH.ROADS[Math.floor(Math.random() * PH.ROADS.length)];
      if (pu % 2 === 0) pd.position.set(pr + (Math.random() * 14 - 7), 0.03, Math.random() * 380 - 190);
      else pd.position.set(Math.random() * 380 - 190, 0.03, pr + (Math.random() * 14 - 7));
      pd.scale.set(2 + Math.random() * 3, 1.2 + Math.random() * 1.6, 1);
      scene.add(pd);
      puddleMats.push(pm);
    }

    // ---------- dynamic pools ----------
    // People: instanced batches (reference §10) — 5-sided cylinder torso,
    // icosahedron head, legs, pelvis block (legs never detach), hair cap,
    // 2 accessories per person, blob shadow.
    var MAXP = 900;
    var bodyIM = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.265, 0.265, 0.60, 5), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var headIM = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.16, 0), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    // Articulated limbs (reference §10): two legs that swing with the walk
    // phase, two arms swinging opposite, shoes at the feet — so people read
    // as jointed figures, not chess pawns.
    var legLIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.19, 0.78, 0.21), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var legRIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.15, 0.5, 0.2), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var armLIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.11, 0.45, 0.14), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var armRIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.11, 0.45, 0.14), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var shoeLIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.09, 0.3), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var shoeRIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.09, 0.3), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var pelvisIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.36, 0.12, 0.22), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var hairIM = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 8, 6), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var accIM = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP * 2);
    var blobIM = new THREE.InstancedMesh(new THREE.CircleGeometry(0.5, 10),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false }), MAXP);
    bodyIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    headIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    legLIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    legRIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    armLIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    armRIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shoeLIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shoeRIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pelvisIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    hairIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    accIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    blobIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bodyIM.frustumCulled = false; headIM.frustumCulled = false;
    legLIM.frustumCulled = false; legRIM.frustumCulled = false;
    armLIM.frustumCulled = false; armRIM.frustumCulled = false;
    shoeLIM.frustumCulled = false; shoeRIM.frustumCulled = false;
    pelvisIM.frustumCulled = false; hairIM.frustumCulled = false; accIM.frustumCulled = false; blobIM.frustumCulled = false;
    scene.add(bodyIM); scene.add(headIM);
    scene.add(legLIM); scene.add(legRIM); scene.add(armLIM); scene.add(armRIM);
    scene.add(shoeLIM); scene.add(shoeRIM);
    scene.add(pelvisIM); scene.add(hairIM); scene.add(accIM); scene.add(blobIM);
    var hideMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    var tmpColor = new THREE.Color();
    var hairColors = [0x2a1a12, 0x6a4a2a, 0x1a1a1a, 0xb8a888, 0x8a3a2a];

    // Vehicles: one Group per car, built from shared geometries.
    var carGeo = {
      wheel: new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10),
      hub: new THREE.CylinderGeometry(0.2, 0.2, 0.34, 8),
      wing: new THREE.BoxGeometry(2.0, 0.07, 0.45),
      bar: new THREE.BoxGeometry(1.6, 0.22, 0.4),
      sign: new THREE.BoxGeometry(0.9, 0.25, 0.5)
    };
    var carGroups = new Map();
    function darkened(hex, f) {
      var c = new THREE.Color(hex);
      c.multiplyScalar(f);
      return c.getHex();
    }
    function makeCarGroup(car) {
      var g = new THREE.Group();
      var bodyM = new THREE.MeshLambertMaterial({ color: car.color });
      var glassM = new THREE.MeshLambertMaterial({ color: 0x395368 });
      var isSport = car.type === 'sport', isVan = car.type === 'van';
      // 5-section shell (reference §8.1): nose / shoulders / cabin / tail each
      // carry their own width and height, so the silhouettes differ.
      var secs;
      if (isVan) {
        secs = [
          { w: 1.95, h: 0.6, len: 1.0, z: 1.95, y: 0.58, m: bodyM },
          { w: 2.05, h: 0.9, len: 1.6, z: 0.4, y: 0.62, m: bodyM },
          { w: 1.95, h: 1.0, len: 2.2, z: -1.2, y: 0.95, m: bodyM },
          { w: 1.95, h: 0.55, len: 0.9, z: -2.35, y: 0.55, m: bodyM }
        ];
      } else {
        var yb = isSport ? 0.48 : 0.55, hb = isSport ? 0.88 : 1;
        secs = [
          { w: 1.85, h: 0.5 * hb, len: 0.9, z: 1.55, y: yb, m: bodyM },
          { w: 2.0, h: 0.62 * hb, len: 1.3, z: 0.45, y: yb, m: bodyM },
          { w: 1.7, h: 0.62 * hb, len: 1.5, z: -0.55, y: (isSport ? 0.92 : 1.02), m: glassM },
          { w: 1.95, h: 0.55 * hb, len: 0.9, z: -1.75, y: yb, m: bodyM }
        ];
      }
      secs.forEach(function (s) {
        var m = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.len), s.m);
        m.position.set(0, s.y, s.z);
        m.castShadow = true;
        g.add(m);
      });
      // GFX1 details: grille, two-tone rocker, beltline, mirrors, indicators,
      // headlights, taillights + full-width tail bar.
      var rockerM = new THREE.MeshLambertMaterial({ color: darkened(car.color, 0.58) });
      var frontZ = isVan ? 2.45 : 2.0, rearZ = isVan ? -2.8 : -2.2;
      var grille = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.18, 0.08), mat(0x22282f));
      grille.position.set(0, 0.5, frontZ + 0.02);
      g.add(grille);
      [-1, 1].forEach(function (s) {
        var rock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 2.6), rockerM);
        rock.position.set(s * 1.0, 0.32, -0.1);
        g.add(rock);
        var belt = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 3.6), mat(0xd9dee2));
        belt.position.set(s * 1.02, 0.92, -0.1);
        g.add(belt);
        var mir = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.18), mat(0x2c3138));
        mir.position.set(s * 1.08, 1.0, 0.4);
        g.add(mir);
        var ind = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.06), mat(0xffb85a));
        ind.position.set(s * 0.8, 0.62, frontZ + 0.02);
        g.add(ind);
        var hl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.06), mat(0xffefd4));
        hl.position.set(s * 0.65, 0.62, frontZ + 0.02);
        g.add(hl);
        var tl = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.06), mat(0xff555e));
        tl.position.set(s * 0.65, 0.62, rearZ - 0.02);
        g.add(tl);
      });
      var tailBar = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.08, 0.05), mat(0xff555e));
      tailBar.position.set(0, 0.62, rearZ - 0.02);
      g.add(tailBar);
      var wheels = [];
      var wz = isVan ? 1.6 : 1.45;
      [[-1.0, wz], [1.0, wz], [-1.0, -wz], [1.0, -wz]].forEach(function (wp) {
        var wg = new THREE.Group();
        var tire = new THREE.Mesh(carGeo.wheel, mat(0x292b37));
        tire.rotation.z = Math.PI / 2;
        wg.add(tire);
        var hub = new THREE.Mesh(carGeo.hub, mat(0xa6b3b8));
        hub.rotation.z = Math.PI / 2;
        wg.add(hub);
        wg.position.set(wp[0], 0.42, wp[1]);
        g.add(wg); wheels.push(wg);
      });
      var extras = {};
      if (car.taxi) {
        var sign = new THREE.Mesh(carGeo.sign, mat(0xffe497, { emissive: 0xffe497, emissiveIntensity: 0.7 }));
        sign.position.set(0, 1.45, -0.3);
        g.add(sign); extras.sign = sign;
      }
      if (isSport) {
        var split = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 0.4), mat(0x22252e));
        split.position.set(0, 0.3, frontZ + 0.1);
        g.add(split);
        var wing = new THREE.Mesh(carGeo.wing, bodyM);
        wing.position.set(0, 0.95, -2.35);
        g.add(wing);
        [-0.8, 0.8].forEach(function (px) {
          var post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.08), bodyM);
          post.position.set(px, 0.78, -2.35);
          g.add(post);
        });
      }
      if (isVan) {
        var seam = new THREE.Mesh(new THREE.BoxGeometry(2.06, 0.1, 0.1), mat(0x5a6a7a));
        seam.position.set(0, 0.8, 0);
        g.add(seam);
      }
      if (car.police) {
        // Blue livery stripes + roof bar trim (reference §8.2).
        var liv = mat(0x24456a);
        [-1, 1].forEach(function (s) {
          var stripe = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 3.0), liv);
          stripe.position.set(s * 1.01, 0.6, -0.1);
          g.add(stripe);
        });
        var hood = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 1.0), liv);
        hood.position.set(0, 0.82, 1.5);
        g.add(hood);
        var trunk = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.8), liv);
        trunk.position.set(0, 0.82, -1.7);
        g.add(trunk);
        var roofBar = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 0.4), mat(0x1c314c));
        roofBar.position.set(0, 1.38, -0.3);
        g.add(roofBar);
        // Lightbar: pink-red left / blue right, flashing only in pursuit.
        var bar = new THREE.Mesh(carGeo.bar, mat(0x222222));
        bar.position.set(0, 1.4, -0.3);
        g.add(bar);
        var rl = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.3), new THREE.MeshBasicMaterial({ color: 0x79314d }));
        rl.position.set(-0.45, 1.55, -0.3);
        g.add(rl);
        var bl = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.3), new THREE.MeshBasicMaterial({ color: 0x2b508a }));
        bl.position.set(0.45, 1.55, -0.3);
        g.add(bl);
        extras.red = rl; extras.blue = bl;
        // Transparent cabin: the officer inside is visible (reference §8.2).
        secs[2].m = new THREE.MeshLambertMaterial({ color: 0x395368, transparent: true, opacity: 0.37 });
        var cabinMesh = g.children[2];
        cabinMesh.material = secs[2].m;
        var drv = new THREE.Group();
        var torso = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.25), mat(0x1d3550));
        torso.position.y = 0.25;
        drv.add(torso);
        var dhead = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), mat(0xc98b65));
        dhead.position.y = 0.62;
        drv.add(dhead);
        var hat = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.3), mat(0x101d30));
        hat.position.y = 0.76;
        drv.add(hat);
        drv.position.set(-0.4, 0.62, -0.5);
        g.add(drv);
      }
      // Headlight cones + pool (PLN, reference §5/§8.1): two cones + pool,
      // toggled at night for occupied cars in syncCar.
      var coneMat = new THREE.MeshBasicMaterial({ color: 0xffe9bb, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      var cones = [];
      [-0.65, 0.65].forEach(function (cx) {
        var cone = new THREE.Mesh(new THREE.ConeGeometry(0.55, 7.5, 8, 1, true), coneMat);
        cone.rotation.x = -Math.PI / 2 + 0.045;
        cone.position.set(cx, 0.45, frontZ + 3.75);
        cone.visible = false;
        g.add(cone); cones.push(cone);
      });
      var poolMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, map: radialTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      var pool = new THREE.Mesh(new THREE.CircleGeometry(2.0, 14), poolMat);
      pool.rotation.x = -Math.PI / 2;
      pool.scale.set(1.2, 1.8, 1);
      pool.position.set(0, 0.05, frontZ + 7.0);
      pool.visible = false;
      g.add(pool);
      extras.cones = cones; extras.coneMat = coneMat; extras.pool = pool; extras.poolMat = poolMat;
      // Blob shadow.
      var blob = new THREE.Mesh(new THREE.PlaneGeometry(3, 5.6),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false }));
      blob.rotation.x = -Math.PI / 2; blob.position.y = 0.03;
      g.add(blob);
      g.userData = { car: car, wheels: wheels, extras: extras, bodyM: bodyM };
      scene.add(g);
      return g;
    }
    function makeTowGroup(car) {
      var g = new THREE.Group();
      var paintM = new THREE.MeshLambertMaterial({ color: 0xeeb54e });
      var cab = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.5, 1.6), paintM);
      cab.position.set(0, 0.95, 1.4); cab.castShadow = true;
      g.add(cab);
      var deck = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.25, 4.2), mat(0x263744));
      deck.position.set(0, 0.75, -1.2);
      g.add(deck);
      var frame = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.3, 5.6), mat(0x344958));
      frame.position.set(0, 0.45, 0);
      g.add(frame);
      var wheels = [];
      [[-1.0, 1.6], [1.0, 1.6], [-1.0, -0.8], [1.0, -0.8], [-1.0, -2.2], [1.0, -2.2]].forEach(function (wp) {
        var w = new THREE.Mesh(carGeo.wheel, mat(0x292b37));
        w.rotation.z = Math.PI / 2;
        w.position.set(wp[0], 0.42, wp[1]);
        g.add(w); wheels.push(w);
      });
      // Industrial A-frame behind the cab + amber beacon + reflective strips.
      [-0.7, 0.7].forEach(function (px) {
        var post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.6, 0.12), paintM);
        post.position.set(px, 1.6, -0.2);
        post.rotation.x = -0.35;
        g.add(post);
      });
      var cross = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 0.12), paintM);
      cross.position.set(0, 2.3, -0.55);
      g.add(cross);
      var beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffc24d }));
      beacon.position.set(0, 1.85, 1.4);
      g.add(beacon);
      [-1, 1].forEach(function (s) {
        var strip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 4.0), mat(0xffdf83));
        strip.position.set(s * 1.01, 0.8, -1.2);
        g.add(strip);
      });
      // Tow cable (sagging line to the target car) + 3-segment yellow hook.
      var cableGeo = new THREE.BufferGeometry();
      cableGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
      var cable = new THREE.Line(cableGeo, new THREE.LineBasicMaterial({ color: 0xa7b8bd }));
      cable.frustumCulled = false;
      scene.add(cable);
      var hook = new THREE.Group();
      for (var hi = 0; hi < 3; hi++) {
        var seg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.18, 0.12), mat(0xf4c15e));
        seg.position.y = -hi * 0.18;
        hook.add(seg);
      }
      scene.add(hook);
      var blob = new THREE.Mesh(new THREE.PlaneGeometry(3, 6.4),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false }));
      blob.rotation.x = -Math.PI / 2; blob.position.y = 0.03;
      g.add(blob);
      g.userData = { car: car, wheels: wheels, extras: { beacon: beacon, cable: cable, hook: hook }, bodyM: paintM };
      scene.add(g);
      return g;
    }
    function makeAmbulanceGroup(car) {
      var g = new THREE.Group();
      var whiteM = new THREE.MeshLambertMaterial({ color: 0xf2f3e9 });
      var comp = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.9, 3.4), whiteM);
      comp.position.set(0, 1.15, -0.8); comp.castShadow = true;
      g.add(comp);
      var cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.2, 1.6), new THREE.MeshLambertMaterial({ color: 0x365e70 }));
      cab.position.set(0, 0.9, 1.6);
      g.add(cab);
      // Teal + lime side stripes; small teal cross on the rear double doors.
      [-1, 1].forEach(function (s) {
        var ts = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.25, 3.4), mat(0x178d88));
        ts.position.set(s * 1.11, 1.0, -0.8);
        g.add(ts);
        var ls = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 3.4), mat(0xd9ef80));
        ls.position.set(s * 1.11, 0.72, -0.8);
        g.add(ls);
      });
      var crossV = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.5, 0.06), mat(0x178d88));
      crossV.position.set(0, 1.3, -2.53);
      g.add(crossV);
      var crossH = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.06), mat(0x178d88));
      crossH.position.set(0, 1.3, -2.53);
      g.add(crossH);
      var bumper = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.3, 0.2), mat(0x344958));
      bumper.position.set(0, 0.35, -2.55);
      g.add(bumper);
      var wheels = [];
      [[-1.0, 1.6], [1.0, 1.6], [-1.0, -1.6], [1.0, -1.6]].forEach(function (wp) {
        var w = new THREE.Mesh(carGeo.wheel, mat(0x292b37));
        w.rotation.z = Math.PI / 2;
        w.position.set(wp[0], 0.42, wp[1]);
        g.add(w); wheels.push(w);
      });
      var strobeB = new THREE.Mesh(new THREE.SphereGeometry(0.14, 6, 6), new THREE.MeshBasicMaterial({ color: 0x61d7ff }));
      strobeB.position.set(-0.5, 2.2, -0.8);
      g.add(strobeB);
      var strobeA = new THREE.Mesh(new THREE.SphereGeometry(0.14, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffc24d }));
      strobeA.position.set(0.5, 2.2, -0.8);
      g.add(strobeA);
      [-1, 1].forEach(function (s) {
        var tl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.06), mat(0xffc24d));
        tl.position.set(s * 0.8, 0.6, -2.53);
        g.add(tl);
      });
      var blob = new THREE.Mesh(new THREE.PlaneGeometry(3, 6.0),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false }));
      blob.rotation.x = -Math.PI / 2; blob.position.y = 0.03;
      g.add(blob);
      g.userData = { car: car, wheels: wheels, extras: { strobeB: strobeB, strobeA: strobeA }, bodyM: whiteM };
      scene.add(g);
      return g;
    }
    function makeBikeGroup(car) {
      var g = new THREE.Group();
      var bodyM = new THREE.MeshLambertMaterial({ color: car.color });
      var engine = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 1.1), mat(0x2b2f38));
      engine.position.y = 0.62;
      g.add(engine);
      var tank = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.35, 0.9), bodyM);
      tank.position.set(0, 0.98, 0.25);
      g.add(tank);
      var spine = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.9), mat(0xd9dee2));
      spine.position.set(0, 1.17, 0.25);
      g.add(spine);
      var seat = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.8), mat(0x22252e));
      seat.position.set(0, 0.95, -0.45);
      g.add(seat);
      var fork = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 6), mat(0x59666b));
      fork.position.set(0, 0.85, 0.85);
      fork.rotation.x = 0.5;
      g.add(fork);
      var bars = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 0.06), mat(0x22252e));
      bars.position.set(0, 1.08, 0.72);
      g.add(bars);
      var fender = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.08, 0.7), bodyM);
      fender.position.set(0, 0.85, 0.95);
      g.add(fender);
      var hl = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.06), mat(0xffefd4));
      hl.position.set(0, 0.95, 1.15);
      g.add(hl);
      var tl = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.06), mat(0xff555e));
      tl.position.set(0, 0.9, -0.95);
      g.add(tl);
      var pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.1, 6), mat(0x8d9fad));
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(0.25, 0.45, -0.3);
      g.add(pipe);
      var w1 = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.09, 6, 12), mat(0x292b37));
      w1.position.set(0, 0.42, 0.95); g.add(w1);
      var w2 = w1.clone(); w2.position.z = -0.95; g.add(w2);
      var hub1 = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 8), mat(0xa6b3b8));
      hub1.rotation.z = Math.PI / 2; hub1.position.set(0, 0.42, 0.95); g.add(hub1);
      var hub2 = hub1.clone(); hub2.position.z = -0.95; g.add(hub2);
      // NPC rider: leaning torso + helmet (reference §8.3).
      var rider = new THREE.Group();
      var rTorso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.28), mat(0x434958));
      rTorso.position.y = 0.3;
      rider.add(rTorso);
      var helmet = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6),
        mat([0xe46c70, 0xf4bb45, 0x3cc8cf, 0xede4cf][car.id % 4]));
      helmet.position.y = 0.72;
      rider.add(helmet);
      rider.position.set(0, 0.95, -0.35);
      rider.rotation.x = 0.5;
      g.add(rider);
      g.userData = { car: car, wheels: [w1, w2], extras: { rider: rider }, bodyM: bodyM };
      scene.add(g);
      return g;
    }
    function makeBoatGroup(car) {
      var g = new THREE.Group();
      var hull = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 6.4), new THREE.MeshLambertMaterial({ color: car.color }));
      hull.position.y = 0.35;
      g.add(hull);
      var bow = new THREE.Mesh(new THREE.ConeGeometry(1.1, 1.6, 4), new THREE.MeshLambertMaterial({ color: car.color }));
      bow.rotation.x = Math.PI / 2; bow.rotation.y = Math.PI / 4;
      bow.position.set(0, 0.35, 3.8);
      g.add(bow);
      var rail = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.1, 6.5), mat(0x1a2a30));
      rail.position.y = 0.68;
      g.add(rail);
      var deck = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 4.6), mat(0x2e4a56));
      deck.position.y = 0.72;
      g.add(deck);
      var console = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.6), mat(0xe46b4e));
      console.position.set(0, 1.05, 0.6);
      g.add(console);
      var shield = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.08), mat(0x395368));
      shield.position.set(0, 1.45, 0.85);
      shield.rotation.x = -0.25;
      g.add(shield);
      var bench = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.18, 0.7), mat(0xf0ead8));
      bench.position.set(0, 0.85, -1.4);
      g.add(bench);
      var stripe = new THREE.Mesh(new THREE.BoxGeometry(2.24, 0.14, 0.5), mat(0xe46b4e));
      stripe.position.set(0, 0.5, 1.5);
      g.add(stripe);
      var bowLight = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), new THREE.MeshBasicMaterial({ color: 0xfff2cf }));
      bowLight.position.set(0, 0.8, 3.2);
      g.add(bowLight);
      // Foam trail behind the stern when moving (reference §11).
      var foam = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 4.5),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
      foam.rotation.x = -Math.PI / 2;
      foam.position.set(0, -0.4, -4.5);
      foam.visible = false;
      g.add(foam);
      g.userData = { car: car, wheels: [], extras: { foam: foam }, bodyM: hull.material };
      scene.add(g);
      return g;
    }

    // Helicopters: 3 rigs (reference §9). Elongated-ball body, blue belly,
    // glass canopy, tail boom + fin + stabilizer, steel skids with struts.
    var heliGroups = [];
    for (var hi = 0; hi < 3; hi++) {
      var hg = new THREE.Group();
      var hBody = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshPhongMaterial({ color: 0xe9ece8, shininess: 30 }));
      hBody.scale.set(2.7, 1.7, 4.3);
      hg.add(hBody);
      var belly = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.5, 3.6), mat(0x244b6b));
      belly.position.y = -0.8;
      hg.add(belly);
      var glass = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.8, 1.2),
        new THREE.MeshPhongMaterial({ color: 0x67b8cb, specular: 0xd8ffff, shininess: 60, transparent: true, opacity: 0.82 }));
      glass.position.set(0, 0.3, 1.9);
      hg.add(glass);
      var sideStripe = new THREE.Mesh(new THREE.BoxGeometry(2.72, 0.22, 3.6), mat(0x244b6b));
      sideStripe.position.y = -0.2;
      hg.add(sideStripe);
      var tail = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.4, 4.4, 6), mat(0xe9ece8));
      tail.rotation.x = Math.PI / 2;
      tail.position.set(0, 0.3, -4.2);
      hg.add(tail);
      var fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.3, 0.9), mat(0x244b6b));
      fin.position.set(0, 0.9, -6.0);
      hg.add(fin);
      var stab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.08, 0.5), mat(0x244b6b));
      stab.position.set(0, 0.4, -5.6);
      hg.add(stab);
      var rotor = new THREE.Mesh(new THREE.BoxGeometry(13, 0.085, 0.2), mat(0x252d38));
      rotor.position.y = 0.95;
      hg.add(rotor);
      var rotor2 = rotor.clone();
      rotor2.rotation.y = Math.PI / 2;
      hg.add(rotor2);
      var tailRotor = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.55, 0.12), mat(0x252d38));
      tailRotor.position.set(0.3, 0.4, -6.2);
      hg.add(tailRotor);
      var navR = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff4455 }));
      navR.position.set(-1.15, 0, 0); hg.add(navR);
      var navG = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), new THREE.MeshBasicMaterial({ color: 0x55ffc2 }));
      navG.position.set(1.15, 0, 0); hg.add(navG);
      var beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff404a }));
      beacon.position.set(0, 0.85, -1); hg.add(beacon);
      var skidMat = mat(0x414b55);
      [-0.9, 0.9].forEach(function (sx) {
        var skid = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 3.4), skidMat);
        skid.position.set(sx, -1.1, 0);
        hg.add(skid);
        [-1.2, 1.2].forEach(function (sz) {
          var strut = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 5), skidMat);
          strut.position.set(sx, -0.7, sz);
          strut.rotation.x = sx > 0 ? 0.5 : -0.5;
          hg.add(strut);
        });
      });
      // Searchlight: real SpotLight + additive cone + ground disk + ring.
      // The cone lives in scene space so it can stretch heli-to-ground.
      var spot = new THREE.SpotLight(0xffe9ad, 0, 620, 0.12, 0.24);
      var spotTarget = new THREE.Object3D();
      scene.add(spot); scene.add(spotTarget);
      spot.target = spotTarget;
      var cone = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffedb7, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
      cone.visible = false;
      scene.add(cone);
      var disk = new THREE.Mesh(new THREE.CircleGeometry(4.5, 20),
        new THREE.MeshBasicMaterial({ color: 0xffe6a2, map: radialTex, transparent: true, opacity: 0.27, blending: THREE.AdditiveBlending, depthWrite: false }));
      disk.rotation.x = -Math.PI / 2;
      disk.visible = false;
      scene.add(disk);
      var ring = new THREE.Mesh(new THREE.RingGeometry(2.35, 2.72, 24),
        new THREE.MeshBasicMaterial({ color: 0xffe6a2, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      scene.add(ring);
      hg.userData = { rotor: rotor, rotor2: rotor2, tailRotor: tailRotor, cone: cone, disk: disk, ring: ring, beacon: beacon, spot: spot, spotTarget: spotTarget };
      hg.visible = false;
      scene.add(hg);
      heliGroups.push(hg);
    }

    // Objective marker: ring + crystal + beam.
    var marker = new THREE.Group();
    var mRing = new THREE.Mesh(new THREE.RingGeometry(0.77, 1, 24),
      new THREE.MeshBasicMaterial({ color: 0xff946a, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    mRing.rotation.x = -Math.PI / 2; mRing.position.y = 0.1;
    marker.add(mRing);
    var mCrystal = new THREE.Mesh(new THREE.OctahedronGeometry(1.05),
      new THREE.MeshBasicMaterial({ color: 0x92f6d1 }));
    mCrystal.position.y = 2.2;
    marker.add(mCrystal);
    var mBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 9.3, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff946a, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
    mBeam.position.y = 4.65;
    marker.add(mBeam);
    scene.add(marker);
    // Shot tracers (reference §12): player 0xffe6a6, enemy 0xff7f82.
    var tracers = [];
    for (var ti = 0; ti < 24; ti++) {
      var tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      var tl = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0xffe6a6, transparent: true, opacity: 0.9 }));
      tl.frustumCulled = false;
      tl.visible = false;
      scene.add(tl);
      tracers.push(tl);
    }
    // Waypoint diamond.
    var waypoint = new THREE.Mesh(new THREE.OctahedronGeometry(0.8),
      new THREE.MeshBasicMaterial({ color: 0xff8d7c }));
    waypoint.position.y = 3;
    scene.add(waypoint);
    // Shell markers: small gold rings (bob with sin).
    var shellRings = [];
    for (var shi = 0; shi < 20; shi++) {
      var sr = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.65, 16),
        new THREE.MeshBasicMaterial({ color: 0xf8cf69, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
      sr.rotation.x = -Math.PI / 2;
      scene.add(sr);
      shellRings.push(sr);
    }

    // ---------- camera state ----------
    var cam = { yaw: game.player.yaw, pitch: 0.16, dist: 9, lookIdle: 0 };
    var plnNightF = 0;
    var frames = 0, presentAcc = 0, fps = 30;
    var lastPresent = 0;

    function daylight(clock) {
      // Light factor 0..1 across the day; golden hour near the edges.
      var light = 1;
      if (clock < 6) light = 0.14;
      else if (clock < 7) light = 0.14 + (clock - 6) * 0.86;
      else if (clock < 17) light = 1;
      else if (clock < 18.5) light = 1 - (clock - 17) * 0.55;
      else light = 0.14;
      return light;
    }
    function stormAmp() {
      var w = game.extras.weather;
      return (w && w.active) ? w.intensity : 0;
    }
    // Ray state shared by the camera: the parking test slices
    // cameraDistance verbatim and calls it with these three names as
    // free variables, so they live at world scope and follow() sets
    // them before every cameraDistance call.
    var buildings = null, target = null, fullOffset = null;
    function cameraDistance(distance) {
      // Pull the camera in when a building blocks the ray (min 0.70).
      // The ray runs from the target (eye height) along fullOffset; a
      // demolished building never blocks it, so the camera never
      // collapses inside the Sunstrand lot.
      var d = distance;
      var steps = 12;
      for (var i = 1; i <= steps; i++) {
        var t = (i / steps) * distance;
        var x = target.x + fullOffset.x * (t / distance);
        var z = target.z + fullOffset.z * (t / distance);
        var y = target.y + fullOffset.y * (t / distance);
        var hit = Math.abs(x) > 216 || Math.abs(z) > 216;
        if (!hit) {
          for (var bi = 0; bi < buildings.length; bi++) {
            var b = buildings[bi];
            if (b.demolished) continue;
            if (x > b.minX - 0.4 && x < b.maxX + 0.4 && z > b.minZ - 0.4 && z < b.maxZ + 0.4) { hit = true; break; }
          }
        }
        if (hit && y < 12) { d = Math.max(0.7, t - 0.6); break; }
      }
      return d;
    }
    function follow(dt, player, car, orbit) {
      var p = player;
      if (orbit.lookDX || orbit.lookDY) {
        orbit.yaw -= orbit.lookDX * 0.004;
        orbit.pitch = clamp(orbit.pitch + orbit.lookDY * 0.003, -1.15, 1.24);
        orbit.lookIdle = 0;
      } else orbit.lookIdle += dt;
      var driving = car !== null && Math.abs(p.speed) > 2;
      if (driving && orbit.lookIdle > 1.8) {
        orbit.yaw += PH.angle(orbit.yaw, p.yaw) * Math.min(1, dt * 1.6);
      }
      var want = orbit.zoom || (car !== null ? 10.5 : 8);
      buildings = game.city.buildings;
      target = { x: p.x, y: p.y + 1.4, z: p.z };
      var horiz = Math.cos(orbit.pitch);
      fullOffset = { x: -Math.cos(orbit.yaw) * horiz * want, y: Math.sin(orbit.pitch) * want, z: -Math.sin(orbit.yaw) * horiz * want };
      var got = cameraDistance(want);
      orbit.dist += (got - orbit.dist) * Math.min(1, dt * 8);
      var cx = target.x + fullOffset.x * (orbit.dist / want);
      var cz = target.z + fullOffset.z * (orbit.dist / want);
      var cy = target.y + fullOffset.y * (orbit.dist / want);
      var k = 1 - Math.exp(-dt * 13);
      camera.position.x += (cx - camera.position.x) * k;
      camera.position.y += (cy - camera.position.y) * k;
      camera.position.z += (cz - camera.position.z) * k;
      if (dist(camera.position.x, camera.position.z, target.x, target.z) > 32) {
        camera.position.set(cx, cy, cz);
      }
      camera.lookAt(target.x, target.y - 0.2, target.z);
    }
    function headlights() {
      // Headlight cones on the player's car + police cars at night.
      return plnNightF;
    }

    // Person color + accessories by role (reference §10).
    function personColor(kind, ref) {
      if (kind === 'hero') return {
        body: 0x3ca7b6, legs: 0x2a2a33, skin: 0xb9744e, hair: 0x34313d, shoes: 0xf1e8d0,
        acc: [
          { c: 0xe46b4e, x: 0, y: 1.08, z: -0.22, sx: 0.34, sy: 0.42, sz: 0.16 },
          { c: 0xffcf75, x: 0, y: 1.08, z: -0.31, sx: 0.34, sy: 0.08, sz: 0.04 },
          { c: 0x293c54, x: 0.28, y: 1.0, z: 0.05, sx: 0.08, sy: 0.42, sz: 0.06 }
        ]
      };
      if (kind === 'officer') return {
        body: 0x254164, legs: 0x22334e, skin: 0xd8a878, hair: 0x203753, shoes: 0x172233,
        acc: [
          { c: 0xf4ce83, x: 0, y: 1.15, z: 0.20, sx: 0.12, sy: 0.08, sz: 0.04 },
          { c: 0x17293e, x: 0, y: 1.08, z: 0.20, sx: 0.36, sy: 0.2, sz: 0.05 },
          { c: 0x192331, x: 0.28, y: 1.0, z: 0.1, sx: 0.08, sy: 0.36, sz: 0.06 },
          { c: 0x1a273c, x: 0, y: 0.86, z: 0, sx: 0.56, sy: 0.07, sz: 0.40 },
          { c: 0x8d9fad, x: 0, y: 0.86, z: 0.21, sx: 0.10, sy: 0.06, sz: 0.04 }
        ]
      };
      if (kind === 'enemy') return {
        body: 0x873b47, legs: 0x272b3e, skin: 0xc68c66, hair: 0x322637, shoes: 0x222222,
        acc: [
          { c: 0xec6976, x: 0, y: 1.15, z: 0.20, sx: 0.14, sy: 0.1, sz: 0.04 },
          { c: 0x2c303e, x: 0.28, y: 1.0, z: 0.1, sx: 0.08, sy: 0.4, sz: 0.06 }
        ]
      };
      if (kind === 'contact') return {
        body: PH.CHECKPOINT_COLORS[ref % 5], legs: 0x2a2a33, skin: 0xd8a878, hair: PH.CHECKPOINT_COLORS[ref % 5], shoes: 0x222222,
        acc: [{ c: 0xffedb8, x: 0, y: 1.15, z: 0.20, sx: 0.12, sy: 0.1, sz: 0.04 }]
      };
      if (kind === 'taxiPassenger') return {
        body: 0xf8cf69, legs: 0x3a3a44, skin: 0xd8a878, hair: 0x34313d, shoes: 0x222222, acc: []
      };
      if (kind === 'medic') return {
        body: 0x208e91, legs: 0x275360, skin: 0xc9e6df, hair: 0x1a2a30, shoes: 0x222222, acc: []
      };
      if (kind === 'towman') return {
        body: 0xf3ae4c, legs: 0x35465b, skin: 0xc98b65, hair: 0x34313d, shoes: 0x222222, acc: []
      };
      if (kind === 'ped') return {
        body: ref.color, legs: ref.pants, skin: ref.skin, hair: ref.hair, shoes: 0x222222, acc: []
      };
      return { body: 0x888888, legs: 0x333333, skin: 0xc98b65, hair: 0x1a1a1a, shoes: 0x222222, acc: [] };
    }
    var accSlot = 0;
    function syncPerson(idx, x, z, y, yaw, size, colors, detail, bobPhase, stride) {
      var s = size || 1;
      var bob = detail ? Math.abs(Math.sin((game.time + bobPhase) * 5)) * 0.03 : 0;
      var swing = (stride || 0) * 0.5 * Math.sin((game.time + bobPhase) * 5);
      var cos = Math.cos(yaw), sin = Math.sin(yaw);
      var shoeCol = colors.shoes === undefined ? 0x222222 : colors.shoes;
      // One limb, swung around its hip/shoulder pivot: the limb centre sits
      // half its length below the pivot, rotated by the swing angle, so the
      // legs and arms read as joints that move, not a single pawn block.
      function limb(mesh, lx, py, len, ang, color) {
        var ox = lx, oy = py - (len / 2) * Math.cos(ang), oz = -(len / 2) * Math.sin(ang);
        dummy.position.set(x + (ox * cos + oz * sin) * s, oy * s + bob + y, z + (-ox * sin + oz * cos) * s);
        dummy.rotation.order = 'YXZ';
        dummy.rotation.set(ang, yaw, 0);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);
        mesh.setColorAt(idx, tmpColor.setHex(color));
        dummy.rotation.order = 'XYZ';
      }
      function shoe(mesh, lx, ang) {
        var fx = lx, fy = 0.78 - 0.78 * Math.cos(ang) + 0.045, fz = -0.78 * Math.sin(ang) + 0.05;
        dummy.position.set(x + (fx * cos + fz * sin) * s, fy * s + bob + y, z + (-fx * sin + fz * cos) * s);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);
        mesh.setColorAt(idx, tmpColor.setHex(shoeCol));
      }
      dummy.position.set(x, 1.08 * s + bob + y, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(s, s, 0.7 * s);
      dummy.updateMatrix();
      bodyIM.setMatrixAt(idx, dummy.matrix);
      bodyIM.setColorAt(idx, tmpColor.setHex(colors.body));
      dummy.position.set(x, 1.57 * s + bob + y, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(s, 1.2 * s, s);
      dummy.updateMatrix();
      headIM.setMatrixAt(idx, dummy.matrix);
      headIM.setColorAt(idx, tmpColor.setHex(colors.skin));
      // Legs swing opposite each other; arms swing opposite their own side's leg.
      limb(legLIM, -0.09, 0.78, 0.78, -swing, colors.legs);
      limb(legRIM, 0.09, 0.78, 0.78, swing, colors.legs);
      limb(armLIM, -0.28, 1.32, 0.45, swing, colors.body);
      limb(armRIM, 0.28, 1.32, 0.45, -swing, colors.body);
      shoe(shoeLIM, -0.09, -swing);
      shoe(shoeRIM, 0.09, swing);
      // Pelvis block connects the waist so legs never detach (reference §10).
      dummy.position.set(x, 0.78 * s + bob + y, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      pelvisIM.setMatrixAt(idx, dummy.matrix);
      pelvisIM.setColorAt(idx, tmpColor.setHex(colors.legs));
      // Hair cap (officer cap / contact hat sewarna baju).
      dummy.position.set(x, 1.72 * s + bob + y, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(s, 0.6 * s, s);
      dummy.updateMatrix();
      hairIM.setMatrixAt(idx, dummy.matrix);
      hairIM.setColorAt(idx, tmpColor.setHex(colors.hair));
      // Accessories in person-local space (x right, z forward).
      (colors.acc || []).forEach(function (a) {
        if (accSlot >= MAXP * 2) return;
        var wx = x + (a.x * cos + a.z * sin) * s;
        var wz = z + (-a.x * sin + a.z * cos) * s;
        dummy.position.set(wx, a.y * s + bob + y, wz);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(a.sx * s, a.sy * s, a.sz * s);
        dummy.updateMatrix();
        accIM.setMatrixAt(accSlot, dummy.matrix);
        accIM.setColorAt(accSlot, tmpColor.setHex(a.c));
        accSlot++;
      });
      // Blob shadow on the ground.
      dummy.position.set(x, 0.04, z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      blobIM.setMatrixAt(idx, dummy.matrix);
    }

    function update(dt, input) {
      var p = game.player;
      var clock = game.clock;
      var storm = stormAmp();
      // Day / night.
      var light = daylight(clock);
      var golden = (clock > 17 && clock < 18.5) || (clock >= 6 && clock < 7);
      sun.intensity = (2.06 * light + 0.13) * (1 - 0.5 * storm);
      sun.color = hexLerp(0xffe9c9, 0xff9a52, golden ? 0.7 : 0);
      hemi.intensity = 1.22 * light + 0.45;
      hemi.color.copy(hexLerp(0x8b9aca, 0xffefd8, light));
      // Sun position swings with the clock.
      var sunAngle = ((clock - 6) / 12) * Math.PI;
      sun.position.set(Math.cos(sunAngle) * -80, 30 + Math.sin(sunAngle) * 60, -38);
      // The shadow frustum follows the camera (reference §2).
      sun.target.position.set(camera.position.x, 0, camera.position.z);
      sun.target.updateMatrixWorld();
      // Sky colours.
      var horizon, zenith;
      if (light > 0.6) { horizon = new THREE.Color(0xbfe3da); zenith = new THREE.Color(0x4ba6d6); }
      else if (light > 0.3) { horizon = new THREE.Color(0xf8bd8d); zenith = new THREE.Color(0x4a6a9a); }
      else { horizon = new THREE.Color(0x333f6b); zenith = new THREE.Color(0x101736); }
      if (storm > 0.3) {
        horizon.lerp(new THREE.Color(0x67707c), storm * 0.6);
        zenith.lerp(new THREE.Color(0x39424e), storm * 0.6);
      }
      skyUniforms.topColor.value.copy(zenith);
      skyUniforms.bottomColor.value.copy(horizon);
      skyUniforms.sunColor.value.copy(sun.color);
      skyUniforms.sunDir.value.set(sun.position.x, sun.position.y, sun.position.z).normalize();
      scene.fog.color.copy(horizon);
      scene.fog.density = 0.0011 + 0.005 * storm;
      // Night lighting (PLN): rises 17.55-18.5, falls 5-6.
      var target = smoothstep(17.55, 18.5, clock) * (1 - smoothstep(5, 6, clock));
      if (clock >= 6 && clock < 17.55) target = 0;
      plnNightF += (target - plnNightF) * Math.min(1, dt * 1.5);
      bulbMat.color.copy(hexLerp(0x49525c, 0xffffff, plnNightF));
      bodyMat.emissiveIntensity = plnNightF * 0.9;
      towerBodyMat.emissiveIntensity = plnNightF * 0.9;
      // Lit window panes: dark glass by day, warm glass at night.
      winLitMat.color.copy(hexLerp(0x17303b, 0xffffff, plnNightF));
      // Rain: 700 slanted lines in a 92x30 box around the camera (§13).
      var rainOpacity = 0.5 * storm;
      rainMat.opacity = rainOpacity;
      if (rainOpacity > 0.01) {
        var pos = rainGeo.attributes.position.array;
        for (var i = 0; i < RAIN_N; i++) {
          var sd = rainSeed[i];
          var rx = camera.position.x + sd.x;
          var ry = ((sd.y - game.time * 23) % 30 + 30) % 30;
          var rz = camera.position.z + sd.z;
          pos[i * 6] = rx; pos[i * 6 + 1] = ry; pos[i * 6 + 2] = rz;
          pos[i * 6 + 3] = rx - 1.5; pos[i * 6 + 4] = ry - 1.6; pos[i * 6 + 5] = rz - 0.5;
        }
        rainGeo.attributes.position.needsUpdate = true;
      }
      // Wet asphalt: sheen + puddles appear with rain, exactly 0 when dry.
      wetMat.opacity = 0.5 * storm;
      puddleMats.forEach(function (pm) { pm.opacity = 0.35 * storm; });
      waterUniforms.time.value = game.time;
      waterUniforms.storm.value = storm;
      // Lightning flash (reference §13): sun +1.5, hemisphere +0.7.
      if (game.lightning) {
        hemi.intensity += 0.7;
        sun.intensity += 1.5;
      }

      // ---------- sync people (instanced, culled to 190) ----------
      var idx = 0;
      accSlot = 0;
      var camX = camera.position.x, camZ = camera.position.z;
      function personVisible(x, z) { return dist(x, z, camX, camZ) < CROWD_RANGE; }
      // Hero: drawn on foot or on a bike; inside a car the cabin hides them.
      if (p.vehicle === null || p.bike) {
        var heroStride = p.bike ? 0 : Math.min(1, Math.abs(p.speed || 0) / 4);
        syncPerson(idx++, p.x, p.z, p.y, p.yaw, 1.12, personColor('hero'), true, 0, heroStride);
      }
      // Pedestrians.
      for (var pi = 0; pi < game.peds.length && idx < MAXP; pi++) {
        var ped = game.peds[pi];
        if (ped.down) continue;
        if (!personVisible(ped.x, ped.z)) continue;
        var detail = dist(ped.x, ped.z, camX, camZ) < DETAIL_DIST;
        syncPerson(idx++, ped.x, ped.z, 0, ped.yaw, ped.size, personColor('ped', ped), detail, ped.id, 1);
      }
      // Police foot officers.
      for (var oi = 0; oi < game.police.length && idx < MAXP; oi++) {
        var off = game.police[oi];
        if (!off.foot || off.state === 'down') continue;
        if (!personVisible(off.x, off.z)) continue;
        syncPerson(idx++, off.x, off.z, 0, off.yaw, 1.04, personColor('officer'), true, oi + 40, 1);
      }
      // Enemies.
      for (var ei = 0; ei < game.enemies.length && idx < MAXP; ei++) {
        var en = game.enemies[ei];
        if (en.down) continue;
        if (!personVisible(en.x, en.z)) continue;
        syncPerson(idx++, en.x, en.z, 0, 0, 1.0, personColor('enemy'), true, ei + 80, 0.8);
      }
      // Contacts (Mara etc.) as gold-striped figures.
      for (var ci = 0; ci < PH.CONTACTS.length && idx < MAXP; ci++) {
        var ct = PH.CONTACTS[ci];
        if (ct.kind !== 'contact') continue;
        if (!personVisible(ct.x, ct.z)) continue;
        syncPerson(idx++, ct.x, ct.z, 0, 0, 1.0, personColor('contact', ci), true, ci + 120, 0);
      }
      // Taxi passenger.
      if (game.taxiWait && idx < MAXP && personVisible(game.taxiWait.x, game.taxiWait.z)) {
        syncPerson(idx++, game.taxiWait.x, game.taxiWait.z, 0, 0, 1.0, personColor('taxiPassenger'), true, 200, 0);
      }
      // Emergency staff: a kneeling medic beside the casualty while an
      // ambulance treats; a tow operator beside the truck while it hooks.
      if (game.emergency) {
        for (var ei2 = 0; ei2 < game.emergency.units.length && idx < MAXP; ei2++) {
          var eu2 = game.emergency.units[ei2];
          if (eu2.kind === 'ambulance' && eu2.state === 'treat' && eu2.target && personVisible(eu2.target.x, eu2.target.z)) {
            syncPerson(idx++, eu2.target.x + 1.2, eu2.target.z, 0, 0, 0.7, personColor('medic'), false, 400, 0);
          } else if (eu2.kind === 'tow' && (eu2.state === 'hook' || eu2.state === 'return') && eu2.car && personVisible(eu2.x, eu2.z)) {
            syncPerson(idx++, eu2.x - Math.cos(eu2.yaw) * 3, eu2.z - Math.sin(eu2.yaw) * 3, 0, eu2.yaw, 1.0, personColor('towman'), true, 420, 0.6);
          }
        }
      }
      // Beachgoers.
      if (game.beachgoers) {
        for (var bi = 0; bi < game.beachgoers.length && idx < MAXP; bi++) {
          var bg = game.beachgoers[bi];
          if (bg.hidden) continue;
          if (!personVisible(bg.x, bg.z)) continue;
          syncPerson(idx++, bg.x, bg.z, 0, bg.yaw, 0.95, { body: bg.color, legs: 0xd8a878, skin: 0xd8a878, hair: 0x34313d, acc: [] }, true, bi + 300, 0.8);
        }
      }
      for (var hi2 = idx; hi2 < MAXP; hi2++) {
        bodyIM.setMatrixAt(hi2, hideMatrix);
        headIM.setMatrixAt(hi2, hideMatrix);
        legLIM.setMatrixAt(hi2, hideMatrix);
        legRIM.setMatrixAt(hi2, hideMatrix);
        armLIM.setMatrixAt(hi2, hideMatrix);
        armRIM.setMatrixAt(hi2, hideMatrix);
        shoeLIM.setMatrixAt(hi2, hideMatrix);
        shoeRIM.setMatrixAt(hi2, hideMatrix);
        pelvisIM.setMatrixAt(hi2, hideMatrix);
        hairIM.setMatrixAt(hi2, hideMatrix);
        blobIM.setMatrixAt(hi2, hideMatrix);
      }
      for (var ai2 = accSlot; ai2 < MAXP * 2; ai2++) accIM.setMatrixAt(ai2, hideMatrix);
      bodyIM.instanceMatrix.needsUpdate = true;
      headIM.instanceMatrix.needsUpdate = true;
      legLIM.instanceMatrix.needsUpdate = true;
      legRIM.instanceMatrix.needsUpdate = true;
      armLIM.instanceMatrix.needsUpdate = true;
      armRIM.instanceMatrix.needsUpdate = true;
      shoeLIM.instanceMatrix.needsUpdate = true;
      shoeRIM.instanceMatrix.needsUpdate = true;
      pelvisIM.instanceMatrix.needsUpdate = true;
      hairIM.instanceMatrix.needsUpdate = true;
      accIM.instanceMatrix.needsUpdate = true;
      blobIM.instanceMatrix.needsUpdate = true;
      if (bodyIM.instanceColor) bodyIM.instanceColor.needsUpdate = true;
      if (headIM.instanceColor) headIM.instanceColor.needsUpdate = true;
      if (legLIM.instanceColor) legLIM.instanceColor.needsUpdate = true;
      if (legRIM.instanceColor) legRIM.instanceColor.needsUpdate = true;
      if (armLIM.instanceColor) armLIM.instanceColor.needsUpdate = true;
      if (armRIM.instanceColor) armRIM.instanceColor.needsUpdate = true;
      if (shoeLIM.instanceColor) shoeLIM.instanceColor.needsUpdate = true;
      if (shoeRIM.instanceColor) shoeRIM.instanceColor.needsUpdate = true;
      if (pelvisIM.instanceColor) pelvisIM.instanceColor.needsUpdate = true;
      if (hairIM.instanceColor) hairIM.instanceColor.needsUpdate = true;
      if (accIM.instanceColor) accIM.instanceColor.needsUpdate = true;
      stats.pedestrians = idx;

      // ---------- sync vehicles ----------
      var carCount = 0;
      var touched = {};
      function syncCar(car) {
        if (!car) return;
        var key = car.id + ':' + car.type;
        touched[key] = true;
        var g = carGroups.get(key);
        if (!g) {
          g = car.type === 'bike' ? makeBikeGroup(car) : car.type === 'boat' ? makeBoatGroup(car)
            : car.type === 'tow' ? makeTowGroup(car) : car.type === 'ambulance' ? makeAmbulanceGroup(car) : makeCarGroup(car);
          carGroups.set(key, g);
        }
        var vis = dist(car.x, car.z, camX, camZ) < CROWD_RANGE + 60 || car.id === p.vehicle;
        g.visible = vis;
        if (!vis) return;
        g.position.set(car.x, car.type === 'boat' ? Math.sin(game.time * 1.25 + car.id) * 0.05 * (1 + 2.4 * storm) : 0, car.z);
        g.rotation.y = -car.yaw + Math.PI / 2;
        // Wheels spin with speed.
        var ud = g.userData;
        if (ud.wheels) {
          var spin = (car.speed || 0) * dt * 0.9;
          for (var w = 0; w < ud.wheels.length; w++) ud.wheels[w].rotation.x += spin;
        }
        // Damaged / inactive cars turn grey (reference §8.1).
        if (ud.bodyM && car.hp !== undefined) {
          ud.bodyM.color.setHex(car.hp < 30 ? 0x4a4d59 : car.color);
        }
        if (ud.extras && ud.extras.red) {
          // Lightbar flashes pink-red / blue at 21 rad/s ONLY while the
          // unit is chasing; dim red/blue otherwise (reference §8.2).
          var chasing = car.chase === true;
          var flash = Math.sin(game.time * 21 + car.id) > 0;
          ud.extras.red.material.color.setHex(chasing ? (flash ? 0xff4d89 : 0x79314d) : 0x79314d);
          ud.extras.blue.material.color.setHex(chasing ? (flash ? 0x2b508a : 0x58c8ff) : 0x2b508a);
        }
        if (ud.extras && ud.extras.cones) {
          // Headlight cones at night for occupied cars (reference §5/§8.1).
          var hOn = plnNightF > 0.02 && !!car.driver;
          for (var ci = 0; ci < ud.extras.cones.length; ci++) ud.extras.cones[ci].visible = hOn;
          ud.extras.coneMat.opacity = 0.42 * plnNightF;
          ud.extras.pool.visible = hOn;
          ud.extras.poolMat.opacity = 0.26 * plnNightF;
        }
        if (ud.extras && ud.extras.rider) ud.extras.rider.visible = !!car.driver;
        if (ud.extras && ud.extras.foam) ud.extras.foam.visible = (car.speed || 0) > 3;
        if (ud.extras && ud.extras.strobeB) {
          // Ambulance strobes alternate blue / amber while on duty.
          var duty = !!(car.unit && (car.unit.state === 'drive' || car.unit.state === 'treat'));
          var ph = Math.sin(game.time * 12 + car.id) > 0;
          ud.extras.strobeB.material.color.setHex(duty ? (ph ? 0x61d7ff : 0x1a3a4a) : 0x1a3a4a);
          ud.extras.strobeA.material.color.setHex(duty ? (ph ? 0x3a2a0a : 0xffc24d) : 0x3a2a0a);
        }
        if (ud.extras && ud.extras.beacon) {
          var onDuty = !!(car.unit && (car.unit.state === 'drive' || car.unit.state === 'hook'));
          ud.extras.beacon.material.color.setHex(onDuty && Math.sin(game.time * 8) > 0 ? 0xffc24d : 0x5a4418);
        }
        if (ud.extras && ud.extras.cable && car.unit && car.unit.car && (car.unit.state === 'hook' || car.unit.state === 'return')) {
          // Tow cable sags from the truck's rear deck to the towed car.
          var fx = Math.cos(car.yaw), fz = Math.sin(car.yaw);
          var ax = car.x - fx * 3, az = car.z - fz * 3;
          var tx = car.unit.car.x, tz = car.unit.car.z;
          var pos = ud.extras.cable.geometry.attributes.position;
          pos.setXYZ(0, ax, 1.6, az);
          pos.setXYZ(1, (ax + tx) / 2, 0.9, (az + tz) / 2);
          pos.setXYZ(2, tx, 0.6, tz);
          pos.setXYZ(3, tx, 0.6, tz);
          pos.setXYZ(4, tx, 0.6, tz);
          pos.setXYZ(5, tx, 0.6, tz);
          pos.needsUpdate = true;
          ud.extras.cable.visible = true;
          ud.extras.hook.position.set(tx, 0.6, tz);
          ud.extras.hook.visible = true;
        } else if (ud.extras && ud.extras.cable) {
          ud.extras.cable.visible = false;
          ud.extras.hook.visible = false;
        }
        carCount++;
      }
      for (var cvi = 0; cvi < game.cars.length; cvi++) syncCar(game.cars[cvi]);
      // Police cars (units, not in game.cars).
      for (var pci = 0; pci < game.police.length; pci++) {
        var unit = game.police[pci];
        if (unit.foot) continue;
        var fake = { id: 5000 + pci, type: 'sedan', color: 0xeff0eb, x: unit.x, z: unit.z, yaw: unit.yaw, speed: unit.speed, police: true, chase: unit.state === 'chase', driver: true };
        syncCar(fake);
      }
      // Emergency units.
      if (game.emergency) {
        for (var eui = 0; eui < game.emergency.units.length; eui++) {
          var eu = game.emergency.units[eui];
          var etype = eu.kind === 'tow' ? 'tow' : 'ambulance';
          var fake2 = { id: 6000 + eui, type: etype, color: eu.color, x: eu.x, z: eu.z, yaw: eu.yaw, speed: eu.speed, unit: eu, driver: true };
          syncCar(fake2);
        }
      }
      // Hide groups whose key was not touched this frame (police / service
      // units come and go, so their ids shift).
      carGroups.forEach(function (g, key) {
        if (!touched[key]) g.visible = false;
      });
      stats.vehicles = carCount;

      // ---------- helis ----------
      if (game.helis) {
        for (var hgi = 0; hgi < game.helis.length; hgi++) {
          var h = game.helis[hgi];
          var hg = heliGroups[hgi];
          hg.visible = !!h.active;
          if (!h.active) {
            // Scene-level searchlight parts must hide with the rig.
            hg.userData.spot.intensity = 0;
            hg.userData.cone.visible = false;
            hg.userData.disk.visible = false;
            hg.userData.ring.visible = false;
            continue;
          }
          hg.position.set(h.x, h.y, h.z);
          hg.rotation.set(h.pitch || 0, -h.yaw + Math.PI / 2, h.roll || 0);
          hg.userData.rotor.rotation.y = h.rotorPhase;
          hg.userData.rotor2.rotation.y = h.rotorPhase + Math.PI / 2;
          hg.userData.tailRotor.rotation.x = h.tailPhase;
          hg.userData.beacon.material.color.setHex(Math.sin(game.time * 6) > 0 ? 0xff404a : 0x550000);
          var lit = !!h.lit;
          var ud = hg.userData;
          if (lit && h.spotTarget) {
            var share = game.litShare || 1;
            // Real SpotLight under the nose, aimed at the tracked target,
            // intensity split evenly when 2-3 helis shine (reference §9).
            ud.spot.position.set(h.x, h.y - 1, h.z);
            ud.spotTarget.position.set(h.spotTarget.x, 0, h.spotTarget.z);
            ud.spot.intensity = 210 * share;
            // Additive cone stretched heli-to-ground: length = heli height,
            // base radius = the spotlight pool radius (4.5 driving, 3.2 on
            // foot), opacity split by litShare like the disc (reference §9).
            var dx = h.x - h.spotTarget.x, dy = h.y - 0, dz = h.z - h.spotTarget.z;
            var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            ud.cone.position.set((h.x + h.spotTarget.x) / 2, h.y / 2, (h.z + h.spotTarget.z) / 2);
            ud.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0),
              new THREE.Vector3(dx / len, dy / len, dz / len));
            var spotR = h.spotRadius || 4.5;
            ud.cone.scale.set(spotR, len, spotR);
            ud.cone.material.opacity = 0.15 * share;
            ud.cone.visible = true;
            ud.disk.position.set(h.spotTarget.x, 0.12, h.spotTarget.z);
            ud.disk.scale.setScalar((h.spotRadius || 4.5) / 4.5);
            ud.disk.material.opacity = 0.27 * share;
            ud.disk.visible = true;
            ud.ring.position.set(h.spotTarget.x, 0.13, h.spotTarget.z);
            ud.ring.scale.setScalar((h.spotRadius || 4.5) / 4.5);
            ud.ring.material.opacity = 0.5 * share;
            ud.ring.visible = true;
          } else {
            ud.spot.intensity = 0;
            ud.cone.visible = false;
            ud.disk.visible = false;
            ud.ring.visible = false;
          }
        }
        stats.helicopters = game.helis.filter(function (hh) { return hh.active; }).length;
        stats.helicopterMode = game.helis[0] ? game.helis[0].mode : 'none';
        stats.searchlight = game.helis.some(function (hh) { return hh.lit; });
      }
      stats.policeOfficers = game.police.filter(function (u) { return u.foot; }).length;
      stats.buildings = liveBuildings.length;

      // ---------- objective marker + waypoint ----------
      var obj = game.objective();
      if (obj && game.mission.active && obj.x !== undefined) {
        marker.visible = true;
        marker.position.set(obj.x, 0, obj.z);
        var pulse = 0.72 + Math.sin(game.time * 3) * 0.23;
        mBeam.material.opacity = 0.3 * pulse;
        // The ground ring breathes ±10.5% at 3.4 rad/s (reference §12).
        var ringPulse = 1 + Math.sin(game.time * 3.4) * 0.105;
        mRing.scale.set(ringPulse, ringPulse, 1);
        mCrystal.position.y = 2.2 + Math.sin(game.time * 2) * 0.3;
        mCrystal.rotation.y = game.time;
        var col = 0xff946a;
        if (game.mission.step !== undefined) {
          var st = PH.MISSIONS[game.mission.index].steps[game.mission.step];
          if (st) col = st.kind === 'kill' ? 0xff626c : st.kind === 'goto' && st.text.indexOf('ledger') >= 0 ? 0x79f4db : 0xff946a;
        }
        mRing.material.color.setHex(col);
        mBeam.material.color.setHex(col);
      } else marker.visible = false;
      // Shot tracers from game.shots (life 0.14 s, fading).
      for (var ti2 = 0; ti2 < tracers.length; ti2++) {
        var tr = tracers[ti2];
        var sh = game.shots && game.shots[ti2];
        if (sh) {
          var tp = tr.geometry.attributes.position;
          tp.setXYZ(0, sh.x, sh.y, sh.z);
          tp.setXYZ(1, sh.tx, sh.y, sh.tz);
          tp.needsUpdate = true;
          tr.material.color.setHex(sh.foe ? 0xff7f82 : 0xffe6a6);
          tr.material.opacity = 0.9 * Math.max(0, sh.life / 0.14);
          tr.visible = true;
        } else tr.visible = false;
      }
      if (game.waypoint) {
        waypoint.visible = true;
        waypoint.position.set(game.waypoint.x, 3 + Math.sin(game.time * 2) * 0.4, game.waypoint.z);
        waypoint.rotation.y = game.time;
      } else waypoint.visible = false;
      // Shell rings bob.
      if (game.extras.shells) {
        for (var sri = 0; sri < PH.SHELL_SPOTS.length; sri++) {
          var sr2 = shellRings[sri];
          var taken = game.extras.shells.indexOf(sri) >= 0;
          sr2.visible = !taken;
          if (!taken) {
            sr2.position.set(PH.SHELL_SPOTS[sri].x, 0.12 + (game.shellBob ? game.shellBob(game.time) : 0), PH.SHELL_SPOTS[sri].z);
          }
        }
      }

      cam.lookDX = input ? input.lookDX || 0 : 0;
      cam.lookDY = input ? input.lookDY || 0 : 0;
      cam.zoom = input ? input.zoom || 0 : 0;
      follow(dt, game.player, game.getCar(), cam);
    }

    function render() {
      // Present at most 30fps; bank the skipped dt into the next present.
      var now = performance.now() / 1000;
      if (lastPresent && now - lastPresent < PRESENT_MIN) return false;
      var dt = lastPresent ? now - lastPresent : 1 / 30;
      lastPresent = now;
      renderer.render(scene, camera);
      stats.presents++;
      stats.drawCalls = renderer.info.render.calls;
      stats.sceneObjects = scene.children.length;
      frames++;
      presentAcc += dt;
      if (presentAcc >= 1) { fps = Math.round(frames / presentAcc); frames = 0; presentAcc = 0; }
      return true;
    }

    function resize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }
    function statsFn() {
      return {
        fps: fps, fixedLook: true, plnNightF: +plnNightF.toFixed(2), plnLamps: lampPositions.length,
        plnPools: 0, shadowSize: 1024, builds: stats.builds, presents: stats.presents,
        drawCalls: stats.drawCalls, sceneObjects: stats.sceneObjects,
        staticInstances: stats.staticInstances, pedestrians: stats.pedestrians || 0,
        vehicles: stats.vehicles || 0, helicopters: stats.helicopters || 0,
        helicopterMode: stats.helicopterMode || 'none', searchlight: !!stats.searchlight,
        policeOfficers: stats.policeOfficers || 0, buildings: stats.buildings || 0
      };
    }
    function dispose() {
      renderer.dispose();
    }

    // Initial camera placement behind the player.
    camera.position.set(game.player.x - Math.cos(game.player.yaw) * 9, 4.5, game.player.z - Math.sin(game.player.yaw) * 9);
    camera.lookAt(game.player.x, 1.2, game.player.z);

    return {
      renderer: renderer, scene: scene, camera: camera,
      update: update, render: render, resize: resize, dispose: dispose, stats: statsFn, fps: function () { return fps; },
      daylight: daylight, stormAmp: stormAmp, updateRain: function () { }, renderAirSupport: function () { },
      follow: follow, cameraDistance: cameraDistance, headlights: headlights,
      person: function () { }, vehicle: function () { }, bikeMesh: function () { },
      boatMesh: function () { }, serviceVehicle: function () { }, serviceCrew: function () { },
      checkpoint: function () { }, districtBoard: function () { }, palm: function () { },
      streetlamp: function () { }, finishBatches: function () { }, applyFixedVisuals: function () { }
    };
  }

  PH.createWorld = createWorld;
  PH.CROWD_RANGE = CROWD_RANGE; PH.DETAIL_DIST = DETAIL_DIST; PH.RAIN_N = RAIN_N;
})();
