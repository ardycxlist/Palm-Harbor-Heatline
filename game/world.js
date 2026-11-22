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
  function buildingTextures() {
    var c = document.createElement('canvas'); c.width = 128; c.height = 128;
    var g = c.getContext('2d');
    g.fillStyle = '#9aa4a8'; g.fillRect(0, 0, 128, 128);
    var e = document.createElement('canvas'); e.width = 128; e.height = 128;
    var ge = e.getContext('2d');
    ge.fillStyle = '#000'; ge.fillRect(0, 0, 128, 128);
    var litColors = ['#ffc786', '#81dfed', '#ff9d94', '#ffe9bb'];
    var darkColors = ['#385974', '#467990', '#668b9e', '#506581', '#397081'];
    var r = PH.rng(1234);
    for (var y = 8; y < 120; y += 16) {
      for (var x = 8; x < 120; x += 16) {
        var lit = r() < 0.3;
        g.fillStyle = lit ? litColors[Math.floor(r() * litColors.length)] : darkColors[Math.floor(r() * darkColors.length)];
        g.fillRect(x, y, 9, 11);
        if (lit) { ge.fillStyle = '#fff'; ge.fillRect(x, y, 9, 11); }
      }
    }
    var map = new THREE.CanvasTexture(c);
    var emissive = new THREE.CanvasTexture(e);
    return { map: map, emissive: emissive };
  }

  function districtBoardTexture(title, name) {
    var c = document.createElement('canvas'); c.width = 512; c.height = 128;
    var g = c.getContext('2d');
    g.fillStyle = '#1d364b'; g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#f4dcb9'; g.lineWidth = 4; g.strokeRect(6, 6, 500, 116);
    g.fillStyle = '#f4dcb9'; g.font = 'bold 37px Georgia'; g.textAlign = 'center';
    g.fillText(title, 256, 52);
    g.fillStyle = '#96e2d3'; g.font = '24px Arial';
    g.fillText(name, 256, 96);
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
      deep: { value: new THREE.Color(0x0a4a66) },
      shallow: { value: new THREE.Color(0x2e8fa8) },
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
    // trims, AC crates, antennas on tall towers. Building 87 is demolished
    // into the Sunstrand lot and skipped here.
    var tex = buildingTextures();
    var bodyGeo = new THREE.BoxGeometry(1, 1, 1);
    var bodyMat = new THREE.MeshLambertMaterial({ map: tex.map, emissiveMap: tex.emissive, emissive: 0xffc786, emissiveIntensity: 0 });
    var liveBuildings = game.city.buildings.filter(function (b) {
      return !(PH.PARKING && b.index === PH.PARKING.buildingIndex);
    });
    var bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, liveBuildings.length);
    var trimMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.3, 1), mat(0xf4ddd0), liveBuildings.length);
    var acMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.9, 1.6), mat(0x8a94a0), liveBuildings.length);
    liveBuildings.forEach(function (b, i) {
      var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      dummy.position.set(cx, b.h / 2, cz);
      dummy.scale.set(b.maxX - b.minX, b.h, b.maxZ - b.minZ);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      bodyMesh.setMatrixAt(i, dummy.matrix);
      bodyMesh.setColorAt(i, new THREE.Color(b.color));
      dummy.position.set(cx, b.h + 0.15, cz);
      dummy.scale.set(b.maxX - b.minX + 0.3, 1, b.maxZ - b.minZ + 0.3);
      dummy.updateMatrix();
      trimMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(cx + (b.maxX - b.minX) * 0.2, b.h + 0.7, cz);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      acMesh.setMatrixAt(i, dummy.matrix);
    });
    bodyMesh.instanceMatrix.needsUpdate = true;
    if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
    trimMesh.instanceMatrix.needsUpdate = true;
    acMesh.instanceMatrix.needsUpdate = true;
    bodyMesh.castShadow = true; bodyMesh.receiveShadow = true;
    scene.add(bodyMesh); scene.add(trimMesh); scene.add(acMesh);
    stats.staticInstances += liveBuildings.length * 3;
    // Red beacon lights on tall towers.
    var beaconMat = new THREE.MeshBasicMaterial({ color: 0xf78495 });
    liveBuildings.forEach(function (b) {
      if (b.h > 33 && b.roof > 0.56) {
        var bc = new THREE.Mesh(new THREE.SphereGeometry(0.35, 6, 6), beaconMat);
        bc.position.set((b.minX + b.maxX) / 2, b.h + 1.4, (b.minZ + b.maxZ) / 2);
        scene.add(bc);
      }
    });

    // Palms: instanced trunks + leaf cones.
    var palms = game.city.props.filter(function (p) { return p.kind === 'palm'; });
    var trunkMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.22, 1, 6), mat(0x8e6556), palms.length);
    var leafColors = [0x196856, 0x2e8768, 0x53a66c, 0x3c925b];
    var leafMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(1.5, 1.1, 8), mat(0x2e8768), palms.length);
    palms.forEach(function (p, i) {
      dummy.position.set(p.x, p.h / 2, p.z);
      dummy.scale.set(1, p.h, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      trunkMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(p.x, p.h + 0.5, p.z);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, p.x * 1.7, 0);
      dummy.updateMatrix();
      leafMesh.setMatrixAt(i, dummy.matrix);
      leafMesh.setColorAt(i, new THREE.Color(leafColors[i % leafColors.length]));
    });
    trunkMesh.instanceMatrix.needsUpdate = true;
    leafMesh.instanceMatrix.needsUpdate = true;
    if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
    scene.add(trunkMesh); scene.add(leafMesh);
    stats.staticInstances += palms.length * 2;

    // Street lamps along the roads.
    var lampPositions = [];
    PH.ROADS.forEach(function (r) {
      for (var a = -176; a <= 176; a += 32) {
        lampPositions.push([a, r + 9.5]);
        lampPositions.push([r + 9.5, a]);
      }
    });
    var poleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.12, 5, 6), mat(0x42586a), lampPositions.length);
    var bulbMat = new THREE.MeshBasicMaterial({ color: 0x49525c });
    var bulbMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 8, 6), bulbMat, lampPositions.length);
    lampPositions.forEach(function (lp, i) {
      dummy.position.set(lp[0], 2.5, lp[1]);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      poleMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(lp[0], 5.1, lp[1]);
      dummy.updateMatrix();
      bulbMesh.setMatrixAt(i, dummy.matrix);
    });
    poleMesh.instanceMatrix.needsUpdate = true;
    bulbMesh.instanceMatrix.needsUpdate = true;
    scene.add(poleMesh); scene.add(bulbMesh);

    // Traffic lights at a few big intersections.
    var tlHeads = [];
    [[0, 0], [64, 64], [-64, -64], [128, 0], [0, 128], [-128, 0], [0, -128]].forEach(function (pt) {
      var g = new THREE.Group();
      var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 6, 6), mat(0x42586a));
      pole.position.y = 3;
      g.add(pole);
      var head = box(0.5, 1.1, 0.5, 0x222222, 0, 6.2, 0, g);
      var red = new THREE.Mesh(new THREE.SphereGeometry(0.14, 6, 6), new THREE.MeshBasicMaterial({ color: 0xf3717b }));
      red.position.set(0, 6.45, 0.28); g.add(red);
      var green = new THREE.Mesh(new THREE.SphereGeometry(0.14, 6, 6), new THREE.MeshBasicMaterial({ color: 0x2a4a3a }));
      green.position.set(0, 5.95, 0.28); g.add(green);
      g.position.set(pt[0] + 9.5, 0, pt[1] + 9.5);
      scene.add(g);
      tlHeads.push({ red: red, green: green });
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
      var post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 8.9, 6), mat(0x42586a));
      post.position.set(bd[2] - 6, 4.45, bd[3]);
      scene.add(post);
      var post2 = post.clone();
      post2.position.set(bd[2] + 6, 4.45, bd[3]);
      scene.add(post2);
    });

    // Beach: sand, shoreline, piers, umbrellas, towels, lifeguard stand.
    var sand = new THREE.Mesh(new THREE.PlaneGeometry(24, 230), mat(0xdec493));
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
      var towel = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.9), mat(0xf4f1e8));
      towel.rotation.x = -Math.PI / 2; towel.position.set(ux + 2.2, 0.08, uz);
      scene.add(towel);
    });
    box(2.2, 3.4, 2.2, 0xf4f1e8, 211, 1.7, 22); // lifeguard stand

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
    }

    // Rain: 700 vertical streaks in a 92x92 box around the camera.
    var rainGeo = new THREE.BufferGeometry();
    var rainPos = new Float32Array(RAIN_N * 6);
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    var rainMat = new THREE.LineBasicMaterial({ color: 0xbfd8e2, transparent: true, opacity: 0 });
    var rain = new THREE.LineSegments(rainGeo, rainMat);
    rain.frustumCulled = false;
    scene.add(rain);
    var rainSeed = [];
    for (var ri = 0; ri < RAIN_N; ri++) rainSeed.push({ x: Math.random() * 92 - 46, y: Math.random() * 30, z: Math.random() * 92 - 46 });

    // ---------- dynamic pools ----------
    // People: 3 InstancedMeshes (bodies, heads, legs), per-instance color.
    var MAXP = 900;
    var bodyIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.62, 0.24), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var headIM = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    var legIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.5, 0.2), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXP);
    bodyIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    headIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    legIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bodyIM.frustumCulled = false; headIM.frustumCulled = false; legIM.frustumCulled = false;
    scene.add(bodyIM); scene.add(headIM); scene.add(legIM);
    var hideMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    var tmpColor = new THREE.Color();
    var hairColors = [0x2a1a12, 0x6a4a2a, 0x1a1a1a, 0xb8a888, 0x8a3a2a];

    // Vehicles: one Group per car, built from shared geometries.
    var carGeo = {
      chassis: new THREE.BoxGeometry(2.5, 0.62, 5.3),
      cabin: new THREE.BoxGeometry(2.1, 0.55, 2.6),
      wheel: new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10),
      wing: new THREE.BoxGeometry(2.4, 0.08, 0.5),
      bar: new THREE.BoxGeometry(1.6, 0.22, 0.4),
      sign: new THREE.BoxGeometry(0.9, 0.25, 0.5)
    };
    var carGroups = new Map();
    function makeCarGroup(car) {
      var g = new THREE.Group();
      var bodyM = new THREE.MeshLambertMaterial({ color: car.color });
      var chassis = new THREE.Mesh(carGeo.chassis, bodyM);
      chassis.position.y = 0.55; chassis.castShadow = true;
      g.add(chassis);
      var cabin = new THREE.Mesh(carGeo.cabin, mat(0x2a3a44));
      cabin.position.set(0, 1.05, -0.3);
      g.add(cabin);
      var wheels = [];
      [[-1.05, 1.7], [1.05, 1.7], [-1.05, -1.7], [1.05, -1.7]].forEach(function (wp) {
        var w = new THREE.Mesh(carGeo.wheel, mat(0x1a1a1a));
        w.rotation.z = Math.PI / 2;
        w.position.set(wp[0], 0.42, wp[1]);
        g.add(w); wheels.push(w);
      });
      var extras = {};
      if (car.taxi) {
        var sign = new THREE.Mesh(carGeo.sign, mat(0xffe497, { emissive: 0xffe497, emissiveIntensity: 0.7 }));
        sign.position.set(0, 1.45, -0.3);
        g.add(sign); extras.sign = sign;
      }
      if (car.type === 'sport') {
        var wing = new THREE.Mesh(carGeo.wing, bodyM);
        wing.position.set(0, 0.95, -2.6);
        g.add(wing);
      }
      if (car.type === 'van') {
        var seam = new THREE.Mesh(new THREE.BoxGeometry(2.52, 0.1, 0.1), mat(0x5a6a7a));
        seam.position.set(0, 0.8, 0);
        g.add(seam);
      }
      if (car.police) {
        var bar = new THREE.Mesh(carGeo.bar, mat(0x222222));
        bar.position.set(0, 1.4, -0.3);
        g.add(bar);
        var rl = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.3), new THREE.MeshBasicMaterial({ color: 0xff2a2a }));
        rl.position.set(-0.45, 1.55, -0.3);
        g.add(rl);
        var bl = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.3), new THREE.MeshBasicMaterial({ color: 0x2a5aff }));
        bl.position.set(0.45, 1.55, -0.3);
        g.add(bl);
        extras.red = rl; extras.blue = bl;
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
    function makeBikeGroup(car) {
      var g = new THREE.Group();
      var bodyM = new THREE.MeshLambertMaterial({ color: car.color });
      var frame = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 2.4), bodyM);
      frame.position.y = 0.7;
      g.add(frame);
      var seat = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.8), mat(0x1a1a1a));
      seat.position.set(0, 0.95, -0.4);
      g.add(seat);
      var w1 = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.09, 6, 12), mat(0x1a1a1a));
      w1.position.set(0, 0.42, 0.95); g.add(w1);
      var w2 = w1.clone(); w2.position.z = -0.95; g.add(w2);
      g.userData = { car: car, wheels: [w1, w2], extras: {} };
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
      var console = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.6), mat(0x395368));
      console.position.set(0, 1.05, 0.6);
      g.add(console);
      var bench = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.18, 0.7), mat(0xf0ead8));
      bench.position.set(0, 0.85, -1.4);
      g.add(bench);
      var stripe = new THREE.Mesh(new THREE.BoxGeometry(2.24, 0.14, 0.5), mat(0xe46b4e));
      stripe.position.set(0, 0.5, 1.5);
      g.add(stripe);
      var bowLight = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), new THREE.MeshBasicMaterial({ color: 0xfff2cf }));
      bowLight.position.set(0, 0.8, 3.2);
      g.add(bowLight);
      g.userData = { car: car, wheels: [], extras: {} };
      scene.add(g);
      return g;
    }

    // Helicopters: 3 rigs.
    var heliGroups = [];
    for (var hi = 0; hi < 3; hi++) {
      var hg = new THREE.Group();
      var hBody = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 4.6), mat(0xe9ece8));
      hBody.position.y = 0;
      hg.add(hBody);
      var belly = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.5, 3.6), mat(0x244b6b));
      belly.position.y = -0.8;
      hg.add(belly);
      var glass = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.8, 1.2), mat(0x67b8cb));
      glass.position.set(0, 0.3, 1.9);
      hg.add(glass);
      var tail = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.4, 4.4, 6), mat(0xe9ece8));
      tail.rotation.x = Math.PI / 2;
      tail.position.set(0, 0.3, -4.2);
      hg.add(tail);
      var rotor = new THREE.Mesh(new THREE.BoxGeometry(13, 0.085, 0.2), mat(0x252d38));
      rotor.position.y = 0.95;
      hg.add(rotor);
      var rotor2 = rotor.clone();
      rotor2.rotation.y = Math.PI / 2;
      hg.add(rotor2);
      var tailRotor = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.6, 0.12), mat(0x252d38));
      tailRotor.position.set(0.3, 0.4, -6.2);
      hg.add(tailRotor);
      var navR = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff4455 }));
      navR.position.set(-1.15, 0, 0); hg.add(navR);
      var navG = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), new THREE.MeshBasicMaterial({ color: 0x55ffc2 }));
      navG.position.set(1.15, 0, 0); hg.add(navG);
      var beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff404a }));
      beacon.position.set(0, 0.85, -1); hg.add(beacon);
      var skid1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 3.4), mat(0x252d38));
      skid1.position.set(-0.9, -1.1, 0); hg.add(skid1);
      var skid2 = skid1.clone(); skid2.position.x = 0.9; hg.add(skid2);
      // Spotlight cone + ground disk + ring (shown when lit).
      var cone = new THREE.Mesh(new THREE.ConeGeometry(4.5, 30, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xfff6c8, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
      cone.position.y = -15;
      cone.visible = false;
      hg.add(cone);
      var disk = new THREE.Mesh(new THREE.CircleGeometry(4.5, 20),
        new THREE.MeshBasicMaterial({ color: 0xfff6c8, transparent: true, opacity: 0.22, depthWrite: false }));
      disk.rotation.x = -Math.PI / 2;
      disk.visible = false;
      scene.add(disk);
      var ring = new THREE.Mesh(new THREE.RingGeometry(4.3, 4.5, 24),
        new THREE.MeshBasicMaterial({ color: 0xfff6c8, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      scene.add(ring);
      hg.userData = { rotor: rotor, rotor2: rotor2, tailRotor: tailRotor, cone: cone, disk: disk, ring: ring, beacon: beacon };
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
    var mCrystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.55),
      new THREE.MeshBasicMaterial({ color: 0x92f6d1 }));
    mCrystal.position.y = 2.2;
    marker.add(mCrystal);
    var mBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 14, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff946a, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
    mBeam.position.y = 7;
    marker.add(mBeam);
    scene.add(marker);
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
    var cam = { yaw: game.player.yaw, pitch: 0.42, dist: 9, lookIdle: 0 };
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
      var want = (input && input.zoom) || (p.vehicle !== null ? 13 : 9);
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
      if (kind === 'hero') return { body: 0x3ca7b6, legs: 0x2a2a33, skin: 0xb9744e };
      if (kind === 'officer') return { body: 0x254164, legs: 0x22334e, skin: 0xd8a878 };
      if (kind === 'enemy') return { body: 0x3a2a2e, legs: 0x222222, skin: 0x8a5a3c };
      if (kind === 'contact') return { body: 0x3ca7b6, legs: 0x2a2a33, skin: 0xb9744e };
      return { body: ref.color || 0x8a94a8, legs: 0x3a3a44, skin: ref.skin || 0xd8a878 };
    }
    function syncPerson(idx, x, z, y, yaw, size, colors, detail, bobPhase) {
      var s = size || 1;
      var bob = detail ? Math.sin(game.time * 6 + bobPhase) * 0.03 : 0;
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
    }

    function update(dt, input) {
      var p = game.player;
      var clock = game.clock;
      var storm = stormAmp();
      // Day / night.
      var light = daylight(clock);
      var golden = (clock > 17 && clock < 18.5) || (clock >= 6 && clock < 7);
      sun.intensity = 2.06 * light + 0.13;
      sun.color = hexLerp(0xffe9c9, 0xff9a52, golden ? 0.7 : 0);
      hemi.intensity = 1.22 * light + 0.45;
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
      bulbMat.color.copy(hexLerp(0x49525c, 0xffffff, plnNightF));
      bodyMat.emissiveIntensity = plnNightF * 0.9;
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
          pos[i * 6] = rx; pos[i * 6 + 1] = ry; pos[i * 6 + 2] = rz;
          pos[i * 6 + 3] = rx; pos[i * 6 + 4] = ry - 1.6; pos[i * 6 + 5] = rz;
        }
        rainGeo.attributes.position.needsUpdate = true;
      }
      waterUniforms.time.value = game.time;
      waterUniforms.storm.value = storm;
      // Lightning flash.
      if (game.lightning) {
        hemi.intensity += 1.2;
        sun.intensity += 0.8;
      }
      // Traffic light cycle.
      var tlPhase = Math.floor(game.time / 4) % 2;
      tlHeads.forEach(function (tl) {
        tl.red.material.color.setHex(tlPhase === 0 ? 0xf3717b : 0x3a1a1a);
        tl.green.material.color.setHex(tlPhase === 1 ? 0x8ef0ad : 0x2a4a3a);
      });

      // ---------- sync people (instanced, culled to 190) ----------
      var idx = 0;
      var camX = camera.position.x, camZ = camera.position.z;
      function personVisible(x, z) { return dist(x, z, camX, camZ) < CROWD_RANGE; }
      // Hero: drawn on foot or on a bike; inside a car the cabin hides them.
      if (p.vehicle === null || p.bike) {
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
      // Contacts (Mara etc.) as gold-striped figures.
      for (var ci = 0; ci < PH.CONTACTS.length && idx < MAXP; ci++) {
        var ct = PH.CONTACTS[ci];
        if (ct.kind !== 'contact') continue;
        if (!personVisible(ct.x, ct.z)) continue;
        syncPerson(idx++, ct.x, ct.z, 0, 0, 1.0, { body: 0x3ca7b6, legs: 0x2a2a33, skin: 0xd8a878 }, true, ci + 120);
      }
      // Taxi passenger.
      if (game.taxiWait && idx < MAXP && personVisible(game.taxiWait.x, game.taxiWait.z)) {
        syncPerson(idx++, game.taxiWait.x, game.taxiWait.z, 0, 0, 1.0, { body: 0xf8cf69, legs: 0x3a3a44, skin: 0xd8a878 }, true, 200);
      }
      // Beachgoers.
      if (game.beachgoers) {
        for (var bi = 0; bi < game.beachgoers.length && idx < MAXP; bi++) {
          var bg = game.beachgoers[bi];
          if (bg.hidden) continue;
          if (!personVisible(bg.x, bg.z)) continue;
          syncPerson(idx++, bg.x, bg.z, 0, bg.yaw, 0.95, { body: bg.color, legs: 0xd8a878, skin: 0xd8a878 }, true, bi + 300);
        }
      }
      for (var hi2 = idx; hi2 < MAXP; hi2++) {
        bodyIM.setMatrixAt(hi2, hideMatrix);
        headIM.setMatrixAt(hi2, hideMatrix);
        legIM.setMatrixAt(hi2, hideMatrix);
      }
      bodyIM.instanceMatrix.needsUpdate = true;
      headIM.instanceMatrix.needsUpdate = true;
      legIM.instanceMatrix.needsUpdate = true;
      if (bodyIM.instanceColor) bodyIM.instanceColor.needsUpdate = true;
      if (headIM.instanceColor) headIM.instanceColor.needsUpdate = true;
      if (legIM.instanceColor) legIM.instanceColor.needsUpdate = true;
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
          g = car.type === 'bike' ? makeBikeGroup(car) : car.type === 'boat' ? makeBoatGroup(car) : makeCarGroup(car);
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
        if (ud.extras && ud.extras.red) {
          var flash = Math.sin(game.time * 21 + car.id) > 0;
          ud.extras.red.material.color.setHex(flash ? 0xff2a2a : 0x550000);
          ud.extras.blue.material.color.setHex(flash ? 0x000055 : 0x2a5aff);
        }
        carCount++;
      }
      for (var cvi = 0; cvi < game.cars.length; cvi++) syncCar(game.cars[cvi]);
      // Police cars (units, not in game.cars).
      for (var pci = 0; pci < game.police.length; pci++) {
        var unit = game.police[pci];
        if (unit.foot) continue;
        var fake = { id: 5000 + pci, type: 'sedan', color: 0xeff0eb, x: unit.x, z: unit.z, yaw: unit.yaw, speed: unit.speed, police: true };
        syncCar(fake);
      }
      // Emergency units.
      if (game.emergency) {
        for (var eui = 0; eui < game.emergency.units.length; eui++) {
          var eu = game.emergency.units[eui];
          var etype = eu.kind === 'tow' ? 'tow' : 'ambulance';
          var fake2 = { id: 6000 + eui, type: etype, color: eu.color, x: eu.x, z: eu.z, yaw: eu.yaw, speed: eu.speed };
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
          if (!h.active) continue;
          hg.position.set(h.x, h.y, h.z);
          hg.rotation.set(h.pitch || 0, -h.yaw + Math.PI / 2, h.roll || 0);
          hg.userData.rotor.rotation.y = h.rotorPhase;
          hg.userData.rotor2.rotation.y = h.rotorPhase + Math.PI / 2;
          hg.userData.tailRotor.rotation.x = h.tailPhase;
          hg.userData.beacon.material.color.setHex(Math.sin(game.time * 6) > 0 ? 0xff404a : 0x550000);
          var lit = !!h.lit;
          hg.userData.cone.visible = lit;
          hg.userData.disk.visible = lit;
          hg.userData.ring.visible = lit;
          if (lit && h.spotTarget) {
            hg.userData.cone.lookAt(h.spotTarget.x, 0, h.spotTarget.z);
            hg.userData.cone.rotateX(Math.PI);
            hg.userData.disk.position.set(h.spotTarget.x, 0.12, h.spotTarget.z);
            hg.userData.disk.scale.setScalar(h.spotRadius / 4.5);
            hg.userData.ring.position.set(h.spotTarget.x, 0.13, h.spotTarget.z);
            hg.userData.ring.scale.setScalar(h.spotRadius / 4.5);
            var share = game.litShare || 1;
            hg.userData.cone.material.opacity = 0.14 * share * 2;
            hg.userData.disk.material.opacity = 0.22 * share * 2;
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
