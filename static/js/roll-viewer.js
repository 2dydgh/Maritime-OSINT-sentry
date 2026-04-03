// ── OVERWATCH 4D — Roll Viewer ──
// Three.js 3D roll prediction viewer for maritime vessel visualization.
// Renders ship model with wave animation and live roll angle chart.

var RollViewer = (function() {

    // ── State ──
    var scene = null;
    var camera = null;
    var renderer = null;
    var controls = null;

    var shipGroup = null;
    var waterMesh = null;
    var composer = null;
    var waterNormals = null;

    var animFrameId = null;
    var clockStart = null;

    var currentMmsi = null;
    var rollHistory = [];
    var pitchHistory = [];
    var rollChart = null;
    var chartInterval = null;

    var weather = null;
    var shipType = 'other';
    var rollParams = null;

    var sprayPoints = null;
    var sprayVelocities = [];
    var SPRAY_COUNT = 80;

    var cameraAnimating = false;
    var cameraAnimStart = 0;
    var CAMERA_ANIM_DURATION = 2.0; // seconds

    // ── Roll simulation params per ship type ──
    var ROLL_PARAMS = {
        cargo:     { amp: 5,   freq: 0.5 },
        tanker:    { amp: 4,   freq: 0.4 },
        passenger: { amp: 3,   freq: 0.6 },
        fishing:   { amp: 7,   freq: 0.7 },
        military:  { amp: 3.5, freq: 0.55 },
        tug:       { amp: 6,   freq: 0.65 },
        other:     { amp: 5,   freq: 0.5 }
    };

    var _resizeHandler = null;

    // ── Find nearest weather grid point from _wxData ──
    function findNearestWeather(lat, lon) {
        var fallback = {
            windSpeed:  Math.round(10 + Math.random() * 15),
            waveHeight: parseFloat((1 + Math.random() * 3).toFixed(1)),
            wavePeriod: Math.round(6 + Math.random() * 6),
            waveDirection: Math.round(Math.random() * 360)
        };

        if (!lat || !lon || typeof _wxData === 'undefined') return fallback;

        var marine = _wxData.marine;
        var wind = _wxData.wind;
        if (!marine || !marine.points || !wind || !wind.points) return fallback;

        // Find nearest marine point
        var nearestMarine = null;
        var minDist = Infinity;
        for (var i = 0; i < marine.points.length; i++) {
            var p = marine.points[i];
            var d = (p.lat - lat) * (p.lat - lat) + (p.lon - lon) * (p.lon - lon);
            if (d < minDist) { minDist = d; nearestMarine = p; }
        }

        // Find nearest wind point
        var nearestWind = null;
        minDist = Infinity;
        for (var j = 0; j < wind.points.length; j++) {
            var pw = wind.points[j];
            var dw = (pw.lat - lat) * (pw.lat - lat) + (pw.lon - lon) * (pw.lon - lon);
            if (dw < minDist) { minDist = dw; nearestWind = pw; }
        }

        return {
            windSpeed:  nearestWind ? Math.round(nearestWind.wind_speed || 0) : fallback.windSpeed,
            waveHeight: nearestMarine ? parseFloat((nearestMarine.wave_height || 0).toFixed(1)) : fallback.waveHeight,
            wavePeriod: nearestMarine ? Math.round(nearestMarine.wave_period || 8) : fallback.wavePeriod,
            waveDirection: nearestMarine ? (nearestMarine.wave_direction || 0) : Math.round(Math.random() * 360)
        };
    }

    // ── Helpers ──
    function getContainer() {
        return document.getElementById('dedicated-roll-prediction');
    }

    function getShipTypeKey(ship) {
        if (!ship || !ship.type) return 'other';
        var t = ship.type.toLowerCase();
        if (t.indexOf('cargo') !== -1)     return 'cargo';
        if (t.indexOf('tanker') !== -1)    return 'tanker';
        if (t.indexOf('passenger') !== -1) return 'passenger';
        if (t.indexOf('fishing') !== -1)   return 'fishing';
        if (t.indexOf('military') !== -1)  return 'military';
        if (t.indexOf('tug') !== -1)       return 'tug';
        // Check for type numeric codes if present
        var code = parseInt(ship.type, 10);
        if (!isNaN(code)) {
            if (code >= 70 && code <= 79) return 'cargo';
            if (code >= 80 && code <= 89) return 'tanker';
            if (code >= 60 && code <= 69) return 'passenger';
            if (code >= 35 && code <= 36) return 'military';
            if (code >= 30 && code <= 39) return 'fishing';
            if (code === 52 || code === 53) return 'tug';
        }
        return 'other';
    }

    function easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    var CAM_START = { x: 80, y: 40, z: 80 };
    var CAM_END   = { x: 30, y: 20, z: 40 };

    function animateCamera(elapsed) {
        if (!cameraAnimating) return;

        var t = Math.min((elapsed - cameraAnimStart) / CAMERA_ANIM_DURATION, 1);
        var e = easeOutCubic(t);

        camera.position.set(
            CAM_START.x + (CAM_END.x - CAM_START.x) * e,
            CAM_START.y + (CAM_END.y - CAM_START.y) * e,
            CAM_START.z + (CAM_END.z - CAM_START.z) * e
        );
        camera.lookAt(0, 2, 0);

        if (t >= 1) {
            cameraAnimating = false;
            if (controls) {
                controls.enabled = true;
                controls.update();
            }
        }
    }

    // ── load(mmsi) ──
    function load(mmsi) {
        dispose();

        var container = getContainer();
        if (!container) return;

        currentMmsi = mmsi;

        // Show placeholder if no ship selected
        if (!mmsi || !window.shipDataMap || !window.shipDataMap[mmsi]) {
            container.style.position = 'relative';
            var backBtn = document.createElement('button');
            backBtn.className = 'roll-viewer-back';
            backBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i><span>지구본으로</span>';
            backBtn.addEventListener('click', function() {
                if (window.LayoutManager) {
                    LayoutManager.handleIconClick('roll-prediction', 'dedicated-screen');
                }
            });
            container.appendChild(backBtn);
            var placeholder = document.createElement('div');
            placeholder.className = 'roll-viewer-placeholder';
            placeholder.innerHTML =
                '<i class="fa-solid fa-ship"></i>' +
                '<span>지구본에서 선박을 선택한 후<br>횡요각 카드를 클릭하세요</span>';
            container.appendChild(placeholder);
            return;
        }

        var ship = window.shipDataMap[mmsi];
        shipType = getShipTypeKey(ship);
        rollParams = ROLL_PARAMS[shipType] || ROLL_PARAMS['other'];

        // Get real weather from nearest grid point, fallback to random
        weather = findNearestWeather(ship.lat, ship.lon);

        // Build layout DOM
        var layout = document.createElement('div');
        layout.className = 'roll-viewer-layout';

        var canvasWrap = document.createElement('div');
        canvasWrap.className = 'roll-viewer-canvas-wrap';

        // Back button overlay
        var backBtn = document.createElement('button');
        backBtn.className = 'roll-viewer-back';
        backBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i><span>지구본으로</span>';
        backBtn.addEventListener('click', function() {
            if (window.LayoutManager) {
                LayoutManager.handleIconClick('roll-prediction', 'dedicated-screen');
            }
        });
        canvasWrap.appendChild(backBtn);

        // Info panel (right 30%)
        var panel = buildInfoPanel(ship);

        layout.appendChild(canvasWrap);
        layout.appendChild(panel);
        container.appendChild(layout);

        // Init Three.js
        initScene(canvasWrap);
        buildSky();
        buildWater();
        buildCompass();
        buildShip(shipType);
        buildSpray();
        startAnimation();

        // Init ECharts roll chart
        initRollChart(panel);
        startChartUpdates();

        // Resize chart after CSS fade-in transition
        setTimeout(function() {
            if (rollChart) {
                rollChart.resize();
            }
        }, 350);
    }

    // ── initScene(container) ──
    function initScene(container) {
        var THREE = window.THREE;

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x2a4a6a);
        scene.fog = new THREE.FogExp2(0x3a5a7a, 0.003);

        var w = container.clientWidth;
        var h = container.clientHeight;
        var aspect = w / (h || 1);

        camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
        camera.position.set(CAM_START.x, CAM_START.y, CAM_START.z);
        camera.lookAt(0, 2, 0);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.8;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(w, h);
        renderer.domElement.style.display = 'block';
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        container.appendChild(renderer.domElement);

        // OrbitControls
        var OC = THREE.OrbitControls;
        controls = new OC(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.minDistance = 15;
        controls.maxDistance = 80;
        controls.target.set(0, 2, 0);

        // Lights — bright enough to see the scene clearly
        var dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
        dirLight.position.set(30, 40, 20);
        scene.add(dirLight);

        // Secondary fill light from opposite side
        var fillLight = new THREE.DirectionalLight(0x88aacc, 0.6);
        fillLight.position.set(-20, 10, -10);
        scene.add(fillLight);

        var ambLight = new THREE.AmbientLight(0xccddee, 0.7);
        scene.add(ambLight);

        // Resize handler
        _resizeHandler = function() {
            if (!renderer || !camera) return;
            var ww = container.clientWidth;
            var hh = container.clientHeight;
            camera.aspect = ww / (hh || 1);
            camera.updateProjectionMatrix();
            renderer.setSize(ww, hh);
            if (composer) composer.setSize(ww, hh);
        };
        window.addEventListener('resize', _resizeHandler);
        renderer._rollViewerResizeHandler = _resizeHandler;

        // ── Post-processing ──
        var renderPass = new THREE.RenderPass(scene, camera);
        var bloomPass = new THREE.UnrealBloomPass(
            new THREE.Vector2(w, h),
            0.4,   // strength
            0.5,   // radius
            0.7    // threshold
        );

        composer = new THREE.EffectComposer(renderer);
        composer.addPass(renderPass);
        composer.addPass(bloomPass);
    }

    // ── buildSky() — gradient sky dome + horizon ──
    function buildSky() {
        var THREE = window.THREE;

        // Large hemisphere for sky gradient
        var skyGeo = new THREE.SphereGeometry(400, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
        var skyVertCount = skyGeo.attributes.position.count;
        var colors = new Float32Array(skyVertCount * 3);
        var topColor = new THREE.Color(0x0a1a3a);      // deep dark at zenith
        var midColor = new THREE.Color(0x2a4a7a);      // mid-sky blue
        var horizonColor = new THREE.Color(0x6a8aaa);   // lighter blue-gray at horizon
        var horizonWarm = new THREE.Color(0x8a7a6a);    // warm haze near horizon line
        var tmp = new THREE.Color();

        for (var i = 0; i < skyVertCount; i++) {
            var y = skyGeo.attributes.position.getY(i);
            var t = Math.max(0, y / 400); // 0 at horizon, 1 at top
            if (t < 0.05) {
                // Warm haze band right at horizon — blends into water edge
                tmp.copy(horizonWarm).lerp(horizonColor, t / 0.05);
            } else if (t < 0.3) {
                // Horizon to mid-sky gradient
                tmp.copy(horizonColor).lerp(midColor, (t - 0.05) / 0.25);
            } else {
                // Mid-sky to zenith
                tmp.copy(midColor).lerp(topColor, (t - 0.3) / 0.7);
            }
            colors[i * 3] = tmp.r;
            colors[i * 3 + 1] = tmp.g;
            colors[i * 3 + 2] = tmp.b;
        }
        skyGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        var skyMat = new THREE.MeshBasicMaterial({
            vertexColors: true,
            side: THREE.BackSide
        });
        var skyMesh = new THREE.Mesh(skyGeo, skyMat);
        scene.add(skyMesh);

    }

    // ── Ship model helpers ──
    function shipMat(color, opts) {
        var THREE = window.THREE;
        var params = {
            color: new THREE.Color(color),
            roughness: (opts && opts.roughness !== undefined) ? opts.roughness : 0.7,
            metalness: (opts && opts.metalness !== undefined) ? opts.metalness : 0.3
        };
        if (opts && opts.emissive) {
            params.emissive = new THREE.Color(opts.emissive);
            params.emissiveIntensity = opts.emissiveIntensity || 0.8;
        }
        return new THREE.MeshStandardMaterial(params);
    }

    function addToShip(mesh) {
        shipGroup.add(mesh);
        return mesh;
    }

    // ── buildCompass() — wave direction arrow + compass ring ──
    function buildCompass() {
        var THREE = window.THREE;
        var dirRad = (weather.waveDirection || 0) * Math.PI / 180;

        // Compass ring on water surface
        var ringGeo = new THREE.RingGeometry(14, 14.3, 64);
        ringGeo.rotateX(-Math.PI / 2);
        var ringMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.15,
            side: THREE.DoubleSide
        });
        var compassRing = new THREE.Mesh(ringGeo, ringMat);
        compassRing.position.y = 0.2;
        scene.add(compassRing);

        // Cardinal direction marks (N, E, S, W)
        var cardinals = [
            { label: 'N', angle: 0 },
            { label: 'E', angle: Math.PI / 2 },
            { label: 'S', angle: Math.PI },
            { label: 'W', angle: -Math.PI / 2 }
        ];
        cardinals.forEach(function(c) {
            var tickGeo = new THREE.PlaneGeometry(0.3, 1.5);
            var tickMat = new THREE.MeshBasicMaterial({
                color: c.label === 'N' ? 0xef4444 : 0xffffff,
                transparent: true,
                opacity: 0.4,
                side: THREE.DoubleSide
            });
            var tick = new THREE.Mesh(tickGeo, tickMat);
            tick.position.set(
                Math.sin(c.angle) * 15,
                0.2,
                Math.cos(c.angle) * 15
            );
            tick.rotation.x = -Math.PI / 2;
            tick.rotation.z = -c.angle;
            scene.add(tick);
        });

        // Wave direction arrow — shows where waves come from
        var arrowLen = 12;
        var arrowDir = new THREE.Vector3(Math.sin(dirRad), 0, Math.cos(dirRad));

        // Arrow shaft
        var shaftGeo = new THREE.CylinderGeometry(0.15, 0.15, arrowLen, 8);
        shaftGeo.rotateZ(Math.PI / 2);
        var shaftMat = new THREE.MeshBasicMaterial({
            color: 0x38bdf8,
            transparent: true,
            opacity: 0.6
        });
        var shaft = new THREE.Mesh(shaftGeo, shaftMat);
        shaft.position.set(
            arrowDir.x * arrowLen * 0.5,
            0.3,
            arrowDir.z * arrowLen * 0.5
        );
        shaft.rotation.y = -dirRad;
        scene.add(shaft);

        // Arrow head (cone)
        var headGeo = new THREE.ConeGeometry(0.5, 1.5, 8);
        headGeo.rotateZ(-Math.PI / 2);
        var headMat = new THREE.MeshBasicMaterial({
            color: 0x38bdf8,
            transparent: true,
            opacity: 0.8
        });
        var head = new THREE.Mesh(headGeo, headMat);
        head.position.set(
            arrowDir.x * arrowLen,
            0.3,
            arrowDir.z * arrowLen
        );
        head.rotation.y = -dirRad;
        scene.add(head);

        // "WAVE" label near arrow tip — using a small sprite
        var canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 32;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('WAVE ' + Math.round(weather.waveDirection) + '°', 64, 22);
        var texture = new THREE.CanvasTexture(canvas);
        var spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.7 });
        var sprite = new THREE.Sprite(spriteMat);
        sprite.position.set(
            arrowDir.x * (arrowLen + 2),
            1.5,
            arrowDir.z * (arrowLen + 2)
        );
        sprite.scale.set(6, 1.5, 1);
        scene.add(sprite);
    }

    // ── buildSpray() — bow spray particle system ──
    // ── buildSpray() — sea mist / fog particle system ──
    function buildSpray() {
        var THREE = window.THREE;

        var geometry = new THREE.BufferGeometry();
        var positions = new Float32Array(SPRAY_COUNT * 3);

        sprayVelocities = [];

        for (var i = 0; i < SPRAY_COUNT; i++) {
            // Spread around the ship, near waterline
            positions[i * 3]     = (Math.random() - 0.3) * 30;   // wide x spread
            positions[i * 3 + 1] = Math.random() * 2;             // low, near water
            positions[i * 3 + 2] = (Math.random() - 0.5) * 30;   // wide z spread

            sprayVelocities.push({
                vx: (Math.random() - 0.5) * 0.3,   // slow drift
                vy: 0.05 + Math.random() * 0.15,    // gentle rise
                vz: (Math.random() - 0.5) * 0.3,
                life: Math.random() * 5,             // stagger start
                maxLife: 3 + Math.random() * 4       // long-lived
            });
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        var material = new THREE.PointsMaterial({
            color: 0xb0c4de,         // light steel blue — mist color
            size: 1.5,               // larger, softer
            transparent: true,
            opacity: 0.12,           // very subtle
            blending: THREE.NormalBlending,
            depthWrite: false,
            sizeAttenuation: true
        });

        sprayPoints = new THREE.Points(geometry, material);
        scene.add(sprayPoints);
    }

    // ── animateSpray(dt) — drift sea mist particles ──
    function animateSpray(dt) {
        if (!sprayPoints) return;

        var pos = sprayPoints.geometry.attributes.position;
        var intensity = Math.min(weather.waveHeight / 3, 1) * 0.7 + 0.3;

        for (var i = 0; i < SPRAY_COUNT; i++) {
            var v = sprayVelocities[i];
            v.life += dt;

            if (v.life >= v.maxLife) {
                // Respawn — scattered around ship area
                pos.setXYZ(i,
                    (Math.random() - 0.3) * 30,
                    Math.random() * 0.5,
                    (Math.random() - 0.5) * 30
                );
                v.vx = (Math.random() - 0.5) * 0.3 * intensity;
                v.vy = (0.05 + Math.random() * 0.15) * intensity;
                v.vz = (Math.random() - 0.5) * 0.3 * intensity;
                v.life = 0;
                v.maxLife = 3 + Math.random() * 4;
                continue;
            }

            var x = pos.getX(i) + v.vx * dt;
            var y = pos.getY(i) + v.vy * dt;
            var z = pos.getZ(i) + v.vz * dt;

            // Fade out at top, reset if too high
            if (y > 3.5) {
                v.life = v.maxLife;
                y = 0;
            }

            pos.setXYZ(i, x, y, z);
        }

        // Very subtle opacity, scales with wave conditions
        sprayPoints.material.opacity = 0.08 + 0.07 * intensity;
        pos.needsUpdate = true;
    }

    // ── buildWater() — Three.js Water shader with reflection/refraction ──
    function buildWater() {
        var THREE = window.THREE;

        var waterGeometry = new THREE.PlaneGeometry(2000, 2000);

        var loader = new THREE.TextureLoader();
        waterNormals = loader.load(
            'https://raw.githubusercontent.com/mrdoob/three.js/r137/examples/textures/waternormals.jpg',
            function(texture) {
                texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
            }
        );

        waterMesh = new THREE.Water(waterGeometry, {
            textureWidth: 512,
            textureHeight: 512,
            waterNormals: waterNormals,
            sunDirection: new THREE.Vector3(0.7, 0.5, 0.3).normalize(),
            sunColor: 0xffffff,
            waterColor: 0x001e3d,
            distortionScale: Math.max(weather.waveHeight * 1.5, 1.0),
            fog: scene.fog !== undefined
        });

        waterMesh.rotation.x = -Math.PI / 2;
        waterMesh.position.y = 0;
        scene.add(waterMesh);
    }

    // ── animateWater(time) — update Water shader uniforms ──
    function animateWater(time) {
        if (!waterMesh || !waterMesh.material || !waterMesh.material.uniforms) return;
        var speed = 0.8 / Math.max(weather.wavePeriod || 8, 1);
        waterMesh.material.uniforms['time'].value = time * speed;
    }

    // ── buildShip(type) — high-quality ship model per type ──
    function buildShip(type) {
        var THREE = window.THREE;
        var color = (window.SHIP_COLORS && window.SHIP_COLORS[type]) || '#6b7280';

        shipGroup = new THREE.Group();

        switch (type) {
            case 'tanker':    buildTanker(THREE, color); break;
            case 'cargo':     buildCargo(THREE, color); break;
            case 'passenger': buildPassenger(THREE, color); break;
            case 'fishing':   buildFishing(THREE, color); break;
            case 'military':  buildMilitary(THREE, color); break;
            case 'tug':       buildTug(THREE, color); break;
            default:          buildGenericShip(THREE, color); break;
        }

        shipGroup.position.y = 1;
        scene.add(shipGroup);
    }

    // ── Tanker: 낮고 긴 선체, 파이프라인, 매니폴드 ──
    function buildTanker(THREE, color) {
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-8, -2.2);
        hullShape.lineTo(-8, 2.2);
        hullShape.quadraticCurveTo(6, 2, 10, 0);
        hullShape.quadraticCurveTo(6, -2, -8, -2.2);

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 3.5, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.2, bevelSegments: 3 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat(color));
        hull.position.set(0, 1.2, -1.75);
        addToShip(hull);

        var deckGeo = new THREE.BoxGeometry(16, 0.2, 4.2);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#3f3f46'))).position.set(0, 3.0, 0);

        for (var p = -1; p <= 1; p++) {
            var pipeGeo = new THREE.CylinderGeometry(0.08, 0.08, 12, 8);
            pipeGeo.rotateZ(Math.PI / 2);
            addToShip(new THREE.Mesh(pipeGeo, shipMat('#71717a', { metalness: 0.6 }))).position.set(0, 3.3, p * 1.2);
        }

        var manifoldGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 12);
        addToShip(new THREE.Mesh(manifoldGeo, shipMat('#52525b', { metalness: 0.7 }))).position.set(0, 3.5, 0);

        for (var r = -1; r <= 1; r++) {
            var riserGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.8, 6);
            addToShip(new THREE.Mesh(riserGeo, shipMat('#71717a', { metalness: 0.6 }))).position.set(0, 3.5, r * 1.2);
        }

        var bridgeGeo = new THREE.BoxGeometry(3.5, 2.5, 3.5);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#3f3f46'))).position.set(-5.5, 4.3, 0);

        var winGeo = new THREE.BoxGeometry(0.1, 0.5, 2.8);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-3.7, 4.6, 0);

        var funnelGeo = new THREE.CylinderGeometry(0.4, 0.5, 2.2, 8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#27272a'))).position.set(-6.5, 5.5, 0);

        var stripeGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.3, 8);
        addToShip(new THREE.Mesh(stripeGeo, shipMat(color))).position.set(-6.5, 5.8, 0);
    }

    // ── Cargo: 컨테이너 적재, 크레인, 높은 브릿지 ──
    function buildCargo(THREE, color) {
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-7, -2);
        hullShape.lineTo(-7, 2);
        hullShape.lineTo(5, 1.5);
        hullShape.lineTo(9, 0);
        hullShape.lineTo(5, -1.5);
        hullShape.closePath();

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 3.8, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.2, bevelSegments: 3 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat(color));
        hull.position.set(0, 1.2, -1.9);
        addToShip(hull);

        var deckGeo = new THREE.BoxGeometry(15, 0.2, 3.8);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#3f3f46'))).position.set(0.5, 3.0, 0);

        var containerColors = ['#dc2626', '#2563eb', '#16a34a', '#ca8a04', '#9333ea', '#0891b2'];
        var rows = [
            { x: 3.5, layers: 3 },
            { x: 1.5, layers: 2 },
            { x: -0.5, layers: 3 },
            { x: -2.5, layers: 2 }
        ];

        rows.forEach(function(row) {
            for (var layer = 0; layer < row.layers; layer++) {
                for (var z = -1; z <= 1; z++) {
                    var cGeo = new THREE.BoxGeometry(1.6, 0.9, 1.1);
                    var cColor = containerColors[Math.floor(Math.random() * containerColors.length)];
                    var container = new THREE.Mesh(cGeo, shipMat(cColor, { roughness: 0.8, metalness: 0.2 }));
                    container.position.set(row.x, 3.6 + layer * 0.95, z * 1.2);
                    addToShip(container);
                }
            }
        });

        var craneBaseGeo = new THREE.BoxGeometry(0.4, 3, 0.4);
        addToShip(new THREE.Mesh(craneBaseGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-4, 4.5, 1.2);
        addToShip(new THREE.Mesh(craneBaseGeo.clone(), shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-4, 4.5, -1.2);

        var craneBoomGeo = new THREE.CylinderGeometry(0.1, 0.1, 4, 6);
        craneBoomGeo.rotateZ(Math.PI / 4);
        addToShip(new THREE.Mesh(craneBoomGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-3, 6.5, 0);

        var bridgeGeo = new THREE.BoxGeometry(3, 3.5, 3.5);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#3f3f46'))).position.set(-5.5, 4.8, 0);

        var winGeo = new THREE.BoxGeometry(0.1, 0.6, 2.8);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-3.95, 5.2, 0);

        var funnelGeo = new THREE.CylinderGeometry(0.35, 0.45, 2, 8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#27272a'))).position.set(-6.5, 6.5, 0);
    }

    // ── Passenger: 다층 데크, 넓은 상부구조, 큰 펀넬 ──
    function buildPassenger(THREE, color) {
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-7, -2.5);
        hullShape.lineTo(-7, 2.5);
        hullShape.quadraticCurveTo(5, 2.2, 10, 0);
        hullShape.quadraticCurveTo(5, -2.2, -7, -2.5);

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 3.5, bevelEnabled: true, bevelThickness: 0.4, bevelSize: 0.3, bevelSegments: 4 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat('#f8fafc', { roughness: 0.5 }));
        hull.position.set(0, 1.0, -1.75);
        addToShip(hull);

        var deckWidths = [13, 12, 10, 8];
        var deckDepths = [4.5, 4.0, 3.5, 2.8];
        for (var d = 0; d < 4; d++) {
            var dGeo = new THREE.BoxGeometry(deckWidths[d], 1.0, deckDepths[d]);
            var deck = new THREE.Mesh(dGeo, shipMat('#e2e8f0', { roughness: 0.6 }));
            deck.position.set(-0.5 + d * 0.3, 3.4 + d * 1.05, 0);
            addToShip(deck);

            var winStripGeo = new THREE.BoxGeometry(deckWidths[d] - 1, 0.15, deckDepths[d] + 0.02);
            var winStrip = new THREE.Mesh(winStripGeo, shipMat('#fbbf24', { emissive: '#fbbf24', emissiveIntensity: 0.5, roughness: 0.3 }));
            winStrip.position.set(-0.5 + d * 0.3, 3.7 + d * 1.05, 0);
            addToShip(winStrip);
        }

        var bridgeGeo = new THREE.BoxGeometry(3, 1.5, 2.5);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#cbd5e1'))).position.set(-1, 8.2, 0);

        var winGeo = new THREE.BoxGeometry(3.02, 0.4, 2.52);
        addToShip(new THREE.Mesh(winGeo, shipMat('#0ea5e9', { emissive: '#0ea5e9', emissiveIntensity: 0.8 }))).position.set(-1, 8.5, 0);

        var funnelGeo = new THREE.CylinderGeometry(0.6, 0.8, 3, 12);
        addToShip(new THREE.Mesh(funnelGeo, shipMat(color))).position.set(-3, 8.5, 0);

        var topGeo = new THREE.CylinderGeometry(0.7, 0.6, 0.5, 12);
        addToShip(new THREE.Mesh(topGeo, shipMat('#1e293b'))).position.set(-3, 10.1, 0);
    }

    // ── Fishing: 작은 선체, 아웃리거/붐, 마스트 ──
    function buildFishing(THREE, color) {
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-4, -1.5);
        hullShape.lineTo(-4, 1.5);
        hullShape.lineTo(2, 1);
        hullShape.lineTo(5, 0);
        hullShape.lineTo(2, -1);
        hullShape.closePath();

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 2.5, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.15, bevelSegments: 2 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat(color));
        hull.position.set(0, 1.0, -1.25);
        addToShip(hull);

        var deckGeo = new THREE.BoxGeometry(8, 0.15, 2.8);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#4b5563'))).position.set(0.5, 2.5, 0);

        var bridgeGeo = new THREE.BoxGeometry(2, 1.8, 2);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#374151'))).position.set(-2, 3.5, 0);

        var winGeo = new THREE.BoxGeometry(0.1, 0.35, 1.5);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-0.95, 3.7, 0);

        var mastGeo = new THREE.CylinderGeometry(0.04, 0.06, 5, 6);
        addToShip(new THREE.Mesh(mastGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(0, 5.0, 0);

        var boomGeo = new THREE.CylinderGeometry(0.03, 0.05, 5, 6);
        var boom1 = new THREE.Mesh(boomGeo, shipMat('#9ca3af', { metalness: 0.5 }));
        boom1.position.set(0, 5.5, 1.5);
        boom1.rotation.x = -0.5;
        boom1.rotation.z = 0.3;
        addToShip(boom1);

        var boom2 = new THREE.Mesh(boomGeo.clone(), shipMat('#9ca3af', { metalness: 0.5 }));
        boom2.position.set(0, 5.5, -1.5);
        boom2.rotation.x = 0.5;
        boom2.rotation.z = 0.3;
        addToShip(boom2);

        var reelGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.5, 8);
        reelGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(reelGeo, shipMat('#6b7280', { metalness: 0.4 }))).position.set(-3.5, 2.8, 0);
    }

    // ── Military: 날렵한 선체, 스텔스 상부구조, 무장 ──
    function buildMilitary(THREE, color) {
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-7, -1.8);
        hullShape.lineTo(-7, 1.8);
        hullShape.lineTo(4, 1.0);
        hullShape.lineTo(10, 0);
        hullShape.lineTo(4, -1.0);
        hullShape.closePath();

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 2.8, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 2 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat('#6b7280', { roughness: 0.6 }));
        hull.position.set(0, 1.2, -1.4);
        addToShip(hull);

        var deckGeo = new THREE.BoxGeometry(15, 0.15, 3.2);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#4b5563'))).position.set(0.5, 2.9, 0);

        var superShape = new THREE.Shape();
        superShape.moveTo(-3, -1.3);
        superShape.lineTo(-3, 1.3);
        superShape.lineTo(-2.5, 1.5);
        superShape.lineTo(2.5, 1.5);
        superShape.lineTo(3, 1.3);
        superShape.lineTo(3, -1.3);
        superShape.lineTo(2.5, -1.5);
        superShape.lineTo(-2.5, -1.5);
        superShape.closePath();

        var superGeo = new THREE.ExtrudeGeometry(superShape, { depth: 2.5, bevelEnabled: false });
        superGeo.rotateX(-Math.PI / 2);
        var superstructure = new THREE.Mesh(superGeo, shipMat('#52525b'));
        superstructure.position.set(-2, 3.0, -1.25);
        addToShip(superstructure);

        var winGeo = new THREE.BoxGeometry(5, 0.25, 2.8);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(-2, 4.8, 0);

        var turretBase = new THREE.CylinderGeometry(0.6, 0.7, 0.5, 12);
        addToShip(new THREE.Mesh(turretBase, shipMat('#4b5563', { metalness: 0.5 }))).position.set(4, 3.3, 0);

        var barrelGeo = new THREE.CylinderGeometry(0.06, 0.08, 2.5, 6);
        barrelGeo.rotateZ(-Math.PI / 2);
        addToShip(new THREE.Mesh(barrelGeo, shipMat('#374151', { metalness: 0.6 }))).position.set(5.5, 3.5, 0);

        var mastGeo = new THREE.CylinderGeometry(0.05, 0.08, 4, 6);
        addToShip(new THREE.Mesh(mastGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(-2, 7.3, 0);

        var radarGeo = new THREE.BoxGeometry(2, 0.08, 0.5);
        addToShip(new THREE.Mesh(radarGeo, shipMat('#94a3b8', { metalness: 0.4 }))).position.set(-2, 9, 0);

        var funnelGeo = new THREE.BoxGeometry(1.2, 1.5, 1.8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#3f3f46'))).position.set(-5, 4.5, 0);
    }

    // ── Tug: 짧고 넓은 선체, 큰 브릿지, 예인 장비 ──
    function buildTug(THREE, color) {
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-3, -1.8);
        hullShape.lineTo(-3, 1.8);
        hullShape.lineTo(2, 1.5);
        hullShape.lineTo(4, 0);
        hullShape.lineTo(2, -1.5);
        hullShape.closePath();

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 3.5, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.2, bevelSegments: 3 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat(color));
        hull.position.set(0, 1.2, -1.75);
        addToShip(hull);

        var deckGeo = new THREE.BoxGeometry(6, 0.2, 3.2);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#4b5563'))).position.set(0.5, 3.0, 0);

        var bridgeGeo = new THREE.BoxGeometry(2.5, 2.8, 2.8);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#374151'))).position.set(0, 4.5, 0);

        var winFront = new THREE.BoxGeometry(0.1, 0.5, 2.2);
        addToShip(new THREE.Mesh(winFront, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(1.3, 4.8, 0);

        var winSide1 = new THREE.BoxGeometry(2, 0.5, 0.1);
        addToShip(new THREE.Mesh(winSide1, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(0, 4.8, 1.45);
        addToShip(new THREE.Mesh(winSide1.clone(), shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(0, 4.8, -1.45);

        var funnelGeo = new THREE.CylinderGeometry(0.35, 0.4, 1.5, 8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#1e293b'))).position.set(-1.5, 5.5, 0);

        var winchGeo = new THREE.CylinderGeometry(0.4, 0.4, 1.2, 10);
        winchGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(winchGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-2.5, 3.3, 0);

        var bittGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.6, 6);
        addToShip(new THREE.Mesh(bittGeo, shipMat('#374151', { metalness: 0.6 }))).position.set(-3, 3.3, 0.5);
        addToShip(new THREE.Mesh(bittGeo.clone(), shipMat('#374151', { metalness: 0.6 }))).position.set(-3, 3.3, -0.5);

        var fenderGeo = new THREE.TorusGeometry(0.25, 0.1, 8, 12);
        for (var f = -1; f <= 2; f++) {
            var fender1 = new THREE.Mesh(fenderGeo, shipMat('#1e293b', { roughness: 0.9 }));
            fender1.position.set(f * 1.5, 2.0, 1.9);
            fender1.rotation.y = Math.PI / 2;
            addToShip(fender1);

            var fender2 = new THREE.Mesh(fenderGeo.clone(), shipMat('#1e293b', { roughness: 0.9 }));
            fender2.position.set(f * 1.5, 2.0, -1.9);
            fender2.rotation.y = Math.PI / 2;
            addToShip(fender2);
        }
    }

    // ── Generic/Other: 기본 선박 모델 ──
    function buildGenericShip(THREE, color) {
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-6, -2);
        hullShape.lineTo(-6, 2);
        hullShape.lineTo(4, 1.2);
        hullShape.lineTo(8, 0);
        hullShape.lineTo(4, -1.2);
        hullShape.closePath();

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 3, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.15, bevelSegments: 2 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat(color));
        hull.position.set(0, 1.5, -1.5);
        addToShip(hull);

        var deckGeo = new THREE.BoxGeometry(12, 0.2, 3.5);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#3f3f46'))).position.set(0, 3.1, 0);

        var bridgeGeo = new THREE.BoxGeometry(3, 2.5, 2.8);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#52525b'))).position.set(-3, 4.5, 0);

        var winGeo = new THREE.BoxGeometry(0.1, 0.6, 2.2);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-1.45, 4.8, 0);

        var funnelGeo = new THREE.CylinderGeometry(0.4, 0.5, 2, 8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#27272a'))).position.set(-4.5, 5, 0);

        var mastGeo = new THREE.CylinderGeometry(0.05, 0.05, 3, 4);
        addToShip(new THREE.Mesh(mastGeo, shipMat('#71717a'))).position.set(-3, 7, 0);
    }

    // ── startAnimation() ──
    function startAnimation() {
        clockStart = performance.now();
        cameraAnimating = true;
        cameraAnimStart = 0;
        camera.position.set(CAM_START.x, CAM_START.y, CAM_START.z);
        camera.lookAt(0, 2, 0);
        if (controls) controls.enabled = false;

        function loop() {
            animFrameId = requestAnimationFrame(loop);

            var elapsed = (performance.now() - clockStart) / 1000;

            animateWater(elapsed);
            animateCamera(elapsed);
            animateSpray(1 / 60);

            // Roll & Pitch calculation
            var roll = rollParams.amp * Math.sin(elapsed * rollParams.freq * Math.PI * 2)
                     + (Math.random() - 0.5) * 1.5;
            var pitch = (rollParams.amp * 0.3) * Math.sin(elapsed * 0.4)
                      + (Math.random() - 0.5) * 0.5;

            // Apply transforms to ship
            if (shipGroup) {
                shipGroup.rotation.z = roll * (Math.PI / 180);
                shipGroup.position.y = 1 + weather.waveHeight * 0.3 * Math.sin(elapsed * 0.8);
                shipGroup.rotation.x = pitch * (Math.PI / 180);
            }

            var absRoll = Math.abs(roll);
            var absPitch = Math.abs(pitch);
            updateGauge(absRoll, roll);
            updatePitchGauge(absPitch, pitch);

            // Push to history, cap at 60
            rollHistory.push(absRoll);
            if (rollHistory.length > 60) rollHistory.shift();
            pitchHistory.push(absPitch);
            if (pitchHistory.length > 60) pitchHistory.shift();

            if (controls) controls.update();
            if (composer) {
                composer.render();
            } else if (renderer && scene && camera) {
                renderer.render(scene, camera);
            }
        }

        loop();
    }

    // ── buildInfoPanel(ship) ──
    function buildInfoPanel(ship) {
        var panel = document.createElement('div');
        panel.className = 'roll-viewer-panel';

        var typeKey = getShipTypeKey(ship);
        var typeLabel = {
            cargo: '화물선', tanker: '탱커', passenger: '여객선',
            fishing: '어선', military: '군함', tug: '예인선', other: '기타'
        }[typeKey] || '기타';

        var sogVal = ship.sog !== undefined ? parseFloat(ship.sog).toFixed(1) + ' kt' : '-';
        var hdgVal = ship.heading !== undefined ? ship.heading + '°' : (ship.cog !== undefined ? parseFloat(ship.cog).toFixed(0) + '°' : '-');

        panel.innerHTML =
            '<div class="roll-viewer-section">' +
                '<div class="roll-viewer-section-title">선박 정보 SHIP INFO</div>' +
                '<div class="rv-info-row"><span class="rv-info-label">선명</span><span class="rv-info-value">' + (ship.name || 'UNKNOWN') + '</span></div>' +
                '<div class="rv-info-row"><span class="rv-info-label">MMSI</span><span class="rv-info-value">' + (ship.mmsi || currentMmsi) + '</span></div>' +
                '<div class="rv-info-row"><span class="rv-info-label">선종</span><span class="rv-info-value">' + typeLabel + '</span></div>' +
                '<div class="rv-info-row"><span class="rv-info-label">속력</span><span class="rv-info-value">' + sogVal + '</span></div>' +
                '<div class="rv-info-row"><span class="rv-info-label">침로</span><span class="rv-info-value">' + hdgVal + '</span></div>' +
            '</div>' +
            '<div class="roll-viewer-section">' +
                '<div class="roll-viewer-section-title">횡요각 ROLL</div>' +
                '<div class="rv-tilt-row">' +
                    '<div class="rv-tilt-indicator" id="rv-roll-tilt">' +
                        '<div class="rv-tilt-ring">' +
                            '<div class="rv-tilt-horizon" id="rv-roll-horizon"></div>' +
                            '<div class="rv-tilt-center"></div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="rv-tilt-info">' +
                        '<div class="rv-tilt-value" id="rv-gauge-value">0.0°</div>' +
                        '<div class="rv-tilt-label">현재 횡요각</div>' +
                        '<div class="roll-gauge roll-gauge-safe" id="rv-gauge">' +
                            '<div class="roll-gauge-track">' +
                                '<div class="roll-gauge-fill" id="rv-gauge-fill"></div>' +
                                '<div class="roll-gauge-threshold"></div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="roll-viewer-section">' +
                '<div class="roll-viewer-section-title">종요각 PITCH</div>' +
                '<div class="rv-tilt-row">' +
                    '<div class="rv-tilt-indicator rv-tilt-pitch" id="rv-pitch-tilt">' +
                        '<div class="rv-tilt-ring">' +
                            '<div class="rv-tilt-horizon" id="rv-pitch-horizon"></div>' +
                            '<div class="rv-tilt-center"></div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="rv-tilt-info">' +
                        '<div class="rv-tilt-value" id="rv-pitch-value">0.0°</div>' +
                        '<div class="rv-tilt-label">현재 종요각</div>' +
                        '<div class="roll-gauge roll-gauge-safe" id="rv-pitch-gauge">' +
                            '<div class="roll-gauge-track">' +
                                '<div class="roll-gauge-fill" id="rv-pitch-fill"></div>' +
                                '<div class="roll-gauge-threshold" style="left:50%;"></div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="roll-viewer-section">' +
                '<div class="roll-viewer-section-title">기상 WEATHER</div>' +
                '<div class="rv-info-row"><span class="rv-info-label">풍속</span><span class="rv-info-value">' + weather.windSpeed + ' kt</span></div>' +
                '<div class="rv-info-row"><span class="rv-info-label">파고</span><span class="rv-info-value">' + weather.waveHeight + ' m</span></div>' +
                '<div class="rv-info-row"><span class="rv-info-label">주기</span><span class="rv-info-value">' + weather.wavePeriod + ' s</span></div>' +
                '<div class="rv-info-row"><span class="rv-info-label">파향</span><span class="rv-info-value">' + Math.round(weather.waveDirection) + '°</span></div>' +
            '</div>' +
            '<div class="roll-viewer-section roll-viewer-section-chart">' +
                '<div class="roll-viewer-section-title">이력 HISTORY</div>' +
                '<div id="rv-roll-chart" style="width:100%;height:120px;"></div>' +
            '</div>';

        return panel;
    }

    // ── updateGauge(absRoll, signedRoll) ──
    function updateGauge(absRoll, signedRoll) {
        var gauge     = document.getElementById('rv-gauge');
        var fill      = document.getElementById('rv-gauge-fill');
        var valueEl   = document.getElementById('rv-gauge-value');
        var horizon   = document.getElementById('rv-roll-horizon');

        if (!gauge || !fill || !valueEl) return;

        var pct = Math.min(absRoll / 30 * 100, 100);
        fill.style.width = pct + '%';
        valueEl.textContent = absRoll.toFixed(1) + '°';

        // Rotate tilt indicator horizon line
        if (horizon) {
            horizon.style.transform = 'rotate(' + (signedRoll || 0) + 'deg)';
        }

        var level;
        if (absRoll < 5)       level = 'safe';
        else if (absRoll < 10) level = 'caution';
        else if (absRoll < 15) level = 'warning';
        else                   level = 'danger';

        gauge.className = 'roll-gauge roll-gauge-' + level;

        // Color the tilt ring border too
        var tilt = document.getElementById('rv-roll-tilt');
        if (tilt) tilt.setAttribute('data-level', level);
    }

    // ── updatePitchGauge(absPitch, signedPitch) ──
    function updatePitchGauge(absPitch, signedPitch) {
        var gauge   = document.getElementById('rv-pitch-gauge');
        var fill    = document.getElementById('rv-pitch-fill');
        var valueEl = document.getElementById('rv-pitch-value');
        var horizon = document.getElementById('rv-pitch-horizon');

        if (!gauge || !fill || !valueEl) return;

        var pct = Math.min(absPitch / 15 * 100, 100);
        fill.style.width = pct + '%';
        valueEl.textContent = absPitch.toFixed(1) + '°';

        // Rotate tilt indicator horizon line
        if (horizon) {
            horizon.style.transform = 'rotate(' + (signedPitch || 0) + 'deg)';
        }

        var level;
        if (absPitch < 2)       level = 'safe';
        else if (absPitch < 4)  level = 'caution';
        else if (absPitch < 6)  level = 'warning';
        else                    level = 'danger';

        gauge.className = 'roll-gauge roll-gauge-' + level;

        var tilt = document.getElementById('rv-pitch-tilt');
        if (tilt) tilt.setAttribute('data-level', level);
    }

    // ── initRollChart(panel) ──
    function initRollChart(panel) {
        // Init history with 60 zeros
        rollHistory = [];
        pitchHistory = [];
        for (var i = 0; i < 60; i++) { rollHistory.push(0); pitchHistory.push(0); }

        var chartEl = panel.querySelector('#rv-roll-chart');
        if (!chartEl || !window.echarts) return;

        rollChart = echarts.init(chartEl);

        var xLabels = [];
        for (var j = 0; j < 60; j++) {
            xLabels.push(j % 15 === 0 ? (60 - j) + 's' : '');
        }

        var option = {
            animation: false,
            grid: { top: 20, right: 12, bottom: 24, left: 36 },
            xAxis: {
                type: 'category',
                data: xLabels,
                axisLabel: {
                    color: '#52525b',
                    fontSize: 10
                },
                axisLine: { lineStyle: { color: '#27272a' } },
                axisTick: { show: false }
            },
            yAxis: {
                type: 'value',
                min: 0,
                max: 20,
                axisLabel: {
                    color: '#52525b',
                    fontSize: 10,
                    formatter: '{value}°'
                },
                axisLine: { show: false },
                splitLine: { lineStyle: { color: '#27272a', type: 'dashed' } }
            },
            legend: {
                data: ['Roll', 'Pitch'],
                right: 12, top: 0,
                textStyle: { color: '#71717a', fontSize: 10 },
                itemWidth: 12, itemHeight: 2
            },
            series: [
                {
                    name: 'Roll',
                    type: 'line',
                    smooth: true,
                    symbol: 'none',
                    data: rollHistory.slice(),
                    lineStyle: { color: '#406fd8', width: 2 },
                    areaStyle: {
                        color: {
                            type: 'linear',
                            x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                                { offset: 0, color: 'rgba(64,111,216,0.35)' },
                                { offset: 1, color: 'rgba(64,111,216,0)' }
                            ]
                        }
                    }
                },
                {
                    name: 'Pitch',
                    type: 'line',
                    smooth: true,
                    symbol: 'none',
                    data: pitchHistory.slice(),
                    lineStyle: { color: '#2dd4bf', width: 1.5 },
                    areaStyle: {
                        color: {
                            type: 'linear',
                            x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                                { offset: 0, color: 'rgba(45,212,191,0.2)' },
                                { offset: 1, color: 'rgba(45,212,191,0)' }
                            ]
                        }
                    }
                },
                {
                    type: 'line',
                    markLine: {
                        silent: true,
                        symbol: 'none',
                        data: [{ yAxis: 15 }],
                        lineStyle: { color: '#ef4444', type: 'dashed', width: 1 }
                    },
                    data: [],
                    silent: true
                }
            ]
        };

        rollChart.setOption(option);
    }

    // ── startChartUpdates() ──
    function startChartUpdates() {
        chartInterval = setInterval(function() {
            if (!rollChart) return;
            rollChart.setOption({
                series: [
                    { data: rollHistory.slice() },
                    { data: pitchHistory.slice() }
                ]
            });
        }, 1000);
    }

    // ── dispose() ──
    function dispose() {
        // Stop animation loop
        if (animFrameId !== null) {
            cancelAnimationFrame(animFrameId);
            animFrameId = null;
        }

        // Stop chart updates
        if (chartInterval !== null) {
            clearInterval(chartInterval);
            chartInterval = null;
        }

        // Dispose ECharts
        if (rollChart) {
            rollChart.dispose();
            rollChart = null;
        }

        // Remove window resize handler
        if (_resizeHandler) {
            window.removeEventListener('resize', _resizeHandler);
            _resizeHandler = null;
        }

        // Dispose Three.js scene objects
        if (scene) {
            scene.traverse(function(obj) {
                if (obj.geometry) {
                    obj.geometry.dispose();
                }
                if (obj.material) {
                    if (Array.isArray(obj.material)) {
                        obj.material.forEach(function(mat) { mat.dispose(); });
                    } else {
                        obj.material.dispose();
                    }
                }
            });
        }

        // Dispose composer
        if (composer) {
            composer.dispose();
            composer = null;
        }

        // Dispose controls
        if (controls) {
            controls.dispose();
            controls = null;
        }

        // Dispose renderer
        if (renderer) {
            renderer.dispose();
            if (renderer.domElement && renderer.domElement.parentNode) {
                renderer.domElement.parentNode.removeChild(renderer.domElement);
            }
            renderer = null;
        }

        // Null out references
        scene = null;
        camera = null;
        shipGroup = null;
        if (waterNormals) { waterNormals.dispose(); }
        waterMesh = null;
        waterNormals = null;
        sprayPoints = null;
        sprayVelocities = [];
        clockStart = null;
        cameraAnimating = false;
        weather = null;
        rollParams = null;
        currentMmsi = null;
        rollHistory = [];
        pitchHistory = [];

        // Clear container DOM
        var container = getContainer();
        if (container) {
            container.innerHTML = '';
        }
    }

    // ── Public API ──
    return {
        load: load,
        dispose: dispose
    };

})();

window.RollViewer = RollViewer;
