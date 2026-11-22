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

  // Window textures shared by all buildings, in 3 lit-density variants
  // (18% / 30% / 40% lit, reference §3: 18-40% per building, fixed per
  // building). The lit windows are DARK in the colour map and only glow
  // through the emissive map: in daylight they read dark (toward 0x17303b),
  // at night the emissive layer lights them warm.
  function buildingTextures() {
    var litColors = ['#ffc786', '#81dfed', '#ff9d94', '#ffe9bb'];
    var darkColors = ['#385974', '#467990', '#668b9e', '#506581', '#397081'];
    var variants = [];
    [0.18, 0.3, 0.4].forEach(function (frac) {
      var c = document.createElement('canvas'); c.width = 128; c.height = 128;
      var g = c.getContext('2d');
      g.fillStyle = '#9aa4a8'; g.fillRect(0, 0, 128, 128);
      var e = document.createElement('canvas'); e.width = 128; e.height = 128;
      var ge = e.getContext('2d');
      ge.fillStyle = '#000'; ge.fillRect(0, 0, 128, 128);
      var r = PH.rng(1234);
      for (var y = 8; y < 120; y += 16) {
        for (var x = 8; x < 120; x += 16) {
          var lit = r() < frac;
          g.fillStyle = lit ? '#17303b' : darkColors[Math.floor(r() * darkColors.length)];
          g.fillRect(x, y, 9, 11);
          if (lit) { ge.fillStyle = litColors[Math.floor(r() * litColors.length)]; ge.fillRect(x, y, 9, 11); }
        }
      }
      variants.push({
        map: new THREE.CanvasTexture(c),
        emissive: new THREE.CanvasTexture(e)
      });
    });
    return variants;
  }

  function districtBoardTexture(title, name) {
    var c = document.createElement('canvas'); c.width = 512; c.height = 128;
    var g = c.getContext('2d');
    g.fillStyle = '#263f54'; g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#f4dcb9'; g.lineWidth = 4; g.strokeRect(6, 6, 500, 116);
    g.fillStyle = '#f4dcb9'; g.font = 'bold 37px Georgia'; g.textAlign = 'center';
    g.fillText(title, 256, 52);
    g.fillStyle = '#96e2d3'; g.font = '24px Arial';
    g.fillText(name, 256, 96);
    return new THREE.CanvasTexture(c);
  }

  function createWorld(game, canvas) {
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    // Physical light units (r155+): the heli SpotLight's intensity 210 is
    // candela with 1/d^2 falloff, so it lights a modest pool instead of
    // blasting the whole city (legacy mode has no distance falloff for it).
    // Directional sun + hemisphere are unaffected by this flag.
    if ('useLegacyLights' in renderer) renderer.useLegacyLights = false;
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
    // Reference §11: teal gradient, sun glitter, white foam 2-14 units from
    // the island edge (island is 448 wide, edge at |x|/|z| = 224).
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
          'float m = max(abs(vP.x), abs(vP.y));' +
          'float foam = smoothstep(208.0, 220.0, m) * (1.0 - smoothstep(220.0, 226.0, m)) * (0.35 + 0.35 * sin(p.x * 2.0 + time));' +
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
    // Zebra crossings + stop lines at every intersection (reference §4),
    // lane edge lines, wet-road sheen and puddles (puddles exactly 0
    // opacity when dry — they only appear in rain/storm).
    var zebraMat = mat(0xffeaca);
    var zebraMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(3, 0.6), zebraMat, 49 * 4 * 5);
    var stopMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(8, 0.5), zebraMat, 49 * 4);
    var zi = 0, si = 0;
    PH.ROADS.forEach(function (rx) {
      PH.ROADS.forEach(function (rz) {
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (dir) {
          var cx = rx + dir[0] * 10, cz = rz + dir[1] * 10;
          for (var s = 0; s < 5; s++) {
            var off = -6.4 + s * 3.2;
            dummy.position.set(cx + (dir[0] === 0 ? off : 0), 0.035, cz + (dir[1] === 0 ? off : 0));
            dummy.scale.set(1, 1, 1);
            dummy.rotation.set(-Math.PI / 2, 0, dir[0] === 0 ? Math.PI / 2 : 0);
            dummy.updateMatrix();
            zebraMesh.setMatrixAt(zi++, dummy.matrix);
          }
          dummy.position.set(cx + dir[0] * -2.5, 0.035, cz + dir[1] * -2.5);
          dummy.rotation.set(-Math.PI / 2, 0, dir[0] === 0 ? Math.PI / 2 : 0);
          dummy.updateMatrix();
          stopMesh.setMatrixAt(si++, dummy.matrix);
        });
      });
    });
    zebraMesh.instanceMatrix.needsUpdate = true;
    stopMesh.instanceMatrix.needsUpdate = true;
    scene.add(zebraMesh); scene.add(stopMesh);
    var edgeMat = mat(0x899aaa);
    PH.ROADS.forEach(function (r) {
      [-8.6, 8.6].forEach(function (off) {
        var e1 = new THREE.Mesh(new THREE.PlaneGeometry(420, 0.25), edgeMat);
        e1.rotation.x = -Math.PI / 2; e1.position.set(0, 0.03, r + off);
        scene.add(e1);
        var e2 = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 420), edgeMat);
        e2.rotation.x = -Math.PI / 2; e2.position.set(r + off, 0.03, 0);
        scene.add(e2);
      });
    });
    var sheenMat = new THREE.MeshLambertMaterial({ color: 0x131a25, transparent: true, opacity: 0 });
    var sheen = new THREE.Mesh(new THREE.PlaneGeometry(448, 448), sheenMat);
    sheen.rotation.x = -Math.PI / 2; sheen.position.y = 0.02;
    scene.add(sheen);
    var puddleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 });
    var puddleSpots = [];
    PH.ROADS.forEach(function (rx) {
      PH.ROADS.forEach(function (rz) {
        puddleSpots.push([rx + 8, rz + 8]); puddleSpots.push([rx - 8, rz - 8]);
      });
    });
    for (var pa = -180; pa <= 180; pa += 64) {
      puddleSpots.push([pa, 8.2]); puddleSpots.push([8.2, pa]);
    }
    var puddleMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 12), puddleMat, puddleSpots.length);
    var puddleR = PH.rng(4242);
    puddleSpots.forEach(function (pp, i) {
      dummy.position.set(pp[0], 0.025, pp[1]);
      dummy.scale.set(2.2 + puddleR() * 1.6, 1.2 + puddleR() * 0.8, 1);
      dummy.rotation.set(-Math.PI / 2, 0, puddleR() * Math.PI);
      dummy.updateMatrix();
      puddleMesh.setMatrixAt(i, dummy.matrix);
      puddleMesh.setColorAt(i, new THREE.Color([0x27384a, 0x2e4256, 0x22303f][i % 3]));
    });
    puddleMesh.instanceMatrix.needsUpdate = true;
    if (puddleMesh.instanceColor) puddleMesh.instanceColor.needsUpdate = true;
    scene.add(puddleMesh);

    // Buildings: instanced bodies (window texture + instance color), roof
    // trims, AC crates, antennas on tall towers. Building 87 is demolished
    // into the Sunstrand lot and skipped here. Reference §3: towers get
    // glass bodies + stepped crowns + penthouse + antenna; every building
    // gets a ground-floor shopfront (glass door + 2 shop windows), a
    // district-coloured sign band with a light strip, and half of them an
    // awning; each road-facing side gets a PLN light pool + 2 wall fixtures.
    var tex = buildingTextures();
    var liveBuildings = game.city.buildings.filter(function (b) {
      return !(PH.PARKING && b.index === PH.PARKING.buildingIndex);
    });
    var towerGlass = PH.TOWER_GLASS || [0x3e708a, 0x527794, 0x426286, 0x468b98];
    var accentOf = PH.DISTRICT_ACCENT || {};
    function faceOf(b) {
      var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      var rx = PH.ROADS.reduce(function (best, r) { return Math.abs(r - cx) < Math.abs(best - cx) ? r : best; }, PH.ROADS[0]);
      var rz = PH.ROADS.reduce(function (best, r) { return Math.abs(r - cz) < Math.abs(best - cz) ? r : best; }, PH.ROADS[0]);
      var dx = Math.abs(rx - cx), dz = Math.abs(rz - cz);
      if (dx <= dz) return { nx: rx > cx ? 1 : -1, nz: 0, fx: rx > cx ? b.maxX : b.minX, fz: cz, w: b.maxZ - b.minZ, rot: rx > cx ? Math.PI / 2 : -Math.PI / 2 };
      return { nx: 0, nz: rz > cz ? 1 : -1, fx: cx, fz: rz > cz ? b.maxZ : b.minZ, w: b.maxX - b.minX, rot: rz > cz ? 0 : Math.PI };
    }
    // Split into 3 lit-density buckets (18% / 30% / 40% lit windows).
    var buckets = [[], [], []];
    liveBuildings.forEach(function (b) {
      buckets[b.lit < 0.25 ? 0 : (b.lit < 0.33 ? 1 : 2)].push(b);
    });
    var bodyMats = [];
    var bodyMeshes = [];
    buckets.forEach(function (group, vi) {
      if (!group.length) return;
      var bm = new THREE.MeshLambertMaterial({ map: tex[vi].map, emissiveMap: tex[vi].emissive, emissive: 0xffffff, emissiveIntensity: 0 });
      bodyMats.push(bm);
      var mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bm, group.length);
      group.forEach(function (b, i) {
        var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
        dummy.position.set(cx, b.h / 2, cz);
        dummy.scale.set(b.maxX - b.minX, b.h, b.maxZ - b.minZ);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, new THREE.Color(b.tower ? towerGlass[b.index % towerGlass.length] : b.color));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true; mesh.receiveShadow = true;
      scene.add(mesh);
      bodyMeshes.push(mesh);
    });
    var N = liveBuildings.length;
    var trimMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.3, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
    var acMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.9, 1.6), mat(0x8a94a0), N);
    var ac2Mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.9, 1.6), mat(0x8a94a0), N);
    var towers = liveBuildings.filter(function (b) { return b.tower; });
    var crownMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, towers.length));
    var pentMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0x355673), Math.max(1, towers.length));
    var antTowers = liveBuildings.filter(function (b) { return b.h > 33 && b.roof > 0.56; });
    var antMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.07, 2.4, 5), mat(0x6b8a91), Math.max(1, antTowers.length));
    var tankMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.9, 0.9, 1.4, 8), mat(0x6b8a91), N);
    var tankTopMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.95, 0.95, 0.18, 8), mat(0xb9a8a0), N);
    var warehouses = liveBuildings.filter(function (b) { return b.warehouse; });
    var ventMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.5, 1), mat(0x5a6a72), Math.max(1, warehouses.length));
    var doorMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.7, 2.5), new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
    var shopWinMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.2, 1.7), mat(0x467990), N * 2);
    var bandMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.9, 0.18), new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
    var stripMat = new THREE.MeshBasicMaterial({ color: 0xffe6b7, transparent: true, opacity: 0.25 });
    var stripMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.12, 0.06), stripMat, N);
    var awnMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.1, 1.4), new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
    var facePoolMat = new THREE.MeshBasicMaterial({ color: 0xffbe78, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    var facePoolMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), facePoolMat, N);
    var fixMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.25 });
    var fixMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.35, 0.1), fixMat, N * 2);
    var zero = new THREE.Matrix4().makeScale(0, 0, 0);
    liveBuildings.forEach(function (b, i) {
      var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      var bw = b.maxX - b.minX, bd = b.maxZ - b.minZ;
      var f = faceOf(b);
      dummy.position.set(cx, b.h + 0.15, cz);
      dummy.scale.set(bw + 0.3, 1, bd + 0.3);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      trimMesh.setMatrixAt(i, dummy.matrix);
      trimMesh.setColorAt(i, new THREE.Color(b.tower ? 0xb7d5db : 0xf4ddd0));
      dummy.position.set(cx - bw * 0.2, b.h + 0.7, cz - bd * 0.2);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      acMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(cx + bw * 0.2, b.h + 0.7, cz + bd * 0.2);
      dummy.updateMatrix();
      ac2Mesh.setMatrixAt(i, dummy.matrix);
      // Water tank (40% of buildings) with a cap disc.
      if (b.tank) {
        dummy.position.set(cx - bw * 0.25, b.h + 1.0, cz + bd * 0.25);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        tankMesh.setMatrixAt(i, dummy.matrix);
        dummy.position.set(cx - bw * 0.25, b.h + 1.75, cz + bd * 0.25);
        dummy.updateMatrix();
        tankTopMesh.setMatrixAt(i, dummy.matrix);
      } else { tankMesh.setMatrixAt(i, zero); tankTopMesh.setMatrixAt(i, zero); }
      // Shopfront on the road-facing side: glass door + 2 shop windows.
      dummy.position.set(f.fx + f.nx * 0.08, 1.25, f.fz + f.nz * 0.08);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, f.rot, 0);
      dummy.updateMatrix();
      doorMesh.setMatrixAt(i, dummy.matrix);
      doorMesh.setColorAt(i, new THREE.Color(b.warehouse ? 0x62727d : 0x385565));
      [-1, 1].forEach(function (s, k) {
        var ox = f.nx === 0 ? s * 3.1 : 0, oz = f.nx !== 0 ? s * 3.1 : 0;
        dummy.position.set(f.fx + f.nx * 0.08 + ox, 1.5, f.fz + f.nz * 0.08 + oz);
        dummy.updateMatrix();
        shopWinMesh.setMatrixAt(i * 2 + k, dummy.matrix);
      });
      // District sign band + light strip above the shopfront.
      var accent = accentOf[b.district] || 0xd88145;
      dummy.position.set(f.fx + f.nx * 0.1, 3.6, f.fz + f.nz * 0.1);
      dummy.scale.set(f.w, 1, 1);
      dummy.rotation.set(0, f.rot, 0);
      dummy.updateMatrix();
      bandMesh.setMatrixAt(i, dummy.matrix);
      bandMesh.setColorAt(i, new THREE.Color(accent));
      dummy.position.set(f.fx + f.nx * 0.2, 3.12, f.fz + f.nz * 0.2);
      dummy.updateMatrix();
      stripMesh.setMatrixAt(i, dummy.matrix);
      // Awning (half the buildings), slanted, district colour.
      if (b.awning) {
        dummy.position.set(f.fx + f.nx * 0.75, 3.0, f.fz + f.nz * 0.75);
        dummy.scale.set(f.w * 0.7, 1, 1);
        dummy.rotation.set(f.nx !== 0 ? 0 : -0.45, f.rot, f.nx !== 0 ? -0.45 : 0);
        dummy.updateMatrix();
        awnMesh.setMatrixAt(i, dummy.matrix);
        awnMesh.setColorAt(i, new THREE.Color(accent));
      } else awnMesh.setMatrixAt(i, zero);
      // PLN: light pool on the sidewalk in front + 2 wall fixtures.
      dummy.position.set(f.fx + f.nx * 1.6, 0.07, f.fz + f.nz * 1.6);
      dummy.scale.set(f.w * 0.92, 2.2, 1);
      dummy.rotation.set(-Math.PI / 2, 0, f.rot);
      dummy.updateMatrix();
      facePoolMesh.setMatrixAt(i, dummy.matrix);
      [-1, 1].forEach(function (s, k) {
        var ox2 = f.nx === 0 ? s * f.w / 3 : 0, oz2 = f.nx !== 0 ? s * f.w / 3 : 0;
        dummy.position.set(f.fx + f.nx * 0.12 + ox2, 2.6, f.fz + f.nz * 0.12 + oz2);
        dummy.scale.set(1, 1, 1);
        dummy.rotation.set(0, f.rot, 0);
        dummy.updateMatrix();
        fixMesh.setMatrixAt(i * 2 + k, dummy.matrix);
      });
    });
    towers.forEach(function (b, i) {
      var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      var bw = b.maxX - b.minX, bd = b.maxZ - b.minZ;
      dummy.position.set(cx, b.h + b.crown / 2, cz);
      dummy.scale.set(bw * 0.7, b.crown, bd * 0.7);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      crownMesh.setMatrixAt(i, dummy.matrix);
      crownMesh.setColorAt(i, new THREE.Color(towerGlass[b.index % towerGlass.length]));
      dummy.position.set(cx, b.h + b.crown + 0.8, cz);
      dummy.scale.set(bw * 0.4, 1.6, bd * 0.4);
      dummy.updateMatrix();
      pentMesh.setMatrixAt(i, dummy.matrix);
    });
    antTowers.forEach(function (b, i) {
      var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      dummy.position.set(cx, b.h + b.crown + 1.2, cz);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      antMesh.setMatrixAt(i, dummy.matrix);
    });
    warehouses.forEach(function (b, i) {
      var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      dummy.position.set(cx, b.h + 0.4, cz);
      dummy.scale.set((b.maxX - b.minX) * 0.6, 1, 1.2);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      ventMesh.setMatrixAt(i, dummy.matrix);
    });
    [trimMesh, acMesh, ac2Mesh, crownMesh, pentMesh, antMesh, tankMesh, tankTopMesh,
      ventMesh, doorMesh, shopWinMesh, bandMesh, stripMesh, awnMesh, facePoolMesh, fixMesh
    ].forEach(function (m) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      scene.add(m);
    });
    trimMesh.receiveShadow = true;
    stats.staticInstances += liveBuildings.length * 8 + towers.length * 2;
    // Red beacon lights on tall towers (pink ball on the antenna tip).
    var beaconMat = new THREE.MeshBasicMaterial({ color: 0xf78495 });
    antTowers.forEach(function (b) {
      var bc = new THREE.Mesh(new THREE.SphereGeometry(0.35, 6, 6), beaconMat);
      bc.position.set((b.minX + b.maxX) / 2, b.h + b.crown + 2.4, (b.minZ + b.maxZ) / 2);
      scene.add(bc);
    });

    // Palms: leaning ringed trunks in square planters, crown ball + 9
    // folded leaves each (reference §7: lean 0.26-0.57, 3-4 per block).
    var palms = game.city.props.filter(function (p) { return p.kind === 'palm'; });
    var ringCanvas = document.createElement('canvas'); ringCanvas.width = 16; ringCanvas.height = 64;
    var rg = ringCanvas.getContext('2d');
    for (var ri = 0; ri < 8; ri++) { rg.fillStyle = ri % 2 ? '#ba9875' : '#a47e65'; rg.fillRect(0, ri * 8, 16, 8); }
    var ringTex = new THREE.CanvasTexture(ringCanvas);
    var trunkMat = new THREE.MeshLambertMaterial({ map: ringTex, color: 0x8e6556 });
    var trunkMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.22, 1, 6), trunkMat, palms.length);
    var planterMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.5, 1.5), mat(0xedc4a5), palms.length);
    var crownBallMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.55, 8, 6), mat(0x536843), palms.length);
    // Leaf geometry (unit length): curved spine, folded V cross-section,
    // serrated edge, drooping tip. Built once, instanced 9x per palm.
    function leafGeometry() {
      var segs = 4, pos = [], idx = [];
      for (var s = 0; s <= segs; s++) {
        var t = s / segs;
        var w = Math.sin(Math.PI * Math.pow(t, 0.8)) * 0.32 * (s % 2 ? 1 : 0.86);
        var y = -t * t * 0.55; // droop
        var z = t;
        pos.push(0, y, z, -w, y + 0.09, z, w, y + 0.09, z);
      }
      for (var q = 0; q < segs; q++) {
        var a = q * 3, b2 = (q + 1) * 3;
        idx.push(a, b2, a + 1, a, a + 1, b2 + 1);
        idx.push(a, a + 2, b2 + 2, a, b2 + 2, b2);
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    }
    var leafColors = [0x196856, 0x2e8768, 0x53a66c, 0x3c925b];
    var leafMesh = new THREE.InstancedMesh(leafGeometry(), new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }), palms.length * 9);
    var leafR = PH.rng(777);
    palms.forEach(function (p, i) {
      var lean = p.lean || 0.4, dir = p.leanDir || 0;
      var topX = p.x + Math.sin(lean) * Math.cos(dir) * p.h;
      var topZ = p.z + Math.sin(lean) * Math.sin(dir) * p.h;
      var topY = Math.cos(lean) * p.h;
      dummy.position.set(p.x + Math.sin(lean) * Math.cos(dir) * p.h / 2, topY / 2, p.z + Math.sin(lean) * Math.sin(dir) * p.h / 2);
      dummy.scale.set(1, p.h, 1);
      dummy.rotation.set(Math.sin(dir) * lean, 0, -Math.cos(dir) * lean);
      dummy.updateMatrix();
      trunkMesh.setMatrixAt(i, dummy.matrix);
      if (p.planter) {
        dummy.position.set(p.x, 0.25, p.z);
        dummy.scale.set(1, 1, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        planterMesh.setMatrixAt(i, dummy.matrix);
      } else planterMesh.setMatrixAt(i, zero);
      dummy.position.set(topX, topY, topZ);
      dummy.updateMatrix();
      crownBallMesh.setMatrixAt(i, dummy.matrix);
      for (var li = 0; li < 9; li++) {
        var az = (li / 9) * Math.PI * 2 + i * 0.7;
        var len = 2.12 + leafR() * 1.26;
        dummy.position.set(topX, topY + 0.1, topZ);
        dummy.scale.set(len, len, len);
        dummy.rotation.set(-0.85 - leafR() * 0.35, az, 0);
        dummy.updateMatrix();
        leafMesh.setMatrixAt(i * 9 + li, dummy.matrix);
        leafMesh.setColorAt(i * 9 + li, new THREE.Color(leafColors[(i + li) % leafColors.length]));
      }
    });
    trunkMesh.instanceMatrix.needsUpdate = true;
    planterMesh.instanceMatrix.needsUpdate = true;
    crownBallMesh.instanceMatrix.needsUpdate = true;
    leafMesh.instanceMatrix.needsUpdate = true;
    if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
    scene.add(trunkMesh); scene.add(planterMesh); scene.add(crownBallMesh); scene.add(leafMesh);
    stats.staticInstances += palms.length * 12;

    // Street lamps (reference §5: 98 lamps, 2 per intersection at diagonal
    // offsets +10.2/+14 and -10.2/-14, facing the road), each with a halo
    // cross-card and an additive light pool on the asphalt (PLN system).
    var lampPositions = [];
    PH.ROADS.forEach(function (rx) {
      PH.ROADS.forEach(function (rz) {
        lampPositions.push([rx + 10.2, rz + 14, rx, rz]);
        lampPositions.push([rx - 10.2, rz - 14, rx, rz]);
      });
    });
    var lampCount = lampPositions.length;
    var poleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.12, 5, 6), mat(0x42586a), lampCount);
    var armMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.08, 1.32), mat(0x42586a), lampCount);
    var headMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.45, 0.15, 0.66), mat(0x53687a), lampCount);
    var bulbMat = new THREE.MeshBasicMaterial({ color: 0x49525c });
    var bulbMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 8, 6), bulbMat, lampCount);
    var haloMat = new THREE.MeshBasicMaterial({ color: 0xffd694, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    var haloMeshA = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.6, 2.6), haloMat, lampCount);
    var haloMeshB = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.6, 2.6), haloMat, lampCount);
    var lampPoolMat = new THREE.MeshBasicMaterial({ color: 0xffc98a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    var lampPoolMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(6.5, 16), lampPoolMat, lampCount);
    lampPositions.forEach(function (lp, i) {
      var dx = lp[2] - lp[0], dz = lp[3] - lp[1];
      var dl = Math.sqrt(dx * dx + dz * dz);
      var ux = dx / dl, uz = dz / dl;
      var th = Math.atan2(ux, uz);
      dummy.position.set(lp[0], 2.5, lp[1]);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      poleMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(lp[0] + ux * 0.66, 5.0, lp[1] + uz * 0.66);
      dummy.rotation.set(0, th, 0);
      dummy.updateMatrix();
      armMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(lp[0] + ux * 1.32, 5.0, lp[1] + uz * 1.32);
      dummy.updateMatrix();
      headMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(lp[0] + ux * 1.32, 5.07, lp[1] + uz * 1.32);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      bulbMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(lp[0] + ux * 1.32, 5.07, lp[1] + uz * 1.32);
      dummy.updateMatrix();
      haloMeshA.setMatrixAt(i, dummy.matrix);
      dummy.rotation.set(0, Math.PI / 2, 0);
      dummy.updateMatrix();
      haloMeshB.setMatrixAt(i, dummy.matrix);
      dummy.position.set(lp[0] + ux * 1.32, 0.04, lp[1] + uz * 1.32);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.updateMatrix();
      lampPoolMesh.setMatrixAt(i, dummy.matrix);
    });
    [poleMesh, armMesh, headMesh, bulbMesh, haloMeshA, haloMeshB, lampPoolMesh].forEach(function (m) {
      m.instanceMatrix.needsUpdate = true;
      scene.add(m);
    });

    // Traffic lights at almost every intersection (reference §6): pole +
    // signal box, red 0xf3717b and green 0x8ef0ad lit TOGETHER as fixed
    // decoration (traffic rhythm is simulated, not driven by the lamps).
    var tlPts = [];
    PH.ROADS.forEach(function (rx) {
      PH.ROADS.forEach(function (rz) { tlPts.push([rx + 9.5, rz + 9.5]); });
    });
    var tlPoleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.12, 4.6, 6), mat(0x485a72), tlPts.length);
    var tlHeadMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.57, 1.27, 0.45), mat(0x344355), tlPts.length);
    var tlRedMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.29, 0.29, 0.1), new THREE.MeshBasicMaterial({ color: 0xf3717b }), tlPts.length);
    var tlGreenMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.29, 0.29, 0.1), new THREE.MeshBasicMaterial({ color: 0x8ef0ad }), tlPts.length);
    tlPts.forEach(function (pt, i) {
      dummy.position.set(pt[0], 2.3, pt[1]);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      tlPoleMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(pt[0], 5.2, pt[1]);
      dummy.updateMatrix();
      tlHeadMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(pt[0], 5.45, pt[1] + 0.26);
      dummy.updateMatrix();
      tlRedMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(pt[0], 4.95, pt[1] + 0.26);
      dummy.updateMatrix();
      tlGreenMesh.setMatrixAt(i, dummy.matrix);
    });
    [tlPoleMesh, tlHeadMesh, tlRedMesh, tlGreenMesh].forEach(function (m) {
      m.instanceMatrix.needsUpdate = true;
      scene.add(m);
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
      var panel = new THREE.Mesh(new THREE.PlaneGeometry(14, 2.7),
        new THREE.MeshBasicMaterial({ map: tex2 }));
      panel.position.set(bd[2], 8.9, bd[3]);
      panel.rotation.y = bd[4];
      scene.add(panel);
      var post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 8.9, 6), mat(0x40536b));
      post.position.set(bd[2] - 6, 4.45, bd[3]);
      scene.add(post);
      var post2 = post.clone();
      post2.position.set(bd[2] + 6, 4.45, bd[3]);
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
      // Reference §11: 4 towels, each with a sunbather on it.
      if (i < 4 && PH.BEACH.towels) {
        var towel = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.9), mat(PH.BEACH.towels[i]));
        towel.rotation.x = -Math.PI / 2; towel.position.set(ux + 2.2, 0.08, uz);
        scene.add(towel);
      }
    });
    // Lifeguard tower at (211, 22): legs + cab + roof.
    box(0.25, 3.0, 0.25, 0x8a6a52, 210.2, 1.5, 21.2);
    box(0.25, 3.0, 0.25, 0x8a6a52, 211.8, 1.5, 21.2);
    box(0.25, 3.0, 0.25, 0x8a6a52, 210.2, 1.5, 22.8);
    box(0.25, 3.0, 0.25, 0x8a6a52, 211.8, 1.5, 22.8);
    box(2.4, 1.6, 2.4, 0xf4f1e8, 211, 3.8, 22);
    box(2.8, 0.2, 2.8, 0xe47271, 211, 4.7, 22);

    // Sunstrand parking lot: asphalt, bay lines, curb, sign.
    if (PH.PARKING) {
      var pad = PH.PARKING.pad;
      var lot = new THREE.Mesh(new THREE.PlaneGeometry(pad.x1 - pad.x0, pad.z1 - pad.z0), mat(0x46536b));
      lot.rotation.x = -Math.PI / 2; lot.position.set((pad.x0 + pad.x1) / 2, 0.06, (pad.z0 + pad.z1) / 2);
      scene.add(lot);
      PH.PARKING.carBays.forEach(function (bay) {
        var ln = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 6.6), mat(0xffeaca));
        ln.rotation.x = -Math.PI / 2; ln.position.set(bay.x - 1.7, 0.08, bay.z);
        scene.add(ln);
      });
      var signC = document.createElement('canvas'); signC.width = 256; signC.height = 96;
      var sg = signC.getContext('2d');
      sg.fillStyle = '#1d364b'; sg.fillRect(0, 0, 256, 96);
      sg.fillStyle = '#f4bb45'; sg.font = 'bold 26px Arial'; sg.textAlign = 'center';
      sg.fillText('PARKING', 128, 40); sg.fillText('SUNSTRAND', 128, 74);
      var sign = new THREE.Mesh(new THREE.PlaneGeometry(5, 1.9),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(signC) }));
      sign.position.set(PH.PARKING.sign.x, 3.4, PH.PARKING.sign.z);
      sign.rotation.y = PH.PARKING.sign.yaw;
      scene.add(sign);
      // Reference §13: "PARKING" label flat in the middle of the pad.
      var labC = document.createElement('canvas'); labC.width = 512; labC.height = 96;
      var lg = labC.getContext('2d');
      lg.fillStyle = '#ffeaca'; lg.font = 'bold 64px Arial'; lg.textAlign = 'center';
      lg.fillText('PARKING', 256, 68);
      var label = new THREE.Mesh(new THREE.PlaneGeometry(12, 2.25),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(labC), transparent: true }));
      label.rotation.x = -Math.PI / 2;
      label.position.set(PH.PARKING.centre.x, 0.09, PH.PARKING.centre.z);
      scene.add(label);
    }

    // Rain: 700 slanted streaks in a 92x30 box around the camera (ref §14).
    var rainGeo = new THREE.BufferGeometry();
    var rainPos = new Float32Array(RAIN_N * 6);
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    var rainMat = new THREE.LineBasicMaterial({ color: 0xcfe4ee, transparent: true, opacity: 0 });
    var rain = new THREE.LineSegments(rainGeo, rainMat);
    rain.frustumCulled = false;
    scene.add(rain);
    var rainSeed = [];
    for (var ri = 0; ri < RAIN_N; ri++) rainSeed.push({ x: Math.random() * 92 - 46, y: Math.random() * 30, z: Math.random() * 30 - 15 });

    // ---------- dynamic pools ----------
    // People: instanced batches (reference §10) — 5-sided cylinder torso,
    // icosahedron head, legs, pelvis block (legs never detach), hair, plus
    // accessory (hero backpack / contact chest mark), cap and side weapon
    // for the kinds that carry them. Per-instance colour everywhere.
    var MAXP = 900;
    var bodyIM = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.21, 0.24, 0.62, 5), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var headIM = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.16, 0), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var legIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.5, 0.2), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var pelvisIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.36, 0.18, 0.22), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var hairIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.12, 0.34), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var accIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.42, 0.12), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var capIM = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.17, 0.17, 0.08, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var weaponIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.5, 0.1), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    [bodyIM, headIM, legIM, pelvisIM, hairIM, accIM, capIM, weaponIM].forEach(function (m) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      scene.add(m);
    });
    var hideMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    var tmpColor = new THREE.Color();
    var personMeshes = [bodyIM, headIM, legIM, pelvisIM, hairIM, accIM, capIM, weaponIM];

    // Vehicles: one Group per car. Reference §8: the body is a 5-section
    // shell (nose / shoulders / cabin / rear deck / tail, each its own
    // width and height) so sedan, sport and van read as different cars,
    // plus GFX1 details (grille, headlight bar, full-width tail bar,
    // beltline, rocker, mirrors, amber indicators). Police, tow and
    // ambulance get their own builders below.
    var carGeo = {
      wheel: new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10),
      wing: new THREE.BoxGeometry(2.2, 0.08, 0.5),
      post: new THREE.BoxGeometry(0.1, 0.35, 0.3),
      bar: new THREE.BoxGeometry(1.6, 0.22, 0.4),
      sign: new THREE.BoxGeometry(0.9, 0.25, 0.5)
    };
    // Shared front/rear detail-bar textures (grille + headlights / tail bar).
    function detailBarTexture(front) {
      var c = document.createElement('canvas'); c.width = 128; c.height = 24;
      var g = c.getContext('2d');
      g.fillStyle = '#22282f'; g.fillRect(0, 0, 128, 24);
      if (front) {
        g.fillStyle = '#ffefd4'; g.fillRect(8, 5, 26, 14); g.fillRect(94, 5, 26, 14);
        g.fillStyle = '#ffb85a'; g.fillRect(2, 8, 5, 8); g.fillRect(121, 8, 5, 8);
      } else {
        g.fillStyle = '#ff555e'; g.fillRect(4, 6, 120, 12);
      }
      return new THREE.CanvasTexture(c);
    }
    var frontBarTex = detailBarTexture(true);
    var rearBarTex = detailBarTexture(false);
    function darken(hex, f) {
      var c = new THREE.Color(hex);
      c.multiplyScalar(f);
      return c.getHex();
    }
    function makeCarGroup(car) {
      var g = new THREE.Group();
      var bodyM = new THREE.MeshLambertMaterial({ color: car.color });
      var rockerM = new THREE.MeshLambertMaterial({ color: darken(car.color, 0.58) });
      var low = car.type === 'sport' ? -0.12 : 0;
      var wScale = car.type === 'sport' ? 0.92 : 1;
      var len = car.type === 'van' ? 1.07 : 1;
      function section(w, h, d, x, y, z, material) {
        var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material || bodyM);
        m.position.set(x, y, z);
        m.castShadow = true;
        g.add(m);
        return m;
      }
      // 5-section shell (forward is +z; rear wing sits at -z).
      section(1.7 * wScale, 0.5, 1.1 * len, 0, 0.55 + low, 1.75 * len); // nose
      section(2.0 * wScale, 0.62, 1.3 * len, 0, 0.55 + low, 0.75 * len); // shoulders
      section(1.9 * wScale, 0.55, 1.1 * len, 0, 0.55 + low, -1.55 * len); // rear deck
      section(1.8 * wScale, 0.48, 0.5 * len, 0, 0.52 + low, -2.25 * len); // tail
      // Cabin glass (tall merged cabin on vans; transparent on police cars).
      var cabinM = car.police
        ? new THREE.MeshLambertMaterial({ color: 0x395368, transparent: true, opacity: 0.37 })
        : mat(0x395368);
      var cabin;
      if (car.type === 'van') {
        cabin = section(1.9, 1.05, 3.0 * len, 0, 1.05, -0.4, cabinM);
        var seamL = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 2.5), mat(0x5a6a7a));
        seamL.position.set(-1.0, 0.8, -0.4); g.add(seamL);
        var seamR = seamL.clone(); seamR.position.x = 1.0; g.add(seamR);
      } else {
        cabin = section(car.type === 'sport' ? 1.6 : 1.7, car.type === 'sport' ? 0.45 : 0.55, 1.9 * len, 0, 1.02 + low, -0.35, cabinM);
      }
      cabin.castShadow = false;
      // GFX1 details: front bar (grille + headlights + indicators), rear
      // bar (full-width tail lights), beltline, rocker, mirror bar.
      var frontBar = new THREE.Mesh(new THREE.BoxGeometry(1.7 * wScale, 0.3, 0.08),
        new THREE.MeshLambertMaterial({ map: frontBarTex }));
      frontBar.position.set(0, 0.58 + low, 2.32 * len);
      g.add(frontBar);
      var rearBar = new THREE.Mesh(new THREE.BoxGeometry(1.75 * wScale, 0.3, 0.08),
        new THREE.MeshLambertMaterial({ map: rearBarTex }));
      rearBar.position.set(0, 0.58 + low, -2.52 * len);
      g.add(rearBar);
      var belt = new THREE.Mesh(new THREE.BoxGeometry(2.06 * wScale, 0.06, 4.4 * len), mat(0xd9dee2));
      belt.position.set(0, 0.92 + low, 0);
      g.add(belt);
      var rocker = new THREE.Mesh(new THREE.BoxGeometry(2.04 * wScale, 0.14, 4.2 * len), rockerM);
      rocker.position.set(0, 0.32, 0);
      g.add(rocker);
      var mirrors = new THREE.Mesh(new THREE.BoxGeometry(2.3 * wScale, 0.08, 0.12), mat(0x2c3138));
      mirrors.position.set(0, 0.95 + low, 0.35);
      g.add(mirrors);
      // Wheels.
      var wheels = [];
      [[-1.05, 1.7], [1.05, 1.7], [-1.05, -1.7], [1.05, -1.7]].forEach(function (wp) {
        var w = new THREE.Mesh(carGeo.wheel, mat(0x292b37));
        w.rotation.z = Math.PI / 2;
        w.position.set(wp[0], 0.42, wp[1] * len);
        g.add(w); wheels.push(w);
      });
      var extras = {};
      if (car.taxi) {
        var sign = new THREE.Mesh(carGeo.sign, mat(0xffe497, { emissive: 0xffe497, emissiveIntensity: 0.7 }));
        sign.position.set(0, 1.45, -0.3);
        g.add(sign); extras.sign = sign;
      }
      if (car.type === 'sport') {
        var splitter = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 0.5), mat(0x22252e));
        splitter.position.set(0, 0.3, 2.25);
        g.add(splitter);
        var wing = new THREE.Mesh(carGeo.wing, bodyM);
        wing.position.set(0, 0.95, -2.6);
        g.add(wing);
        [-0.8, 0.8].forEach(function (px) {
          var post = new THREE.Mesh(carGeo.post, bodyM);
          post.position.set(px, 0.78, -2.6);
          g.add(post);
        });
      }
      if (car.police) {
        // Dark blue livery: side stripe, hood + trunk stripes, roof trim.
        var stripe = new THREE.Mesh(new THREE.BoxGeometry(2.06, 0.18, 3.4), mat(0x24456a));
        stripe.position.set(0, 0.62, 0);
        g.add(stripe);
        var hood = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.02, 1.1), mat(0x24456a));
        hood.position.set(0, 0.87, 1.4);
        g.add(hood);
        var trunk = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.02, 0.9), mat(0x24456a));
        trunk.position.set(0, 0.87, -1.9);
        g.add(trunk);
        var roofBar = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.06, 0.4), mat(0x1c314c));
        roofBar.position.set(0, 1.38, -0.3);
        g.add(roofBar);
        var bar = new THREE.Mesh(carGeo.bar, mat(0x222222));
        bar.position.set(0, 1.4, -0.3);
        g.add(bar);
        var rl = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.3), new THREE.MeshBasicMaterial({ color: 0xff4d89 }));
        rl.position.set(-0.45, 1.55, -0.3);
        g.add(rl);
        var bl = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.3), new THREE.MeshBasicMaterial({ color: 0x58c8ff }));
        bl.position.set(0.45, 1.55, -0.3);
        g.add(bl);
        extras.red = rl; extras.blue = bl;
        // The driver is visible through the transparent cabin (reference §8.2).
        var dBody = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.25), mat(0x1d3550));
        dBody.position.set(0, 0.75, -0.35);
        g.add(dBody);
        var dHead = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), mat(0xc98b65));
        dHead.position.set(0, 1.15, -0.35);
        g.add(dHead);
        var dHat = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 0.34), mat(0x101d30));
        dHat.position.set(0, 1.28, -0.35);
        g.add(dHat);
      }
      // Blob shadow.
      var blob = new THREE.Mesh(new THREE.PlaneGeometry(3, 5.6),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false }));
      blob.rotation.x = -Math.PI / 2; blob.position.y = 0.03;
      g.add(blob);
      g.userData = { car: car, wheels: wheels, extras: extras };
      scene.add(g);
      return g;
    }
    function makeTowGroup(car) {
      var g = new THREE.Group();
      var cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.1, 1.6), mat(0xeeb54e));
      cab.position.set(0, 0.85, 1.6); cab.castShadow = true;
      g.add(cab);
      var shield = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 0.1), mat(0x395368));
      shield.position.set(0, 1.05, 2.42);
      g.add(shield);
      var frame = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.3, 4.6), mat(0x344958));
      frame.position.set(0, 0.5, 0);
      g.add(frame);
      var deck = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.25, 3.6), mat(0x263744));
      deck.position.set(0, 0.75, -1.2);
      g.add(deck);
      var strip = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.1, 3.4), mat(0xffdf83));
      strip.position.set(0, 0.78, -1.2);
      g.add(strip);
      // Industrial A-frame behind the cab.
      [-0.7, 0.7].forEach(function (ax) {
        var leg = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.7, 0.15), mat(0xeeb54e));
        leg.position.set(ax, 1.5, 0.5);
        leg.rotation.x = -0.35;
        g.add(leg);
      });
      var cross = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.15, 0.15), mat(0xeeb54e));
      cross.position.set(0, 2.2, 0.2);
      g.add(cross);
      var beacon = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.15, 0.4), new THREE.MeshBasicMaterial({ color: 0xffc24d }));
      beacon.position.set(0, 1.48, 1.6);
      g.add(beacon);
      var wheels = [];
      [[-1.05, 1.7], [1.05, 1.7], [-1.05, -0.8], [1.05, -0.8], [-1.05, -1.9], [1.05, -1.9]].forEach(function (wp) {
        var w = new THREE.Mesh(carGeo.wheel, mat(0x292b37));
        w.rotation.z = Math.PI / 2;
        w.position.set(wp[0], 0.42, wp[1]);
        g.add(w); wheels.push(w);
      });
      // Steel cable (sagging) + 3-segment yellow hook, shown when towing.
      var cablePts = [
        new THREE.Vector3(0, 2.2, 0.2), new THREE.Vector3(0, 1.6, -1.8),
        new THREE.Vector3(0, 1.0, -3.6), new THREE.Vector3(0, 0.6, -5.4),
        new THREE.Vector3(0, 0.55, -6.0)
      ];
      var cableGeo = new THREE.BufferGeometry().setFromPoints(cablePts);
      var cable = new THREE.Line(cableGeo, new THREE.LineBasicMaterial({ color: 0xa7b8bd }));
      cable.visible = false;
      g.add(cable);
      var hook = new THREE.Group();
      [0, 1, 2].forEach(function (hi) {
        var seg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.16), mat(0xf4c15e));
        seg.position.set(0, -hi * 0.2, hi * 0.12);
        hook.add(seg);
      });
      hook.position.set(0, 0.55, -6.0);
      hook.visible = false;
      g.add(hook);
      var blob = new THREE.Mesh(new THREE.PlaneGeometry(3, 6.4),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false }));
      blob.rotation.x = -Math.PI / 2; blob.position.y = 0.03;
      g.add(blob);
      g.userData = { car: car, wheels: wheels, extras: { beacon: beacon, cable: cable, hook: hook } };
      scene.add(g);
      return g;
    }
    function makeAmbulanceGroup(car) {
      var g = new THREE.Group();
      var box1 = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.9, 3.2), mat(0xf2f3e9));
      box1.position.set(0, 1.25, -1.0); box1.castShadow = true;
      g.add(box1);
      var cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.0, 1.4), mat(0x365e70));
      cab.position.set(0, 0.8, 1.6);
      g.add(cab);
      var hood = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.5, 0.8), mat(0xf2f3e9));
      hood.position.set(0, 0.55, 2.2);
      g.add(hood);
      // Teal + lime side stripes (reference §8.5: NO red cross).
      var teal = new THREE.Mesh(new THREE.BoxGeometry(2.14, 0.25, 3.0), mat(0x178d88));
      teal.position.set(0, 1.0, -1.0);
      g.add(teal);
      var lime = new THREE.Mesh(new THREE.BoxGeometry(2.14, 0.12, 3.0), mat(0xd9ef80));
      lime.position.set(0, 0.7, -1.0);
      g.add(lime);
      var crossV = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.04), mat(0x178d88));
      crossV.position.set(0, 1.3, -2.62);
      g.add(crossV);
      var crossH = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.04), mat(0x178d88));
      crossH.position.set(0, 1.3, -2.62);
      g.add(crossH);
      var strobeB = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.4), new THREE.MeshBasicMaterial({ color: 0x61d7ff }));
      strobeB.position.set(-0.5, 2.28, -1.0);
      g.add(strobeB);
      var strobeA = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.4), new THREE.MeshBasicMaterial({ color: 0xffc24d }));
      strobeA.position.set(0.5, 2.28, -1.0);
      g.add(strobeA);
      var bumper = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.3, 0.2), mat(0x344958));
      bumper.position.set(0, 0.4, 2.5);
      g.add(bumper);
      [-0.8, 0.8].forEach(function (tx) {
        var tl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.06), mat(0xffc24d));
        tl.position.set(tx, 0.7, -2.63);
        g.add(tl);
      });
      var wheels = [];
      [[-1.05, 1.7], [1.05, 1.7], [-1.05, -1.7], [1.05, -1.7]].forEach(function (wp) {
        var w = new THREE.Mesh(carGeo.wheel, mat(0x292b37));
        w.rotation.z = Math.PI / 2;
        w.position.set(wp[0], 0.42, wp[1]);
        g.add(w); wheels.push(w);
      });
      var blob = new THREE.Mesh(new THREE.PlaneGeometry(3, 5.6),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false }));
      blob.rotation.x = -Math.PI / 2; blob.position.y = 0.03;
      g.add(blob);
      g.userData = { car: car, wheels: wheels, extras: { strobeB: strobeB, strobeA: strobeA } };
      scene.add(g);
      return g;
    }
    function makeBikeGroup(car) {
      var g = new THREE.Group();
      var bodyM = new THREE.MeshLambertMaterial({ color: car.color });
      var engine = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.45, 1.0), mat(0x2b2f38));
      engine.position.y = 0.6;
      g.add(engine);
      var tank = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.35, 0.9), bodyM);
      tank.position.set(0, 0.95, 0.3);
      g.add(tank);
      var spine = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.9), mat(0xd9dee2));
      spine.position.set(0, 1.14, 0.3);
      g.add(spine);
      var seat = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.8), mat(0x22252e));
      seat.position.set(0, 0.9, -0.55);
      g.add(seat);
      var fork = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, 0.08), mat(0x59666b));
      fork.position.set(0, 0.75, 0.95);
      fork.rotation.x = 0.5;
      g.add(fork);
      var bars = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 0.06), mat(0x22252e));
      bars.position.set(0, 1.15, 0.75);
      g.add(bars);
      var head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.08), mat(0xffefd4));
      head.position.set(0, 0.95, 1.15);
      g.add(head);
      var tail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.06), mat(0xff555e));
      tail.position.set(0, 0.85, -1.0);
      g.add(tail);
      var exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.0, 6), mat(0x8d9fad));
      exhaust.rotation.x = Math.PI / 2;
      exhaust.position.set(0.32, 0.55, -0.3);
      g.add(exhaust);
      var fender = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 0.7), bodyM);
      fender.position.set(0, 0.92, 1.0);
      g.add(fender);
      var w1 = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.09, 6, 12), mat(0x292b37));
      w1.position.set(0, 0.42, 0.95); g.add(w1);
      var w2 = w1.clone(); w2.position.z = -0.95; g.add(w2);
      // Rider: leaning on the bars, helmet for NPC riders (reference §8.3).
      var rider = new THREE.Group();
      var rBody = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.5, 0.22), mat(0x4d6967));
      rBody.position.set(0, 1.05, -0.1);
      rBody.rotation.x = 0.5;
      rider.add(rBody);
      var rHead = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), mat(0xd8a878));
      rHead.position.set(0, 1.38, 0.05);
      rider.add(rHead);
      var helmet = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshLambertMaterial({ color: 0xe46c70 }));
      helmet.position.set(0, 1.4, 0.05);
      rider.add(helmet);
      rider.visible = false;
      g.add(rider);
      g.userData = { car: car, wheels: [w1, w2], extras: { rider: rider, riderBody: rBody, helmet: helmet } };
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
      var deck = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 4.6), mat(0x2e4a56));
      deck.position.y = 0.72;
      g.add(deck);
      var console = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.6), mat(0xe46b4e));
      console.position.set(0, 1.05, 0.6);
      g.add(console);
      var shield = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.08), mat(0x395368));
      shield.position.set(0, 1.5, 0.95);
      g.add(shield);
      var bench = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.18, 0.7), mat(0xf0ead8));
      bench.position.set(0, 0.85, -1.4);
      g.add(bench);
      var rail = new THREE.Mesh(new THREE.BoxGeometry(2.24, 0.14, 6.2), mat(0x22282f));
      rail.position.set(0, 0.72, 0);
      g.add(rail);
      var stripe = new THREE.Mesh(new THREE.BoxGeometry(2.24, 0.14, 0.5), mat(0xe46b4e));
      stripe.position.set(0, 0.5, 1.5);
      g.add(stripe);
      var bowLight = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), new THREE.MeshBasicMaterial({ color: 0xfff2cf }));
      bowLight.position.set(0, 0.8, 3.2);
      g.add(bowLight);
      // Foam trail at the stern (reference §11: speed > 3).
      var foam = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 4.0),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false }));
      foam.rotation.x = -Math.PI / 2;
      foam.position.set(0, 0.06, -4.5);
      foam.visible = false;
      g.add(foam);
      // Helmsman seated at the console (reference §10 sitting pose).
      var helm = new THREE.Group();
      var hBody = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.5, 0.22), mat(0x3ca7b6));
      hBody.position.set(0, 1.0, 0.1);
      helm.add(hBody);
      var hHead = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), mat(0xd8a878));
      hHead.position.set(0, 1.35, 0.15);
      helm.add(hHead);
      helm.visible = false;
      g.add(helm);
      g.userData = { car: car, wheels: [], extras: { foam: foam, helm: helm } };
      scene.add(g);
      return g;
    }
    var carGroups = new Map();
    // Headlight cones + pools (reference §5/§8.1): instanced, capped at the
    // 24 occupied cars nearest the camera, only at night.
    var HL_MAX = 24;
    var hlConeGeo = new THREE.ConeGeometry(1.1, 7.5, 10, 1, true);
    hlConeGeo.rotateX(-Math.PI / 2);
    hlConeGeo.translate(0, 0, 3.75);
    hlConeGeo.rotateX(0.045); // tilt 0.045 down toward the road
    var hlConeMat = new THREE.MeshBasicMaterial({ color: 0xffe9bb, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    var hlConeIM = new THREE.InstancedMesh(hlConeGeo, hlConeMat, HL_MAX * 2);
    hlConeIM.frustumCulled = false;
    scene.add(hlConeIM);
    var hlPoolMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
    var hlPoolIM = new THREE.InstancedMesh(new THREE.CircleGeometry(1.6, 12), hlPoolMat, HL_MAX);
    hlPoolIM.frustumCulled = false;
    scene.add(hlPoolIM);

    // Helicopters: 3 rigs (reference §9) — elongated-ball body, blue belly,
    // glass canopy, tail boom + fin + stabilizer, steel skids with struts,
    // 13-unit main rotor, tail rotor, nav lights, beacon, and a REAL
    // SpotLight (0xffe9ad, 210, 620, 0.12, 0.24) with an additive cone
    // (0xffedb7, 0.15) + ground disc (0xffe6a2, 0.27) + edge ring.
    var heliGroups = [];
    var _upNeg = new THREE.Vector3(0, -1, 0);
    var _v1 = new THREE.Vector3();
    for (var hi = 0; hi < 3; hi++) {
      var hg = new THREE.Group();
      var hBody = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshPhongMaterial({ color: 0xe9ece8, shininess: 30 }));
      hBody.scale.set(2.7, 1.7, 4.3);
      hg.add(hBody);
      var belly = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), mat(0x244b6b));
      belly.scale.set(2.2, 0.8, 3.4);
      belly.position.y = -0.7;
      hg.add(belly);
      var glass = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8),
        new THREE.MeshPhongMaterial({ color: 0x67b8cb, specular: 0xd8ffff, shininess: 60, transparent: true, opacity: 0.82 }));
      glass.scale.set(1.6, 0.9, 1.6);
      glass.position.set(0, 0.4, 1.9);
      hg.add(glass);
      var sideStripe = new THREE.Mesh(new THREE.BoxGeometry(2.72, 0.18, 3.8), mat(0x244b6b));
      sideStripe.position.set(0, 0.1, 0);
      hg.add(sideStripe);
      var tail = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.4, 4.4, 6), mat(0xe9ece8));
      tail.rotation.x = Math.PI / 2;
      tail.position.set(0, 0.3, -4.2);
      hg.add(tail);
      var fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 1.0), mat(0x244b6b));
      fin.position.set(0, 0.9, -5.6);
      hg.add(fin);
      var stab = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.5), mat(0x244b6b));
      stab.position.set(0, 0.35, -5.2);
      hg.add(stab);
      var rotor = new THREE.Mesh(new THREE.BoxGeometry(13, 0.085, 0.2), mat(0x252d38));
      rotor.position.y = 0.95;
      hg.add(rotor);
      [-6.25, 6.25].forEach(function (tx) {
        var tip = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.24), mat(0xe9ece8));
        tip.position.set(tx, 0, 0);
        rotor.add(tip);
      });
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
      [-0.9, 0.9].forEach(function (sx) {
        var skid = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 3.4), mat(0x414b55));
        skid.position.set(sx, -1.1, 0); hg.add(skid);
        [-1.0, 1.0].forEach(function (sz) {
          var strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, 0.08), mat(0x414b55));
          strut.position.set(sx, -0.6, sz);
          strut.rotation.z = sx > 0 ? 0.4 : -0.4;
          hg.add(strut);
        });
      });
      // Spotlight housing under the nose + lens.
      var housing = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.5), mat(0x252d38));
      housing.position.set(0, -0.95, 1.8);
      hg.add(housing);
      var lens = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffe9ad }));
      lens.position.set(0, -1.1, 1.8);
      hg.add(lens);
      // Searchlight: real SpotLight + additive cone (unit height, scaled to
      // the heli-to-target distance) + ground disc + edge ring.
      var spot = new THREE.SpotLight(0xffe9ad, 0, 620, 0.12, 0.24);
      var spotTarget = new THREE.Object3D();
      scene.add(spotTarget);
      spot.target = spotTarget;
      spot.visible = false;
      scene.add(spot);
      var cone = new THREE.Mesh(new THREE.ConeGeometry(4.5, 1, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffedb7, transparent: true, opacity: 0.15, side: THREE.FrontSide, depthWrite: false, blending: THREE.AdditiveBlending }));
      cone.visible = false;
      scene.add(cone);
      var disk = new THREE.Mesh(new THREE.CircleGeometry(4.5, 20),
        new THREE.MeshBasicMaterial({ color: 0xffe6a2, transparent: true, opacity: 0.27, depthWrite: false, blending: THREE.AdditiveBlending }));
      disk.rotation.x = -Math.PI / 2;
      disk.visible = false;
      scene.add(disk);
      var ring = new THREE.Mesh(new THREE.RingGeometry(4.3, 4.5, 24),
        new THREE.MeshBasicMaterial({ color: 0xffe6a2, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      scene.add(ring);
      hg.userData = { rotor: rotor, rotor2: rotor2, tailRotor: tailRotor, cone: cone, disk: disk, ring: ring, beacon: beacon, spot: spot, spotTarget: spotTarget };
      hg.visible = false;
      scene.add(hg);
      heliGroups.push(hg);
    }

    // Objective marker: pulsing ground ring + floating rotating crystal +
    // vertical beam (reference §12: ring breathes ±10.5% at 3.4 rad/s,
    // main crystal 1.05 with a 9.3 beam; side targets smaller, no beam).
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
    // Tracers: short lines, player 0xffe6a6 / enemy 0xff7f82 (reference §12).
    var TRACER_MAX = 24;
    var tracerGeo = new THREE.BufferGeometry();
    tracerGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRACER_MAX * 6), 3));
    tracerGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRACER_MAX * 6), 3));
    var tracers = new THREE.LineSegments(tracerGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
    tracers.frustumCulled = false;
    scene.add(tracers);
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
    // Chase camera sits lower and closer than before (reference framing:
    // the road fills the frame and speed reads).
    var cam = { yaw: game.player.yaw, pitch: 0.16, dist: 8, lookIdle: 0 };
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
    function cameraDistance(target, want) {
      // Pull the camera in when a building blocks the ray (min 0.70).
      var d = want;
      var steps = 12;
      for (var i = 1; i <= steps; i++) {
        var t = (i / steps) * want;
        var x = target.x - Math.cos(cam.yaw) * Math.cos(cam.pitch) * t;
        var z = target.z - Math.sin(cam.yaw) * Math.cos(cam.pitch) * t;
        var y = target.y + 1.4 + Math.sin(cam.pitch) * t;
        if (game.blocked(x, z) && y < 12) { d = Math.max(0.7, t - 0.6); break; }
      }
      return d;
    }
    function follow(dt, input) {
      var p = game.player;
      var target = { x: p.x, y: p.y, z: p.z };
      if (input && (input.lookDX || input.lookDY)) {
        cam.yaw -= input.lookDX * 0.004;
        cam.pitch = clamp(cam.pitch + input.lookDY * 0.003, -1.15, 1.24);
        cam.lookIdle = 0;
      } else cam.lookIdle += dt;
      var driving = p.vehicle !== null && Math.abs(p.speed) > 2;
      if (driving && cam.lookIdle > 1.8) {
        cam.yaw += PH.angle(cam.yaw, p.yaw) * Math.min(1, dt * 1.6);
      }
      var want = (input && input.zoom) || (p.vehicle !== null ? 10.5 : 8);
      var got = cameraDistance(target, want);
      cam.dist += (got - cam.dist) * Math.min(1, dt * 8);
      var cx = target.x - Math.cos(cam.yaw) * Math.cos(cam.pitch) * cam.dist;
      var cz = target.z - Math.sin(cam.yaw) * Math.cos(cam.pitch) * cam.dist;
      var cy = target.y + 1.4 + Math.sin(cam.pitch) * cam.dist;
      var k = 1 - Math.exp(-dt * 13);
      camera.position.x += (cx - camera.position.x) * k;
      camera.position.y += (cy - camera.position.y) * k;
      camera.position.z += (cz - camera.position.z) * k;
      if (dist(camera.position.x, camera.position.z, target.x, target.z) > 32) {
        camera.position.set(cx, cy, cz);
      }
      camera.lookAt(target.x, target.y + 1.2, target.z);
    }
    function headlights() {
      // Headlight cones on the player's car + police cars at night.
      return plnNightF;
    }

    function personColor(kind, ref) {
      if (kind === 'hero') return { body: 0x3ca7b6, legs: 0x2a2a33, skin: 0xb9744e,
        hair: 0x272d36, acc: 0xe46b4e, accFront: false, weapon: 0x293c54 };
      if (kind === 'officer') return { body: 0x254164, legs: 0x22334e, skin: 0xd8a878,
        hair: 0x272d36, cap: 0x203753, weapon: 0x192331 };
      if (kind === 'enemy') return { body: 0x873b47, legs: 0x272b3e, skin: 0x8a5a3c,
        hair: 0x322637, acc: 0xec6976, accFront: true, weapon: 0x2c303e };
      if (kind === 'contact') return { body: ref.color || 0xf77f80, legs: 0x2a2a33, skin: 0xd8a878,
        hair: ref.color || 0xf77f80, cap: ref.color || 0xf77f80, acc: 0xffedb8, accFront: true };
      return { body: ref.color || 0x8a94a8, legs: ref.pants || 0x3a3a44, skin: ref.skin || 0xd8a878,
        hair: ref.hair || 0x272d36 };
    }
    function syncPerson(idx, x, z, y, yaw, size, colors, detail, bobPhase) {
      var s = size || 1;
      var bob = detail ? Math.sin(game.time * 6 + bobPhase) * 0.03 : 0;
      var fx = Math.sin(yaw), fz = Math.cos(yaw); // facing direction
      dummy.position.set(x, 0.31 * s + bob + y, z);
      dummy.scale.set(s, s, s);
      dummy.rotation.set(0, yaw, 0);
      dummy.updateMatrix();
      bodyIM.setMatrixAt(idx, dummy.matrix);
      bodyIM.setColorAt(idx, tmpColor.setHex(colors.body));
      dummy.position.set(x, (0.62 + 0.16) * s + bob + y, z);
      dummy.updateMatrix();
      headIM.setMatrixAt(idx, dummy.matrix);
      headIM.setColorAt(idx, tmpColor.setHex(colors.skin));
      if (detail) {
        dummy.position.set(x, 0.25 * s + y, z);
        dummy.updateMatrix();
        legIM.setMatrixAt(idx, dummy.matrix);
        legIM.setColorAt(idx, tmpColor.setHex(colors.legs));
      } else {
        legIM.setMatrixAt(idx, hideMatrix);
      }
      // Pelvis block joins waist to legs; hair sits on the head.
      dummy.position.set(x, 0.55 * s + bob + y, z);
      dummy.updateMatrix();
      pelvisIM.setMatrixAt(idx, dummy.matrix);
      pelvisIM.setColorAt(idx, tmpColor.setHex(colors.legs));
      dummy.position.set(x, (0.62 + 0.16 + 0.12) * s + bob + y, z);
      dummy.updateMatrix();
      hairIM.setMatrixAt(idx, dummy.matrix);
      hairIM.setColorAt(idx, tmpColor.setHex(colors.hair || 0x272d36));
      if (detail) {
        if (colors.acc !== undefined) {
          var as = colors.accFront ? 1 : -1;
          dummy.position.set(x + fx * 0.2 * as * s, 0.42 * s + bob + y, z + fz * 0.2 * as * s);
          dummy.updateMatrix();
          accIM.setMatrixAt(idx, dummy.matrix);
          accIM.setColorAt(idx, tmpColor.setHex(colors.acc));
        } else accIM.setMatrixAt(idx, hideMatrix);
        if (colors.cap !== undefined) {
          dummy.position.set(x, (0.62 + 0.16 + 0.2) * s + bob + y, z);
          dummy.updateMatrix();
          capIM.setMatrixAt(idx, dummy.matrix);
          capIM.setColorAt(idx, tmpColor.setHex(colors.cap));
        } else capIM.setMatrixAt(idx, hideMatrix);
        if (colors.weapon !== undefined) {
          dummy.position.set(x - fz * 0.28 * s, 0.5 * s + bob + y, z + fx * 0.28 * s);
          dummy.updateMatrix();
          weaponIM.setMatrixAt(idx, dummy.matrix);
          weaponIM.setColorAt(idx, tmpColor.setHex(colors.weapon));
        } else weaponIM.setMatrixAt(idx, hideMatrix);
      } else {
        accIM.setMatrixAt(idx, hideMatrix);
        capIM.setMatrixAt(idx, hideMatrix);
        weaponIM.setMatrixAt(idx, hideMatrix);
      }
    }

    function update(dt, input) {
      var p = game.player;
      var clock = game.clock;
      var storm = stormAmp();
      // Day / night.
      var light = daylight(clock);
      var golden = (clock > 17 && clock < 18.5) || (clock >= 6 && clock < 7);
      sun.intensity = 2.04 * light + 0.05;
      sun.color = hexLerp(0xffe9c9, 0xff9a52, golden ? 0.7 : 0);
      // Hemisphere shifts with the day curve (reference §2): 0x8b9aca at
      // night, 0xffefd8 at noon; intensity 1.52 at full day.
      hemi.intensity = 1.52 * (0.35 + 0.65 * light);
      hemi.color.copy(hexLerp(0x8b9aca, 0xffefd8, light));
      // Sun position swings with the clock.
      var sunAngle = ((clock - 6) / 12) * Math.PI;
      sun.position.set(Math.cos(sunAngle) * -80, 30 + Math.sin(sunAngle) * 60, -38);
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
      bulbMat.color.copy(hexLerp(0x49525c, 0xffdda7, plnNightF));
      for (var bmi = 0; bmi < bodyMats.length; bmi++) bodyMats[bmi].emissiveIntensity = plnNightF * 0.9;
      haloMat.opacity = 0.85 * plnNightF;
      lampPoolMat.opacity = 0.5 * plnNightF;
      facePoolMat.opacity = 0.5 * plnNightF;
      stripMat.opacity = 0.25 + 0.75 * plnNightF;
      fixMat.opacity = 0.25 + 0.75 * plnNightF;
      sheenMat.opacity = 0.35 * storm;
      puddleMat.opacity = 0.55 * storm;
      // Rain.
      var rainOpacity = 0.5 * storm;
      rainMat.opacity = rainOpacity;
      if (rainOpacity > 0.01) {
        var pos = rainGeo.attributes.position.array;
        for (var i = 0; i < RAIN_N; i++) {
          var sd = rainSeed[i];
          var rx = camera.position.x + sd.x;
          var ry = ((sd.y - game.time * 23) % 30 + 30) % 30;
          var rz = camera.position.z + sd.z;
          pos[i * 6] = rx + 0.5; pos[i * 6 + 1] = ry; pos[i * 6 + 2] = rz;
          pos[i * 6 + 3] = rx; pos[i * 6 + 4] = ry - 1.6; pos[i * 6 + 5] = rz;
        }
        rainGeo.attributes.position.needsUpdate = true;
      }
      waterUniforms.time.value = game.time;
      waterUniforms.storm.value = storm;
      // Lightning flash (reference §14: sun +1.5, hemisphere +0.7).
      if (game.lightning) {
        hemi.intensity += 0.7;
        sun.intensity += 1.5;
      }

      // ---------- sync people (instanced, culled to 190) ----------
      var idx = 0;
      var camX = camera.position.x, camZ = camera.position.z;
      function personVisible(x, z) { return dist(x, z, camX, camZ) < CROWD_RANGE; }
      // Hero: drawn on foot; in a car the cabin hides them, on a bike or
      // boat the seated rider/helmsman figure on the vehicle shows them.
      if (p.vehicle === null) {
        syncPerson(idx++, p.x, p.z, p.y, p.yaw, 1.12, personColor('hero'), true, 0);
      }
      // Pedestrians.
      for (var pi = 0; pi < game.peds.length && idx < MAXP; pi++) {
        var ped = game.peds[pi];
        if (ped.down) continue;
        if (!personVisible(ped.x, ped.z)) continue;
        var detail = dist(ped.x, ped.z, camX, camZ) < DETAIL_DIST;
        syncPerson(idx++, ped.x, ped.z, 0, ped.yaw, ped.size, personColor('ped', ped), detail, ped.id);
      }
      // Police foot officers.
      for (var oi = 0; oi < game.police.length && idx < MAXP; oi++) {
        var off = game.police[oi];
        if (!off.foot || off.state === 'down') continue;
        if (!personVisible(off.x, off.z)) continue;
        syncPerson(idx++, off.x, off.z, 0, off.yaw, 1.04, personColor('officer'), true, oi + 40);
      }
      // Enemies.
      for (var ei = 0; ei < game.enemies.length && idx < MAXP; ei++) {
        var en = game.enemies[ei];
        if (en.down) continue;
        if (!personVisible(en.x, en.z)) continue;
        syncPerson(idx++, en.x, en.z, 0, 0, 1.0, personColor('enemy'), true, ei + 80);
      }
      // Contacts (Mara etc.): contact-palette figures with chest mark + hat.
      for (var ci = 0; ci < PH.CONTACTS.length && idx < MAXP; ci++) {
        var ct = PH.CONTACTS[ci];
        if (ct.kind !== 'contact') continue;
        if (!personVisible(ct.x, ct.z)) continue;
        syncPerson(idx++, ct.x, ct.z, 0, 0, 1.0,
          personColor('contact', { color: PH.CHECKPOINT_COLORS[ci % PH.CHECKPOINT_COLORS.length] }), true, ci + 120);
      }
      // Taxi passenger.
      if (game.taxiWait && idx < MAXP && personVisible(game.taxiWait.x, game.taxiWait.z)) {
        syncPerson(idx++, game.taxiWait.x, game.taxiWait.z, 0, 0, 1.0, { body: 0xf8cf69, legs: 0x3a3a44, skin: 0xd8a878, hair: 0x34313d }, true, 200);
      }
      // Beachgoers.
      if (game.beachgoers) {
        for (var bi = 0; bi < game.beachgoers.length && idx < MAXP; bi++) {
          var bg = game.beachgoers[bi];
          if (bg.hidden) continue;
          if (!personVisible(bg.x, bg.z)) continue;
          syncPerson(idx++, bg.x, bg.z, 0, bg.yaw, 0.95, { body: bg.color, legs: 0xd8a878, skin: 0xd8a878, hair: 0x34313d }, true, bi + 300);
        }
      }
      for (var hi2 = idx; hi2 < MAXP; hi2++) {
        for (var hm = 0; hm < personMeshes.length; hm++) personMeshes[hm].setMatrixAt(hi2, hideMatrix);
      }
      personMeshes.forEach(function (m) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      });
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
          if (car.type === 'bike') g = makeBikeGroup(car);
          else if (car.type === 'boat') g = makeBoatGroup(car);
          else if (car.type === 'tow') g = makeTowGroup(car);
          else if (car.type === 'ambulance') g = makeAmbulanceGroup(car);
          else g = makeCarGroup(car);
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
        if (ud.extras) {
          var ex = ud.extras;
          // Police lightbar: pink-red 0xff4d89 / blue 0x58c8ff alternating
          // at 21 rad/s ONLY while chasing; dim when inactive (ref §8.2).
          if (ex.red) {
            if (car.pursuit) {
              var flash = Math.sin(game.time * 21 + car.id) > 0;
              ex.red.material.color.setHex(flash ? 0xff4d89 : 0x79314d);
              ex.blue.material.color.setHex(flash ? 0x2b508a : 0x58c8ff);
            } else {
              ex.red.material.color.setHex(0x79314d);
              ex.blue.material.color.setHex(0x2b508a);
            }
          }
          // Tow beacon flashes amber; cable + hook show while towing.
          if (ex.beacon) {
            ex.beacon.material.color.setHex(Math.sin(game.time * 6) > 0 ? 0xffc24d : 0x553a00);
          }
          if (ex.cable) {
            var hooked = !!car.hooked;
            ex.cable.visible = hooked;
            ex.hook.visible = hooked;
          }
          // Ambulance strobe: blue/amber alternating while on duty.
          if (ex.strobeB) {
            var onDuty = car.state === 'drive' || car.state === 'treat';
            var st = Math.sin(game.time * 8) > 0;
            ex.strobeB.material.color.setHex(onDuty ? (st ? 0x61d7ff : 0x1a3a4a) : 0x1a3a4a);
            ex.strobeA.material.color.setHex(onDuty ? (st ? 0x553a00 : 0xffc24d) : 0x553a00);
          }
          // Bike rider: leaning on the bars, helmet for NPC riders only.
          if (ex.rider) {
            ex.rider.visible = !!car.driver;
            var isPlayer = car.id === p.vehicle;
            ex.helmet.visible = !!car.driver && !isPlayer;
            ex.riderBody.material.color.setHex(isPlayer ? 0x3ca7b6 : [0x314157, 0x434958, 0x676477, 0x385c64, 0x8f775f][car.id % 5]);
            ex.helmet.material.color.setHex([0xe46c70, 0xf4bb45, 0x3cc8cf, 0xede4cf][car.id % 4]);
          }
          // Boat foam trail (speed > 3) + helmsman at the console.
          if (ex.foam) {
            ex.foam.visible = Math.abs(car.speed || 0) > 3;
            ex.helm.visible = !!car.driver;
          }
        }
        carCount++;
      }
      for (var cvi = 0; cvi < game.cars.length; cvi++) syncCar(game.cars[cvi]);
      // Police cars (units, not in game.cars).
      for (var pci = 0; pci < game.police.length; pci++) {
        var unit = game.police[pci];
        if (unit.foot) continue;
        var fake = { id: 5000 + pci, type: 'sedan', color: 0xeff0eb, x: unit.x, z: unit.z, yaw: unit.yaw, speed: unit.speed, police: true, pursuit: unit.state === 'chase' };
        syncCar(fake);
      }
      // Emergency units.
      if (game.emergency) {
        for (var eui = 0; eui < game.emergency.units.length; eui++) {
          var eu = game.emergency.units[eui];
          var etype = eu.kind === 'tow' ? 'tow' : 'ambulance';
          var fake2 = { id: 6000 + eui, type: etype, color: eu.color, x: eu.x, z: eu.z, yaw: eu.yaw, speed: eu.speed, state: eu.state, hooked: !!(eu.car && eu.car.hooked) };
          syncCar(fake2);
        }
      }
      // Headlight cones + pools for the nearest occupied cars at night.
      var hlCars = [];
      if (plnNightF > 0.05) {
        carGroups.forEach(function (gg) {
          var cc = gg.userData.car;
          if (cc && cc.driver && gg.visible && cc.type !== 'boat' && cc.type !== 'tow' && cc.type !== 'ambulance') hlCars.push(cc);
        });
        hlCars.sort(function (a, b) { return dist(a.x, a.z, camX, camZ) - dist(b.x, b.z, camX, camZ); });
      }
      for (var hli = 0; hli < HL_MAX; hli++) {
        var hc = hlCars[hli];
        if (hc) {
          var rotY = -hc.yaw + Math.PI / 2;
          var fxx = Math.cos(hc.yaw), fzz = Math.sin(hc.yaw);
          var lenScale = hc.type === 'bike' ? 5 / 7.5 : 1;
          [-0.6, 0.6].forEach(function (lat, k) {
            dummy.position.set(hc.x + fxx * 2.6 - fzz * lat, 0.6, hc.z + fzz * 2.6 + fxx * lat);
            dummy.scale.set(1, 1, lenScale);
            dummy.rotation.set(0, rotY, 0);
            dummy.updateMatrix();
            hlConeIM.setMatrixAt(hli * 2 + k, dummy.matrix);
          });
          dummy.position.set(hc.x + fxx * 6.5, 0.05, hc.z + fzz * 6.5);
          dummy.scale.set(1, 1, 1);
          dummy.rotation.set(-Math.PI / 2, 0, 0);
          dummy.updateMatrix();
          hlPoolIM.setMatrixAt(hli, dummy.matrix);
        } else {
          hlConeIM.setMatrixAt(hli * 2, hideMatrix);
          hlConeIM.setMatrixAt(hli * 2 + 1, hideMatrix);
          hlPoolIM.setMatrixAt(hli, hideMatrix);
        }
      }
      hlConeIM.instanceMatrix.needsUpdate = true;
      hlPoolIM.instanceMatrix.needsUpdate = true;
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
          if (!h.active) continue;
          hg.position.set(h.x, h.y, h.z);
          hg.rotation.set(h.pitch || 0, -h.yaw + Math.PI / 2, h.roll || 0);
          hg.userData.rotor.rotation.y = h.rotorPhase;
          hg.userData.rotor2.rotation.y = h.rotorPhase + Math.PI / 2;
          hg.userData.tailRotor.rotation.x = h.tailPhase;
          hg.userData.beacon.material.color.setHex(Math.sin(game.time * 6) > 0 ? 0xff404a : 0x550000);
          var lit = !!h.lit;
          var ud = hg.userData;
          ud.cone.visible = lit;
          ud.disk.visible = lit;
          ud.ring.visible = lit;
          ud.spot.visible = lit;
          if (lit && h.spotTarget) {
            var tx = h.spotTarget.x, tz = h.spotTarget.z;
            var dx = tx - h.x, dy = 0 - h.y, dz = tz - h.z;
            var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            var baseR = len * 0.12; // SpotLight angle 0.12
            ud.cone.position.set((h.x + tx) / 2, h.y / 2, (h.z + tz) / 2);
            _v1.set(dx / len, dy / len, dz / len);
            ud.cone.quaternion.setFromUnitVectors(_upNeg, _v1);
            ud.cone.scale.set(baseR / 4.5, len, baseR / 4.5);
            ud.disk.position.set(tx, 0.12, tz);
            ud.disk.scale.setScalar(baseR / 4.5);
            ud.ring.position.set(tx, 0.13, tz);
            ud.ring.scale.setScalar(baseR / 4.5);
            ud.spot.position.set(h.x, h.y - 1, h.z);
            ud.spotTarget.position.set(tx, 0, tz);
            // Intensity is split evenly when 2-3 helis shine together
            // (reference §9: "dibagi rata supaya tidak menumpuk") — the
            // light, the cone, the disc and the ring all share one budget,
            // so three overlapping beams total 210 / 0.15 / 0.27 / 0.5.
            var share = game.litShare || 1;
            ud.spot.intensity = 210 * share;
            // The cone is one beam per heli — the beams do not share a
            // spot, so each keeps its full 0.15. The disc and ring do
            // share the target spot, so they split like the light.
            ud.cone.material.opacity = 0.15;
            ud.disk.material.opacity = 0.27 * share;
            ud.ring.material.opacity = 0.5 * share;
          } else {
            ud.spot.intensity = 0;
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
        // Reference §12: the ground ring breathes ±10.5% at 3.4 rad/s.
        mRing.scale.setScalar(1 + 0.105 * Math.sin(game.time * 3.4));
        var pulse = 0.72 + Math.sin(game.time * 3) * 0.23;
        mBeam.material.opacity = 0.3 * pulse;
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
      // Tracers (reference §12): player 0xffe6a6, enemy 0xff7f82.
      var tPos = tracerGeo.attributes.position.array;
      var tCol = tracerGeo.attributes.color.array;
      var tPlayer = new THREE.Color(0xffe6a6), tFoe = new THREE.Color(0xff7f82);
      for (var ti = 0; ti < TRACER_MAX; ti++) {
        var sh = game.shots && game.shots[ti];
        var c = sh ? (sh.foe ? tFoe : tPlayer) : tPlayer;
        tPos[ti * 6] = sh ? sh.x : 0; tPos[ti * 6 + 1] = sh ? sh.y : 0; tPos[ti * 6 + 2] = sh ? sh.z : 0;
        tPos[ti * 6 + 3] = sh ? sh.tx : 0; tPos[ti * 6 + 4] = sh ? 1.35 : 0; tPos[ti * 6 + 5] = sh ? sh.tz : 0;
        tCol[ti * 6] = c.r; tCol[ti * 6 + 1] = c.g; tCol[ti * 6 + 2] = c.b;
        tCol[ti * 6 + 3] = c.r; tCol[ti * 6 + 4] = c.g; tCol[ti * 6 + 5] = c.b;
      }
      tracerGeo.attributes.position.needsUpdate = true;
      tracerGeo.attributes.color.needsUpdate = true;

      follow(dt, input);
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
        fps: fps, fixedLook: true, plnNightF: +plnNightF.toFixed(2), plnLamps: lampCount,
        plnPools: lampCount + liveBuildings.length, shadowSize: 1024, builds: stats.builds, presents: stats.presents,
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
