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
    var shipGroupPred = null;              // 예측 선박 (실제 선박의 클론)
    var splitView = true;                  // 좌우 2분할 on/off
    var waterMesh = null;
    var gltfModelCache = {};   // { type: THREE.Group }
    var gltfLoader = null;
    var useGltfModels = false;  // disabled — only cargo.glb exists; code ships keep all types consistent
    var composer = null;
    var mainDirLight = null;
    var waterNormals = null;

    var animFrameId = null;
    var clockStart = null;

    var currentMmsi = null;
    // ── LLM scenario override ──
    var _baseWeather = null;       // observed weather snapshot (immutable after load)
    var _baseShipSpeed = null;     // observed shipSpeed snapshot (immutable after load)
    var _scenarioOverride = null;  // { windSpeed?, waveHeight?, wavePeriod?, waveDirection?, timeScale?, shipSpeed? } from LLM
    var _timeScale = 1.0;          // wave-time multiplier (1=realtime)
    var simWaveTime = 0;           // accumulated simulated wave time (separate from elapsed)
    var rollHistory = [];
    var pitchHistory = [];
    var rollChart = null;
    var chartInterval = null;

    var weather = null;
    var shipType = 'other';
    var rollParams = null;
    var naturalRollPeriod = null;  // beam/GM-derived ship roll period — drives resonance amplification
    var sogSignalLost = false;

    var sprayPoints = null;
    var sprayVelocities = [];
    var SPRAY_COUNT = 80;

    var cameraAnimating = false;
    var cameraAnimStart = 0;
    var CAMERA_ANIM_DURATION = 2.0; // seconds

    // ── Camera preset animation state ──
    var camPresetAnim = null;  // { from: {x,y,z}, to: {x,y,z}, start: elapsed, duration: 1.2 }

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
    var predRoll = 0;                       // 예측 roll (원시)
    var predPitch = 0;                      // 예측 pitch (원시)
    var smoothPredRoll = 0;                 // lerp-smoothed 예측 roll
    var smoothPredPitch = 0;               // lerp-smoothed 예측 pitch
    var predRollHistory = [];               // 예측 roll 이력 (실제와 동일 길이 유지)
    var predPitchHistory = [];

    // ── Capsize scenario state ──
    // Real capsized ships often end up *lying on their side* (rolled ~90°,
    // settled to ~100-110°) and float that way for a long time before sinking.
    // We don't go past ~110° because the ship model's origin is near the keel,
    // and rotating past 90° starts pushing the visible bulk underwater.
    // Stage timeline (seconds from trigger):
    //   0  ..3.5  rolling      0° → 90°    (quadratic ease-in past PoNR ~60°)
    //   3.5..6.5  settling     90° → 105°  (slumps a bit further, slight Y rise to expose hull side)
    //   >6.5     floating      105° + gentle wave bob — ship lies visibly on its side
    var _capsize = null;  // { startTime: number|null, direction: 1|-1, sinkY: number }

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

    var SHIP_TYPE_KO = {
        cargo: '화물선', tanker: '탱커', passenger: '여객선',
        fishing: '어선', military: '군함', tug: '예인선', other: '기타'
    };

    function _escHtml(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    // Rough distance (km) from the centre of Korean waters (equirectangular approx).
    var _KR_CENTER = { lat: 36.0, lon: 128.5 };
    function _distFromKoreaKm(lat, lon) {
        if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return 99999;
        var dLat = lat - _KR_CENTER.lat;
        var dLon = (lon - _KR_CENTER.lon) * Math.cos(_KR_CENTER.lat * Math.PI / 180);
        return Math.sqrt(dLat * dLat + dLon * dLon) * 111;
    }

    // Pick vessels for the empty-state quick picker, ranked by Korea-nearshore
    // proximity + vessel size (roll prediction matters most for large ships, and
    // the demo context is domestic). Each entry carries enough info (type / length
    // / speed / proximity) for the user to choose with a rationale.
    function _pickCandidateShips(limit) {
        limit = limit || 10;
        var map = window.shipDataMap || {};
        var keys = Object.keys(map);
        var scored = [];
        for (var i = 0; i < keys.length; i++) {
            var s = map[keys[i]];
            if (!s) continue;
            var mmsi = s.mmsi || keys[i];
            var len = parseFloat(s.length) || 0;
            var lat = parseFloat(s.lat), lon = parseFloat(s.lng);
            var dist = _distFromKoreaKm(lat, lon);
            var sog = parseFloat(s.sog);
            var typeKo = SHIP_TYPE_KO[getShipTypeKey(s)] || '기타';
            var hasName = s.name && s.name !== 'UNKNOWN';
            // Nearshore bonus (up to ~1500km) weighted with length.
            var score = Math.max(0, 1500 - dist) * 0.3 + len;
            scored.push({
                mmsi: mmsi,
                name: hasName ? _escHtml(s.name) : ('MMSI ' + mmsi),
                typeKo: typeKo,
                lenTxt: len ? Math.round(len) + 'm' : null,
                sogTxt: (!isNaN(sog) && sog > 0) ? sog.toFixed(1) + 'kn' : null,
                near: dist < 600,
                distTxt: dist < 99999 ? (dist < 1 ? '0km' : Math.round(dist) + 'km') : null,
                score: score
            });
        }
        scored.sort(function (a, b) { return b.score - a.score; });
        return scored.slice(0, limit);
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

        // Stop proximity tracking — modal & globe lines tied to the previously selected ship are
        // irrelevant in the roll viewer, and updateProximity() ticks would otherwise re-spawn the modal.
        if (typeof window.clearProximity === 'function') {
            window.clearProximity();
        } else if (typeof window.closeNearbyModal === 'function') {
            window.closeNearbyModal();
        }

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
            var ships = _pickCandidateShips(10);
            var listHtml = ships.length
                ? '<div class="roll-ship-picker">' + ships.map(function(s) {
                        var meta = [s.lenTxt, s.sogTxt, s.distTxt && ('한국 ' + s.distTxt)]
                            .filter(Boolean).join(' · ');
                        return '<button class="roll-ship-row" data-mmsi="' + s.mmsi + '">' +
                            '<i class="fa-solid fa-ship"></i>' +
                            '<div class="roll-ship-main">' +
                                '<div class="roll-ship-line1">' +
                                    '<span class="roll-ship-name">' + s.name + '</span>' +
                                    '<span class="roll-ship-type">' + s.typeKo + '</span>' +
                                    (s.near ? '<span class="roll-ship-near">근해</span>' : '') +
                                '</div>' +
                                (meta ? '<div class="roll-ship-line2">' + meta + '</div>' : '') +
                            '</div>' +
                        '</button>';
                    }).join('') + '</div>'
                : '<div class="screen-empty-sub" style="margin-top:10px;">추적 중인 선박이 없습니다.<br>지구본에서 선박을 선택해 주세요.</div>';
            placeholder.innerHTML =
                '<div class="screen-empty-card roll-empty-card">' +
                    '<i class="fa-solid fa-compass-drafting"></i>' +
                    '<div class="screen-empty-title">횡요각 예측</div>' +
                    '<div class="screen-empty-sub">지구본에서 선박을 클릭하거나,<br>아래에서 바로 선택하세요</div>' +
                    (ships.length ? '<div class="roll-picker-head">추적 중인 선박 · 한국 근해 우선</div>' : '') +
                    listHtml +
                '</div>';
            container.appendChild(placeholder);
            placeholder.addEventListener('click', function (e) {
                var row = e.target.closest('.roll-ship-row');
                if (row && row.dataset.mmsi) load(row.dataset.mmsi);
            });
            return;
        }

        var ship = window.shipDataMap[mmsi];
        shipType = getShipTypeKey(ship);
        rollParams = ROLL_PARAMS[shipType] || ROLL_PARAMS['other'];
        naturalRollPeriod = _estimateRollPeriod(ship, shipType);

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
        _baseWeather = findNearestWeather(ship.lat, ship.lon);
        _baseShipSpeed = shipSpeed;
        _scenarioOverride = null;
        _timeScale = 1.0;
        simWaveTime = 0;
        weather = Object.assign({}, _baseWeather);
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

        // 우측 슬라이드 드로우 (공유 입력: 선박/항해/기상/분석)
        var panel = buildInfoPanel(ship);
        var drawer = document.createElement('div');
        drawer.className = 'rv-drawer';
        drawer.id = 'rv-drawer';
        drawer.appendChild(panel);

        var drawerToggle = document.createElement('button');
        drawerToggle.className = 'rv-drawer-toggle';
        drawerToggle.id = 'rv-drawer-toggle';
        drawerToggle.innerHTML = '<i class="fa-solid fa-bars"></i>';
        drawerToggle.addEventListener('click', function () {
            drawer.classList.toggle('rv-drawer-open');
        });

        layout.appendChild(canvasWrap);
        layout.appendChild(drawer);
        layout.appendChild(drawerToggle);
        container.appendChild(layout);

        // Build turn scenario UI overlay on canvas
        buildTurnScenarioUI(canvasWrap);
        buildCanvasOverlays(canvasWrap);

        // Init Three.js
        initScene(canvasWrap);
        buildSky();
        // buildSun(); // disabled — too bright
        buildWater();
        buildCompass();
        buildShip(shipType);
        if (shipGroup) {
            shipGroupPred = shipGroup.clone(true);
            scene.add(shipGroupPred);
        }

        buildSeaMarkers();
        buildRadarIndicator();
        startAnimation();
        initRollChart();
        startChartUpdates();
    }

    function applyPanelViewOffset(w, h) {
        // 2분할 모드는 전체 캔버스를 쓰므로 패널 오프셋 불필요.
        // (드로우는 캔버스 위에 떠 있는 오버레이)
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
        applyPanelViewOffset(w, h);

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
        dirLight.shadow.mapSize.width = 512;
        dirLight.shadow.mapSize.height = 512;
        dirLight.shadow.camera.near = 1;
        dirLight.shadow.camera.far = 100;
        dirLight.shadow.camera.left = -25;
        dirLight.shadow.camera.right = 25;
        dirLight.shadow.camera.top = 25;
        dirLight.shadow.camera.bottom = -25;
        dirLight.shadow.bias = -0.002;
        scene.add(dirLight);

        var wxMod = getWeatherModifiers();
        dirLight.intensity *= wxMod.sunIntensity;

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
            applyPanelViewOffset(ww, hh);
            camera.updateProjectionMatrix();
            renderer.setSize(ww, hh);
            if (composer) composer.setSize(ww, hh);
        };
        window.addEventListener('resize', _resizeHandler);
        renderer._rollViewerResizeHandler = _resizeHandler;

        // ── Post-processing ──
        var renderPass = new THREE.RenderPass(scene, camera);
        var wxMod2 = getWeatherModifiers();
        var bloomStrength = wxMod2.bloomStrength;
        var bloomPass = new THREE.UnrealBloomPass(
            new THREE.Vector2(w, h),
            bloomStrength,   // strength
            0.6,   // radius — wider glow spread
            0.6    // threshold — catch more bright surfaces
        );

        composer = new THREE.EffectComposer(renderer);
        composer.addPass(renderPass);
        composer.addPass(bloomPass);

        // God Rays — dawn/dusk only
        if (tod === 'dawn' || tod === 'dusk') {
            var godRaysShader = {
                uniforms: {
                    tDiffuse: { value: null },
                    lightPos: { value: new THREE.Vector2(0.5, 0.5) },
                    exposure: { value: 0.18 },
                    decay: { value: 0.95 },
                    density: { value: 0.8 },
                    weight: { value: 0.4 },
                    samples: { value: 15 }
                },
                vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
                fragmentShader: [
                    'uniform sampler2D tDiffuse;',
                    'uniform vec2 lightPos;',
                    'uniform float exposure;',
                    'uniform float decay;',
                    'uniform float density;',
                    'uniform float weight;',
                    'varying vec2 vUv;',
                    'void main() {',
                    '    vec2 deltaUV = (vUv - lightPos) * density / 15.0;',
                    '    vec2 uv = vUv;',
                    '    vec4 color = texture2D(tDiffuse, vUv);',
                    '    float illumination = 1.0;',
                    '    for (int i = 0; i < 15; i++) {',
                    '        uv -= deltaUV;',
                    '        vec4 s = texture2D(tDiffuse, uv);',
                    '        s *= illumination * weight;',
                    '        color += s;',
                    '        illumination *= decay;',
                    '    }',
                    '    gl_FragColor = color * exposure;',
                    '}'
                ].join('\n')
            };
            godRaysShaderPass = new THREE.ShaderPass(godRaysShader);
            composer.addPass(godRaysShaderPass);
        }

        var satShader = {
            uniforms: {
                tDiffuse: { value: null },
                saturation: { value: wxMod2.saturation }
            },
            vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
            fragmentShader: 'uniform sampler2D tDiffuse; uniform float saturation; varying vec2 vUv; void main() { vec4 color = texture2D(tDiffuse, vUv); float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114)); gl_FragColor = vec4(mix(vec3(lum), color.rgb, saturation), color.a); }'
        };
        saturationPass = new THREE.ShaderPass(satShader);
        composer.addPass(saturationPass);
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

    // ── Weather-based visual modifiers ──
    function getWeatherModifiers() {
        if (!weather) {
            return { fogDensity: 0.0004, cloudOpacity: 0.5, sunIntensity: 1.0, saturation: 1.0, turbidity: 4, bloomStrength: 0.4 };
        }
        var ws = weather.windSpeed || 0;
        var wh = weather.waveHeight || 0;
        var severity = Math.min(1, Math.max(ws / 30, wh / 4));
        return {
            fogDensity: 0.0003 + severity * 0.0007,
            cloudOpacity: 0.3 + severity * 0.5,
            sunIntensity: 1.0 - severity * 0.5,
            saturation: 1.0 - severity * 0.3,
            turbidity: 3 + severity * 10,
            bloomStrength: Math.max(0, 0.4 - severity * 0.4)
        };
    }

    // ── Sun position by time of day ──
    function calcSunPosition(tod) {
        var THREE = window.THREE;
        var phi, theta;
        switch (tod) {
            case 'dawn':
                phi = THREE.MathUtils.degToRad(90 - 10);
                theta = THREE.MathUtils.degToRad(90);
                break;
            case 'day':
                phi = THREE.MathUtils.degToRad(90 - 55);
                theta = THREE.MathUtils.degToRad(180);
                break;
            case 'dusk':
                phi = THREE.MathUtils.degToRad(90 - 8);
                theta = THREE.MathUtils.degToRad(270);
                break;
            default:
                phi = THREE.MathUtils.degToRad(90 + 20);
                theta = THREE.MathUtils.degToRad(0);
                break;
        }
        var pos = new THREE.Vector3();
        pos.setFromSphericalCoords(1, phi, theta);
        return pos;
    }

    // ── Sky group — moves with ship so horizon never breaks ──
    var skyGroup = null;
    var skyMesh = null;
    var sunPosition = null;
    var saturationPass = null;
    var godRaysShaderPass = null;

    // ── buildSky() — THREE.Sky for dawn/day/dusk, vertex-color dome for night ──
    function buildSky() {
        var THREE = window.THREE;
        var tod = getTimeOfDay();
        var pal = SKY_PALETTES[tod];

        scene.fog = new THREE.FogExp2(pal.fog, 0.0004);

        skyGroup = new THREE.Group();

        if (tod !== 'night' && THREE.Sky) {
            // Sky shader replaces scene.background
            scene.background = null;

            skyMesh = new THREE.Sky();
            skyMesh.scale.setScalar(450);

            var skyUniforms = skyMesh.material.uniforms;
            var wxMod = getWeatherModifiers();
            skyUniforms['turbidity'].value = wxMod.turbidity;
            skyUniforms['rayleigh'].value = 1;
            skyUniforms['mieCoefficient'].value = 0.003;
            skyUniforms['mieDirectionalG'].value = 0.7;

            sunPosition = calcSunPosition(tod);
            skyUniforms['sunPosition'].value.copy(sunPosition);

            // Render sky behind everything
            skyMesh.renderOrder = -1;

            skyGroup.add(skyMesh);

            // Reduce exposure for Sky shader — it's inherently bright
            if (renderer) {
                renderer.toneMappingExposure = tod === 'day' ? 0.5 : 0.6;
            }
        } else {
            scene.background = new THREE.Color(pal.bg);
            // Night — vertex-color sky dome
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

            // Stars
            var starCount = tod === 'night' ? 300 : 100;
            var starGeo = new THREE.BufferGeometry();
            var starPos = new Float32Array(starCount * 3);
            for (var s = 0; s < starCount; s++) {
                var sTheta = Math.random() * Math.PI * 2;
                var sPhi = Math.random() * Math.PI * 0.45;
                var r = 380;
                starPos[s * 3] = r * Math.sin(sPhi) * Math.cos(sTheta);
                starPos[s * 3 + 1] = r * Math.cos(sPhi);
                starPos[s * 3 + 2] = r * Math.sin(sPhi) * Math.sin(sTheta);
            }
            starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
            var starMat = new THREE.PointsMaterial({
                color: 0xffffff,
                size: tod === 'night' ? 1.2 : 0.7,
                transparent: true,
                opacity: tod === 'night' ? 0.8 : 0.4
            });
            skyGroup.add(new THREE.Points(starGeo, starMat));

            // Moon for night
            if (tod === 'night') {
                var moonCanvas = document.createElement('canvas');
                moonCanvas.width = 128;
                moonCanvas.height = 128;
                var ctx = moonCanvas.getContext('2d');
                var glow = ctx.createRadialGradient(64, 64, 20, 64, 64, 64);
                glow.addColorStop(0, 'rgba(220,230,255,0.9)');
                glow.addColorStop(0.3, 'rgba(200,215,240,0.4)');
                glow.addColorStop(0.6, 'rgba(150,170,200,0.1)');
                glow.addColorStop(1, 'rgba(100,120,150,0)');
                ctx.fillStyle = glow;
                ctx.fillRect(0, 0, 128, 128);
                ctx.beginPath();
                ctx.arc(64, 64, 18, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(230,235,245,0.95)';
                ctx.fill();
                var moonTex = new THREE.CanvasTexture(moonCanvas);
                var moonMat = new THREE.SpriteMaterial({ map: moonTex, transparent: true, depthWrite: false });
                var moonSprite = new THREE.Sprite(moonMat);
                moonSprite.position.set(150, 200, -100);
                moonSprite.scale.set(60, 60, 1);
                skyGroup.add(moonSprite);
            }

            sunPosition = calcSunPosition(tod);
        }

        scene.add(skyGroup);
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

        // ── Layer 1: Horizon mist band (skip when Sky shader is active) ──
        if (!skyMesh) {
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
                var cMat = new THREE.SpriteMaterial({ map: cTex, transparent: true, opacity: 0.7 + Math.random() * 0.25, depthWrite: false, blending: THREE.AdditiveBlending });
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
                var wMat = new THREE.SpriteMaterial({ map: wTex, transparent: true, opacity: 0.5 + Math.random() * 0.3, depthWrite: false, blending: THREE.AdditiveBlending });
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
        // Turn scenario play button — kept at top center for quick toggle
        turnBtnEl = document.createElement('button');
        turnBtnEl.className = 'rv-scenario-btn';
        turnBtnEl.innerHTML = '<i class="fa-solid fa-ship"></i> 선회 시나리오';
        turnBtnEl.title = '코너링 시 횡요각 변화 시뮬레이션';
        turnBtnEl.addEventListener('click', function () {
            toggleTurnScenario();
        });
        canvasWrap.appendChild(turnBtnEl);

        // (Bottom-left HUD removed — duplicated info that lives in the side panel and prediction modal.)


        // Top-right unified scenario status panel.
        // Shows when turn scenario is active OR any weather/speed/time override is set.
        // Holds: simulation badge, override list, turn state details — all in one place.
        var scenarioOverlay = document.createElement('div');
        scenarioOverlay.className = 'rv-canvas-hud-scenario';
        scenarioOverlay.id = 'rv-canvas-hud-scenario';
        scenarioOverlay.hidden = true;
        scenarioOverlay.innerHTML =
            '<div class="rv-scenario-header">' +
            '<span>시뮬레이션</span>' +
            '<button type="button" class="rv-scenario-clear-btn" id="rv-scenario-clear-btn" title="실제 관측값으로 복귀">초기화</button>' +
            '</div>' +
            '<div class="rv-scenario-overrides" id="rv-scenario-overrides"></div>' +
            '<div class="rv-scenario-turn" id="rv-hud-turn-section" hidden>' +
            '<div class="rv-scenario-turn-row">' +
            '<div class="rv-scenario-turn-item">' +
            '<span class="rv-scenario-turn-label">상태</span>' +
            '<span class="rv-scenario-turn-val" id="rv-turn-phase">직진</span>' +
            '</div>' +
            '<div class="rv-scenario-turn-item">' +
            '<span class="rv-scenario-turn-label">침로</span>' +
            '<span class="rv-scenario-turn-val" id="rv-turn-heading">000°</span>' +
            '</div>' +
            '<div class="rv-scenario-turn-item">' +
            '<span class="rv-scenario-turn-label">타각</span>' +
            '<span class="rv-scenario-turn-val" id="rv-turn-rudder">0°</span>' +
            '</div>' +
            '</div>' +
            '<div class="rv-turn-progress">' +
            '<div class="rv-turn-progress-fill" id="rv-turn-progress-fill"></div>' +
            '</div>' +
            '</div>';
        canvasWrap.appendChild(scenarioOverlay);

        // Wire up the clear button (now always in DOM, even when panel is hidden)
        var clearBtn = document.getElementById('rv-scenario-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', function (e) {
                e.preventDefault();
                clearScenarioOverride();
            });
        }

        // Keep turnHudEl reference for toggle logic (still uses id="rv-hud-turn-section")
        turnHudEl = document.getElementById('rv-hud-turn-section');
    }

    // ── Canvas HUD overlay + Camera presets ──
    function buildCanvasOverlays(canvasWrap) {
        var split = document.createElement('div');
        split.className = 'rv-split-overlay';
        split.innerHTML =
            '<div class="rv-split-divider"></div>' +
            '<div class="rv-split-side rv-split-left">' +
            '<div class="rv-split-label">실제 REAL</div>' +
            '<div class="rv-split-roll" id="rv-real-roll">0.0°</div>' +
            '<div class="roll-gauge roll-gauge-safe" id="rv-real-gauge"><div class="roll-gauge-track"><div class="roll-gauge-fill" id="rv-real-fill"></div></div></div>' +
            '</div>' +
            '<div class="rv-split-side rv-split-right">' +
            '<div class="rv-split-label">예측 PRED</div>' +
            '<div class="rv-split-roll" id="rv-pred-roll">0.0°</div>' +
            '<div class="roll-gauge roll-gauge-safe" id="rv-pred-gauge"><div class="roll-gauge-track"><div class="roll-gauge-fill" id="rv-pred-fill"></div></div></div>' +
            '</div>';
        canvasWrap.appendChild(split);

        var compare = document.createElement('div');
        compare.className = 'rv-compare';
        compare.innerHTML =
            '<div class="rv-compare-metrics">' +
            '<div class="rv-metric"><span class="rv-metric-label">Δ Roll</span><span class="rv-metric-val" id="rv-d-roll">0.0°</span></div>' +
            '<div class="rv-metric"><span class="rv-metric-label">Δ Pitch</span><span class="rv-metric-val" id="rv-d-pitch">0.0°</span></div>' +
            '<div class="rv-metric"><span class="rv-metric-label">RMSE</span><span class="rv-metric-val" id="rv-rmse">0.0°</span></div>' +
            '</div>' +
            '<div class="rv-compare-actions">' +
            '<button type="button" class="rv-action-btn" id="rv-act-turn">선회 시나리오</button>' +
            '<button type="button" class="rv-action-btn" id="rv-act-capsize">전복</button>' +
            '<button type="button" class="rv-action-btn" id="rv-act-clear">초기화</button>' +
            '</div>' +
            '<div class="rv-compare-chart" id="rv-roll-chart"></div>';
        canvasWrap.appendChild(compare);

        var actTurn = document.getElementById('rv-act-turn');
        var actCapsize = document.getElementById('rv-act-capsize');
        var actClear = document.getElementById('rv-act-clear');
        if (actTurn) actTurn.addEventListener('click', function () { toggleTurnScenario(); });
        if (actCapsize) actCapsize.addEventListener('click', function () { triggerCapsize(1, 0); });
        if (actClear) actClear.addEventListener('click', function () { clearScenarioOverride(); });

        // (Removed) Top-right SAFE/CAUTION badge — ROLL HUD value color already conveys the same level.

        // Camera preset buttons (bottom-right)
        var camGroup = document.createElement('div');
        camGroup.className = 'rv-cam-presets';

        var presets = [
            { id: 'beam', icon: 'fa-arrows-left-right', label: '측면', pos: { x: 0, y: 12, z: 45 } },
            { id: 'bow', icon: 'fa-arrow-up', label: '선수', pos: { x: 35, y: 15, z: 0 } },
            { id: 'stern', icon: 'fa-arrow-down', label: '선미', pos: { x: -35, y: 15, z: 0 } },
            { id: 'top', icon: 'fa-eye', label: '탑뷰', pos: { x: 0, y: 55, z: 1 } }
        ];

        presets.forEach(function (p) {
            var btn = document.createElement('button');
            btn.className = 'rv-cam-btn';
            btn.innerHTML = '<i class="fa-solid ' + p.icon + '"></i><span>' + p.label + '</span>';
            btn.title = p.label + ' 시점';
            btn.addEventListener('click', function () {
                animateCameraToPreset(p.pos);
            });
            camGroup.appendChild(btn);
        });
        canvasWrap.appendChild(camGroup);
    }

    function animateCameraToPreset(targetPos) {
        if (!camera || cameraAnimating) return;
        var elapsed = (performance.now() - clockStart) / 1000;
        camPresetAnim = {
            fromPos: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
            toPos: { x: shipWorldPos.x + targetPos.x, y: targetPos.y, z: shipWorldPos.z + targetPos.z },
            fromTarget: controls ? { x: controls.target.x, y: controls.target.y, z: controls.target.z } : { x: 0, y: 2, z: 0 },
            toTarget: { x: shipWorldPos.x, y: 2, z: shipWorldPos.z },
            start: elapsed,
            duration: 1.0
        };
    }

    function updateCameraPresetAnim(elapsed) {
        if (!camPresetAnim) return;
        var t = Math.min((elapsed - camPresetAnim.start) / camPresetAnim.duration, 1);
        var e = easeOutCubic(t);

        var fp = camPresetAnim.fromPos, tp = camPresetAnim.toPos;
        var ft = camPresetAnim.fromTarget, tt = camPresetAnim.toTarget;

        camera.position.set(
            fp.x + (tp.x - fp.x) * e,
            fp.y + (tp.y - fp.y) * e,
            fp.z + (tp.z - fp.z) * e
        );

        if (controls) {
            controls.target.set(
                ft.x + (tt.x - ft.x) * e,
                ft.y + (tt.y - ft.y) * e,
                ft.z + (tt.z - ft.z) * e
            );
        }

        camera.lookAt(
            ft.x + (tt.x - ft.x) * e,
            ft.y + (tt.y - ft.y) * e,
            ft.z + (tt.z - ft.z) * e
        );

        if (t >= 1) {
            camPresetAnim = null;
            if (controls) controls.update();
        }
    }

    function updateCanvasHUD(absRoll, absPitch, speed) {
        // Bottom-left HUD removed \u2014 ROLL/PITCH live in the prediction modal (separate update path
        // via updateGauge / updatePitchGauge), and ship speed is shown in the side panel SHIP INFO.
        // Keeping this function as a no-op so the animation loop call site is unaffected.
    }

    function setTurnScenario(active, direction) {
        // direction: 1 = locked starboard, -1 = locked port, 0/undefined = alternate each cycle
        turnScenarioActive = !!active;
        if (turnScenarioActive) {
            // Skip the 8-second 'straight' lead-in — when a user explicitly asks for
            // a turn, they expect to see the ship turning immediately.
            turnElapsed = TURN_TIMING.straight;
            turnPhase = 'entering';
            turnHeading = 0;
            shipWorldPos = { x: 0, z: 0 };
            camFollow = { x: 0, z: 0 };
            turnDirection = (direction === 1 || direction === -1) ? direction : 0;
            if (turnBtnEl) {
                turnBtnEl.innerHTML = '<i class="fa-solid fa-stop"></i> 시나리오 정지';
                turnBtnEl.classList.add('active');
            }
        } else {
            if (controls) {
                controls.target.set(shipWorldPos.x, 2, shipWorldPos.z);
                controls.enabled = true;
            }
            if (turnBtnEl) {
                turnBtnEl.innerHTML = '<i class="fa-solid fa-ship"></i> 선회 시나리오';
                turnBtnEl.classList.remove('active');
            }
            turnHeading = 0;
            camFollowHeading = 0;
        }
        // Refresh top-right scenario panel — it shows turn details when active
        _refreshWeatherDisplay();
    }

    function toggleTurnScenario() {
        setTurnScenario(!turnScenarioActive);
    }

    // Returns { headingDelta, rollMultiplier, rudderAngle, phaseName }
    function computeTurnState(dt) {
        if (!turnScenarioActive) return { headingDelta: 0, rollMultiplier: 1, rudderAngle: 0, phaseName: '직진' };
        // Capsized ship has no rudder authority — freeze heading once the capsize
        // is *armed* (i.e. the pre-roll delay has elapsed and the ship is actually
        // rolling over). During the delay the turn continues normally.
        if (_capsize && _capsize.armed) return { headingDelta: 0, rollMultiplier: 0, rudderAngle: 0, phaseName: '제어 상실' };

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

        // Direction: locked (turnDirection ±1) or alternating each cycle (turnDirection 0)
        var dir;
        if (turnDirection === 1 || turnDirection === -1) {
            dir = turnDirection;
        } else {
            var cycleIndex = Math.floor(turnElapsed / TURN_TOTAL);
            dir = (cycleIndex % 2 === 0) ? 1 : -1;
        }

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
            phaseEl.className = 'rv-scenario-turn-val' + (turnPhase === 'turning' ? ' rv-turn-danger' : turnPhase !== 'straight' ? ' rv-turn-active' : '');
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

                // Wrap in a container group for clean transform
                var container = new THREE.Group();
                container.add(model);

                // Orient FIRST so the bounding box below reflects the final pose —
                // rotating after centering shifts the model off the roll pivot.
                var box = new THREE.Box3().setFromObject(container);
                var size = new THREE.Vector3();
                box.getSize(size);
                if (size.z > size.x * 1.3) {
                    model.rotation.y = Math.PI / 2;
                }

                // Normalize scale — target hull length ~20 units
                box.setFromObject(container);
                box.getSize(size);
                var maxDim = Math.max(size.x, size.y, size.z);
                var scale = 20 / maxDim;
                model.scale.setScalar(scale);

                // Recompute after scale, center horizontally, and sink the hull so
                // the waterline actually cuts it (group origin is the roll pivot)
                box.setFromObject(container);
                box.getSize(size);
                var center = new THREE.Vector3();
                box.getCenter(center);
                model.position.x -= center.x;
                model.position.z -= center.z;
                model.position.y -= box.min.y + size.y * 0.18;

                // Enable shadows and apply envMap
                container.traverse(function (child) {
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

                gltfModelCache[type] = container;
                callback(container.clone());
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

    var _shipMatCache = {};
    function shipMat(color, opts) {
        // Cache key from all material params
        var r = (opts && opts.roughness !== undefined) ? opts.roughness : 0.55;
        var m = (opts && opts.metalness !== undefined) ? opts.metalness : 0.35;
        var e = (opts && opts.emissive) ? opts.emissive : '';
        var ei = (opts && opts.emissiveIntensity) ? opts.emissiveIntensity : 0;
        var emi = (opts && opts.envMapIntensity !== undefined) ? opts.envMapIntensity : 0.4;
        var key = color + '|' + r + '|' + m + '|' + e + '|' + ei + '|' + emi;
        if (_shipMatCache[key]) return _shipMatCache[key];

        var THREE = window.THREE;
        var params = {
            color: new THREE.Color(color),
            roughness: r,
            metalness: m
        };
        if (shipEnvMap) {
            params.envMap = shipEnvMap;
            params.envMapIntensity = emi;
        }
        if (e) {
            params.emissive = new THREE.Color(e);
            params.emissiveIntensity = ei || 0.8;
        }
        var mat = new THREE.MeshStandardMaterial(params);
        _shipMatCache[key] = mat;
        return mat;
    }

    function addToShip(mesh) {
        shipGroup.add(mesh);
        return mesh;
    }

    // ── Procedural rust/weathering canvas texture ──
    var _rustTextureCache = {};
    function createRustTexture(baseColor, intensity) {
        var key = baseColor + '|' + intensity;
        if (_rustTextureCache[key]) return _rustTextureCache[key];

        var THREE = window.THREE;
        var sz = 256;
        var canvas = document.createElement('canvas');
        canvas.width = sz; canvas.height = sz;
        var ctx = canvas.getContext('2d');

        // Base hull color
        ctx.fillStyle = baseColor;
        ctx.fillRect(0, 0, sz, sz);

        // Hull plating seams — horizontal weld lines with staggered vertical joints
        ctx.fillStyle = '#000000';
        for (var py = 28; py < sz; py += 44) {
            ctx.globalAlpha = 0.14;
            ctx.fillRect(0, py, sz, 1.5);
            ctx.globalAlpha = 0.06;
            var stagger = ((py / 44) % 2) * 32;
            for (var px = stagger; px < sz; px += 64) {
                ctx.fillRect(px, py - 44, 1.5, 44);
            }
        }
        ctx.globalAlpha = 1.0;

        var rustColors = ['#8B4513', '#A0522D', '#6B3410', '#CD853F', '#D2691E'];

        // Rust patches (elliptical blotches)
        var patchCount = Math.floor(25 * intensity);
        for (var i = 0; i < patchCount; i++) {
            var rx = Math.random() * sz;
            var ry = Math.random() * sz;
            var rw = 4 + Math.random() * 18;
            var rh = 8 + Math.random() * 35;
            ctx.globalAlpha = 0.08 + Math.random() * 0.25 * intensity;
            ctx.fillStyle = rustColors[Math.floor(Math.random() * rustColors.length)];
            ctx.beginPath();
            ctx.ellipse(rx, ry, rw, rh, Math.random() * Math.PI, 0, Math.PI * 2);
            ctx.fill();
        }

        // Vertical rust streaks (water runoff drips)
        var streakCount = Math.floor(6 * intensity);
        for (var s = 0; s < streakCount; s++) {
            var sx = Math.random() * sz;
            var sy = Math.random() * sz * 0.5;
            var sw = 1.5 + Math.random() * 3;
            var sh = 25 + Math.random() * 70;
            ctx.globalAlpha = 0.12 + Math.random() * 0.18 * intensity;
            ctx.fillStyle = rustColors[Math.floor(Math.random() * rustColors.length)];
            ctx.fillRect(sx, sy, sw, sh);
        }

        // Fine grime/dirt speckle
        for (var d = 0; d < 150; d++) {
            ctx.globalAlpha = Math.random() * 0.04 * intensity;
            ctx.fillStyle = Math.random() > 0.5 ? '#2a2a2a' : '#4a3a2a';
            ctx.fillRect(Math.random() * sz, Math.random() * sz, 1 + Math.random() * 2, 1 + Math.random() * 2);
        }
        ctx.globalAlpha = 1.0;

        var texture = new THREE.CanvasTexture(canvas);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        _rustTextureCache[key] = texture;
        return texture;
    }

    // Rust intensity per ship type
    var RUST_INTENSITY = {
        cargo: 0.6, tanker: 0.5, passenger: 0.15,
        fishing: 0.8, military: 0.12, tug: 0.7, other: 0.4
    };

    function rustHullMat(baseColor, type) {
        var THREE = window.THREE;
        var intensity = RUST_INTENSITY[type] || 0.4;
        var texture = createRustTexture(baseColor, intensity);
        var params = {
            map: texture,
            roughness: 0.55,
            metalness: 0.3,
            side: THREE.DoubleSide
        };
        if (shipEnvMap) {
            params.envMap = shipEnvMap;
            params.envMapIntensity = 0.35;
        }
        return new THREE.MeshStandardMaterial(params);
    }

    // ── Corrugated container texture — vertical ribs + grime so boxes read as
    // real containers instead of flat-shaded toy blocks ──
    var _containerTexCache = {};
    function createContainerTexture(baseColor) {
        if (_containerTexCache[baseColor]) return _containerTexCache[baseColor];
        var THREE = window.THREE;
        var w = 128, h = 128;
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        var ctx = cv.getContext('2d');
        ctx.fillStyle = baseColor;
        ctx.fillRect(0, 0, w, h);

        // Vertical corrugation ribs (shadow + highlight pair)
        for (var x = 0; x < w; x += 8) {
            ctx.globalAlpha = 0.22;
            ctx.fillStyle = '#000000';
            ctx.fillRect(x, 0, 2, h);
            ctx.globalAlpha = 0.13;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x + 4, 0, 2, h);
        }

        // Grime streaks running down from the roof line
        ctx.fillStyle = '#1a1a1a';
        for (var s = 0; s < 5; s++) {
            ctx.globalAlpha = 0.05 + Math.random() * 0.1;
            ctx.fillRect(Math.random() * w, 0, 2 + Math.random() * 4, 20 + Math.random() * 60);
        }

        // Corner-casting frame
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 6;
        ctx.strokeRect(0, 0, w, h);
        ctx.globalAlpha = 1;

        var tex = new THREE.CanvasTexture(cv);
        _containerTexCache[baseColor] = tex;
        return tex;
    }

    // Per-face materials: corrugated sides, plain darker roof/floor.
    // BoxGeometry face order: +x, -x, +y(top), -y, +z, -z
    var _containerMatCache = {};
    function containerMats(baseColor) {
        if (_containerMatCache[baseColor]) return _containerMatCache[baseColor];
        var THREE = window.THREE;
        var side = new THREE.MeshStandardMaterial({
            map: createContainerTexture(baseColor),
            roughness: 0.85,
            metalness: 0.15
        });
        var top = new THREE.MeshStandardMaterial({
            color: new THREE.Color(baseColor).multiplyScalar(0.7),
            roughness: 0.9,
            metalness: 0.15
        });
        if (shipEnvMap) {
            side.envMap = shipEnvMap; side.envMapIntensity = 0.2;
            top.envMap = shipEnvMap; top.envMapIntensity = 0.15;
        }
        var mats = [side, side, top, top, side, side];
        _containerMatCache[baseColor] = mats;
        return mats;
    }

    // ── Hull identity decals — painted ship name (bow quarters + stern) and
    // draft marks, rendered as thin planes floating just off the hull plating ──
    var HULL_DIMS = {
        cargo:     { length: 17, beam: 3.8, deckY: 3.0, wlY: 1.6 },
        tanker:    { length: 18, beam: 4.4, deckY: 3.0, wlY: 1.6 },
        passenger: { length: 18, beam: 5.0, deckY: 3.4, wlY: 1.4 },
        fishing:   { length: 10, beam: 2.8, deckY: 2.5, wlY: 1.4 },
        military:  { length: 18, beam: 3.2, deckY: 2.9, wlY: 1.6 },
        tug:       { length: 8,  beam: 3.6, deckY: 3.0, wlY: 1.6 },
        other:     { length: 11, beam: 3.2, deckY: 2.8, wlY: 1.5 }
    };

    function makeTextTexture(text, color, w, h) {
        var THREE = window.THREE;
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        var ctx = cv.getContext('2d');
        var fs = Math.min(h * 0.68, (w * 0.92) / Math.max(text.length, 1) * 1.7);
        ctx.font = '700 ' + fs.toFixed(0) + "px 'Wanted Sans Variable', 'Pretendard Variable', 'Inter', sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.92;
        ctx.fillText(text, w / 2, h / 2);
        return new THREE.CanvasTexture(cv);
    }

    // Draft mark column: depth numbers + gauge ticks, read bottom-up like real marks
    function makeDraftTexture(color) {
        var THREE = window.THREE;
        var cv = document.createElement('canvas');
        cv.width = 96; cv.height = 256;
        var ctx = cv.getContext('2d');
        ctx.font = "700 38px 'JetBrains Mono', monospace";
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.85;
        var levels = [8, 6, 4, 2];
        for (var i = 0; i < levels.length; i++) {
            var y = 32 + i * 64;
            ctx.fillText(String(levels[i]) + 'M', 6, y);
            ctx.fillRect(64, y - 3, 26, 6);
        }
        return new THREE.CanvasTexture(cv);
    }

    var hullMeshRef = null;   // set by each builder; decals project onto this mesh
    var _decalProxy = null;   // non-indexed copy — r137 DecalGeometry rejects indexed geometry

    function _getDecalProxy() {
        var THREE = window.THREE;
        if (_decalProxy && _decalProxy.userData.src === hullMeshRef) return _decalProxy;
        var geo = hullMeshRef.geometry.index
            ? hullMeshRef.geometry.toNonIndexed()
            : hullMeshRef.geometry;
        _decalProxy = new THREE.Mesh(geo, hullMeshRef.material);
        _decalProxy.position.copy(hullMeshRef.position);
        _decalProxy.rotation.copy(hullMeshRef.rotation);
        _decalProxy.scale.copy(hullMeshRef.scale);
        _decalProxy.updateMatrixWorld(true);
        _decalProxy.userData.src = hullMeshRef;
        return _decalProxy;
    }

    // Project a texture onto the hull plating so it hugs the curvature like paint.
    // Falls back to a floating plane when DecalGeometry isn't loaded.
    function _projectHullDecal(tex, pos, rotY, w, h) {
        var THREE = window.THREE;
        if (THREE.DecalGeometry && hullMeshRef && shipGroup) {
            var geo = new THREE.DecalGeometry(
                _getDecalProxy(),
                new THREE.Vector3(pos.x, pos.y, pos.z),
                new THREE.Euler(0, rotY, 0),
                new THREE.Vector3(w, h, 2.0)
            );
            var mat = new THREE.MeshStandardMaterial({
                map: tex,
                transparent: true,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -4,
                roughness: 0.7,
                metalness: 0.1,
                // Hull triangles have mixed winding (masked by the hull's own
                // DoubleSide material) — without this the decal gets culled.
                side: THREE.DoubleSide
            });
            addToShip(new THREE.Mesh(geo, mat));
            return;
        }
        var plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), _decalMat(tex));
        plane.rotation.y = rotY;
        plane.position.set(pos.x, pos.y, pos.z);
        addToShip(plane);
    }

    function _decalMat(tex) {
        var THREE = window.THREE;
        return new THREE.MeshStandardMaterial({
            map: tex,
            transparent: true,
            roughness: 0.7,
            metalness: 0.1,
            polygonOffset: true,
            polygonOffsetFactor: -2
        });
    }

    function addHullIdentity(THREE, type) {
        var dims = HULL_DIMS[type] || HULL_DIMS.other;
        var ship = window.shipDataMap && window.shipDataMap[currentMmsi];
        var name = (ship && ship.name && ship.name !== 'UNKNOWN') ? String(ship.name).toUpperCase() : null;
        // Light text on dark hulls, dark text on the pale passenger/military hulls
        var textColor = (type === 'passenger' || type === 'military') ? '#23303c' : '#e8edf2';
        var nameY = dims.wlY + (dims.deckY - dims.wlY) * 0.58;
        var halfZ = dims.beam / 2 + 0.06;

        if (name) {
            var nameW = Math.min(dims.length * 0.22, 0.42 * name.length + 0.8);
            var nameH = nameW * 0.26;
            var tex = makeTextTexture(name, textColor, 512, 96);
            _projectHullDecal(tex, { x: dims.length * 0.22, y: nameY, z: halfZ }, 0, nameW, nameH);
            _projectHullDecal(tex, { x: dims.length * 0.22, y: nameY, z: -halfZ }, Math.PI, nameW, nameH);
            _projectHullDecal(tex, { x: -dims.length / 2 - 0.02, y: nameY, z: 0 }, -Math.PI / 2, nameW * 0.75, nameH * 0.75);
        }

        // Draft marks — big merchant/naval hulls only. Midship, where the hull is
        // full-beam (the bow taper slips out of the decal projection box).
        if (type === 'cargo' || type === 'tanker' || type === 'passenger' || type === 'military') {
            var dTex = makeDraftTexture(textColor);
            _projectHullDecal(dTex, { x: 0, y: dims.wlY + 0.2, z: halfZ }, 0, 0.5, 1.4);
            _projectHullDecal(dTex, { x: 0, y: dims.wlY + 0.2, z: -halfZ }, Math.PI, 0.5, 1.4);
        }
    }

    // ── Underwater & stern fittings ──
    function addPropeller(THREE, x, y, r, z) {
        var prop = new THREE.Group();
        var bronze = shipMat('#9c7a45', { metalness: 0.8, roughness: 0.35 });
        var hubGeo = new THREE.CylinderGeometry(0.12 * r, 0.16 * r, 0.38 * r, 8);
        hubGeo.rotateZ(Math.PI / 2);
        prop.add(new THREE.Mesh(hubGeo, bronze));
        for (var i = 0; i < 4; i++) {
            var pivot = new THREE.Group();
            var bladeGeo = new THREE.BoxGeometry(0.05 * r, 0.85 * r, 0.3 * r);
            var blade = new THREE.Mesh(bladeGeo, bronze);
            blade.position.y = 0.5 * r;
            blade.rotation.y = 0.45; // blade pitch
            pivot.add(blade);
            pivot.rotation.x = i * Math.PI / 2 + 0.4;
            prop.add(pivot);
        }
        prop.position.set(x, y, z || 0);
        addToShip(prop);
    }

    function addBulbousBow(THREE, x, y, scale, color) {
        var geo = new THREE.SphereGeometry(0.5 * scale, 10, 8);
        geo.scale(1.9, 0.75, 0.75);
        addToShip(new THREE.Mesh(geo, shipMat(color, { roughness: 0.6 }))).position.set(x, y, 0);
    }

    // ── Deck railing helper — stanchions + top bar + middle bar ──
    function addDeckRailing(THREE, opts) {
        var startX = opts.startX, endX = opts.endX;
        var y = opts.y;              // deck surface Y
        var z = opts.z;              // z position (beam edge)
        var count = opts.postCount || 7;
        var height = opts.postHeight || 0.8;
        var color = opts.color || '#a1a1aa';
        var length = Math.abs(endX - startX);
        var midX = (startX + endX) / 2;

        var mat = shipMat(color, { metalness: 0.4, roughness: 0.6 });

        // Stanchions
        var postGeo = new THREE.CylinderGeometry(0.02, 0.025, height, 4);
        for (var i = 0; i <= count; i++) {
            var x = startX + (endX - startX) * i / count;
            addToShip(new THREE.Mesh(postGeo, mat)).position.set(x, y + height / 2, z);
        }

        // Top rail bar
        var topGeo = new THREE.CylinderGeometry(0.015, 0.015, length, 4);
        topGeo.rotateZ(Math.PI / 2);
        addToShip(new THREE.Mesh(topGeo, mat)).position.set(midX, y + height, z);

        // Middle rail bar
        var midGeo = new THREE.CylinderGeometry(0.012, 0.012, length, 4);
        midGeo.rotateZ(Math.PI / 2);
        addToShip(new THREE.Mesh(midGeo, mat)).position.set(midX, y + height * 0.5, z);
    }

    // ── Ship detail helpers ──

    // Bulbous bow — elongated sphere at waterline
    function addBulbousBow(THREE, bowX, y, radius, color) {
        var geo = new THREE.SphereGeometry(radius, 12, 8);
        geo.scale(2.2, 0.7, 0.9);
        addToShip(new THREE.Mesh(geo, shipMat(color, { roughness: 0.6 }))).position.set(bowX, y, 0);
    }

    // Anchor — shank + crown + flukes + ring
    function addAnchor(THREE, x, y, z, scale) {
        var mat = shipMat('#1a1a1a', { metalness: 0.8, roughness: 0.4 });
        // Shank
        addToShip(new THREE.Mesh(new THREE.BoxGeometry(0.05 * scale, 0.7 * scale, 0.05 * scale), mat)).position.set(x, y, z);
        // Crown bar
        addToShip(new THREE.Mesh(new THREE.BoxGeometry(0.04 * scale, 0.04 * scale, 0.35 * scale), mat)).position.set(x, y - 0.35 * scale, z);
        // Flukes
        var flukeGeo = new THREE.BoxGeometry(0.04 * scale, 0.22 * scale, 0.04 * scale);
        var f1 = addToShip(new THREE.Mesh(flukeGeo, mat));
        f1.position.set(x, y - 0.42 * scale, z + 0.15 * scale);
        f1.rotation.x = 0.6;
        var f2 = addToShip(new THREE.Mesh(flukeGeo.clone(), mat));
        f2.position.set(x, y - 0.42 * scale, z - 0.15 * scale);
        f2.rotation.x = -0.6;
        // Ring at top
        var ring = new THREE.TorusGeometry(0.06 * scale, 0.015 * scale, 6, 8);
        addToShip(new THREE.Mesh(ring, mat)).position.set(x, y + 0.38 * scale, z);
    }

    // Hawsepipe — hull opening for anchor chain
    function addHawsepipe(THREE, x, y, z, scale) {
        var outerGeo = new THREE.CylinderGeometry(0.14 * scale, 0.14 * scale, 0.15 * scale, 8);
        outerGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(outerGeo, shipMat('#374151', { metalness: 0.6 }))).position.set(x, y, z);
        var innerGeo = new THREE.CylinderGeometry(0.10 * scale, 0.10 * scale, 0.17 * scale, 8);
        innerGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(innerGeo, shipMat('#0a0a0a'))).position.set(x, y, z);
    }

    // Rudder blade + stock
    function addRudder(THREE, sternX, y, height, color) {
        var bladeGeo = new THREE.BoxGeometry(0.5, height, 0.06);
        addToShip(new THREE.Mesh(bladeGeo, shipMat(color, { roughness: 0.7 }))).position.set(sternX, y, 0);
        var stockGeo = new THREE.CylinderGeometry(0.04, 0.04, height * 0.6, 6);
        addToShip(new THREE.Mesh(stockGeo, shipMat('#4b5563', { metalness: 0.5 }))).position.set(sternX + 0.1, y + height * 0.5, 0);
    }

    // Stem bar — vertical edge at bow front
    function addStemBar(THREE, bowX, yBottom, yTop) {
        var height = yTop - yBottom;
        var geo = new THREE.BoxGeometry(0.08, height, 0.08);
        addToShip(new THREE.Mesh(geo, shipMat('#27272a', { metalness: 0.5 }))).position.set(bowX, yBottom + height / 2, 0);
    }

    // ── createHullGeometry() — parametric hull with curved cross-section ──
    function createHullGeometry(THREE, opts) {
        var L = opts.length, B = opts.beam, D = opts.depth;
        var bowFine = opts.bowFineness || 1.5;
        var sternFull = opts.sternFullness || 0.7;

        // Cross-section profile: starboard deck edge → keel
        // [z_frac (1=halfBeam), y_frac (1=depth)]
        var hp = [
            [1.00, 0.00], [1.02, 0.08], [1.00, 0.25],
            [0.94, 0.42], [0.80, 0.60], [0.55, 0.78],
            [0.25, 0.92], [0.00, 1.00]
        ];
        // Full ring: starboard → keel → port
        var ring = [];
        for (var i = 0; i < hp.length; i++) ring.push(hp[i]);
        for (var i = hp.length - 2; i >= 0; i--) ring.push([-hp[i][0], hp[i][1]]);
        var NR = ring.length;
        var NS = 14;
        var sternX = -(L * 0.45), bowX = L * 0.55;
        var positions = [];

        for (var s = 0; s <= NS; s++) {
            var t = s / NS;
            var x = sternX + t * (bowX - sternX);
            var wf;
            if (t < 0.3) {
                wf = sternFull + (1 - sternFull) * Math.pow(t / 0.3, 0.8);
            } else if (t < 0.55) {
                wf = 1.0;
            } else {
                wf = Math.pow(Math.max(1 - (t - 0.55) / 0.45, 0), bowFine);
            }
            wf = Math.max(wf, 0.015);
            var halfB = B / 2 * wf;
            var localD = D * Math.min(0.4 + 0.6 * wf / Math.max(sternFull, 0.3), 1.0);
            for (var r = 0; r < NR; r++) {
                positions.push(x, -ring[r][1] * localD, ring[r][0] * halfB);
            }
        }
        // Triangulate hull surface
        var indices = [];
        for (var s = 0; s < NS; s++) {
            for (var r = 0; r < NR - 1; r++) {
                var a = s * NR + r, b = a + 1;
                var c = (s + 1) * NR + r, d = c + 1;
                indices.push(a, c, b);
                indices.push(b, c, d);
            }
        }
        // Close stern face
        var sci = positions.length / 3;
        positions.push(sternX, -D * sternFull * 0.5, 0);
        for (var r = 0; r < NR - 1; r++) indices.push(r + 1, r, sci);

        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        return geo;
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
            { label: 'E', angle: Math.PI / 2, color: '#cbd5e1' },
            { label: 'S', angle: Math.PI, color: '#cbd5e1' },
            { label: 'W', angle: -Math.PI / 2, color: '#cbd5e1' }
        ];
        cardinals.forEach(function (c) {
            var cv = document.createElement('canvas');
            cv.width = 128; cv.height = 128;
            var cx = cv.getContext('2d');
            cx.fillStyle = c.color;
            cx.font = "600 88px 'Wanted Sans Variable', 'Pretendard Variable', 'Inter', sans-serif";
            cx.textAlign = 'center';
            cx.textBaseline = 'middle';
            cx.fillText(c.label, 64, 68);
            var tex = new THREE.CanvasTexture(cv);
            var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.7 }));
            sp.position.set(Math.sin(c.angle) * 15.5, 1.4, Math.cos(c.angle) * 15.5);
            sp.scale.set(1.9, 1.9, 1);
            compassGroup.add(sp);
        });

        // "WAVE" label only (arrow removed)
        var arrowDir = new THREE.Vector3(Math.sin(dirRad), 0, Math.cos(dirRad));
        var canvas = document.createElement('canvas');
        canvas.width = 128; canvas.height = 32;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#38bdf8';
        ctx.font = "700 20px 'Wanted Sans Variable', 'Pretendard Variable', 'Inter', sans-serif";
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
            textureWidth: 256,
            textureHeight: 256,
            waterNormals: waterNormals,
            sunDirection: (sunPosition ? sunPosition.clone().normalize() : new THREE.Vector3(0.7, 0.5, 0.3).normalize()),
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

        // Painted name + draft marks from the selected ship's AIS data
        addHullIdentity(THREE, type);
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

        buildNavLights(type);

        shipGroup.position.y = -0.8;
        scene.add(shipGroup);
    }

    // ── buildNavLights() — COLREG navigation lights (port/starboard/stern/masthead) ──
    var navLights = [];
    function buildNavLights(type) {
        var THREE = window.THREE;
        var tod = getTimeOfDay();
        if (tod === 'day') return;

        // Ship dimensions by type for light placement
        var dims = {
            tanker: { bow: 10, stern: -8, beam: 2.2, mast: 8, deck: 3.0 },
            cargo: { bow: 9, stern: -7, beam: 1.9, mast: 7.5, deck: 3.0 },
            passenger: { bow: 10, stern: -8, beam: 2.3, mast: 9, deck: 5.0 },
            fishing: { bow: 5, stern: -4, beam: 1.4, mast: 5, deck: 2.5 },
            military: { bow: 9, stern: -7, beam: 1.6, mast: 7, deck: 3.5 },
            tug: { bow: 4, stern: -3, beam: 1.6, mast: 5, deck: 3.0 },
            other: { bow: 6, stern: -5, beam: 1.5, mast: 6, deck: 3.0 }
        };
        var d = dims[type] || dims['other'];

        var intensity = (tod === 'night') ? 2.0 : 1.0;
        var distance = (tod === 'night') ? 25 : 15;

        // Glow sprite texture (shared)
        var canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        var ctx = canvas.getContext('2d');
        var grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.3, 'rgba(255,255,255,0.6)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 32, 32);
        var glowTex = new THREE.CanvasTexture(canvas);

        var lights = [
            // Port (left) — red
            { color: 0xff0022, x: d.bow * 0.6, y: d.deck + 0.5, z: d.beam, glow: 0xff2222 },
            // Starboard (right) — green
            { color: 0x00ff44, x: d.bow * 0.6, y: d.deck + 0.5, z: -d.beam, glow: 0x22ff44 },
            // Stern — white
            { color: 0xfff8e0, x: d.stern + 0.5, y: d.deck + 0.5, z: 0, glow: 0xfff8e0 },
            // Masthead — white
            { color: 0xfff8e0, x: d.bow * 0.3, y: d.mast + 1.5, z: 0, glow: 0xfff8e0 }
        ];

        for (var i = 0; i < lights.length; i++) {
            var cfg = lights[i];

            // Point light
            var pl = new THREE.PointLight(cfg.color, intensity, distance);
            pl.position.set(cfg.x, cfg.y, cfg.z);
            shipGroup.add(pl);

            // Small physical bulb mesh
            var bulbGeo = new THREE.SphereGeometry(0.12, 8, 8);
            var bulbMat = new THREE.MeshBasicMaterial({ color: cfg.color });
            var bulb = new THREE.Mesh(bulbGeo, bulbMat);
            bulb.position.set(cfg.x, cfg.y, cfg.z);
            shipGroup.add(bulb);

            // Glow sprite
            var spriteMat = new THREE.SpriteMaterial({
                map: glowTex,
                color: cfg.glow,
                transparent: true,
                opacity: (tod === 'night') ? 0.7 : 0.4,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            });
            var sprite = new THREE.Sprite(spriteMat);
            sprite.scale.set(1.5, 1.5, 1);
            sprite.position.set(cfg.x, cfg.y, cfg.z);
            shipGroup.add(sprite);

            navLights.push({ light: pl, bulb: bulb, sprite: sprite, mat: spriteMat });
        }
    }

    // ── Tanker: 낮고 긴 선체, 파이프라인, 매니폴드, 탱크돔, 캣워크 ──
    function buildTanker(THREE, color) {
        // Hull — parametric curved cross-section with weathering
        var hullGeo = createHullGeometry(THREE, {
            length: 18, beam: 4.4, depth: 3.0,
            bowFineness: 1.0, sternFullness: 0.8
        });
        var hullMat = rustHullMat('#5d3328', 'tanker');
        var hull = new THREE.Mesh(hullGeo, hullMat);
        hull.position.set(0, 3.0, 0);
        hullMeshRef = hull;
        addToShip(hull);

        // Painted deck green — classic tanker working deck
        var deckGeo = new THREE.BoxGeometry(16, 0.2, 4.2);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#46594c', { roughness: 0.8 }))).position.set(0, 3.0, 0);

        // Tank dome tops (spherical caps)
        for (var td = -2; td <= 2; td++) {
            var domeGeo = new THREE.SphereGeometry(1.4, 12, 6, 0, Math.PI * 2, 0, Math.PI / 3);
            addToShip(new THREE.Mesh(domeGeo, shipMat('#c9ced3', { roughness: 0.7, metalness: 0.3 }))).position.set(td * 3, 3.1, 0);
        }

        // Catwalk (elevated walkway along centerline)
        var catwalkGeo = new THREE.BoxGeometry(14, 0.06, 0.4);
        addToShip(new THREE.Mesh(catwalkGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(0, 3.8, 0);
        for (var cs = -3; cs <= 3; cs++) {
            var csGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.7, 4);
            addToShip(new THREE.Mesh(csGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(cs * 2, 3.45, 0);
        }

        // Pipelines (3 parallel)
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

        // Vent pipes (PV valves on each tank)
        for (var vp = -2; vp <= 2; vp++) {
            var ventGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6);
            addToShip(new THREE.Mesh(ventGeo, shipMat('#a1a1aa', { metalness: 0.4 }))).position.set(vp * 3, 4.0, 1.5);
            var capGeo = new THREE.CylinderGeometry(0.12, 0.08, 0.15, 6);
            addToShip(new THREE.Mesh(capGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(vp * 3, 4.55, 1.5);
        }

        // Bridge (multi-layer) — white accommodation block
        var bridgeGeo = new THREE.BoxGeometry(3.5, 2.0, 3.5);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#d6dde3', { roughness: 0.6, metalness: 0.15 }))).position.set(-5.5, 4.0, 0);
        var bridgeUpperGeo = new THREE.BoxGeometry(3.0, 1.0, 3.2);
        addToShip(new THREE.Mesh(bridgeUpperGeo, shipMat('#e3e9ee', { roughness: 0.6, metalness: 0.15 }))).position.set(-5.5, 5.5, 0);

        // Bridge wings
        var wingGeo = new THREE.BoxGeometry(1.0, 0.8, 0.6);
        addToShip(new THREE.Mesh(wingGeo, shipMat('#d6dde3', { roughness: 0.6, metalness: 0.15 }))).position.set(-5.5, 5.4, 2.2);
        addToShip(new THREE.Mesh(wingGeo.clone(), shipMat('#d6dde3', { roughness: 0.6, metalness: 0.15 }))).position.set(-5.5, 5.4, -2.2);

        // Windows (front + sides)
        var winGeo = new THREE.BoxGeometry(0.1, 0.5, 2.8);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-3.7, 5.5, 0);
        var winSideGeo = new THREE.BoxGeometry(2.5, 0.4, 0.08);
        addToShip(new THREE.Mesh(winSideGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-5.5, 5.5, 1.62);
        addToShip(new THREE.Mesh(winSideGeo.clone(), shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-5.5, 5.5, -1.62);

        // Funnel with cap
        var funnelGeo = new THREE.CylinderGeometry(0.4, 0.5, 2.2, 8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#27272a'))).position.set(-6.5, 5.5, 0);
        var stripeGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.3, 8);
        addToShip(new THREE.Mesh(stripeGeo, shipMat(color))).position.set(-6.5, 5.8, 0);
        var fCapGeo = new THREE.CylinderGeometry(0.45, 0.38, 0.2, 8);
        addToShip(new THREE.Mesh(fCapGeo, shipMat('#1e1e1e'))).position.set(-6.5, 6.65, 0);

        // Mast with radar
        var mastGeo = new THREE.CylinderGeometry(0.04, 0.06, 3, 6);
        addToShip(new THREE.Mesh(mastGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(-5.5, 7.5, 0);
        var radarGeo = new THREE.BoxGeometry(1.5, 0.06, 0.3);
        addToShip(new THREE.Mesh(radarGeo, shipMat('#94a3b8', { metalness: 0.4 }))).position.set(-5.5, 8.8, 0);

        // Deck railing (port & starboard)
        addDeckRailing(THREE, { startX: -6.6, endX: 7, y: 3.1, z: 2.1, postCount: 7, postHeight: 0.8 });
        addDeckRailing(THREE, { startX: -6.6, endX: 7, y: 3.1, z: -2.1, postCount: 7, postHeight: 0.8 });

        // Bow mooring bollards
        var bowBollardGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.3, 8);
        addToShip(new THREE.Mesh(bowBollardGeo, shipMat('#4b5563', { metalness: 0.6 }))).position.set(7, 3.2, 0.6);
        addToShip(new THREE.Mesh(bowBollardGeo.clone(), shipMat('#4b5563', { metalness: 0.6 }))).position.set(7, 3.2, -0.6);

        // Stem bar
        addStemBar(THREE, 10.5, 1.2, 3.2);
        // Anchors + hawsepipes (port & starboard)
        addAnchor(THREE, 8.5, 2.0, 2.0, 1.0);
        addHawsepipe(THREE, 8.8, 2.6, 2.0, 1.0);
        addAnchor(THREE, 8.5, 2.0, -2.0, 1.0);
        addHawsepipe(THREE, 8.8, 2.6, -2.0, 1.0);
        // Rudder
        addRudder(THREE, -8.8, 0.8, 1.8, color);
        // Propeller + bulbous bow (kept deep so it only hints through the water)
        addPropeller(THREE, -8.2, 0.8, 1.0);
        addBulbousBow(THREE, 9.2, 0.5, 1.1, '#5d3328');
    }

    // ── Cargo: 컨테이너 적재, 크레인, 높은 브릿지, 래싱브릿지, 레일링 ──
    function buildCargo(THREE, color) {
        // Hull — parametric curved cross-section with weathering
        var hullGeo = createHullGeometry(THREE, {
            length: 17, beam: 3.8, depth: 3.0,
            bowFineness: 1.3, sternFullness: 0.7
        });
        var hullMat = rustHullMat('#2c3e50', 'cargo');
        var hull = new THREE.Mesh(hullGeo, hullMat);
        hull.position.set(0, 3.0, 0);
        hullMeshRef = hull;
        addToShip(hull);

        var deckGeo = new THREE.BoxGeometry(15, 0.2, 3.8);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#3f3f46'))).position.set(0.5, 3.0, 0);

        // Hold covers (flat panels between container bays)
        var holdCoverGeo = new THREE.BoxGeometry(1.4, 0.08, 3.4);
        for (var hc = 0; hc < 4; hc++) {
            addToShip(new THREE.Mesh(holdCoverGeo, shipMat('#52525b', { roughness: 0.7 }))).position.set(3.5 - hc * 2, 3.15, 0);
        }

        // Containers with lashing rods (visible gaps between) — weathered
        // shipping-line tones, not saturated web colors
        var containerColors = ['#9b3b2e', '#27506e', '#3a5f47', '#b06a28', '#5b6068', '#6e3f4a'];
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
                    var container = new THREE.Mesh(cGeo, containerMats(cColor));
                    container.position.set(row.x, 3.6 + layer * 0.95, z * 1.2);
                    addToShip(container);
                }
            }
            // Lashing bridge between container stacks
            var lashGeo = new THREE.BoxGeometry(0.15, 0.6, 3.6);
            addToShip(new THREE.Mesh(lashGeo, shipMat('#fbbf24', { metalness: 0.4 }))).position.set(row.x + 0.9, 3.5, 0);
        });

        // Crane pair (A-frame style)
        var craneBaseGeo = new THREE.BoxGeometry(0.3, 3, 0.3);
        addToShip(new THREE.Mesh(craneBaseGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-4, 4.5, 1.2);
        addToShip(new THREE.Mesh(craneBaseGeo.clone(), shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-4, 4.5, -1.2);
        // Cross beam
        var crossGeo = new THREE.BoxGeometry(0.15, 0.15, 2.4);
        addToShip(new THREE.Mesh(crossGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-4, 5.8, 0);

        var craneBoomGeo = new THREE.CylinderGeometry(0.08, 0.1, 4, 6);
        craneBoomGeo.rotateZ(Math.PI / 4);
        addToShip(new THREE.Mesh(craneBoomGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-3, 6.5, 0);
        // Crane cable
        var cableGeo = new THREE.CylinderGeometry(0.015, 0.015, 3, 4);
        addToShip(new THREE.Mesh(cableGeo, shipMat('#71717a'))).position.set(-1.8, 5.8, 0);

        // Bridge (multi-deck) — white accommodation block, like real ships
        var bridgeLowerGeo = new THREE.BoxGeometry(3, 2.5, 3.5);
        addToShip(new THREE.Mesh(bridgeLowerGeo, shipMat('#d6dde3', { roughness: 0.6, metalness: 0.15 }))).position.set(-5.5, 4.3, 0);
        var bridgeUpperGeo = new THREE.BoxGeometry(2.5, 1.2, 3.2);
        addToShip(new THREE.Mesh(bridgeUpperGeo, shipMat('#e3e9ee', { roughness: 0.6, metalness: 0.15 }))).position.set(-5.5, 6.2, 0);

        // Bridge wings
        var bWingGeo = new THREE.BoxGeometry(0.8, 0.6, 0.5);
        addToShip(new THREE.Mesh(bWingGeo, shipMat('#d6dde3', { roughness: 0.6, metalness: 0.15 }))).position.set(-5.5, 6.1, 2.1);
        addToShip(new THREE.Mesh(bWingGeo.clone(), shipMat('#d6dde3', { roughness: 0.6, metalness: 0.15 }))).position.set(-5.5, 6.1, -2.1);

        // Windows (front + sides)
        var winGeo = new THREE.BoxGeometry(0.1, 0.6, 2.8);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-3.95, 6.2, 0);
        var winSideGeo = new THREE.BoxGeometry(2.0, 0.4, 0.08);
        addToShip(new THREE.Mesh(winSideGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-5.5, 6.2, 1.62);
        addToShip(new THREE.Mesh(winSideGeo.clone(), shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-5.5, 6.2, -1.62);

        // Funnel with cap — red body, black cap (classic livery)
        var funnelGeo = new THREE.CylinderGeometry(0.35, 0.45, 2, 8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#a63d35', { roughness: 0.6 }))).position.set(-6.5, 6.5, 0);
        var fCapGeo = new THREE.CylinderGeometry(0.4, 0.33, 0.2, 8);
        addToShip(new THREE.Mesh(fCapGeo, shipMat('#1e1e1e'))).position.set(-6.5, 7.55, 0);

        // Mast with radar
        var mastGeo = new THREE.CylinderGeometry(0.04, 0.06, 2.5, 6);
        addToShip(new THREE.Mesh(mastGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(-5.5, 8.0, 0);
        var radarGeo = new THREE.BoxGeometry(1.2, 0.06, 0.25);
        addToShip(new THREE.Mesh(radarGeo, shipMat('#94a3b8', { metalness: 0.4 }))).position.set(-5.5, 9.1, 0);

        // Deck railing
        addDeckRailing(THREE, { startX: -6, endX: 6, y: 3.1, z: 1.9, postCount: 7, postHeight: 0.7 });
        addDeckRailing(THREE, { startX: -6, endX: 6, y: 3.1, z: -1.9, postCount: 7, postHeight: 0.7 });

        // Bow bollards
        var bowBollardGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.25, 8);
        addToShip(new THREE.Mesh(bowBollardGeo, shipMat('#4b5563', { metalness: 0.6 }))).position.set(6, 3.2, 0.5);
        addToShip(new THREE.Mesh(bowBollardGeo.clone(), shipMat('#4b5563', { metalness: 0.6 }))).position.set(6, 3.2, -0.5);

        // Stem bar
        addStemBar(THREE, 9.5, 1.2, 3.2);
        // Anchors + hawsepipes
        addAnchor(THREE, 7.5, 2.0, 1.8, 1.0);
        addHawsepipe(THREE, 7.8, 2.6, 1.8, 1.0);
        addAnchor(THREE, 7.5, 2.0, -1.8, 1.0);
        addHawsepipe(THREE, 7.8, 2.6, -1.8, 1.0);
        // Rudder
        addRudder(THREE, -7.8, 0.8, 1.6, color);
        // Propeller + bulbous bow (kept deep so it only hints through the water)
        addPropeller(THREE, -7.3, 0.8, 0.9);
        addBulbousBow(THREE, 8.7, 0.5, 1.0, '#2c3e50');
    }

    // ── Passenger: 다층 데크, 넓은 상부구조, 큰 펀넬, 구명정, 레이더돔 ──
    function buildPassenger(THREE, color) {
        // Hull — parametric curved cross-section, elegant with light weathering
        var hullGeo = createHullGeometry(THREE, {
            length: 18, beam: 5.0, depth: 3.0,
            bowFineness: 1.5, sternFullness: 0.6
        });
        var hullMat = rustHullMat('#f8fafc', 'passenger');
        var hull = new THREE.Mesh(hullGeo, hullMat);
        hull.position.set(0, 3.4, 0);
        hullMeshRef = hull;
        addToShip(hull);

        // Multi-deck superstructure with window strips
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

            // Deck railing per level (port & starboard)
            var rlX = -0.5 + d * 0.3;
            var rlY = 3.9 + d * 1.05;
            addDeckRailing(THREE, { startX: rlX - 4, endX: rlX + 4, y: rlY, z: deckDepths[d] / 2 + 0.02, postCount: 5, postHeight: 0.5, color: '#d4d4d8' });
            addDeckRailing(THREE, { startX: rlX - 4, endX: rlX + 4, y: rlY, z: -deckDepths[d] / 2 - 0.02, postCount: 5, postHeight: 0.5, color: '#d4d4d8' });
        }

        // Lifeboat davits (port & starboard, 3 per side on deck 2)
        var lifeboatGeo = new THREE.CylinderGeometry(0.15, 0.2, 1.2, 8);
        lifeboatGeo.rotateZ(Math.PI / 2);
        for (var lb = 0; lb < 3; lb++) {
            var lbPort = new THREE.Mesh(lifeboatGeo, shipMat('#f97316', { roughness: 0.7 }));
            lbPort.position.set(-2 + lb * 2.5, 5.0, 2.3);
            addToShip(lbPort);
            var lbStbd = new THREE.Mesh(lifeboatGeo.clone(), shipMat('#f97316', { roughness: 0.7 }));
            lbStbd.position.set(-2 + lb * 2.5, 5.0, -2.3);
            addToShip(lbStbd);
            // Davit arms
            var davitGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.0, 4);
            addToShip(new THREE.Mesh(davitGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(-2 + lb * 2.5, 5.6, 2.1);
            addToShip(new THREE.Mesh(davitGeo.clone(), shipMat('#71717a', { metalness: 0.5 }))).position.set(-2 + lb * 2.5, 5.6, -2.1);
        }

        // Bridge
        var bridgeGeo = new THREE.BoxGeometry(3, 1.5, 2.5);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#cbd5e1'))).position.set(-1, 8.2, 0);
        // Bridge wings
        var bwGeo = new THREE.BoxGeometry(0.8, 0.6, 0.5);
        addToShip(new THREE.Mesh(bwGeo, shipMat('#cbd5e1'))).position.set(-1, 8.2, 1.7);
        addToShip(new THREE.Mesh(bwGeo.clone(), shipMat('#cbd5e1'))).position.set(-1, 8.2, -1.7);

        var winGeo = new THREE.BoxGeometry(3.02, 0.4, 2.52);
        addToShip(new THREE.Mesh(winGeo, shipMat('#0ea5e9', { emissive: '#0ea5e9', emissiveIntensity: 0.8 }))).position.set(-1, 8.5, 0);

        // Funnel (large, iconic)
        var funnelGeo = new THREE.CylinderGeometry(0.6, 0.8, 3, 12);
        addToShip(new THREE.Mesh(funnelGeo, shipMat(color))).position.set(-3, 8.5, 0);
        var topGeo = new THREE.CylinderGeometry(0.7, 0.6, 0.5, 12);
        addToShip(new THREE.Mesh(topGeo, shipMat('#1e293b'))).position.set(-3, 10.1, 0);

        // Radar dome on top of bridge
        var radarDomeGeo = new THREE.SphereGeometry(0.4, 12, 8);
        addToShip(new THREE.Mesh(radarDomeGeo, shipMat('#e2e8f0', { roughness: 0.3 }))).position.set(-1, 9.3, 0);

        // Mast with antennae
        var mastGeo = new THREE.CylinderGeometry(0.04, 0.06, 2, 6);
        addToShip(new THREE.Mesh(mastGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(-1, 10.0, 0);
        var antGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.6, 4);
        antGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(antGeo, shipMat('#a1a1aa'))).position.set(-1, 10.8, 0);

        // Pool area on top deck (cyan rectangle)
        var poolGeo = new THREE.BoxGeometry(1.5, 0.05, 1.2);
        addToShip(new THREE.Mesh(poolGeo, shipMat('#22d3ee', { emissive: '#22d3ee', emissiveIntensity: 0.3, roughness: 0.2 }))).position.set(2, 7.6, 0);

        // Bow mooring
        var bowBollGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.25, 8);
        addToShip(new THREE.Mesh(bowBollGeo, shipMat('#4b5563', { metalness: 0.6 }))).position.set(7.5, 3.1, 0.5);
        addToShip(new THREE.Mesh(bowBollGeo.clone(), shipMat('#4b5563', { metalness: 0.6 }))).position.set(7.5, 3.1, -0.5);

        // Stem bar
        addStemBar(THREE, 10.5, 1.0, 3.2);
        // Anchors + hawsepipes
        addAnchor(THREE, 8.5, 2.0, 2.2, 0.9);
        addHawsepipe(THREE, 8.8, 2.6, 2.2, 0.9);
        addAnchor(THREE, 8.5, 2.0, -2.2, 0.9);
        addHawsepipe(THREE, 8.8, 2.6, -2.2, 0.9);
        // Rudder
        addRudder(THREE, -7.8, 0.6, 1.6, '#cbd5e1');
        // Propeller + bulbous bow (kept deep so it only hints through the water)
        addPropeller(THREE, -8.2, 0.8, 1.0);
        addBulbousBow(THREE, 9.2, 0.5, 1.1, '#f8fafc');
    }

    // ── Fishing: 작은 선체, 아웃리거/붐, 마스트, A프레임, 그물드럼, 항해등 ──
    function buildFishing(THREE, color) {
        // Hull — parametric curved cross-section with heavy weathering
        var hullGeo = createHullGeometry(THREE, {
            length: 10, beam: 2.8, depth: 2.0,
            bowFineness: 1.5, sternFullness: 0.8
        });
        var hullMat = rustHullMat('#2c5f94', 'fishing');
        var hull = new THREE.Mesh(hullGeo, hullMat);
        hull.position.set(0, 2.5, 0);
        hullMeshRef = hull;
        addToShip(hull);

        var deckGeo = new THREE.BoxGeometry(8, 0.15, 2.8);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#4b5563'))).position.set(0.5, 2.5, 0);

        // Bulwark (raised hull edges)
        var bulwarkGeo = new THREE.BoxGeometry(7, 0.4, 0.08);
        addToShip(new THREE.Mesh(bulwarkGeo, shipMat('#cbd5e1', { roughness: 0.7 }))).position.set(0.5, 2.8, 1.4);
        addToShip(new THREE.Mesh(bulwarkGeo.clone(), shipMat('#cbd5e1', { roughness: 0.7 }))).position.set(0.5, 2.8, -1.4);

        // Bridge (with roof) — white wheelhouse
        var bridgeGeo = new THREE.BoxGeometry(2, 1.8, 2);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#dde3e8', { roughness: 0.65 }))).position.set(-2, 3.5, 0);
        var roofGeo = new THREE.BoxGeometry(2.2, 0.1, 2.2);
        addToShip(new THREE.Mesh(roofGeo, shipMat('#52525b'))).position.set(-2, 4.45, 0);

        // Windows (front + sides)
        var winGeo = new THREE.BoxGeometry(0.1, 0.35, 1.5);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-0.95, 3.7, 0);
        var winSideGeo = new THREE.BoxGeometry(1.2, 0.3, 0.08);
        addToShip(new THREE.Mesh(winSideGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-2, 3.7, 1.02);
        addToShip(new THREE.Mesh(winSideGeo.clone(), shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-2, 3.7, -1.02);

        // Mast
        var mastGeo = new THREE.CylinderGeometry(0.04, 0.06, 5, 6);
        addToShip(new THREE.Mesh(mastGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(0, 5.0, 0);

        // Navigation light on mast top
        var navLightGeo = new THREE.SphereGeometry(0.08, 6, 6);
        addToShip(new THREE.Mesh(navLightGeo, shipMat('#22c55e', { emissive: '#22c55e', emissiveIntensity: 1.0 }))).position.set(0, 7.5, 0);

        // Cross-tree on mast
        var crossTreeGeo = new THREE.CylinderGeometry(0.02, 0.02, 1.5, 4);
        crossTreeGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(crossTreeGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(0, 6.5, 0);

        // Outrigger booms — thick enough to read in silhouette
        var boomGeo = new THREE.CylinderGeometry(0.06, 0.09, 5, 6);
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

        // A-frame at stern
        var aFrameGeo = new THREE.CylinderGeometry(0.07, 0.1, 2.5, 6);
        var aFrame1 = new THREE.Mesh(aFrameGeo, shipMat('#fbbf24', { metalness: 0.5 }));
        aFrame1.position.set(-3.8, 3.5, 0.6);
        aFrame1.rotation.z = -0.2;
        addToShip(aFrame1);
        var aFrame2 = new THREE.Mesh(aFrameGeo.clone(), shipMat('#fbbf24', { metalness: 0.5 }));
        aFrame2.position.set(-3.8, 3.5, -0.6);
        aFrame2.rotation.z = -0.2;
        addToShip(aFrame2);
        // A-frame cross bar
        var aCrossGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.3, 4);
        aCrossGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(aCrossGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-4.1, 4.6, 0);

        // Net reel (larger, more detailed)
        var reelGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.5, 10);
        reelGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(reelGeo, shipMat('#6b7280', { metalness: 0.4 }))).position.set(-3.5, 2.8, 0);
        // Reel flanges
        var flangeGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.05, 10);
        flangeGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(flangeGeo, shipMat('#52525b', { metalness: 0.5 }))).position.set(-3.5, 2.8, 0.75);
        addToShip(new THREE.Mesh(flangeGeo.clone(), shipMat('#52525b', { metalness: 0.5 }))).position.set(-3.5, 2.8, -0.75);

        // Exhaust stack (small)
        var exhaustGeo = new THREE.CylinderGeometry(0.12, 0.15, 0.8, 6);
        addToShip(new THREE.Mesh(exhaustGeo, shipMat('#27272a'))).position.set(-2.5, 4.8, 0);

        // Deck bollards
        var bollGeo = new THREE.CylinderGeometry(0.06, 0.08, 0.2, 6);
        addToShip(new THREE.Mesh(bollGeo, shipMat('#374151', { metalness: 0.6 }))).position.set(3.5, 2.7, 0.8);
        addToShip(new THREE.Mesh(bollGeo.clone(), shipMat('#374151', { metalness: 0.6 }))).position.set(3.5, 2.7, -0.8);

        // Stem bar
        addStemBar(THREE, 5.5, 1.0, 2.8);
        // Anchor (port only — small vessel)
        addAnchor(THREE, 4.5, 1.8, 1.2, 0.7);
        addHawsepipe(THREE, 4.7, 2.3, 1.2, 0.7);
        // Rudder
        addRudder(THREE, -4.5, 0.6, 1.2, color);
        // Propeller
        addPropeller(THREE, -4.1, 0.7, 0.5);
    }

    // ── Military: 날렵한 선체, 스텔스 상부구조, 무장, CIWS, 헬기패드, 레이더 ──
    function buildMilitary(THREE, color) {
        // Hull — parametric, sharp knife bow with minimal weathering
        var hullGeo = createHullGeometry(THREE, {
            length: 18, beam: 3.2, depth: 2.5,
            bowFineness: 2.5, sternFullness: 0.5
        });
        var hullMat = rustHullMat('#9ca3af', 'military');
        var hull = new THREE.Mesh(hullGeo, hullMat);
        hull.position.set(0, 2.9, 0);
        hullMeshRef = hull;
        addToShip(hull);

        var deckGeo = new THREE.BoxGeometry(15, 0.15, 3.2);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#4b5563'))).position.set(0.5, 2.9, 0);

        // Stealth superstructure (angled facets)
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

        // Uniform haze gray like a real warship — superstructure matches the hull tone
        var superGeo = new THREE.ExtrudeGeometry(superShape, { depth: 2.5, bevelEnabled: false });
        superGeo.rotateX(-Math.PI / 2);
        var superstructure = new THREE.Mesh(superGeo, shipMat('#8a929b', { roughness: 0.65 }));
        superstructure.position.set(-2, 3.0, -1.25);
        addToShip(superstructure);

        // Bridge upper tier
        var bridgeUpperGeo = new THREE.BoxGeometry(3.5, 0.8, 2.5);
        addToShip(new THREE.Mesh(bridgeUpperGeo, shipMat('#959da6', { roughness: 0.65 }))).position.set(-2, 5.7, 0);

        // Windows
        var winGeo = new THREE.BoxGeometry(3.5, 0.2, 2.3);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(-2, 5.9, 0);

        // Forward gun turret (detailed)
        var turretBase = new THREE.CylinderGeometry(0.6, 0.7, 0.5, 12);
        addToShip(new THREE.Mesh(turretBase, shipMat('#4b5563', { metalness: 0.5 }))).position.set(4, 3.3, 0);
        // Gun shield
        var shieldGeo = new THREE.SphereGeometry(0.5, 8, 6, 0, Math.PI, 0, Math.PI / 2);
        shieldGeo.rotateZ(Math.PI / 2);
        addToShip(new THREE.Mesh(shieldGeo, shipMat('#4b5563', { metalness: 0.5 }))).position.set(4.3, 3.5, 0);
        var barrelGeo = new THREE.CylinderGeometry(0.06, 0.08, 2.5, 6);
        barrelGeo.rotateZ(-Math.PI / 2);
        addToShip(new THREE.Mesh(barrelGeo, shipMat('#374151', { metalness: 0.6 }))).position.set(5.5, 3.5, 0);

        // CIWS (close-in weapon system) on stern superstructure
        var ciwsBase = new THREE.CylinderGeometry(0.25, 0.3, 0.4, 8);
        addToShip(new THREE.Mesh(ciwsBase, shipMat('#52525b', { metalness: 0.5 }))).position.set(-4.5, 5.5, 0);
        var ciwsBarrelGeo = new THREE.CylinderGeometry(0.03, 0.04, 1.0, 6);
        ciwsBarrelGeo.rotateZ(-Math.PI / 4);
        addToShip(new THREE.Mesh(ciwsBarrelGeo, shipMat('#374151', { metalness: 0.7 }))).position.set(-4.1, 6.0, 0);
        // CIWS radome
        var ciwsDomeGeo = new THREE.SphereGeometry(0.2, 8, 6);
        addToShip(new THREE.Mesh(ciwsDomeGeo, shipMat('#e2e8f0', { roughness: 0.3 }))).position.set(-4.5, 5.9, 0);

        // Missile launchers (VLS cells — two banks of hatches)
        var vlsGeo = new THREE.BoxGeometry(1.5, 0.15, 1.5);
        addToShip(new THREE.Mesh(vlsGeo, shipMat('#4b5563', { roughness: 0.7 }))).position.set(2, 3.1, 0);
        // VLS cell grid lines
        for (var vi = 0; vi < 3; vi++) {
            var vLineGeo = new THREE.BoxGeometry(1.5, 0.17, 0.02);
            addToShip(new THREE.Mesh(vLineGeo, shipMat('#374151'))).position.set(2, 3.1, -0.5 + vi * 0.5);
        }

        // Mast (taller, lattice-style)
        var mastGeo = new THREE.CylinderGeometry(0.05, 0.08, 4, 6);
        addToShip(new THREE.Mesh(mastGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(-2, 7.3, 0);
        // Secondary mast strut
        var strutGeo = new THREE.CylinderGeometry(0.03, 0.03, 2.5, 4);
        strutGeo.rotateZ(0.15);
        addToShip(new THREE.Mesh(strutGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(-1.6, 6.5, 0.3);
        addToShip(new THREE.Mesh(strutGeo.clone(), shipMat('#71717a', { metalness: 0.5 }))).position.set(-1.6, 6.5, -0.3);

        // Radar arrays (phased array panels)
        var radarGeo = new THREE.BoxGeometry(0.08, 1.0, 0.8);
        addToShip(new THREE.Mesh(radarGeo, shipMat('#94a3b8', { metalness: 0.4 }))).position.set(-1.4, 7.5, 0);
        addToShip(new THREE.Mesh(radarGeo.clone(), shipMat('#94a3b8', { metalness: 0.4 }))).position.set(-2.6, 7.5, 0);
        // Rotating radar on top
        var rotRadarGeo = new THREE.BoxGeometry(2, 0.08, 0.5);
        addToShip(new THREE.Mesh(rotRadarGeo, shipMat('#94a3b8', { metalness: 0.4 }))).position.set(-2, 9.2, 0);

        // Funnel (angled, stealth-shaped) — haze gray to match
        var funnelGeo = new THREE.BoxGeometry(1.2, 1.5, 1.8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#8a929b', { roughness: 0.65 }))).position.set(-5, 4.5, 0);
        // Funnel top grill
        var grillGeo = new THREE.BoxGeometry(1.0, 0.06, 1.6);
        addToShip(new THREE.Mesh(grillGeo, shipMat('#27272a'))).position.set(-5, 5.28, 0);

        // Helicopter landing pad (stern)
        var heliPadGeo = new THREE.BoxGeometry(3, 0.05, 3);
        addToShip(new THREE.Mesh(heliPadGeo, shipMat('#4b5563', { roughness: 0.8 }))).position.set(-6, 3.0, 0);
        // "H" marking on helipad
        var hMarkGeo = new THREE.BoxGeometry(0.8, 0.06, 0.1);
        addToShip(new THREE.Mesh(hMarkGeo, shipMat('#fbbf24'))).position.set(-6, 3.05, 0.3);
        addToShip(new THREE.Mesh(hMarkGeo.clone(), shipMat('#fbbf24'))).position.set(-6, 3.05, -0.3);
        var hCrossGeo = new THREE.BoxGeometry(0.1, 0.06, 0.7);
        addToShip(new THREE.Mesh(hCrossGeo, shipMat('#fbbf24'))).position.set(-6, 3.05, 0);
        // Helipad safety net
        var netGeo = new THREE.RingGeometry(1.0, 1.05, 16);
        netGeo.rotateX(-Math.PI / 2);
        addToShip(new THREE.Mesh(netGeo, shipMat('#fbbf24', { roughness: 0.9 }))).position.set(-6, 3.06, 0);

        // Deck railing
        addDeckRailing(THREE, { startX: -6, endX: 8, y: 3.0, z: 1.6, postCount: 8, postHeight: 0.6, color: '#71717a' });
        addDeckRailing(THREE, { startX: -6, endX: 8, y: 3.0, z: -1.6, postCount: 8, postHeight: 0.6, color: '#71717a' });

        // Stem bar (sharp bow edge)
        addStemBar(THREE, 10.5, 1.2, 3.0);
        // Anchors + hawsepipes
        addAnchor(THREE, 8.5, 2.0, 1.5, 0.9);
        addHawsepipe(THREE, 8.8, 2.6, 1.5, 0.9);
        addAnchor(THREE, 8.5, 2.0, -1.5, 0.9);
        addHawsepipe(THREE, 8.8, 2.6, -1.5, 0.9);
        // Twin rudders (warship)
        var twinRudderMat = shipMat('#6b7280', { roughness: 0.7 });
        var rBlade1 = new THREE.BoxGeometry(0.45, 1.4, 0.05);
        addToShip(new THREE.Mesh(rBlade1, twinRudderMat)).position.set(-7.8, 0.8, 0.5);
        addToShip(new THREE.Mesh(rBlade1.clone(), twinRudderMat)).position.set(-7.8, 0.8, -0.5);
        // Sonar dome (instead of bulbous bow)
        var sonarGeo = new THREE.SphereGeometry(0.5, 10, 8);
        sonarGeo.scale(1.5, 0.8, 0.8);
        addToShip(new THREE.Mesh(sonarGeo, shipMat('#52525b', { roughness: 0.4 }))).position.set(10.5, 1.0, 0);
        // Twin screws matching the twin rudders
        addPropeller(THREE, -7.4, 0.8, 0.75, 0.5);
        addPropeller(THREE, -7.4, 0.8, 0.75, -0.5);
    }

    // ── Tug: 짧고 넓은 선체, 큰 브릿지, 예인 장비, 푸시니, 서치라이트 ──
    function buildTug(THREE, color) {
        // Hull — parametric, bluff bow, wide with heavy weathering
        var hullGeo = createHullGeometry(THREE, {
            length: 8, beam: 3.6, depth: 2.8,
            bowFineness: 0.8, sternFullness: 0.9
        });
        var hullMat = rustHullMat('#7a2e25', 'tug');
        var hull = new THREE.Mesh(hullGeo, hullMat);
        hull.position.set(0, 3.0, 0);
        hullMeshRef = hull;
        addToShip(hull);

        var deckGeo = new THREE.BoxGeometry(6, 0.2, 3.2);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#4b5563'))).position.set(0.5, 3.0, 0);

        // Push knees (reinforced bow plates)
        var kneeGeo = new THREE.BoxGeometry(0.3, 1.5, 3.0);
        addToShip(new THREE.Mesh(kneeGeo, shipMat('#374151', { roughness: 0.8, metalness: 0.3 }))).position.set(3.5, 2.5, 0);

        // Bridge (tall, good visibility) — cream wheelhouse over the red hull
        var bridgeGeo = new THREE.BoxGeometry(2.5, 2.8, 2.8);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#e6e1d3', { roughness: 0.65 }))).position.set(0, 4.5, 0);
        // Bridge roof
        var roofGeo = new THREE.BoxGeometry(2.8, 0.12, 3.0);
        addToShip(new THREE.Mesh(roofGeo, shipMat('#52525b'))).position.set(0, 5.96, 0);

        // Windows (wrap-around for 360° visibility)
        var winFront = new THREE.BoxGeometry(0.1, 0.5, 2.2);
        addToShip(new THREE.Mesh(winFront, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(1.3, 4.8, 0);
        var winBack = new THREE.BoxGeometry(0.1, 0.4, 1.8);
        addToShip(new THREE.Mesh(winBack, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-1.3, 4.8, 0);
        var winSide1 = new THREE.BoxGeometry(2, 0.5, 0.1);
        addToShip(new THREE.Mesh(winSide1, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(0, 4.8, 1.45);
        addToShip(new THREE.Mesh(winSide1.clone(), shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(0, 4.8, -1.45);

        // Searchlight on roof
        var slBaseGeo = new THREE.CylinderGeometry(0.12, 0.15, 0.2, 8);
        addToShip(new THREE.Mesh(slBaseGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(0.8, 6.15, 0);
        var slLampGeo = new THREE.CylinderGeometry(0.08, 0.12, 0.2, 8);
        slLampGeo.rotateZ(-Math.PI / 2);
        addToShip(new THREE.Mesh(slLampGeo, shipMat('#fbbf24', { emissive: '#fbbf24', emissiveIntensity: 0.4 }))).position.set(1.0, 6.25, 0);

        // Funnel (with rain cap)
        var funnelGeo = new THREE.CylinderGeometry(0.35, 0.4, 1.5, 8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#1e293b'))).position.set(-1.5, 5.5, 0);
        var fCapGeo = new THREE.CylinderGeometry(0.4, 0.33, 0.15, 8);
        addToShip(new THREE.Mesh(fCapGeo, shipMat('#0f0f0f'))).position.set(-1.5, 6.3, 0);

        // Mast with antenna
        var mastGeo = new THREE.CylinderGeometry(0.03, 0.04, 1.5, 4);
        addToShip(new THREE.Mesh(mastGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(0, 6.8, 0);
        var antGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.5, 4);
        antGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(antGeo, shipMat('#a1a1aa'))).position.set(0, 7.4, 0);

        // Towing winch (larger, detailed)
        var winchGeo = new THREE.CylinderGeometry(0.4, 0.4, 1.2, 10);
        winchGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(winchGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-2.5, 3.3, 0);
        // Winch flanges
        var wFlangeGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.05, 10);
        wFlangeGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(wFlangeGeo, shipMat('#d97706', { metalness: 0.5 }))).position.set(-2.5, 3.3, 0.6);
        addToShip(new THREE.Mesh(wFlangeGeo.clone(), shipMat('#d97706', { metalness: 0.5 }))).position.set(-2.5, 3.3, -0.6);

        // Towing bitts
        var bittGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.6, 6);
        addToShip(new THREE.Mesh(bittGeo, shipMat('#374151', { metalness: 0.6 }))).position.set(-3, 3.3, 0.5);
        addToShip(new THREE.Mesh(bittGeo.clone(), shipMat('#374151', { metalness: 0.6 }))).position.set(-3, 3.3, -0.5);

        // Stern tow hook
        var hookGeo = new THREE.TorusGeometry(0.15, 0.04, 6, 8, Math.PI);
        hookGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(hookGeo, shipMat('#374151', { metalness: 0.7 }))).position.set(-3.2, 3.4, 0);

        // Tire fenders (rubber bumpers, port & starboard)
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

        // Bow bollards
        var bowBollGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.25, 8);
        addToShip(new THREE.Mesh(bowBollGeo, shipMat('#4b5563', { metalness: 0.6 }))).position.set(2.5, 3.2, 0.8);
        addToShip(new THREE.Mesh(bowBollGeo.clone(), shipMat('#4b5563', { metalness: 0.6 }))).position.set(2.5, 3.2, -0.8);

        // Stem bar
        addStemBar(THREE, 4.5, 1.2, 3.2);
        // Anchor (port only — small vessel)
        addAnchor(THREE, 3.5, 1.8, 1.6, 0.7);
        addHawsepipe(THREE, 3.7, 2.4, 1.6, 0.7);
        // Rudder
        addRudder(THREE, -3.5, 0.6, 1.4, color);
        // Propeller (oversized for bollard pull, like a real tug)
        addPropeller(THREE, -3.1, 0.7, 0.7);
    }

    // ── Generic/Unknown: 소형 다목적 선박 — 둥근 선체, 중앙 캐빈, 작업 데크, 레일링 ──
    function buildGenericShip(THREE, color) {
        // Hull — parametric curved cross-section with weathering
        var hullGeo = createHullGeometry(THREE, {
            length: 11, beam: 3.2, depth: 2.5,
            bowFineness: 1.2, sternFullness: 0.7
        });
        var hullMat = rustHullMat('#454c54', 'other');
        var hull = new THREE.Mesh(hullGeo, hullMat);
        hull.position.set(0, 2.8, 0);
        hullMeshRef = hull;
        addToShip(hull);

        // Flat work deck
        var deckGeo = new THREE.BoxGeometry(10, 0.15, 3.2);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#52525b'))).position.set(0, 2.8, 0);

        // Bulwark (raised edges around deck)
        var bulwarkGeo = new THREE.BoxGeometry(9, 0.35, 0.06);
        addToShip(new THREE.Mesh(bulwarkGeo, shipMat('#cbd5e1', { roughness: 0.7 }))).position.set(0, 3.05, 1.6);
        addToShip(new THREE.Mesh(bulwarkGeo.clone(), shipMat('#cbd5e1', { roughness: 0.7 }))).position.set(0, 3.05, -1.6);

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

        // Antenna on roof
        var antGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.2, 4);
        addToShip(new THREE.Mesh(antGeo, shipMat('#a1a1aa'))).position.set(-0.5, 5.6, 0);
        // Navigation light on antenna
        var navLightGeo = new THREE.SphereGeometry(0.06, 6, 6);
        addToShip(new THREE.Mesh(navLightGeo, shipMat('#22c55e', { emissive: '#22c55e', emissiveIntensity: 1.0 }))).position.set(-0.5, 6.2, 0);

        // Exhaust pipe
        var exhaustGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.6, 6);
        addToShip(new THREE.Mesh(exhaustGeo, shipMat('#27272a'))).position.set(-1.2, 5.2, 0);

        // Forward bollards
        for (var fb = 0; fb < 2; fb++) {
            var bollGeo = new THREE.CylinderGeometry(0.12, 0.15, 0.4, 8);
            addToShip(new THREE.Mesh(bollGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(4 - fb * 1.5, 3.1, 0);
        }

        // Railing around deck (port & starboard)
        addDeckRailing(THREE, { startX: -4, endX: 4, y: 2.9, z: 1.6, postCount: 5, postHeight: 0.8 });
        addDeckRailing(THREE, { startX: -4, endX: 4, y: 2.9, z: -1.6, postCount: 5, postHeight: 0.8 });

        // Stern railing (across beam)
        var sternRailMat = shipMat('#a1a1aa', { metalness: 0.4, roughness: 0.6 });
        var sRailPostGeo = new THREE.CylinderGeometry(0.02, 0.025, 0.8, 4);
        for (var sp = -1; sp <= 1; sp++) {
            addToShip(new THREE.Mesh(sRailPostGeo, sternRailMat)).position.set(-4.5, 3.3, sp * 1.0);
        }
        var sTopGeo = new THREE.CylinderGeometry(0.015, 0.015, 2.2, 4);
        sTopGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(sTopGeo, sternRailMat)).position.set(-4.5, 3.7, 0);
        var sMidGeo = new THREE.CylinderGeometry(0.012, 0.012, 2.2, 4);
        sMidGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(sMidGeo, sternRailMat)).position.set(-4.5, 3.3, 0);

        // Deck equipment (small crane/davit)
        var davitGeo = new THREE.CylinderGeometry(0.04, 0.05, 1.5, 6);
        davitGeo.rotateZ(0.3);
        addToShip(new THREE.Mesh(davitGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(2.5, 3.6, 0.8);

        // Stem bar
        addStemBar(THREE, 6.5, 1.2, 3.0);
        // Anchor (port only)
        addAnchor(THREE, 5.0, 1.8, 1.4, 0.8);
        addHawsepipe(THREE, 5.2, 2.4, 1.4, 0.8);
        // Rudder
        addRudder(THREE, -5.5, 0.6, 1.2, color);
        // Propeller
        addPropeller(THREE, -5.1, 0.7, 0.6);
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
            updateCameraPresetAnim(elapsed);
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

            // Weather-dynamic fog & clouds
            var wxDyn = getWeatherModifiers();
            if (scene.fog) scene.fog.density = wxDyn.fogDensity;
            if (_cloudSprites) {
                for (var ci = 0; ci < _cloudSprites.length; ci++) {
                    var cs = _cloudSprites[ci];
                    cs.mat.opacity = Math.min(1, cs.baseOpacity * (wxDyn.cloudOpacity / 0.5));
                }
            }

            // Speed is now updated via updateCanvasHUD

            // Advance simulated wave time (separate from elapsed so timeScale only affects waves, not clouds/water)
            simWaveTime += dt * _timeScale;

            // Roll & Pitch calculation — scaled by wave height (2m baseline)
            var waveScale = Math.max(weather.waveHeight / 2.0, 0.3);
            var freqScale = weather.wavePeriod ? (8 / weather.wavePeriod) : 1;

            // Base wave-induced roll — primary swell + secondary + tertiary harmonics
            // (no Math.random — deterministic harmonics prevent per-frame jitter)
            var w1 = simWaveTime * rollParams.freq * Math.PI * 2 * freqScale;

            // Resonance amplification — when wave period approaches the ship's
            // natural roll period, each successive wave reinforces the swing
            // instead of cancelling. Real ships see 2-4x amplitude at resonance.
            // Matches the panel's _resonanceRisk thresholds for visual consistency.
            var resonanceMult = 1.0;
            if (naturalRollPeriod && weather.wavePeriod) {
                var dT = Math.abs(naturalRollPeriod - weather.wavePeriod);
                if (dT < 1.0) resonanceMult = 3.5;        // 공진 위험
                else if (dT < 2.5) resonanceMult = 1.8;   // 공진 주의
            }

            var primaryRoll = rollParams.amp * waveScale * resonanceMult * Math.sin(w1);
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
            var rawPitch = (rollParams.amp * 0.35) * pitchScale * Math.sin(w1 * 0.6)
                + rollParams.amp * 0.12 * pitchScale * Math.sin(w1 * 1.3 + 0.8);

            // Smooth roll & pitch — exponential lerp removes any remaining jitter
            var motionLerp = 1 - Math.pow(0.015, dt);  // ~τ=0.24s, smooth but responsive
            smoothRoll += (rawRoll - smoothRoll) * motionLerp;
            smoothPitch += (rawPitch - smoothPitch) * motionLerp;

            // ── Capsize override — ship rolls onto its side and floats there ──
            // During the optional pre-roll delay, the normal physics (turn heel,
            // wave roll) is left untouched so the build-up is visible.
            var capsizeSinkY = 0;
            if (_capsize) {
                if (_capsize.startTime === null) _capsize.startTime = elapsed;
                var ct = elapsed - _capsize.startTime - (_capsize.delay || 0);
                if (ct >= 0) {
                    _capsize.armed = true;
                    var capRollDeg;
                    if (ct < 3.5) {
                        var u1 = ct / 3.5;
                        capRollDeg = 90 * (u1 * u1);                    // 0° → 90° (ease-in past PoNR)
                        capsizeSinkY = 0;
                    } else if (ct < 6.5) {
                        var u2 = (ct - 3.5) / 3.0;
                        capRollDeg = 90 + 15 * u2;                      // 90° → 105°
                        capsizeSinkY = 0.6 * u2;
                    } else {
                        var capBob = 3 * Math.sin((ct - 6.5) * 0.6);    // ±3° bob
                        capRollDeg = 105 + capBob;
                        capsizeSinkY = 0.6;
                    }
                    smoothRoll = _capsize.direction * capRollDeg;
                    _capsize.sinkY = capsizeSinkY;
                }
                // ct < 0 → still in the pre-capsize delay; no roll override yet.
            }

            // ── Apply ship world position + rotations ──
            if (shipGroup) {
                shipGroup.position.x = shipWorldPos.x;
                shipGroup.position.z = shipWorldPos.z;
                shipGroup.position.y = -0.8 + weather.waveHeight * 0.1 * Math.sin(elapsed * 0.8) + capsizeSinkY;
                shipGroup.rotation.y = headingRad;
                shipGroup.rotation.x = smoothRoll * (Math.PI / 180);
                shipGroup.rotation.z = smoothPitch * (Math.PI / 180);
                if (shipGroupPred) {
                    shipGroupPred.position.copy(shipGroup.position);
                    shipGroupPred.rotation.y = headingRad;
                    shipGroupPred.rotation.x = smoothPredRoll * (Math.PI / 180);
                    shipGroupPred.rotation.z = smoothPredPitch * (Math.PI / 180);
                }
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

            // ── 예측값 산출 (모델 seam) ──
            if (window.RollPrediction) {
                var _pred = RollPrediction.predictRoll(
                    { roll: smoothRoll, pitch: smoothPitch },
                    { seed: shipType, t: elapsed }
                );
                predRoll = _pred.roll;
                predPitch = _pred.pitch;
                smoothPredRoll += (predRoll - smoothPredRoll) * motionLerp;
                smoothPredPitch += (predPitch - smoothPredPitch) * motionLerp;
                // 예측 이력은 예측이 실제로 산출될 때만 쌓는다 (모듈 부재 시 0-시리즈 방지)
                predRollHistory.push(Math.abs(smoothPredRoll));
                if (predRollHistory.length > 60) predRollHistory.shift();
                predPitchHistory.push(Math.abs(smoothPredPitch));
                if (predPitchHistory.length > 60) predPitchHistory.shift();
            }
            var absRoll = Math.abs(smoothRoll);
            var absPitch = Math.abs(smoothPitch);
            updateRollGaugeBy('rv-real-gauge', 'rv-real-fill', 'rv-real-roll', absRoll);
            updateRollGaugeBy('rv-pred-gauge', 'rv-pred-fill', 'rv-pred-roll', Math.abs(smoothPredRoll));
            if (window.RollPrediction) {
                var _d = RollPrediction.computeDelta(
                    { roll: smoothRoll, pitch: smoothPitch },
                    { roll: smoothPredRoll, pitch: smoothPredPitch }
                );
                var dRollEl = document.getElementById('rv-d-roll');
                var dPitchEl = document.getElementById('rv-d-pitch');
                var rmseEl = document.getElementById('rv-rmse');
                if (dRollEl) {
                    dRollEl.textContent = Math.abs(_d.dRoll).toFixed(1) + '°';
                    dRollEl.className = 'rv-metric-val ' + (Math.abs(_d.dRoll) < 2 ? 'rv-ok' : Math.abs(_d.dRoll) < 5 ? 'rv-warn' : 'rv-bad');
                }
                if (dPitchEl) dPitchEl.textContent = Math.abs(_d.dPitch).toFixed(1) + '°';
                if (rmseEl) rmseEl.textContent = RollPrediction.computeRMSE(rollHistory, predRollHistory).toFixed(1) + '°';
            }
            updateCanvasHUD(absRoll, absPitch, smoothSpeed);

            // Encounter period drifts with heading/speed — 2Hz is plenty for the panel
            _analysisAccum += dt;
            if (_analysisAccum >= 0.5) {
                _analysisAccum = 0;
                updateAnalysis();
            }

            // Push to history, cap at 60
            rollHistory.push(absRoll);
            if (rollHistory.length > 60) rollHistory.shift();
            pitchHistory.push(absPitch);
            if (pitchHistory.length > 60) pitchHistory.shift();

            // ── Camera roll sync — tilt camera with ship roll ──
            var camRollRad = smoothRoll * (Math.PI / 180) * 0.3;  // 30% of ship roll
            camera.up.set(Math.sin(camRollRad), Math.cos(camRollRad), 0);

            if (controls) controls.update();

            // Update God Rays sun screen position
            if (godRaysShaderPass && sunPosition) {
                var sunWorld = sunPosition.clone().multiplyScalar(100);
                sunWorld.add(new THREE.Vector3(shipWorldPos.x, 0, shipWorldPos.z));
                var sunScreen = sunWorld.clone().project(camera);
                godRaysShaderPass.uniforms['lightPos'].value.set(
                    (sunScreen.x + 1) / 2,
                    (sunScreen.y + 1) / 2
                );
            }

            if (splitView) {
                renderSplit();
            } else if (composer) {
                composer.render();
            } else if (renderer && scene && camera) {
                renderer.render(scene, camera);
            }
        }

        loop();
    }

    // ── buildInfoPanel(ship) ──
    // Estimate natural roll period from ship beam (rough approximation, T = 0.85·B/√GM, GM ≈ 0.05·B)
    function _estimateRollPeriod(ship, shipTypeKey) {
        var beam = parseFloat(ship.beam) || 0;
        if (beam > 0) {
            var gm = 0.05 * beam;
            return 0.85 * beam / Math.sqrt(gm);
        }
        var freq = (ROLL_PARAMS[shipTypeKey] && ROLL_PARAMS[shipTypeKey].freq) || 0.08;
        return 1.0 / freq;
    }

    function _resonanceRisk(naturalPeriod, wavePeriod) {
        if (!wavePeriod || wavePeriod <= 0) return { level: 'safe', label: '판정 불가' };
        var delta = Math.abs(naturalPeriod - wavePeriod);
        if (delta < 1.0) return { level: 'danger', label: '공진 위험' };
        if (delta < 2.5) return { level: 'caution', label: '공진 주의' };
        return { level: 'safe', label: '안전 범위' };
    }

    // Encounter period Te = Tw / (1 − 2π·U·cos(μ)/(g·Tw)) — μ is the angle between
    // wave propagation and ship heading (0 = following seas, 180 = head seas).
    function _encounterPeriod(waveT, speedKt, relAngleDeg) {
        if (!waveT || waveT <= 0) return 0;
        var U = speedKt * 0.5144;
        var mu = relAngleDeg * Math.PI / 180;
        var denom = 1 - (2 * Math.PI * U * Math.cos(mu)) / (9.81 * waveT);
        // Ship riding the waves at their own speed — encounter period diverges
        if (Math.abs(denom) < 0.02) return Infinity;
        return Math.abs(waveT / denom);
    }

    var ANALYSIS_AXIS_MAX = 24; // seconds — full width of the period axis

    function _periodPct(t) {
        return Math.max(0, Math.min(100, t / ANALYSIS_AXIS_MAX * 100));
    }

    // One-sentence explanation of WHY the current verdict was reached — shown under
    // the period axis so the badge is never unexplained.
    function _analysisReason(naturalP, te, risk) {
        if (!te || !isFinite(te)) return '파주기 정보가 없어 공진 위험을 판정할 수 없습니다.';
        var d = Math.abs(naturalP - te).toFixed(1);
        var base = '현재 속력·침로에서 배가 파도를 만나는 주기(조우주기)는 ' + te.toFixed(1) + 's. ';
        if (risk.level === 'danger') {
            return base + '선체가 스스로 흔들리는 고유주기(' + naturalP.toFixed(1) + 's)와 ' + d + 's 차이 — 매 파도가 횡요를 증폭시키는 공진 구간입니다.';
        }
        if (risk.level === 'caution') {
            return base + '선체 고유주기(' + naturalP.toFixed(1) + 's)와 ' + d + 's 차이로 공진 구간에 근접해 있습니다.';
        }
        return base + '선체 고유주기(' + naturalP.toFixed(1) + 's)와 ' + d + 's 떨어져 있어 공진 가능성이 낮습니다.';
    }

    // Refresh the live parts of the ANALYSIS section: encounter period shifts with
    // speed/heading (turn scenario) and weather overrides, so resonance is judged
    // on Te vs the natural period, not the raw wave period.
    var _analysisAccum = 0;

    function updateAnalysis() {
        var teEl = document.getElementById('rv-an-te');
        if (!teEl) return;

        var waveT = (weather && weather.wavePeriod) || 0;
        var relAngle = ((weather && weather.waveDirection) || 0) - (turnScenarioActive ? turnHeading : 0);
        var te = _encounterPeriod(waveT, shipSpeed, relAngle);
        var risk = _resonanceRisk(naturalRollPeriod, isFinite(te) ? te : 0);
        var margin = (isFinite(te) && te > 0) ? Math.abs(naturalRollPeriod - te) : null;

        teEl.textContent = !te ? '-' : (isFinite(te) ? te.toFixed(1) + ' s' : '∞');

        var marginEl = document.getElementById('rv-an-margin');
        if (marginEl) {
            marginEl.textContent = margin === null ? '-' : margin.toFixed(1) + ' s';
            marginEl.className = 'rv-info-value rv-an-margin rv-an-margin-' + risk.level;
        }

        var pill = document.getElementById('rv-an-resonance');
        if (pill) {
            pill.textContent = risk.label;
            pill.className = 'rv-info-value rv-resonance rv-resonance-' + risk.level;
        }

        var marker = document.getElementById('rv-period-marker-te');
        if (marker) {
            marker.style.left = _periodPct(isFinite(te) ? te : ANALYSIS_AXIS_MAX) + '%';
            marker.setAttribute('data-level', risk.level);
        }

        var note = document.getElementById('rv-an-note');
        if (note) note.textContent = _analysisReason(naturalRollPeriod, te, risk);
    }

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

        // Voyage info — fall back to '-' for missing AIS fields
        var destination = (ship.destination && ship.destination !== 'UNKNOWN') ? ship.destination : '-';
        var eta = ship.eta || '-';
        var statusLabel = ship.status || '-';
        var callsign = ship.callsign || '-';
        var imo = ship.imo ? String(ship.imo) : '-';

        // Roll analysis — natural period vs the period the ship actually meets the
        // waves at (encounter period, depends on speed and heading)
        var naturalPeriod = _estimateRollPeriod(ship, typeKey);
        var wavePeriodObs = (_baseWeather && _baseWeather.wavePeriod) || 0;
        var encounterT = _encounterPeriod(wavePeriodObs, shipSpeed, (_baseWeather && _baseWeather.waveDirection) || 0);
        var resonance = _resonanceRisk(naturalPeriod, isFinite(encounterT) ? encounterT : 0);
        var marginInit = (isFinite(encounterT) && encounterT > 0) ? Math.abs(naturalPeriod - encounterT) : null;
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
            '<div class="roll-viewer-section-title">항해 정보 VOYAGE</div>' +
            '<div class="rv-info-row"><span class="rv-info-label">목적지</span><span class="rv-info-value">' + destination + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">ETA</span><span class="rv-info-value">' + eta + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">상태</span><span class="rv-info-value">' + statusLabel + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">호출부호</span><span class="rv-info-value">' + callsign + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">IMO</span><span class="rv-info-value">' + imo + '</span></div>' +
            '</div>' +
            // ROLL/PITCH sections relocated to the prediction modal on the canvas — they are
            // simulation OUTPUT, not real data. The side panel keeps only observed values.
            '<div class="roll-viewer-section">' +
            '<div class="roll-viewer-section-title">기상 WEATHER</div>' +
            '<div class="rv-info-row"><span class="rv-info-label">풍속</span><span class="rv-info-value" id="rv-weather-wind">' + weather.windSpeed + ' kt</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">파고</span><span class="rv-info-value" id="rv-weather-wave">' + weather.waveHeight + ' m</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">주기</span><span class="rv-info-value" id="rv-weather-period">' + weather.wavePeriod + ' s</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">파향</span><span class="rv-info-value" id="rv-weather-direction">' + Math.round(weather.waveDirection) + '°</span></div>' +
            '</div>' +
            '<div class="roll-viewer-section">' +
            '<div class="roll-viewer-section-title">횡요각 분석 ANALYSIS</div>' +
            '<div class="rv-info-row"><span class="rv-info-label">고유 횡요주기</span><span class="rv-info-value">' + naturalPeriod.toFixed(1) + ' s</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">파주기</span><span class="rv-info-value">' + (wavePeriodObs ? wavePeriodObs.toFixed(0) + ' s' : '-') + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">조우주기</span><span class="rv-info-value" id="rv-an-te">' + (encounterT ? (isFinite(encounterT) ? encounterT.toFixed(1) + ' s' : '∞') : '-') + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">공진 여유</span><span class="rv-info-value rv-an-margin rv-an-margin-' + resonance.level + '" id="rv-an-margin">' + (marginInit === null ? '-' : marginInit.toFixed(1) + ' s') + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">공진 판정</span><span class="rv-info-value rv-resonance rv-resonance-' + resonance.level + '" id="rv-an-resonance">' + resonance.label + '</span></div>' +
            '<div class="rv-period-axis">' +
            '<div class="rv-period-track">' +
            '<div class="rv-period-zone rv-period-zone-caution" style="left:' + _periodPct(naturalPeriod - 2.5) + '%;width:' + (_periodPct(naturalPeriod + 2.5) - _periodPct(naturalPeriod - 2.5)) + '%"></div>' +
            '<div class="rv-period-zone rv-period-zone-danger" style="left:' + _periodPct(naturalPeriod - 1) + '%;width:' + (_periodPct(naturalPeriod + 1) - _periodPct(naturalPeriod - 1)) + '%"></div>' +
            '<div class="rv-period-marker rv-period-marker-tn" style="left:' + _periodPct(naturalPeriod) + '%"><span>고유</span></div>' +
            '<div class="rv-period-marker rv-period-marker-te" id="rv-period-marker-te" data-level="' + resonance.level + '" style="left:' + _periodPct(isFinite(encounterT) ? encounterT : ANALYSIS_AXIS_MAX) + '%"><span>조우</span></div>' +
            '</div>' +
            '<div class="rv-period-scale"><span>0s</span><span>6</span><span>12</span><span>18</span><span>24s</span></div>' +
            '<div class="rv-an-legend">' +
            '<span><i class="rv-an-swatch rv-an-swatch-tn"></i>고유주기</span>' +
            '<span><i class="rv-an-swatch rv-an-swatch-te"></i>조우주기</span>' +
            '<span><i class="rv-an-swatch rv-an-swatch-caution"></i>주의 ±2.5s</span>' +
            '<span><i class="rv-an-swatch rv-an-swatch-danger"></i>위험 ±1s</span>' +
            '</div>' +
            '<div class="rv-an-note" id="rv-an-note">' + _analysisReason(naturalPeriod, encounterT, resonance) + '</div>' +
            '</div>' +
            '</div>';

        return panel;
    }

    // 임의의 게이지 세트를 갱신. (gaugeId, fillId, valueId, absRoll)
    function updateRollGaugeBy(gaugeId, fillId, valueId, absRoll) {
        var gauge = document.getElementById(gaugeId);
        var fill = document.getElementById(fillId);
        var valueEl = document.getElementById(valueId);
        if (!gauge || !fill || !valueEl) return;
        fill.style.width = Math.min(absRoll / 30 * 100, 100) + '%';
        valueEl.textContent = absRoll.toFixed(1) + '°';
        var level;
        if (absRoll < 5) level = 'safe';
        else if (absRoll < 10) level = 'caution';
        else if (absRoll < 15) level = 'warning';
        else level = 'danger';
        gauge.className = 'roll-gauge roll-gauge-' + level;
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

    // ── initRollChart() ──
    // Chart container now lives on the canvas (prediction modal), not in the side panel.
    function initRollChart() {
        // Init history with 60 zeros
        rollHistory = [];
        pitchHistory = [];
        for (var i = 0; i < 60; i++) { rollHistory.push(0); pitchHistory.push(0); }
        predRollHistory = [];
        predPitchHistory = [];
        for (var k = 0; k < 60; k++) { predRollHistory.push(0); predPitchHistory.push(0); }

        var chartEl = document.getElementById('rv-roll-chart');
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
                data: ['실제', '예측'],
                right: 12, top: 0,
                textStyle: { color: '#71717a', fontSize: 10 },
                itemWidth: 12, itemHeight: 2
            },
            series: [
                {
                    name: '실제', type: 'line', smooth: true, symbol: 'none',
                    data: rollHistory.slice(),
                    lineStyle: { color: '#38bdf8', width: 2 }
                },
                {
                    name: '예측', type: 'line', smooth: true, symbol: 'none',
                    data: predRollHistory.slice(),
                    lineStyle: { color: '#fbbf24', width: 2, type: 'dashed' }
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
                    { data: predRollHistory.slice() }
                ]
            });
        }, 1000);
    }

    // 좌(실제)/우(예측) 2분할 렌더. 각 패스마다 반대편 선박을 숨긴다.
    // 두 반쪽 모두 동일한 프레이밍(선박 중앙)을 보여줘야 하므로 setViewOffset은
    // 쓰지 않고 camera.aspect + setViewport/setScissor 만으로 분할한다.
    // 주의: 분할 모드는 composer(블룸/갓레이) 경로를 우회한다 — spec 4절의 의도적 트레이드오프.
    function renderSplit() {
        var THREE = window.THREE;
        if (!renderer || !scene || !camera || !THREE) return;
        var size = renderer.getSize(new THREE.Vector2());
        var w = size.x, h = size.y;
        var leftW = Math.floor(w / 2);
        var rightW = w - leftW;

        // 패널 오프셋 등 이전 프레임의 viewOffset 잔재 제거 (분할은 전체 폭 사용)
        camera.clearViewOffset();
        renderer.setScissorTest(true);

        // 좌: 실제
        if (shipGroupPred) shipGroupPred.visible = false;
        if (shipGroup) shipGroup.visible = true;
        camera.aspect = leftW / h;
        camera.updateProjectionMatrix();
        renderer.setViewport(0, 0, leftW, h);
        renderer.setScissor(0, 0, leftW, h);
        renderer.render(scene, camera);

        // 우: 예측
        if (shipGroup) shipGroup.visible = false;
        if (shipGroupPred) shipGroupPred.visible = true;
        camera.aspect = rightW / h;
        camera.updateProjectionMatrix();
        renderer.setViewport(leftW, 0, rightW, h);
        renderer.setScissor(leftW, 0, rightW, h);
        renderer.render(scene, camera);

        // 원복: 스시저 끄고, 전체 뷰포트/aspect 복원, 두 선박 모두 보이게
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, w, h);
        if (shipGroup) shipGroup.visible = true;
        if (shipGroupPred) shipGroupPred.visible = true;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
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

        // Clear texture caches
        _rustTextureCache = {};
        _shipMatCache = {};

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
        skyMesh = null;
        sunPosition = null;
        saturationPass = null;
        godRaysShaderPass = null;
        compassGroup = null;
        cloudGroup = null;
        _cloudSprites = [];

        // Clear material cache
        _shipMatCache = {};

        seaMarkers = [];
        navLights = [];
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
        _capsize = null;
        camFollow = { x: 0, z: 0 };
        camFollowHeading = 0;
        weather = null;
        rollParams = null;
        naturalRollPeriod = null;
        currentMmsi = null;
        _baseWeather = null;
        _baseShipSpeed = null;
        _scenarioOverride = null;
        _timeScale = 1.0;
        simWaveTime = 0;
        rollHistory = [];
        pitchHistory = [];

        // Clear container DOM
        var container = getContainer();
        if (container) {
            container.innerHTML = '';
        }
    }

    // ── LLM scenario override API ──
    var _OVERRIDE_KEY_TO_ID = {
        windSpeed: 'rv-weather-wind',
        waveHeight: 'rv-weather-wave',
        wavePeriod: 'rv-weather-period',
        waveDirection: 'rv-weather-direction'
    };

    function _refreshWeatherDisplay() {
        // Side panel WEATHER section is INTENTIONALLY left untouched here.
        // It must always show observed (base) values — built once on load() — so users
        // can compare "real" vs "simulated" at a glance. The override badge/highlight
        // logic that used to color those rows has been removed for that reason.

        var ov = _scenarioOverride || {};
        var hasTimeScale = ov.timeScale !== undefined && Math.abs(_timeScale - 1.0) > 0.01;

        var weatherOverride = (ov.windSpeed !== undefined) || (ov.waveHeight !== undefined) ||
            (ov.wavePeriod !== undefined) || (ov.waveDirection !== undefined);
        var anyOverride = weatherOverride || (ov.shipSpeed !== undefined) || hasTimeScale;

        // Top-right unified scenario panel: visible when override OR turn scenario is active
        var hudScenario = document.getElementById('rv-canvas-hud-scenario');
        var panelVisible = anyOverride || turnScenarioActive;
        if (hudScenario) hudScenario.hidden = !panelVisible;

        // Override rows
        var overridesEl = document.getElementById('rv-scenario-overrides');
        if (overridesEl) {
            var rows = [];
            if (ov.windSpeed !== undefined) rows.push(['풍속', Math.round(ov.windSpeed) + ' kt']);
            if (ov.waveHeight !== undefined) rows.push(['파고', ov.waveHeight.toFixed(1) + ' m']);
            if (ov.wavePeriod !== undefined) rows.push(['파주기', Math.round(ov.wavePeriod) + ' s']);
            if (ov.waveDirection !== undefined) rows.push(['파향', Math.round(ov.waveDirection) + '°']);
            if (ov.shipSpeed !== undefined) rows.push(['속력', ov.shipSpeed.toFixed(1) + ' kt']);
            if (hasTimeScale) rows.push(['시간배율', _timeScale.toFixed(1) + '×']);
            overridesEl.innerHTML = rows.map(function (r) {
                return '<div class="rv-scenario-override-row"><span class="rv-scenario-override-label">' + r[0] +
                    '</span><span class="rv-scenario-override-val">' + r[1] + '</span></div>';
            }).join('');
            overridesEl.hidden = rows.length === 0;
        }

        // Show/hide turn details section based on turn scenario state
        var turnSection = document.getElementById('rv-hud-turn-section');
        if (turnSection) turnSection.hidden = !turnScenarioActive;
    }

    function setScenarioOverride(params) {
        if (!_baseWeather || !weather) return false;
        params = params || {};
        _scenarioOverride = Object.assign({}, _scenarioOverride || {}, params);
        // Apply weather params to the EFFECTIVE `weather` (used by simulation).
        // The side panel WEATHER section is rendered from the original baseWeather snapshot
        // at load() and is never updated, so it stays as observed values.
        var weatherKeys = ['windSpeed', 'waveHeight', 'wavePeriod', 'waveDirection'];
        weatherKeys.forEach(function (k) {
            if (params[k] !== undefined) weather[k] = params[k];
        });
        if (params.timeScale !== undefined) {
            _timeScale = Math.max(0.25, Math.min(10, params.timeScale));
        }
        if (params.shipSpeed !== undefined) {
            shipSpeed = Math.max(0, Math.min(35, params.shipSpeed));
        }
        _refreshWeatherDisplay();
        return true;
    }

    function clearScenarioOverride() {
        if (!_baseWeather) return false;
        _scenarioOverride = null;
        _timeScale = 1.0;
        if (_baseShipSpeed !== null) shipSpeed = _baseShipSpeed;
        Object.assign(weather, _baseWeather);
        _refreshWeatherDisplay();
        return true;
    }

    function isActive() {
        if (!currentMmsi) return false;
        var container = getContainer();
        return !!(container && container.offsetParent !== null);
    }

    // ── Capsize scenario API ──
    // direction: -1 = port (좌현/왼쪽), 1 = starboard (우현/오른쪽), 0 or undefined = random.
    // delaySec: seconds to wait before the capsize stages begin. During the delay
    //   the ship continues normal physics (turn heel, wave roll, etc.) so that
    //   "선회 → 전복" reads as a build-up rather than an instant snap. Default 0.
    // Coexists with the turn scenario — turn drives heading (rotation.y),
    // capsize drives roll (rotation.x). The turn is only frozen once the
    // capsize is *armed* (i.e. the delay has elapsed).
    function triggerCapsize(direction, delaySec) {
        if (!shipGroup) return false;
        var dir;
        if (direction === -1 || direction === 1) {
            dir = direction;
        } else {
            dir = (Math.random() < 0.5) ? -1 : 1;
        }
        var d = (typeof delaySec === 'number' && delaySec > 0) ? Math.min(delaySec, 60) : 0;
        _capsize = { startTime: null, direction: dir, sinkY: 0, delay: d, armed: false };
        return true;
    }

    function clearCapsize() {
        _capsize = null;
        return true;
    }

    // ── Public API ──
    return {
        load: load,
        dispose: dispose,
        setScenarioOverride: setScenarioOverride,
        clearScenarioOverride: clearScenarioOverride,
        setTurnScenario: setTurnScenario,
        isTurnActive: function () { return turnScenarioActive; },
        triggerCapsize: triggerCapsize,
        clearCapsize: clearCapsize,
        isCapsizing: function () { return !!_capsize; },
        getCurrentMmsi: function () { return currentMmsi; },
        isActive: isActive
    };

})();

window.RollViewer = RollViewer;
