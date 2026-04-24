// ── OVERWATCH 4D — Roll Viewer ──
// Three.js 3D roll prediction viewer for maritime vessel visualization.
// Renders ship model with wave animation and live roll angle chart.

var RollViewer = (function () {

    // ── State ──
    var scene = null;
    var camera = null;
    var renderer = null;
    var controls = null;

    var shipGroup = null;
    var waterMesh = null;
    var gltfModelCache = {};   // { type: THREE.Group }
    var gltfLoader = null;
    var useGltfModels = true;  // false if all loads fail
    var composer = null;
    var mainDirLight = null;
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
    var sogSignalLost = false;

    var sprayPoints = null;
    var sprayVelocities = [];
    var SPRAY_COUNT = 80;

    var cameraAnimating = false;
    var cameraAnimStart = 0;
    var CAMERA_ANIM_DURATION = 2.0; // seconds

    // ── Turning scenario state ──
    var turnScenarioActive = false;
    var turnPhase = 'straight';   // 'straight' | 'entering' | 'turning' | 'exiting'
    var turnElapsed = 0;
    var turnHeading = 0;          // current heading in degrees
    var turnDirection = 1;        // 1 = starboard, -1 = port
    var turnHudEl = null;
    var turnBtnEl = null;
    var shipSpeed = 12;           // knots — set from actual SOG, capped
    var shipWorldPos = { x: 0, z: 0 };  // ship position in world space
    var camFollow = { x: 0, z: 0 };     // smoothed camera target
    var camFollowHeading = 0;              // smoothed camera heading (radians)
    var smoothSpeed = 12;                  // lerp-smoothed current speed
    var smoothRoll = 0;                    // lerp-smoothed roll angle
    var smoothPitch = 0;                   // lerp-smoothed pitch angle

    // Turning cycle timings (seconds)
    var TURN_TIMING = {
        straight: 8,    // straight ahead
        entering: 4,    // entering turn
        turning: 6,     // max turn
        exiting: 4      // exiting turn
    };
    var TURN_TOTAL = TURN_TIMING.straight + TURN_TIMING.entering + TURN_TIMING.turning + TURN_TIMING.exiting;

    // Turn-induced roll multiplier per ship type (higher = more roll during turns)
    var TURN_ROLL_MULT = {
        cargo: 1.8,
        tanker: 1.5,
        passenger: 1.4,
        fishing: 2.2,
        military: 1.5,
        tug: 1.8,
        other: 1.6
    };

    // ── Roll simulation params per ship type ──
    // amp = max wave-induced roll (degrees), freq = Hz (1/period)
    // Real ships: cargo ~12-16s period, tanker ~14-20s, passenger ~10-14s, fishing ~6-10s
    var ROLL_PARAMS = {
        cargo: { amp: 4, freq: 0.07 },     // ~14s period
        tanker: { amp: 3, freq: 0.06 },     // ~17s period
        passenger: { amp: 2.5, freq: 0.08 }, // ~12s period
        fishing: { amp: 6, freq: 0.12 },    // ~8s period
        military: { amp: 3, freq: 0.09 },   // ~11s period
        tug: { amp: 5, freq: 0.11 },        // ~9s period
        other: { amp: 4, freq: 0.08 }       // ~12s period
    };

    var _resizeHandler = null;

    // ── Find nearest weather grid point from _wxData ──
    function findNearestWeather(lat, lon) {
        var fallback = {
            windSpeed: Math.round(10 + Math.random() * 15),
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
            windSpeed: nearestWind ? Math.round(nearestWind.wind_speed || 0) : fallback.windSpeed,
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
        if (t.indexOf('cargo') !== -1) return 'cargo';
        if (t.indexOf('tanker') !== -1) return 'tanker';
        if (t.indexOf('passenger') !== -1) return 'passenger';
        if (t.indexOf('fishing') !== -1) return 'fishing';
        if (t.indexOf('military') !== -1) return 'military';
        if (t.indexOf('tug') !== -1) return 'tug';
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
    var CAM_END = { x: 30, y: 20, z: 40 };

    function animateCamera(elapsed) {
        if (!cameraAnimating) return;

        var t = Math.min((elapsed - cameraAnimStart) / CAMERA_ANIM_DURATION, 1);
        var e = easeOutCubic(t);

        camera.position.set(
            shipWorldPos.x + CAM_START.x + (CAM_END.x - CAM_START.x) * e,
            CAM_START.y + (CAM_END.y - CAM_START.y) * e,
            shipWorldPos.z + CAM_START.z + (CAM_END.z - CAM_START.z) * e
        );
        camera.lookAt(shipWorldPos.x, 2, shipWorldPos.z);

        if (t >= 1) {
            cameraAnimating = false;
            camFollow.x = shipWorldPos.x;
            camFollow.z = shipWorldPos.z;
            if (controls) {
                controls.target.set(shipWorldPos.x, 2, shipWorldPos.z);
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
            backBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i> <span>지구본으로</span>';
            backBtn.addEventListener('click', function () {
                if (window.LayoutManager) {
                    LayoutManager.closeDedicatedPanel();
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

        // Set ship speed from SOG, capped to realistic range (max 30kt for most ships)
        var rawSog = parseFloat(ship.sog);
        sogSignalLost = false;
        var defaultSpeeds = { cargo: 12, tanker: 11, passenger: 18, fishing: 8, military: 20, tug: 10, other: 12 };
        if (!isNaN(rawSog) && Math.abs(rawSog - 102.3) < 0.2) {
            sogSignalLost = true;
            shipSpeed = defaultSpeeds[shipType] || 12;
        } else if (!isNaN(rawSog) && rawSog > 0 && rawSog <= 35) {
            shipSpeed = rawSog;
        } else {
            shipSpeed = defaultSpeeds[shipType] || 12;
        }

        // Get real weather from nearest grid point, fallback to random
        weather = findNearestWeather(ship.lat, ship.lon);
        waterFlowOffset = { x: 0, z: 0 };

        // Build layout DOM
        var layout = document.createElement('div');
        layout.className = 'roll-viewer-layout';

        var canvasWrap = document.createElement('div');
        canvasWrap.className = 'roll-viewer-canvas-wrap';

        // Back button overlay
        var backBtn = document.createElement('button');
        backBtn.className = 'roll-viewer-back';
        backBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i> <span>지구본으로</span>';
        backBtn.addEventListener('click', function () {
            if (window.LayoutManager) {
                LayoutManager.closeDedicatedPanel();
            }
        });
        canvasWrap.appendChild(backBtn);

        // Info panel (right 30%)
        var panel = buildInfoPanel(ship);

        layout.appendChild(canvasWrap);
        layout.appendChild(panel);
        container.appendChild(layout);

        // Build turn scenario UI overlay on canvas
        buildTurnScenarioUI(canvasWrap);

        // Init Three.js
        initScene(canvasWrap);
        buildSky();
        // buildSun(); // disabled — too bright
        buildWater();
        buildCompass();
        buildShip(shipType);
        buildSeagulls();
        buildSeaMarkers();
        buildRadarIndicator();
        startAnimation();

        // Init ECharts roll chart
        initRollChart(panel);
        startChartUpdates();

        // Resize chart after CSS fade-in transition
        setTimeout(function () {
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

        var w = container.clientWidth;
        var h = container.clientHeight;
        var aspect = w / (h || 1);

        camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
        camera.position.set(CAM_START.x, CAM_START.y, CAM_START.z);
        camera.lookAt(0, 2, 0);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        var todPal = SKY_PALETTES[getTimeOfDay()];
        renderer.toneMappingExposure = todPal.exposure || 0.8;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

        // Lights — adjusted by time of day
        var tod = getTimeOfDay();
        var pal = SKY_PALETTES[tod];
        mainDirLight = new THREE.DirectionalLight(pal.sunColor, pal.sunIntensity);
        var dirLight = mainDirLight;
        dirLight.position.set(30, 40, 20);
        dirLight.castShadow = true;
        dirLight.shadow.mapSize.width = 1024;
        dirLight.shadow.mapSize.height = 1024;
        dirLight.shadow.camera.near = 1;
        dirLight.shadow.camera.far = 100;
        dirLight.shadow.camera.left = -25;
        dirLight.shadow.camera.right = 25;
        dirLight.shadow.camera.top = 25;
        dirLight.shadow.camera.bottom = -25;
        dirLight.shadow.bias = -0.002;
        scene.add(dirLight);

        var fillLight = new THREE.DirectionalLight(0xaaccff, tod === 'night' ? 0.2 : 0.5);
        fillLight.position.set(-20, 10, -10);
        scene.add(fillLight);

        var ambLight = new THREE.AmbientLight(0xffffff, tod === 'night' ? 0.3 : 0.8);
        scene.add(ambLight);

        // Resize handler
        _resizeHandler = function () {
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
        var bloomStrength = todPal.bloom !== undefined ? todPal.bloom : 0.5;
        var bloomPass = new THREE.UnrealBloomPass(
            new THREE.Vector2(w, h),
            bloomStrength,   // strength
            0.6,   // radius — wider glow spread
            0.6    // threshold — catch more bright surfaces
        );

        composer = new THREE.EffectComposer(renderer);
        composer.addPass(renderPass);
        composer.addPass(bloomPass);
    }

    // ── Time-of-day sky palettes ──
    function getTimeOfDay() {
        var h = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();
        if (h >= 5 && h < 7) return 'dawn';
        if (h >= 7 && h < 17) return 'day';
        if (h >= 17 && h < 19) return 'dusk';
        return 'night';
    }

    var SKY_PALETTES = {
        dawn: {
            top: 0x1a1a4a, mid: 0x4a3a6a, horizon: 0xd4856a, warm: 0xe8a070,
            bg: 0x3a3050, fog: 0x6a5060, sunColor: 0xffcc88, sunIntensity: 1.2,
            waterColor: 0x1a2a3d
        },
        day: {
            top: 0x0055cc, mid: 0x0088ee, horizon: 0x40aaff, warm: 0x70c8ff,
            bg: 0x0077dd, fog: 0x3399ee, sunColor: 0xfffff0, sunIntensity: 2.0,
            waterColor: 0x005577, exposure: 1.1, bloom: 0
        },
        dusk: {
            top: 0x0a1a3a, mid: 0x4a3060, horizon: 0xc86040, warm: 0xe08850,
            bg: 0x2a2040, fog: 0x5a4050, sunColor: 0xff9966, sunIntensity: 1.0,
            waterColor: 0x0a1a2d
        },
        night: {
            top: 0x020810, mid: 0x0a1520, horizon: 0x1a2a3a, warm: 0x2a3040,
            bg: 0x060c18, fog: 0x101828, sunColor: 0x8899bb, sunIntensity: 0.4,
            waterColor: 0x000a15
        }
    };

    // ── Sky group — moves with ship so horizon never breaks ──
    var skyGroup = null;

    // ── buildSky() — time-of-day gradient sky dome + clouds ──
    function buildSky() {
        var THREE = window.THREE;
        var tod = getTimeOfDay();
        var pal = SKY_PALETTES[tod];

        // Update scene background & fog to match time
        scene.background = new THREE.Color(pal.bg);
        scene.fog = new THREE.FogExp2(pal.fog, 0.0004);

        skyGroup = new THREE.Group();

        // Sky dome
        var skyGeo = new THREE.SphereGeometry(400, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
        var skyVertCount = skyGeo.attributes.position.count;
        var colors = new Float32Array(skyVertCount * 3);
        var topColor = new THREE.Color(pal.top);
        var midColor = new THREE.Color(pal.mid);
        var horizonColor = new THREE.Color(pal.horizon);
        var horizonWarm = new THREE.Color(pal.warm);
        var tmp = new THREE.Color();

        for (var i = 0; i < skyVertCount; i++) {
            var y = skyGeo.attributes.position.getY(i);
            var t = Math.max(0, y / 400);
            if (t < 0.05) {
                tmp.copy(horizonWarm).lerp(horizonColor, t / 0.05);
            } else if (t < 0.3) {
                tmp.copy(horizonColor).lerp(midColor, (t - 0.05) / 0.25);
            } else {
                tmp.copy(midColor).lerp(topColor, (t - 0.3) / 0.7);
            }
            colors[i * 3] = tmp.r;
            colors[i * 3 + 1] = tmp.g;
            colors[i * 3 + 2] = tmp.b;
        }
        skyGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        var skyMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
        skyGroup.add(new THREE.Mesh(skyGeo, skyMat));

        // Stars for night/dawn/dusk
        if (tod === 'night' || tod === 'dawn' || tod === 'dusk') {
            var starCount = tod === 'night' ? 300 : 100;
            var starGeo = new THREE.BufferGeometry();
            var starPos = new Float32Array(starCount * 3);
            for (var s = 0; s < starCount; s++) {
                var theta = Math.random() * Math.PI * 2;
                var phi = Math.random() * Math.PI * 0.45; // upper hemisphere
                var r = 380;
                starPos[s * 3] = r * Math.sin(phi) * Math.cos(theta);
                starPos[s * 3 + 1] = r * Math.cos(phi);
                starPos[s * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
            }
            starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
            var starMat = new THREE.PointsMaterial({
                color: 0xffffff,
                size: tod === 'night' ? 1.2 : 0.7,
                transparent: true,
                opacity: tod === 'night' ? 0.8 : 0.4
            });
            skyGroup.add(new THREE.Points(starGeo, starMat));
        }

        scene.add(skyGroup);

        // Clouds — scattered billboard sprites near horizon
        buildClouds(THREE, tod);
    }

    var _cloudSprites = [];  // for per-sprite animation

    function _makeCloudCanvas(w, h, painter) {
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        painter(c.getContext('2d'), w, h);
        return new THREE.CanvasTexture(c);
    }

    function buildClouds(THREE, tod) {
        cloudGroup = new THREE.Group();
        _cloudSprites = [];
        var isNight = tod === 'night';
        var isDusk = tod === 'dusk' || tod === 'dawn';

        // ── Layer 1: Horizon mist band ──
        var mistTex = _makeCloudCanvas(512, 64, function (ctx, w, h) {
            var mc = isNight ? [15, 20, 35] : isDusk ? [180, 150, 120] : [220, 235, 250];
            var g = ctx.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, 'rgba(' + mc.join(',') + ',0)');
            g.addColorStop(0.3, 'rgba(' + mc.join(',') + ',0.35)');
            g.addColorStop(0.6, 'rgba(' + mc.join(',') + ',0.25)');
            g.addColorStop(1, 'rgba(' + mc.join(',') + ',0)');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
        });
        for (var m = 0; m < 14; m++) {
            var ma = (m / 14) * Math.PI * 2;
            var mMat = new THREE.SpriteMaterial({ map: mistTex, transparent: true, opacity: isNight ? 0.25 : 0.45, depthWrite: false });
            var mSp = new THREE.Sprite(mMat);
            mSp.position.set(280 * Math.cos(ma), 12 + Math.random() * 8, 280 * Math.sin(ma));
            mSp.scale.set(200, 28, 1);
            cloudGroup.add(mSp);
        }

        // ── Layer 2: Cumulus puffs — volumetric-look billboards ──
        if (!isNight) {
            // Generate several unique cumulus textures
            var cumulusTextures = [];
            for (var ct = 0; ct < 4; ct++) {
                var seed = ct;
                cumulusTextures.push(_makeCloudCanvas(256, 256, function (ctx, w, h) {
                    ctx.clearRect(0, 0, w, h);
                    // Build up cloud from overlapping radial gradients
                    var cx = w / 2, cy = h / 2;
                    var puffs = 8 + Math.floor(Math.random() * 6);
                    for (var p = 0; p < puffs; p++) {
                        var px = cx + (Math.random() - 0.5) * w * 0.5;
                        var py = cy + (Math.random() - 0.5) * h * 0.35 + h * 0.05;
                        var pr = 30 + Math.random() * 55;
                        var rg = ctx.createRadialGradient(px, py, 0, px, py, pr);
                        var baseAlpha = 0.25 + Math.random() * 0.2;
                        if (isDusk) {
                            // warm tint for dawn/dusk
                            rg.addColorStop(0, 'rgba(255,230,200,' + (baseAlpha + 0.1) + ')');
                            rg.addColorStop(0.4, 'rgba(255,220,190,' + baseAlpha + ')');
                            rg.addColorStop(1, 'rgba(255,210,180,0)');
                        } else {
                            rg.addColorStop(0, 'rgba(255,255,255,' + (baseAlpha + 0.15) + ')');
                            rg.addColorStop(0.3, 'rgba(250,252,255,' + baseAlpha + ')');
                            rg.addColorStop(0.7, 'rgba(240,245,255,' + (baseAlpha * 0.4) + ')');
                            rg.addColorStop(1, 'rgba(230,240,250,0)');
                        }
                        ctx.fillStyle = rg;
                        ctx.fillRect(0, 0, w, h);
                    }
                    // Soft bottom shadow for depth
                    var sg = ctx.createLinearGradient(0, h * 0.55, 0, h);
                    sg.addColorStop(0, 'rgba(0,0,0,0)');
                    sg.addColorStop(0.5, 'rgba(100,120,150,0.08)');
                    sg.addColorStop(1, 'rgba(80,100,130,0)');
                    ctx.fillStyle = sg;
                    ctx.fillRect(0, 0, w, h);
                }));
            }

            var cumulusCount = 14;
            for (var ci = 0; ci < cumulusCount; ci++) {
                var ca = (ci / cumulusCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
                var cd = 120 + Math.random() * 160;
                var cTex = cumulusTextures[ci % cumulusTextures.length];
                var cMat = new THREE.SpriteMaterial({ map: cTex, transparent: true, opacity: 0.7 + Math.random() * 0.25, depthWrite: false });
                var cSp = new THREE.Sprite(cMat);
                var cHeight = 35 + Math.random() * 30;
                var cScaleX = 50 + Math.random() * 40;
                var cScaleY = 20 + Math.random() * 15;
                cSp.position.set(cd * Math.cos(ca), cHeight, cd * Math.sin(ca));
                cSp.scale.set(cScaleX, cScaleY, 1);
                cloudGroup.add(cSp);
                _cloudSprites.push({
                    sprite: cSp,
                    baseY: cHeight,
                    driftSpeed: 0.3 + Math.random() * 0.8,
                    bobAmp: 0.5 + Math.random() * 1.0,
                    bobFreq: 0.1 + Math.random() * 0.15,
                    angle: ca,
                    dist: cd,
                    baseOpacity: cMat.opacity,
                    mat: cMat
                });
            }
        }

        // ── Layer 3: Cirrus wisps — high altitude, thin streaks ──
        if (!isNight) {
            var cirrusTextures = [];
            for (var wt = 0; wt < 3; wt++) {
                cirrusTextures.push(_makeCloudCanvas(512, 64, function (ctx, w, h) {
                    ctx.clearRect(0, 0, w, h);
                    var strokes = 4 + Math.floor(Math.random() * 5);
                    for (var s = 0; s < strokes; s++) {
                        var sx = 20 + Math.random() * 80;
                        var sy = 15 + Math.random() * 34;
                        var ex = sx + 180 + Math.random() * 250;
                        var cy = sy + (Math.random() - 0.5) * 20;
                        ctx.strokeStyle = isDusk
                            ? 'rgba(255,220,190,' + (0.25 + Math.random() * 0.35) + ')'
                            : 'rgba(255,255,255,' + (0.2 + Math.random() * 0.35) + ')';
                        ctx.lineWidth = 1.5 + Math.random() * 3;
                        ctx.lineCap = 'round';
                        ctx.filter = 'blur(1px)';
                        ctx.beginPath();
                        ctx.moveTo(sx, sy);
                        ctx.bezierCurveTo(sx + 60, cy - 5, ex - 60, cy + 5, ex, sy + (Math.random() - 0.5) * 10);
                        ctx.stroke();
                        ctx.filter = 'none';
                    }
                }));
            }

            var cirrusCount = 8;
            for (var wi = 0; wi < cirrusCount; wi++) {
                var wa = (wi / cirrusCount) * Math.PI * 2 + Math.random() * 0.4;
                var wd = 130 + Math.random() * 120;
                var wTex = cirrusTextures[wi % cirrusTextures.length];
                var wMat = new THREE.SpriteMaterial({ map: wTex, transparent: true, opacity: 0.5 + Math.random() * 0.3, depthWrite: false });
                var wSp = new THREE.Sprite(wMat);
                var wH = 70 + Math.random() * 40;
                wSp.position.set(wd * Math.cos(wa), wH, wd * Math.sin(wa));
                wSp.scale.set(130 + Math.random() * 90, 10 + Math.random() * 8, 1);
                cloudGroup.add(wSp);
                _cloudSprites.push({
                    sprite: wSp,
                    baseY: wH,
                    driftSpeed: 0.6 + Math.random() * 1.0,
                    bobAmp: 0.3,
                    bobFreq: 0.05 + Math.random() * 0.05,
                    angle: wa,
                    dist: wd,
                    baseOpacity: wMat.opacity,
                    mat: wMat
                });
            }
        }

        // ── Night: subtle dark clouds for moonlit silhouettes ──
        if (isNight) {
            var nightTex = _makeCloudCanvas(256, 128, function (ctx, w, h) {
                ctx.clearRect(0, 0, w, h);
                for (var p = 0; p < 6; p++) {
                    var px = w * 0.3 + Math.random() * w * 0.4;
                    var py = h * 0.4 + Math.random() * h * 0.2;
                    var pr = 25 + Math.random() * 35;
                    var rg = ctx.createRadialGradient(px, py, 0, px, py, pr);
                    rg.addColorStop(0, 'rgba(30,35,55,0.2)');
                    rg.addColorStop(0.6, 'rgba(20,25,45,0.1)');
                    rg.addColorStop(1, 'rgba(10,15,30,0)');
                    ctx.fillStyle = rg;
                    ctx.fillRect(0, 0, w, h);
                }
            });
            for (var ni = 0; ni < 6; ni++) {
                var na = (ni / 6) * Math.PI * 2 + Math.random() * 0.5;
                var nd = 150 + Math.random() * 100;
                var nMat = new THREE.SpriteMaterial({ map: nightTex, transparent: true, opacity: 0.35, depthWrite: false });
                var nSp = new THREE.Sprite(nMat);
                var nH = 40 + Math.random() * 25;
                nSp.position.set(nd * Math.cos(na), nH, nd * Math.sin(na));
                nSp.scale.set(80 + Math.random() * 50, 20 + Math.random() * 12, 1);
                cloudGroup.add(nSp);
                _cloudSprites.push({
                    sprite: nSp, baseY: nH, driftSpeed: 0.2 + Math.random() * 0.3,
                    bobAmp: 0.3, bobFreq: 0.04, angle: na, dist: nd,
                    baseOpacity: 0.35, mat: nMat
                });
            }
        }

        scene.add(cloudGroup);
    }

    // ── buildSun() — sun or moon disc in the sky ──
    var sunMesh = null;
    function buildSun() {
        var THREE = window.THREE;
        var tod = getTimeOfDay();
        var isSun = (tod === 'day' || tod === 'dawn' || tod === 'dusk');

        var size = isSun ? 8 : 5;
        var color = tod === 'day' ? 0xfffde8 : tod === 'dawn' ? 0xffcc88 : tod === 'dusk' ? 0xff8844 : 0xddeeff;
        var emissive = color;
        var intensity = tod === 'night' ? 0.5 : 1.5;

        var geo = new THREE.SphereGeometry(size, 16, 16);
        var mat = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: tod === 'night' ? 0.6 : 0.9
        });
        sunMesh = new THREE.Mesh(geo, mat);

        // Position based on time — sun arc
        var angle = tod === 'dawn' ? 0.1 : tod === 'day' ? 0.8 : tod === 'dusk' ? 0.15 : 0.5;
        var sunAngle = tod === 'dusk' ? Math.PI * 0.9 : Math.PI * 0.2;
        sunMesh.position.set(
            300 * Math.cos(sunAngle),
            80 + angle * 200,
            -200
        );
        scene.add(sunMesh);

        // Glow sprite around sun/moon
        var glowCanvas = document.createElement('canvas');
        glowCanvas.width = 128;
        glowCanvas.height = 128;
        var gCtx = glowCanvas.getContext('2d');
        var glowGrad = gCtx.createRadialGradient(64, 64, 0, 64, 64, 64);
        var glowColor = isSun ? 'rgba(255,250,200,' : 'rgba(200,220,255,';
        glowGrad.addColorStop(0, glowColor + '0.4)');
        glowGrad.addColorStop(0.5, glowColor + '0.1)');
        glowGrad.addColorStop(1, glowColor + '0)');
        gCtx.fillStyle = glowGrad;
        gCtx.fillRect(0, 0, 128, 128);

        var glowTex = new THREE.CanvasTexture(glowCanvas);
        var glowMat = new THREE.SpriteMaterial({
            map: glowTex,
            transparent: true,
            opacity: isSun ? 0.35 : 0.2,
            depthWrite: false
        });
        var glowSprite = new THREE.Sprite(glowMat);
        glowSprite.scale.set(size * 4, size * 4, 1);
        glowSprite.position.copy(sunMesh.position);
        scene.add(glowSprite);
    }

    // ── buildWake() — foam particle trail behind ship ──
    var wakePoints = null;
    var wakeParticles = [];
    var WAKE_COUNT = 80;

    function buildWake() {
        var THREE = window.THREE;

        // Procedural foam dot texture
        var canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        var ctx = canvas.getContext('2d');
        var grad = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
        grad.addColorStop(0, 'rgba(255,255,255,0.8)');
        grad.addColorStop(0.5, 'rgba(255,255,255,0.3)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 16, 16);
        var tex = new THREE.CanvasTexture(canvas);

        var positions = new Float32Array(WAKE_COUNT * 3);
        var sizes = new Float32Array(WAKE_COUNT);

        for (var i = 0; i < WAKE_COUNT; i++) {
            var t = i / WAKE_COUNT;
            var spread = t * 4;
            var side = (i % 2 === 0) ? 1 : -1;
            positions[i * 3] = -8 - t * 25;                          // X: trail behind stern
            positions[i * 3 + 1] = 0.1;                              // Y: just above water
            positions[i * 3 + 2] = side * spread * (0.5 + Math.random() * 0.5); // Z: V spread
            sizes[i] = 0.4 + t * 1.2;
            wakeParticles.push({
                baseX: positions[i * 3],
                baseZ: positions[i * 3 + 2],
                phase: Math.random() * Math.PI * 2
            });
        }

        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

        var mat = new THREE.PointsMaterial({
            map: tex,
            color: 0xffffff,
            size: 1.5,
            transparent: true,
            opacity: 0.3,
            depthWrite: false,
            sizeAttenuation: true
        });
        wakePoints = new THREE.Points(geo, mat);
        scene.add(wakePoints);
    }

    function animateWake(elapsed) {
        if (!wakePoints) return;
        var pos = wakePoints.geometry.attributes.position;
        for (var i = 0; i < WAKE_COUNT; i++) {
            var p = wakeParticles[i];
            var t = i / WAKE_COUNT;
            // Gentle drift and bob
            pos.array[i * 3] = p.baseX + Math.sin(elapsed * 0.5 + p.phase) * 0.3;
            pos.array[i * 3 + 1] = 0.1 + Math.sin(elapsed * 1.5 + p.phase) * 0.05;
            pos.array[i * 3 + 2] = p.baseZ + Math.sin(elapsed * 0.8 + p.phase) * 0.2;
        }
        pos.needsUpdate = true;
        // Fade opacity with wave conditions
        wakePoints.material.opacity = 0.15 + 0.1 * Math.sin(elapsed * 0.6);
    }

    // ── buildSeagulls() — animated bird sprites circling the ship ──
    var seagulls = [];
    function buildSeagulls() {
        var THREE = window.THREE;
        var tod = getTimeOfDay();
        if (tod === 'night') return; // no birds at night

        var count = 4;

        // Procedural bird texture
        var canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, 64, 64);
        ctx.strokeStyle = '#555555';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(8, 36);
        ctx.quadraticCurveTo(20, 16, 32, 30);
        ctx.quadraticCurveTo(44, 16, 56, 36);
        ctx.stroke();
        // Body dot
        ctx.fillStyle = '#666666';
        ctx.beginPath();
        ctx.arc(32, 30, 2.5, 0, Math.PI * 2);
        ctx.fill();

        var tex = new THREE.CanvasTexture(canvas);

        for (var i = 0; i < count; i++) {
            var mat = new THREE.SpriteMaterial({
                map: tex,
                transparent: true,
                opacity: 1.0,
                depthWrite: false
            });
            var sprite = new THREE.Sprite(mat);
            sprite.scale.set(4, 2, 1);

            var birdData = {
                sprite: sprite,
                angle: (i / count) * Math.PI * 2,
                radius: 12 + Math.random() * 10,
                height: 15 + Math.random() * 12,
                speed: 0.3 + Math.random() * 0.3,
                vertSpeed: 1.5 + Math.random() * 1.0
            };
            seagulls.push(birdData);
            scene.add(sprite);
        }
    }

    function animateSeagulls(elapsed) {
        for (var i = 0; i < seagulls.length; i++) {
            var b = seagulls[i];
            var a = b.angle + elapsed * b.speed;
            b.sprite.position.set(
                b.radius * Math.cos(a),
                b.height + 2 * Math.sin(elapsed * b.vertSpeed + i),
                b.radius * Math.sin(a)
            );
            // Wing flap — scale oscillation
            var flap = 1 + 0.3 * Math.sin(elapsed * 8 + i * 2);
            b.sprite.scale.set(3 * flap, 1.5, 1);
        }
    }

    // ── Wake trail — persistent foam path showing where ship has been ──
    var wakeTrail = null;
    var WAKE_TRAIL_MAX = 600;       // max trail points
    var wakeTrailData = [];         // { x, z, age }
    var wakeTrailTimer = 0;
    var WAKE_TRAIL_INTERVAL = 0.04; // seconds between drops — denser for smooth trail
    var WAKE_TRAIL_LIFETIME = 30;   // seconds before fade out

    function buildWakeTrail() {
        var THREE = window.THREE;

        // Procedural foam splash texture — irregular, organic blobs (64px for detail)
        var canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        var ctx = canvas.getContext('2d');
        // Soft radial base
        var grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, 'rgba(255,255,255,0.95)');
        grad.addColorStop(0.25, 'rgba(230,240,255,0.7)');
        grad.addColorStop(0.5, 'rgba(200,225,245,0.35)');
        grad.addColorStop(0.8, 'rgba(180,210,235,0.1)');
        grad.addColorStop(1, 'rgba(180,210,235,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 64, 64);
        // Overlay irregular foam blobs for organic look
        for (var fb = 0; fb < 8; fb++) {
            var angle = fb * Math.PI * 2 / 8 + 0.3;
            var dist = 6 + (fb % 3) * 5;
            var bx = 32 + Math.cos(angle) * dist;
            var by = 32 + Math.sin(angle) * dist;
            var br = 4 + (fb % 4) * 2.5;
            var bg = ctx.createRadialGradient(bx, by, 0, bx, by, br);
            bg.addColorStop(0, 'rgba(255,255,255,0.6)');
            bg.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = bg;
            ctx.beginPath();
            ctx.arc(bx, by, br, 0, Math.PI * 2);
            ctx.fill();
        }
        var tex = new THREE.CanvasTexture(canvas);

        var positions = new Float32Array(WAKE_TRAIL_MAX * 3);
        var alphas = new Float32Array(WAKE_TRAIL_MAX);
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

        // Custom shader: per-point alpha
        var mat = new THREE.ShaderMaterial({
            uniforms: {
                uTexture: { value: tex },
                uSize: { value: 50.0 * window.devicePixelRatio }
            },
            vertexShader: [
                'attribute float alpha;',
                'varying float vAlpha;',
                'uniform float uSize;',
                'void main() {',
                '  vAlpha = alpha;',
                '  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);',
                '  gl_PointSize = uSize / -mvPos.z;',
                '  gl_Position = projectionMatrix * mvPos;',
                '}'
            ].join('\n'),
            fragmentShader: [
                'uniform sampler2D uTexture;',
                'varying float vAlpha;',
                'void main() {',
                '  vec4 tex = texture2D(uTexture, gl_PointCoord);',
                '  gl_FragColor = vec4(tex.rgb, tex.a * vAlpha);',
                '}'
            ].join('\n'),
            transparent: true,
            depthWrite: false
        });

        wakeTrail = new THREE.Points(geo, mat);
        scene.add(wakeTrail);
    }

    function animateWakeTrail(dt, shipX, shipZ, headingRad, rudderAngle) {
        if (!wakeTrail) return;

        wakeTrailTimer += dt;
        var isTurning = turnScenarioActive && typeof rudderAngle === 'number' && Math.abs(rudderAngle) > 1;
        var turnIntensity = isTurning ? Math.min(Math.abs(rudderAngle) / 25, 1) : 0;
        var turnOuter = rudderAngle > 0 ? -1 : 1;
        var turnInner = -turnOuter;

        // Drop interval: denser during turns for thick foam trail
        var dropInterval = isTurning
            ? WAKE_TRAIL_INTERVAL * (1 - turnIntensity * 0.5)
            : WAKE_TRAIL_INTERVAL;

        if (wakeTrailTimer >= dropInterval) {
            wakeTrailTimer = 0;

            var fwdX = Math.cos(headingRad);
            var fwdZ = -Math.sin(headingRad);
            var sideX = Math.sin(headingRad);
            var sideZ = Math.cos(headingRad);
            var baseSpread = 1.5;
            var turnSpread = isTurning ? turnIntensity * 3.0 : 0;

            // — Central stern foam strip (multiple particles across width) —
            var stripCount = 3 + (isTurning ? Math.floor(turnIntensity * 4) : 0);
            for (var sc = 0; sc < stripCount; sc++) {
                var stripT = (sc / (stripCount - 1)) * 2 - 1; // -1..+1
                var sternDist = 7 + Math.random() * 2;
                var lateralSpread = baseSpread * 0.8;
                var px = shipX - fwdX * sternDist + sideX * stripT * lateralSpread + (Math.random() - 0.5) * 0.6;
                var pz = shipZ - fwdZ * sternDist + sideZ * stripT * lateralSpread + (Math.random() - 0.5) * 0.6;
                wakeTrailData.push({
                    x: px, z: pz, age: 0,
                    // Each particle gets random size for organic variety
                    sz: 0.6 + Math.random() * 0.8,
                    // Slight drift velocity — foam disperses outward
                    vx: sideX * stripT * 0.15 + (Math.random() - 0.5) * 0.1,
                    vz: sideZ * stripT * 0.15 + (Math.random() - 0.5) * 0.1,
                    bright: 0
                });
            }

            // — V-wake arms: two lines spreading from stern —
            for (var side = -1; side <= 1; side += 2) {
                var isOuter = (side === turnOuter);
                var spread = baseSpread + (isOuter ? turnSpread * 0.7 : turnSpread * 0.4);
                for (var vi = 0; vi < 2; vi++) {
                    var vDist = 8 + vi * 2 + Math.random() * 1.5;
                    var vSpread = spread * (0.8 + Math.random() * 0.4);
                    var vx = shipX - fwdX * vDist + sideX * side * vSpread + (Math.random() - 0.5) * 0.5;
                    var vz = shipZ - fwdZ * vDist + sideZ * side * vSpread + (Math.random() - 0.5) * 0.5;
                    wakeTrailData.push({
                        x: vx, z: vz, age: 0,
                        sz: 0.5 + Math.random() * 1.0,
                        vx: sideX * side * (0.2 + Math.random() * 0.15),
                        vz: sideZ * side * (0.2 + Math.random() * 0.15),
                        bright: isTurning ? 1 : 0
                    });
                }
            }

            // — Extra turn foam: dense spray on outer + inner hull —
            if (isTurning && turnIntensity > 0.2) {
                var extraCount = Math.floor(turnIntensity * 6);
                for (var e = 0; e < extraCount; e++) {
                    var eSide = (e % 2 === 0) ? turnOuter : turnInner;
                    var eDist = 2 + Math.random() * 7;
                    var eSpread = baseSpread + turnSpread * (0.3 + Math.random() * 0.7);
                    var ex = shipX - fwdX * eDist + sideX * eSide * eSpread + (Math.random() - 0.5) * 1.2;
                    var ez = shipZ - fwdZ * eDist + sideZ * eSide * eSpread + (Math.random() - 0.5) * 1.2;
                    wakeTrailData.push({
                        x: ex, z: ez, age: 0,
                        sz: 0.4 + Math.random() * 1.2,
                        vx: sideX * eSide * (0.3 + Math.random() * 0.3),
                        vz: sideZ * eSide * (0.3 + Math.random() * 0.3),
                        bright: 1
                    });
                }
            }

            while (wakeTrailData.length > WAKE_TRAIL_MAX) {
                wakeTrailData.shift();
            }
        }

        // Update geometry — age particles, apply drift, fade
        var pos = wakeTrail.geometry.attributes.position;
        var alp = wakeTrail.geometry.attributes.alpha;

        for (var i = 0; i < WAKE_TRAIL_MAX; i++) {
            if (i < wakeTrailData.length) {
                var p = wakeTrailData[i];
                p.age += dt;

                // Foam drifts outward + slows down over time
                var driftDecay = Math.max(0, 1 - p.age * 0.3);
                p.x += p.vx * dt * driftDecay;
                p.z += p.vz * dt * driftDecay;

                pos.array[i * 3] = p.x;
                pos.array[i * 3 + 1] = 0.08;
                pos.array[i * 3 + 2] = p.z;

                // Alpha: quick appear, slow fade, cubic falloff
                var life = Math.min(p.age / WAKE_TRAIL_LIFETIME, 1);
                var fadeIn = Math.min(p.age * 8, 1);
                var fadeOut = (1 - life);
                var baseAlpha = fadeIn * fadeOut * fadeOut * 0.55;
                alp.array[i] = p.bright ? baseAlpha * (1 + turnIntensity * 0.6) : baseAlpha;
            } else {
                pos.array[i * 3 + 1] = -10;
                alp.array[i] = 0;
            }
        }

        pos.needsUpdate = true;
        alp.needsUpdate = true;
        wakeTrail.geometry.setDrawRange(0, wakeTrailData.length);

        while (wakeTrailData.length > 0 && wakeTrailData[0].age > WAKE_TRAIL_LIFETIME) {
            wakeTrailData.shift();
        }
    }

    // ── Sea markers — floating foam/debris patches that stream past the ship ──
    var seaMarkers = [];
    var SEA_MARKER_COUNT = 60;

    // ── Radar-style heading & turn indicator inside compass ──
    // ── Radar sweep — fan-shaped sector pointing in ship heading direction ──
    var radarSweep = null;
    var RADAR_HALF_ANGLE = Math.PI / 8; // 22.5° each side = 45° total fan

    function buildRadarIndicator() {
        var THREE = window.THREE;
        if (!compassGroup) return;

        // Fan sector mesh — rebuilt each frame to follow heading
        radarSweep = new THREE.Mesh(
            new THREE.BufferGeometry(),
            new THREE.MeshBasicMaterial({
                color: 0x22c55e, transparent: true, opacity: 0.55,
                side: THREE.DoubleSide, depthWrite: false
            })
        );
        radarSweep.position.y = 0.25;
        compassGroup.add(radarSweep);
    }

    function animateRadarIndicator(headingRad) {
        if (!radarSweep) return;
        var THREE = window.THREE;

        var radius = 13;
        var segments = 16;
        var centerAngle = headingRad + Math.PI / 2;
        var startAngle = centerAngle - RADAR_HALF_ANGLE;
        var endAngle = centerAngle + RADAR_HALF_ANGLE;

        // Fan geometry: center vertex + arc vertices
        var verts = [0, 0, 0];
        for (var i = 0; i <= segments; i++) {
            var t = i / segments;
            var a = startAngle + (endAngle - startAngle) * t;
            verts.push(Math.sin(a) * radius, 0, Math.cos(a) * radius);
        }
        var indices = [];
        for (var j = 1; j <= segments; j++) {
            indices.push(0, j, j + 1);
        }

        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geo.setIndex(indices);
        if (radarSweep.geometry) radarSweep.geometry.dispose();
        radarSweep.geometry = geo;
    }

    function buildSeaMarkers() {
        var THREE = window.THREE;

        // Procedural foam patch texture
        var canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, 32, 32);
        // Irregular foam blobs
        for (var b = 0; b < 5; b++) {
            var bx = 8 + Math.random() * 16;
            var by = 8 + Math.random() * 16;
            var br = 3 + Math.random() * 6;
            var grad = ctx.createRadialGradient(bx, by, 0, bx, by, br);
            grad.addColorStop(0, 'rgba(255,255,255,0.6)');
            grad.addColorStop(0.6, 'rgba(200,220,240,0.2)');
            grad.addColorStop(1, 'rgba(200,220,240,0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(bx, by, br, 0, Math.PI * 2);
            ctx.fill();
        }
        var tex = new THREE.CanvasTexture(canvas);

        for (var i = 0; i < SEA_MARKER_COUNT; i++) {
            var mat = new THREE.SpriteMaterial({
                map: tex,
                transparent: true,
                opacity: 0.15 + Math.random() * 0.2,
                depthWrite: false
            });
            var sprite = new THREE.Sprite(mat);
            var sz = 1.5 + Math.random() * 3;
            sprite.scale.set(sz, sz * 0.5, 1);
            sprite.rotation = Math.random() * Math.PI * 2;

            // Scatter around ship's starting position
            var mx = (Math.random() - 0.3) * 120;
            var mz = (Math.random() - 0.5) * 100;
            sprite.position.set(mx, 0.05, mz);

            seaMarkers.push({
                sprite: sprite,
                x: mx,
                z: mz,
                bob: Math.random() * Math.PI * 2
            });
            scene.add(sprite);
        }
    }

    function animateSeaMarkers(dt, headingRad, flowRate) {
        // Markers are stationary in world. Respawn around ship's current position.
        var sx = shipWorldPos.x;
        var sz = shipWorldPos.z;

        for (var i = 0; i < seaMarkers.length; i++) {
            var m = seaMarkers[i];

            // Distance from ship
            var relX = m.x - sx;
            var relZ = m.z - sz;
            var dist = Math.sqrt(relX * relX + relZ * relZ);

            // Respawn if too far from ship
            if (dist > 80) {
                // Respawn ahead/around ship in world coords
                var fwdX = Math.cos(headingRad);
                var fwdZ = -Math.sin(headingRad);
                var aheadDist = 20 + Math.random() * 60;
                var sideDist = (Math.random() - 0.5) * 90;
                m.x = sx + fwdX * aheadDist - fwdZ * sideDist;
                m.z = sz + fwdZ * aheadDist + fwdX * sideDist;
            }

            m.sprite.position.x = m.x;
            m.sprite.position.z = m.z;
            m.sprite.position.y = 0.05 + Math.sin(performance.now() * 0.001 + m.bob) * 0.03;
        }
    }

    // ── Turning scenario ──
    function buildTurnScenarioUI(canvasWrap) {
        // Scenario play button
        turnBtnEl = document.createElement('button');
        turnBtnEl.className = 'rv-scenario-btn';
        turnBtnEl.innerHTML = '<i class="fa-solid fa-ship"></i> 선회 시나리오';
        turnBtnEl.title = '코너링 시 횡요각 변화 시뮬레이션';
        turnBtnEl.addEventListener('click', function () {
            toggleTurnScenario();
        });
        canvasWrap.appendChild(turnBtnEl);

        // HUD overlay
        turnHudEl = document.createElement('div');
        turnHudEl.className = 'rv-turn-hud';
        turnHudEl.style.display = 'none';
        turnHudEl.innerHTML =
            '<div class="rv-turn-hud-row">' +
            '<span class="rv-turn-hud-label">상태</span>' +
            '<span class="rv-turn-hud-value" id="rv-turn-phase">직진</span>' +
            '</div>' +
            '<div class="rv-turn-hud-row">' +
            '<span class="rv-turn-hud-label">침로</span>' +
            '<span class="rv-turn-hud-value" id="rv-turn-heading">000°</span>' +
            '</div>' +
            '<div class="rv-turn-hud-row">' +
            '<span class="rv-turn-hud-label">타각</span>' +
            '<span class="rv-turn-hud-value" id="rv-turn-rudder">0°</span>' +
            '</div>' +
            '<div class="rv-turn-hud-row">' +
            '<span class="rv-turn-hud-label">속력</span>' +
            '<span class="rv-turn-hud-value" id="rv-turn-speed">' + shipSpeed + ' kt</span>' +
            '</div>' +
            '<div class="rv-turn-progress">' +
            '<div class="rv-turn-progress-fill" id="rv-turn-progress-fill"></div>' +
            '</div>';
        canvasWrap.appendChild(turnHudEl);
    }

    function toggleTurnScenario() {
        turnScenarioActive = !turnScenarioActive;
        if (turnScenarioActive) {
            turnElapsed = 0;
            turnPhase = 'straight';
            turnHeading = 0;
            shipWorldPos = { x: 0, z: 0 };
            camFollow = { x: 0, z: 0 };
            turnDirection = (Math.random() > 0.5) ? 1 : -1;
            // controls stays enabled — user can zoom/pan slightly
            if (turnHudEl) turnHudEl.style.display = '';
            if (turnBtnEl) {
                turnBtnEl.innerHTML = '<i class="fa-solid fa-stop"></i> 시나리오 정지';
                turnBtnEl.classList.add('active');
            }
        } else {
            if (controls) {
                controls.target.set(shipWorldPos.x, 2, shipWorldPos.z);
                controls.enabled = true;
            }
            if (turnHudEl) turnHudEl.style.display = 'none';
            if (turnBtnEl) {
                turnBtnEl.innerHTML = '<i class="fa-solid fa-ship"></i> 선회 시나리오';
                turnBtnEl.classList.remove('active');
            }
            turnHeading = 0;
            camFollowHeading = 0;
        }
    }

    // Returns { headingDelta, rollMultiplier, rudderAngle, phaseName }
    function computeTurnState(dt) {
        if (!turnScenarioActive) return { headingDelta: 0, rollMultiplier: 1, rudderAngle: 0, phaseName: '직진' };

        turnElapsed += dt;
        var cycleTime = turnElapsed % TURN_TOTAL;

        var headingRate = 0;   // degrees per second
        var rollMult = 1;
        var rudder = 0;
        var phaseName = '직진';
        var maxTurnRate = 5;   // degrees per second at max turn

        if (cycleTime < TURN_TIMING.straight) {
            // Straight ahead
            turnPhase = 'straight';
            phaseName = '직진';
            headingRate = 0;
            rudder = 0;
            rollMult = 1;
        } else if (cycleTime < TURN_TIMING.straight + TURN_TIMING.entering) {
            // Entering turn — rudder increasing, roll building
            turnPhase = 'entering';
            phaseName = '선회 진입';
            var t = (cycleTime - TURN_TIMING.straight) / TURN_TIMING.entering;
            var ease = t * t; // ease-in
            headingRate = maxTurnRate * ease;
            rudder = 35 * ease;
            rollMult = 1 + (TURN_ROLL_MULT[shipType] - 1) * ease;
        } else if (cycleTime < TURN_TIMING.straight + TURN_TIMING.entering + TURN_TIMING.turning) {
            // Full turn — max roll
            turnPhase = 'turning';
            phaseName = '선회 중';
            headingRate = maxTurnRate;
            rudder = 35;
            rollMult = TURN_ROLL_MULT[shipType];
        } else {
            // Exiting turn — rudder decreasing, roll settling
            turnPhase = 'exiting';
            phaseName = '선회 탈출';
            var tExit = (cycleTime - TURN_TIMING.straight - TURN_TIMING.entering - TURN_TIMING.turning) / TURN_TIMING.exiting;
            var easeOut = 1 - tExit * tExit; // ease-out
            headingRate = maxTurnRate * easeOut;
            rudder = 35 * easeOut;
            rollMult = 1 + (TURN_ROLL_MULT[shipType] - 1) * easeOut;
        }

        // Alternate turn direction each cycle
        var cycleIndex = Math.floor(turnElapsed / TURN_TOTAL);
        var dir = (cycleIndex % 2 === 0) ? 1 : -1;

        turnHeading += headingRate * dir * dt;
        // Normalize heading 0-360
        turnHeading = ((turnHeading % 360) + 360) % 360;

        // Update HUD
        var phaseEl = document.getElementById('rv-turn-phase');
        var headingEl = document.getElementById('rv-turn-heading');
        var rudderEl = document.getElementById('rv-turn-rudder');
        var progressFill = document.getElementById('rv-turn-progress-fill');

        if (phaseEl) {
            phaseEl.textContent = phaseName;
            phaseEl.className = 'rv-turn-hud-value' + (turnPhase === 'turning' ? ' rv-turn-danger' : turnPhase !== 'straight' ? ' rv-turn-active' : '');
        }
        if (headingEl) headingEl.textContent = ('00' + Math.round(turnHeading)).slice(-3) + '°';
        if (rudderEl) rudderEl.textContent = (rudder > 0.5 ? (dir > 0 ? 'S' : 'P') + Math.round(rudder) + '°' : '0°');
        if (progressFill) progressFill.style.width = ((cycleTime / TURN_TOTAL) * 100) + '%';

        return {
            headingDelta: headingRate * dir * dt,
            rollMultiplier: rollMult,
            rudderAngle: rudder * dir,
            phaseName: phaseName
        };
    }

    // ── Turn splash particles — bow wave and side spray during turns ──
    var turnSplashPoints = null;
    var turnSplashData = [];
    var TURN_SPLASH_COUNT = 120;

    function buildTurnSplash() {
        var THREE = window.THREE;
        var geo = new THREE.BufferGeometry();
        var positions = new Float32Array(TURN_SPLASH_COUNT * 3);
        var alphas = new Float32Array(TURN_SPLASH_COUNT);
        var sizes = new Float32Array(TURN_SPLASH_COUNT);
        turnSplashData = [];
        for (var i = 0; i < TURN_SPLASH_COUNT; i++) {
            positions[i * 3] = 0;
            positions[i * 3 + 1] = -10; // hidden below water
            positions[i * 3 + 2] = 0;
            alphas[i] = 0;
            sizes[i] = 1;
            turnSplashData.push({ x: 0, y: -10, z: 0, vx: 0, vy: 0, vz: 0, life: 999, maxLife: 1, active: false });
        }
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
        geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

        var mat = new THREE.PointsMaterial({
            color: 0xddeeff,
            size: 1.2,
            transparent: true,
            opacity: 0.6,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            sizeAttenuation: true
        });
        turnSplashPoints = new THREE.Points(geo, mat);
        scene.add(turnSplashPoints);
    }

    function animateTurnSplash(dt, shipX, shipZ, headingRad, rudderAngle, isturning) {
        if (!turnSplashPoints) return;
        var pos = turnSplashPoints.geometry.attributes.position;
        var alp = turnSplashPoints.geometry.attributes.alpha;
        var siz = turnSplashPoints.geometry.attributes.size;

        var intensity = Math.min(Math.abs(rudderAngle) / 25, 1);
        var spawnRate = isturning ? 8 + intensity * 20 : 0;
        var spawnAccum = spawnRate * dt;

        // Ship directions
        var fwdX = Math.cos(headingRad);
        var fwdZ = -Math.sin(headingRad);
        var sideX = -fwdZ; // perpendicular
        var sideZ = fwdX;
        var turnSide = rudderAngle > 0 ? 1 : -1; // outer side of turn

        // Spawn new particles
        for (var si = 0; si < TURN_SPLASH_COUNT && spawnAccum > 0; si++) {
            var sd = turnSplashData[si];
            if (sd.active) continue;
            spawnAccum -= 1;

            var isBow = Math.random() < 0.4;
            if (isBow) {
                // Bow splash — forward of ship
                var bx = shipX + fwdX * (8 + Math.random() * 3) + sideX * (Math.random() - 0.5) * 4;
                var bz = shipZ + fwdZ * (8 + Math.random() * 3) + sideZ * (Math.random() - 0.5) * 4;
                sd.x = bx; sd.y = 0.2; sd.z = bz;
                sd.vx = fwdX * (2 + Math.random() * 3) + (Math.random() - 0.5) * 1.5;
                sd.vy = 1.5 + Math.random() * 3;
                sd.vz = fwdZ * (2 + Math.random() * 3) + (Math.random() - 0.5) * 1.5;
            } else {
                // Side splash — outer side of turn, along hull
                var along = -2 + Math.random() * 10;
                var sx = shipX + fwdX * along + sideX * turnSide * (3 + Math.random() * 2);
                var sz = shipZ + fwdZ * along + sideZ * turnSide * (3 + Math.random() * 2);
                sd.x = sx; sd.y = 0.1; sd.z = sz;
                sd.vx = sideX * turnSide * (1.5 + Math.random() * 3 * intensity);
                sd.vy = 0.8 + Math.random() * 2.5 * intensity;
                sd.vz = sideZ * turnSide * (1.5 + Math.random() * 3 * intensity);
            }
            sd.life = 0;
            sd.maxLife = 0.8 + Math.random() * 1.2;
            sd.active = true;
        }

        // Update particles
        for (var i = 0; i < TURN_SPLASH_COUNT; i++) {
            var p = turnSplashData[i];
            if (!p.active) {
                alp.setX(i, 0);
                continue;
            }
            p.life += dt;
            if (p.life >= p.maxLife) {
                p.active = false;
                pos.setXYZ(i, 0, -10, 0);
                alp.setX(i, 0);
                continue;
            }
            // Gravity
            p.vy -= 6.0 * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.z += p.vz * dt;
            // Water surface collision
            if (p.y < 0) {
                p.y = 0;
                p.vy *= -0.2;
                p.vx *= 0.7;
                p.vz *= 0.7;
            }
            pos.setXYZ(i, p.x, p.y, p.z);
            var t = p.life / p.maxLife;
            alp.setX(i, (1 - t) * 0.7 * intensity);
            siz.setX(i, 0.5 + t * 1.5);
        }

        pos.needsUpdate = true;
        alp.needsUpdate = true;
        siz.needsUpdate = true;
        turnSplashPoints.material.opacity = 0.4 + intensity * 0.4;
    }

    // (bow wave removed — looked too artificial)

    // ── Cloud group for animation ──
    var cloudGroup = null;

    // ── Ship model helpers ──
    var shipEnvMap = null;

    // ── GLTF model loader with fallback ──
    function loadGltfModel(type, callback) {
        var THREE = window.THREE;
        if (!THREE.GLTFLoader) {
            callback(null);
            return;
        }
        if (gltfModelCache[type]) {
            callback(gltfModelCache[type].clone());
            return;
        }

        if (!gltfLoader) {
            gltfLoader = new THREE.GLTFLoader();
        }

        var url = 'models/ships/' + type + '.glb';
        gltfLoader.load(
            url,
            function (gltf) {
                var model = gltf.scene;

                // Normalize scale — target hull length ~20 units
                var box = new THREE.Box3().setFromObject(model);
                var size = new THREE.Vector3();
                box.getSize(size);
                var maxDim = Math.max(size.x, size.y, size.z);
                var targetSize = 20;
                var scale = targetSize / maxDim;
                model.scale.setScalar(scale);

                // Center model at origin
                box.setFromObject(model);
                var center = new THREE.Vector3();
                box.getCenter(center);
                model.position.sub(center);
                model.position.y = 0;

                // Enable shadows and apply envMap
                model.traverse(function (child) {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                        if (child.material && shipEnvMap) {
                            child.material.envMap = shipEnvMap;
                            child.material.envMapIntensity = 0.4;
                            child.material.needsUpdate = true;
                        }
                    }
                });

                gltfModelCache[type] = model;
                callback(model.clone());
            },
            undefined,
            function (err) {
                console.warn('GLTF load failed for ' + type + ':', err);
                callback(null);
            }
        );
    }

    function buildShipEnvMap() {
        var THREE = window.THREE;
        // Simple gradient cubemap for subtle reflections
        var size = 64;
        var faces = [];
        for (var f = 0; f < 6; f++) {
            var canvas = document.createElement('canvas');
            canvas.width = size; canvas.height = size;
            var ctx = canvas.getContext('2d');
            var grad = ctx.createLinearGradient(0, 0, 0, size);
            grad.addColorStop(0, '#4a6fa5');
            grad.addColorStop(0.5, '#1a2a3a');
            grad.addColorStop(1, '#0a1520');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, size, size);
            faces.push(canvas);
        }
        var cubeTexture = new THREE.CubeTexture(faces);
        cubeTexture.needsUpdate = true;
        shipEnvMap = cubeTexture;
    }

    function shipMat(color, opts) {
        var THREE = window.THREE;
        var params = {
            color: new THREE.Color(color),
            roughness: (opts && opts.roughness !== undefined) ? opts.roughness : 0.55,
            metalness: (opts && opts.metalness !== undefined) ? opts.metalness : 0.35
        };
        if (shipEnvMap) {
            params.envMap = shipEnvMap;
            params.envMapIntensity = (opts && opts.envMapIntensity !== undefined) ? opts.envMapIntensity : 0.4;
        }
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

    // Waterline stripe — red band at hull waterline
    function addWaterline(THREE, hullLength, hullWidth, yPos) {
        var stripeGeo = new THREE.BoxGeometry(hullLength * 0.85, 0.15, hullWidth + 0.05);
        var stripe = new THREE.Mesh(stripeGeo, shipMat('#991b1b', { roughness: 0.8, metalness: 0.1, envMapIntensity: 0.1 }));
        stripe.position.set(0, yPos, 0);
        addToShip(stripe);
    }

    // ── buildCompass() — wave direction arrow + compass ring (grouped) ──
    var compassGroup = null;

    function buildCompass() {
        var THREE = window.THREE;
        var dirRad = (weather.waveDirection || 0) * Math.PI / 180;

        compassGroup = new THREE.Group();

        // Compass ring on water surface
        var ringGeo = new THREE.RingGeometry(14, 14.3, 64);
        ringGeo.rotateX(-Math.PI / 2);
        var ringMat = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.3, side: THREE.DoubleSide
        });
        var compassRing = new THREE.Mesh(ringGeo, ringMat);
        compassRing.position.y = 0.2;
        compassGroup.add(compassRing);

        // Cardinal direction labels (N, E, S, W)
        var cardinals = [
            { label: 'N', angle: 0, color: '#ef4444' },
            { label: 'E', angle: Math.PI / 2, color: '#ffffff' },
            { label: 'S', angle: Math.PI, color: '#ffffff' },
            { label: 'W', angle: -Math.PI / 2, color: '#ffffff' }
        ];
        cardinals.forEach(function (c) {
            var cv = document.createElement('canvas');
            cv.width = 64; cv.height = 64;
            var cx = cv.getContext('2d');
            cx.fillStyle = c.color;
            cx.font = 'bold 48px monospace';
            cx.textAlign = 'center';
            cx.textBaseline = 'middle';
            cx.fillText(c.label, 32, 32);
            var tex = new THREE.CanvasTexture(cv);
            var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.85 }));
            sp.position.set(Math.sin(c.angle) * 15.5, 1.0, Math.cos(c.angle) * 15.5);
            sp.scale.set(2.5, 2.5, 1);
            compassGroup.add(sp);
        });

        // "WAVE" label only (arrow removed)
        var arrowDir = new THREE.Vector3(Math.sin(dirRad), 0, Math.cos(dirRad));
        var canvas = document.createElement('canvas');
        canvas.width = 128; canvas.height = 32;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('WAVE ' + Math.round(weather.waveDirection) + '°', 64, 22);
        var texture = new THREE.CanvasTexture(canvas);
        var sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.9 }));
        sprite.position.set(arrowDir.x * 14, 1.5, arrowDir.z * 14);
        sprite.scale.set(6, 1.5, 1);
        compassGroup.add(sprite);

        scene.add(compassGroup);
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
            positions[i * 3] = (Math.random() - 0.3) * 30;   // wide x spread
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

    // ── animateSpray(dt) — drift sea mist particles, amplified during turns ──
    function animateSpray(dt, headingRad, rudderAngle) {
        if (!sprayPoints) return;

        var pos = sprayPoints.geometry.attributes.position;
        var intensity = Math.min(weather.waveHeight / 3, 1) * 0.7 + 0.3;
        var isTurning = turnScenarioActive && typeof rudderAngle === 'number' && Math.abs(rudderAngle) > 1;
        var turnIntensity = isTurning ? Math.min(Math.abs(rudderAngle) / 25, 1) : 0;
        var turnOuter = (rudderAngle || 0) > 0 ? 1 : -1;

        // Side vector relative to heading
        var sideX = typeof headingRad === 'number' ? Math.sin(headingRad) : 0;
        var sideZ = typeof headingRad === 'number' ? Math.cos(headingRad) : 0;
        var fwdX = typeof headingRad === 'number' ? Math.cos(headingRad) : 1;
        var fwdZ = typeof headingRad === 'number' ? -Math.sin(headingRad) : 0;

        for (var i = 0; i < SPRAY_COUNT; i++) {
            var v = sprayVelocities[i];
            v.life += dt;

            if (v.life >= v.maxLife) {
                if (isTurning && Math.random() < 0.5 + turnIntensity * 0.4) {
                    // Respawn on turn inner side — more concentrated spray
                    var along = -2 + Math.random() * 14;
                    var spread = 3 + Math.random() * 4 * turnIntensity;
                    pos.setXYZ(i,
                        fwdX * along + sideX * turnOuter * spread,
                        Math.random() * 0.3,
                        fwdZ * along + sideZ * turnOuter * spread
                    );
                    v.vx = sideX * turnOuter * (0.3 + Math.random() * 0.8 * turnIntensity) + (Math.random() - 0.5) * 0.2;
                    v.vy = (0.1 + Math.random() * 0.4) * (1 + turnIntensity);
                    v.vz = sideZ * turnOuter * (0.3 + Math.random() * 0.8 * turnIntensity) + (Math.random() - 0.5) * 0.2;
                    v.maxLife = 1.5 + Math.random() * 2.5;
                } else {
                    // Normal respawn — scattered
                    pos.setXYZ(i,
                        (Math.random() - 0.3) * 30,
                        Math.random() * 0.5,
                        (Math.random() - 0.5) * 30
                    );
                    v.vx = (Math.random() - 0.5) * 0.3 * intensity;
                    v.vy = (0.05 + Math.random() * 0.15) * intensity;
                    v.vz = (Math.random() - 0.5) * 0.3 * intensity;
                    v.maxLife = 3 + Math.random() * 4;
                }
                v.life = 0;
                continue;
            }

            var x = pos.getX(i) + v.vx * dt;
            var y = pos.getY(i) + v.vy * dt;
            var z = pos.getZ(i) + v.vz * dt;

            if (y > 3.5 + turnIntensity * 2) {
                v.life = v.maxLife;
                y = 0;
            }

            pos.setXYZ(i, x, y, z);
        }

        sprayPoints.material.opacity = 0.08 + 0.07 * intensity + turnIntensity * 0.1;
        sprayPoints.material.size = 1.5 + turnIntensity * 1.0;
        pos.needsUpdate = true;
    }

    // ── buildWater() — Three.js Water shader with reflection/refraction ──
    function buildWater() {
        var THREE = window.THREE;

        var waterGeometry = new THREE.PlaneGeometry(2000, 2000);

        var loader = new THREE.TextureLoader();
        waterNormals = loader.load(
            'https://raw.githubusercontent.com/mrdoob/three.js/r137/examples/textures/waternormals.jpg',
            function (texture) {
                texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
            }
        );

        var tod = getTimeOfDay();
        var pal = SKY_PALETTES[tod];
        waterMesh = new THREE.Water(waterGeometry, {
            textureWidth: 512,
            textureHeight: 512,
            waterNormals: waterNormals,
            sunDirection: new THREE.Vector3(0.7, 0.5, 0.3).normalize(),
            sunColor: pal.sunColor,
            waterColor: pal.waterColor,
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
    // ── buildCodeShip(type, color) — procedural geometry fallback ──
    function buildCodeShip(type, color) {
        var THREE = window.THREE;
        switch (type) {
            case 'tanker': buildTanker(THREE, color); break;
            case 'cargo': buildCargo(THREE, color); break;
            case 'passenger': buildPassenger(THREE, color); break;
            case 'fishing': buildFishing(THREE, color); break;
            case 'military': buildMilitary(THREE, color); break;
            case 'tug': buildTug(THREE, color); break;
            default: buildGenericShip(THREE, color); break;
        }

        // Waterline red stripe per ship type
        var wlMap = {
            tanker: [16, 4.2, 1.6], cargo: [14, 3.8, 1.6], passenger: [16, 4.5, 1.4],
            fishing: [8, 2.8, 1.4], military: [14, 3.2, 1.6], tug: [6, 3.2, 1.6], other: [10, 3.2, 1.5]
        };
        var wl = wlMap[type] || wlMap['other'];
        addWaterline(THREE, wl[0], wl[1], wl[2]);
    }

    // ── buildShip(type) — GLTF model with code-based fallback ──
    function buildShip(type) {
        var THREE = window.THREE;
        var color = (window.SHIP_COLORS && window.SHIP_COLORS[type]) || '#6b7280';

        if (!shipEnvMap) buildShipEnvMap();

        shipGroup = new THREE.Group();

        // Always build code model first (shown while GLTF loads)
        buildCodeShip(type, color);

        // Attempt GLTF load
        if (useGltfModels) {
            loadGltfModel(type, function (model) {
                if (model && shipGroup) {
                    // Remove code model children, keep lights
                    var toRemove = [];
                    shipGroup.children.forEach(function (child) {
                        if (child.isMesh) toRemove.push(child);
                    });
                    toRemove.forEach(function (child) {
                        shipGroup.remove(child);
                        if (child.geometry) child.geometry.dispose();
                        if (child.material) child.material.dispose();
                    });

                    // Add GLTF model
                    shipGroup.add(model);

                    // Re-enable shadows
                    shipGroup.traverse(function (child) {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                        }
                    });
                }
            });
        }

        // Rim light
        var rimLight = new THREE.DirectionalLight(0x88aacc, 0.6);
        rimLight.position.set(-15, 8, -10);
        shipGroup.add(rimLight);

        // Enable shadows on all ship meshes
        shipGroup.traverse(function (child) {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        shipGroup.position.y = -0.8;
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

        rows.forEach(function (row) {
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
    // ── Generic/Unknown: 소형 다목적 선박 — 둥근 선체, 중앙 캐빈, 작업 데크 ──
    function buildGenericShip(THREE, color) {
        // Short rounded hull
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-5, -1.6);
        hullShape.quadraticCurveTo(-5.5, 0, -5, 1.6);
        hullShape.quadraticCurveTo(2, 2.2, 6, 0);
        hullShape.quadraticCurveTo(2, -2.2, -5, -1.6);

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 2.5, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.2, bevelSegments: 3 });
        hullGeo.rotateX(-Math.PI / 2);
        addToShip(new THREE.Mesh(hullGeo, shipMat(color))).position.set(0, 1.2, -1.25);

        // Flat work deck
        var deckGeo = new THREE.BoxGeometry(10, 0.15, 3.2);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#52525b'))).position.set(0, 2.8, 0);

        // Center cabin (box + slanted roof)
        var cabinGeo = new THREE.BoxGeometry(3, 1.8, 2.4);
        addToShip(new THREE.Mesh(cabinGeo, shipMat('#e8e8e8'))).position.set(0, 3.9, 0);

        // Slanted roof
        var roofGeo = new THREE.BoxGeometry(3.4, 0.15, 2.8);
        addToShip(new THREE.Mesh(roofGeo, shipMat('#71717a'))).position.set(0, 4.9, 0);

        // Windows — wrap-around
        var winFrontGeo = new THREE.BoxGeometry(0.08, 0.5, 2.0);
        addToShip(new THREE.Mesh(winFrontGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(1.5, 4.0, 0);
        var winSide1 = new THREE.BoxGeometry(2.0, 0.5, 0.08);
        addToShip(new THREE.Mesh(winSide1, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(0, 4.0, 1.2);
        addToShip(new THREE.Mesh(winSide1.clone(), shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(0, 4.0, -1.2);

        // Short antenna on roof
        var antGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.8, 4);
        addToShip(new THREE.Mesh(antGeo, shipMat('#a1a1aa'))).position.set(-0.5, 5.4, 0);

        // Forward bollards
        for (var fb = 0; fb < 2; fb++) {
            var bollGeo = new THREE.CylinderGeometry(0.12, 0.15, 0.4, 8);
            addToShip(new THREE.Mesh(bollGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(4 - fb * 1.5, 3.1, 0);
        }

        // Stern railing posts
        for (var rp = -1; rp <= 1; rp++) {
            var railGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.2, 4);
            addToShip(new THREE.Mesh(railGeo, shipMat('#a1a1aa'))).position.set(-4.5, 3.5, rp * 1.0);
        }
        // Railing bar
        var barGeo = new THREE.CylinderGeometry(0.025, 0.025, 2.2, 4);
        barGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(barGeo, shipMat('#a1a1aa'))).position.set(-4.5, 4.1, 0);
    }

    // ── startAnimation() ──
    var lastFrameTime = 0;

    function startAnimation() {
        clockStart = performance.now();
        lastFrameTime = clockStart;
        cameraAnimating = true;
        cameraAnimStart = 0;
        camera.position.set(CAM_START.x, CAM_START.y, CAM_START.z);
        camera.lookAt(0, 2, 0);
        if (controls) controls.enabled = false;

        function loop() {
            animFrameId = requestAnimationFrame(loop);

            var now = performance.now();
            var dt = Math.min((now - lastFrameTime) / 1000, 0.1); // cap at 100ms
            lastFrameTime = now;
            var elapsed = (now - clockStart) / 1000;

            animateCamera(elapsed);
            // ── Cloud animation: slow drift + gentle bobbing ──
            if (cloudGroup) {
                cloudGroup.rotation.y = elapsed * 0.008;
                for (var ci = 0; ci < _cloudSprites.length; ci++) {
                    var cs = _cloudSprites[ci];
                    // Gentle vertical bob
                    cs.sprite.position.y = cs.baseY + Math.sin(elapsed * cs.bobFreq * Math.PI * 2 + ci) * cs.bobAmp;
                    // Subtle opacity breathing
                    cs.mat.opacity = cs.baseOpacity + Math.sin(elapsed * 0.15 + ci * 1.5) * 0.05;
                }
            }

            // ── Turn scenario computation ──
            var turnState = computeTurnState(dt);

            // ── Ship heading & speed ──
            var headingRad = turnScenarioActive ? (turnHeading * Math.PI / 180) : 0;
            var targetSpeed = shipSpeed;
            if (turnScenarioActive && turnPhase === 'turning') {
                targetSpeed = shipSpeed * 0.7;
            } else if (turnScenarioActive && (turnPhase === 'entering' || turnPhase === 'exiting')) {
                targetSpeed = shipSpeed * 0.85;
            }
            // Smooth speed transitions — no sudden jumps between phases
            var speedLerp = 1 - Math.pow(0.05, dt);
            smoothSpeed += (targetSpeed - smoothSpeed) * speedLerp;

            // ── Move ship forward in world space ──
            var moveRate = smoothSpeed * 0.8; // scene units/sec
            shipWorldPos.x += Math.cos(headingRad) * moveRate * dt;
            shipWorldPos.z -= Math.sin(headingRad) * moveRate * dt;

            // ── Environment follows ship — sky, water, clouds move with ship ──
            if (skyGroup) {
                skyGroup.position.x = shipWorldPos.x;
                skyGroup.position.z = shipWorldPos.z;
            }
            if (waterMesh) {
                waterMesh.position.x = shipWorldPos.x;
                waterMesh.position.z = shipWorldPos.z;
            }
            if (cloudGroup) {
                cloudGroup.position.x = shipWorldPos.x;
                cloudGroup.position.z = shipWorldPos.z;
            }
            // ── Animate sea markers (stationary in world, ship passes them) ──
            animateSeaMarkers(dt, headingRad, 0);

            animateWater(elapsed);
            // (old static wake removed — wakeTrail handles this now)
            // (wakeTrail removed — water reflections provide sufficient visual cue)

            // Update HUD speed display
            var speedEl = document.getElementById('rv-turn-speed');
            if (speedEl) speedEl.textContent = smoothSpeed.toFixed(1) + ' kt';

            // Roll & Pitch calculation — scaled by wave height (2m baseline)
            var waveScale = Math.max(weather.waveHeight / 2.0, 0.3);
            var freqScale = weather.wavePeriod ? (8 / weather.wavePeriod) : 1;

            // Base wave-induced roll — primary swell + secondary + tertiary harmonics
            // (no Math.random — deterministic harmonics prevent per-frame jitter)
            var w1 = elapsed * rollParams.freq * Math.PI * 2 * freqScale;
            var primaryRoll = rollParams.amp * waveScale * Math.sin(w1);
            var secondaryRoll = rollParams.amp * 0.3 * waveScale * Math.sin(w1 * 1.7 + 1.2);
            var tertiaryRoll = rollParams.amp * 0.12 * waveScale * Math.sin(w1 * 3.1 + 2.7);
            var waveRoll = primaryRoll + secondaryRoll + tertiaryRoll;

            // Turn-induced heel: steady inward lean during turn
            var turnHeel = 0;
            if (turnScenarioActive && turnState.rudderAngle !== 0) {
                turnHeel = -turnState.rudderAngle * 0.22;
            }

            // Combined roll — cap to realistic max ~18°
            var rawRoll = waveRoll * turnState.rollMultiplier + turnHeel;
            if (rawRoll > 18) rawRoll = 18;
            if (rawRoll < -18) rawRoll = -18;

            // Pitch: longer period, smaller amplitude, deterministic noise
            var pitchScale = turnScenarioActive ? Math.min(waveScale, 0.6) : waveScale;
            var rawPitch = (rollParams.amp * 0.12) * pitchScale * Math.sin(w1 * 0.6)
                + rollParams.amp * 0.04 * pitchScale * Math.sin(w1 * 1.3 + 0.8);

            // Smooth roll & pitch — exponential lerp removes any remaining jitter
            var motionLerp = 1 - Math.pow(0.015, dt);  // ~τ=0.24s, smooth but responsive
            smoothRoll += (rawRoll - smoothRoll) * motionLerp;
            smoothPitch += (rawPitch - smoothPitch) * motionLerp;

            // ── Apply ship world position + rotations ──
            if (shipGroup) {
                shipGroup.position.x = shipWorldPos.x;
                shipGroup.position.z = shipWorldPos.z;
                shipGroup.position.y = -0.8 + weather.waveHeight * 0.1 * Math.sin(elapsed * 0.8);
                shipGroup.rotation.y = headingRad;
                shipGroup.rotation.x = smoothRoll * (Math.PI / 180);
                shipGroup.rotation.z = smoothPitch * (Math.PI / 180);
            }

            // ── Compass follows ship ──
            if (compassGroup) {
                compassGroup.position.x = shipWorldPos.x;
                compassGroup.position.z = shipWorldPos.z;
            }

            // ── Shadow light follows ship ──
            if (mainDirLight) {
                mainDirLight.position.set(shipWorldPos.x + 30, 40, shipWorldPos.z + 20);
                mainDirLight.target.position.set(shipWorldPos.x, 0, shipWorldPos.z);
                mainDirLight.target.updateMatrixWorld();
            }

            // ── Radar heading & turn indicator ──
            animateRadarIndicator(headingRad);

            // ── Seagulls follow ship ──
            for (var si = 0; si < seagulls.length; si++) {
                var b = seagulls[si];
                var a = b.angle + elapsed * b.speed;
                b.sprite.position.set(
                    shipWorldPos.x + b.radius * Math.cos(a),
                    b.height + 2 * Math.sin(elapsed * b.vertSpeed + si),
                    shipWorldPos.z + b.radius * Math.sin(a)
                );
                var flap = 1 + 0.3 * Math.sin(elapsed * 8 + si * 2);
                b.sprite.scale.set(3 * flap, 1.5, 1);
            }

            // ── Camera follows ship: position + orbit behind heading ──
            if (!cameraAnimating && controls) {
                var lerpFactor = 1 - Math.pow(0.02, dt);
                camFollow.x += (shipWorldPos.x - camFollow.x) * lerpFactor;
                camFollow.z += (shipWorldPos.z - camFollow.z) * lerpFactor;

                var dx = camFollow.x - controls.target.x;
                var dz = camFollow.z - controls.target.z;
                controls.target.x += dx;
                controls.target.z += dz;
                camera.position.x += dx;
                camera.position.z += dz;

                // Orbit camera around target to stay behind ship
                if (turnScenarioActive) {
                    var headingLerp = 1 - Math.pow(0.05, dt);
                    var dHeading = headingRad - camFollowHeading;
                    if (dHeading > Math.PI) dHeading -= 2 * Math.PI;
                    if (dHeading < -Math.PI) dHeading += 2 * Math.PI;
                    var rotAmount = dHeading * headingLerp;
                    camFollowHeading += rotAmount;

                    var cx = camera.position.x - controls.target.x;
                    var cz = camera.position.z - controls.target.z;
                    var cosR = Math.cos(-rotAmount);
                    var sinR = Math.sin(-rotAmount);
                    camera.position.x = controls.target.x + (cx * cosR - cz * sinR);
                    camera.position.z = controls.target.z + (cx * sinR + cz * cosR);
                }
            }

            var absRoll = Math.abs(smoothRoll);
            var absPitch = Math.abs(smoothPitch);
            updateGauge(absRoll, smoothRoll);
            updatePitchGauge(absPitch, smoothPitch);

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

        // Use the capped shipSpeed instead of raw SOG (AIS can have errors like 102kt)
        var sogVal = sogSignalLost
            ? shipSpeed.toFixed(1) + ' kt (신호없음, 기본값)'
            : shipSpeed.toFixed(1) + ' kt';
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
        var gauge = document.getElementById('rv-gauge');
        var fill = document.getElementById('rv-gauge-fill');
        var valueEl = document.getElementById('rv-gauge-value');
        var horizon = document.getElementById('rv-roll-horizon');

        if (!gauge || !fill || !valueEl) return;

        var pct = Math.min(absRoll / 30 * 100, 100);
        fill.style.width = pct + '%';
        valueEl.textContent = absRoll.toFixed(1) + '°';

        // Rotate tilt indicator horizon line
        if (horizon) {
            horizon.style.transform = 'rotate(' + (signedRoll || 0) + 'deg)';
        }

        var level;
        if (absRoll < 5) level = 'safe';
        else if (absRoll < 10) level = 'caution';
        else if (absRoll < 15) level = 'warning';
        else level = 'danger';

        gauge.className = 'roll-gauge roll-gauge-' + level;

        // Color the tilt ring border too
        var tilt = document.getElementById('rv-roll-tilt');
        if (tilt) tilt.setAttribute('data-level', level);
    }

    // ── updatePitchGauge(absPitch, signedPitch) ──
    function updatePitchGauge(absPitch, signedPitch) {
        var gauge = document.getElementById('rv-pitch-gauge');
        var fill = document.getElementById('rv-pitch-fill');
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
        if (absPitch < 2) level = 'safe';
        else if (absPitch < 4) level = 'caution';
        else if (absPitch < 6) level = 'warning';
        else level = 'danger';

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
                    lineStyle: { color: '#38bdf8', width: 2 },
                    areaStyle: {
                        color: {
                            type: 'linear',
                            x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                                { offset: 0, color: 'rgba(56,189,248,0.25)' },
                                { offset: 1, color: 'rgba(56,189,248,0)' }
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
                    lineStyle: { color: '#38bdf8', width: 1.5, type: 'dashed' },
                    areaStyle: {
                        color: {
                            type: 'linear',
                            x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                                { offset: 0, color: 'rgba(56,189,248,0.12)' },
                                { offset: 1, color: 'rgba(56,189,248,0)' }
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
        chartInterval = setInterval(function () {
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
            scene.traverse(function (obj) {
                if (obj.geometry) {
                    obj.geometry.dispose();
                }
                if (obj.material) {
                    if (Array.isArray(obj.material)) {
                        obj.material.forEach(function (mat) { mat.dispose(); });
                    } else {
                        obj.material.dispose();
                    }
                }
            });
        }

        // Dispose composer
        if (composer) {
            if (typeof composer.dispose === 'function') composer.dispose();
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
        wakePoints = null;
        wakeParticles = [];
        wakeTrail = null;
        wakeTrailData = [];
        wakeTrailTimer = 0;
        sunMesh = null;
        skyGroup = null;
        compassGroup = null;
        cloudGroup = null;
        _cloudSprites = [];
        seagulls = [];
        seaMarkers = [];
        radarSweep = null;
        sprayPoints = null;
        sprayVelocities = [];
        gltfModelCache = {};
        gltfLoader = null;
        clockStart = null;
        lastFrameTime = 0;
        cameraAnimating = false;
        turnScenarioActive = false;
        turnPhase = 'straight';
        turnElapsed = 0;
        turnHeading = 0;
        turnHudEl = null;
        turnBtnEl = null;
        shipWorldPos = { x: 0, z: 0 };
        smoothSpeed = 12;
        smoothRoll = 0;
        smoothPitch = 0;
        camFollow = { x: 0, z: 0 };
        camFollowHeading = 0;
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
