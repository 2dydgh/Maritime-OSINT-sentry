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
        scene.background = new THREE.Color(0x1a2a3a);
        scene.fog = new THREE.FogExp2(0x1a2a3a, 0.004);

        var w = container.clientWidth;
        var h = container.clientHeight;
        var aspect = w / (h || 1);

        camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
        camera.position.set(30, 20, 40);
        camera.lookAt(0, 0, 0);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.6;
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
        var topColor = new THREE.Color(0x1a2a4a);    // deep navy at zenith
        var horizonColor = new THREE.Color(0x3a5a7a); // lighter at horizon
        var tmp = new THREE.Color();

        for (var i = 0; i < skyVertCount; i++) {
            var y = skyGeo.attributes.position.getY(i);
            var t = Math.max(0, y / 400); // 0 at horizon, 1 at top
            tmp.copy(horizonColor).lerp(topColor, t);
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

    // ── buildShip(type) ──
    function buildShip(type) {
        var THREE = window.THREE;
        var color = (window.SHIP_COLORS && window.SHIP_COLORS[type]) || '#6b7280';

        shipGroup = new THREE.Group();

        // Hull via ExtrudeGeometry
        var shape = new THREE.Shape();
        shape.moveTo(-6, -2);
        shape.lineTo(-6, 2);
        shape.lineTo(4, 1.2);
        shape.lineTo(8, 0);
        shape.lineTo(4, -1.2);
        shape.closePath();

        var extrudeSettings = { depth: 3, bevelEnabled: false };
        var hullGeo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        hullGeo.rotateX(-Math.PI / 2);

        var hullMat = new THREE.MeshPhongMaterial({ color: new THREE.Color(color) });
        var hull = new THREE.Mesh(hullGeo, hullMat);
        hull.position.y = 1.5;
        hull.position.z = -1.5; // center the extrude depth
        shipGroup.add(hull);

        // Deck
        var deckGeo = new THREE.BoxGeometry(12, 0.3, 3.5);
        var deckMat = new THREE.MeshPhongMaterial({ color: 0x3f3f46 });
        var deck = new THREE.Mesh(deckGeo, deckMat);
        deck.position.set(0, 3.1, 0);
        shipGroup.add(deck);

        // Bridge
        var bridgeGeo = new THREE.BoxGeometry(3, 2.5, 2.8);
        var bridgeMat = new THREE.MeshPhongMaterial({ color: 0x52525b });
        var bridge = new THREE.Mesh(bridgeGeo, bridgeMat);
        bridge.position.set(-3, 4.5, 0);
        shipGroup.add(bridge);

        // Bridge windows
        var winGeo = new THREE.BoxGeometry(0.1, 0.6, 2.2);
        var winMat = new THREE.MeshPhongMaterial({
            color: 0x38bdf8,
            emissive: new THREE.Color(0x38bdf8),
            emissiveIntensity: 0.8
        });
        var win = new THREE.Mesh(winGeo, winMat);
        win.position.set(-1.45, 4.8, 0);
        shipGroup.add(win);

        // Funnel
        var funnelGeo = new THREE.CylinderGeometry(0.4, 0.5, 2, 8);
        var funnelMat = new THREE.MeshPhongMaterial({ color: 0x27272a });
        var funnel = new THREE.Mesh(funnelGeo, funnelMat);
        funnel.position.set(-4.5, 5, 0);
        shipGroup.add(funnel);

        // Mast
        var mastGeo = new THREE.CylinderGeometry(0.05, 0.05, 3, 4);
        var mastMat = new THREE.MeshPhongMaterial({ color: 0x71717a });
        var mast = new THREE.Mesh(mastGeo, mastMat);
        mast.position.set(-3, 7, 0);
        shipGroup.add(mast);

        shipGroup.position.y = 1;
        scene.add(shipGroup);
    }

    // ── startAnimation() ──
    function startAnimation() {
        clockStart = performance.now();

        function loop() {
            animFrameId = requestAnimationFrame(loop);

            var elapsed = (performance.now() - clockStart) / 1000;

            animateWater(elapsed);

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
                    lineStyle: { color: '#f97316', width: 1.5 },
                    areaStyle: {
                        color: {
                            type: 'linear',
                            x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                                { offset: 0, color: 'rgba(249,115,22,0.2)' },
                                { offset: 1, color: 'rgba(249,115,22,0)' }
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
        waterMesh = null;
        clockStart = null;
        weather = null;
        rollParams = null;
        currentMmsi = null;
        rollHistory = [];

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
