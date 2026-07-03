// ── OVERWATCH 4D — Roll Viewer ──
// Three.js 3D roll prediction viewer for maritime vessel visualization.
// Renders ship model with wave animation and live roll angle chart.

var RollViewer = (function () {

    // ── State ──
    var scene = null;
    var camera = null;
    var renderer = null;
    var controls = null;
    var _resizeObserver = null;            // 무대 컨테이너 크기 변화 감지 (하단 시뮬 패널 리플로우 동기화)

    var shipGroup = null;
    var shipGroupPred = null;              // 예측 선박 (실제 선박의 클론)
    var splitView = false;                 // false=고스트 겹쳐보기(기본) · true=좌우 나눠보기
    var _predGhostMats = [];               // 예측 선박 전용(클론된) 머티리얼 — 고스트 처리 대상
    var _predEdgeMats = [];                // 예측 헐 EdgesGeometry 외곽선 머티리얼
    var _predGhostReady = false;
    var heelRefGroup = null;               // 수평(0°) 기준선 — 선박 위치만 따라가고 롤은 따라가지 않음
    var _rollWedge = null;                 // 실측↔예측 롤 각 사이를 채우는 오차 쐐기(겹쳐보기 전용)
    var _rollWedgeMat = null;
    var _HEEL = { deckY: 5.0, half: 8.5 }; // 횡요 사다리 끝점 좌표(라벨 투영용)
    var _setRightPanel = null;             // 우측 패널(시뮬레이션/상세) 상호배타 토글 — load()에서 배선
    var waterMesh = null;
    // ── 수중 모드 (카메라가 수면 아래로 내려가면 잠수 뷰로 전환) ──
    var _underwater = false;
    var _underwaterTintEl = null;
    var _savedFog = null;            // 수면 위 fog 복원용 { color, density }
    var SURFACE_Y = 0.4;             // 이 높이보다 카메라가 낮아지면 수중 처리
    var gltfModelCache = {};   // { type: THREE.Group }
    var gltfLoader = null;
    var useGltfModels = false;  // disabled — only cargo.glb exists; code ships keep all types consistent
    var composer = null;
    var mainDirLight = null;
    var _fillLight = null;        // module-scoped so the sky-mood switcher can retune them
    var _ambLight = null;
    var waterNormals = null;
    var _waves = [];               // current Gerstner wave specs (Gerstner.buildWaves)
    var _waterPatched = false;     // true once Water vertex shader has the Gerstner injection

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
    // 횡요 트레이스 리본 — 실측(실선) vs 예측(점선) 시간축 비교 + 오차 밴드
    var traceCanvas = null, traceCtx = null;
    var traceBuf = [];             // {t, r, p} 샘플 — 최근 TRACE_WINDOW초
    var traceAccum = 0;            // 샘플링 어큐뮬레이터(초)
    var traceYMax = 5;             // 대칭 y-스케일(°) — 5° 배수로 자동 조정
    var traceCollapsed = false;    // 접힘 상태 — 세션 내 선박 전환에도 유지
    var _traceWasCollapsed = false; // 시뮬 덱이 열리기 직전 상태 (덱 닫으면 복원)
    var traceCol = null;           // CSS 토큰에서 읽은 색 캐시
    var traceRO = null;            // 리본 캔버스 ResizeObserver
    var TRACE_WINDOW = 90;         // 표시 구간(초)
    var TRACE_DT = 0.1;            // 샘플 간격(초) — 90초 × 10Hz = 900pt

    var weather = null;
    var shipType = 'other';
    var rollParams = null;
    var naturalRollPeriod = null;  // beam/GM-derived ship roll period — drives resonance amplification
    var sogSignalLost = false;

    var sprayPoints = null;
    var sprayVelocities = [];
    var SPRAY_COUNT = 90;
    var _contactShadow = null;   // 수면 위 옅은 접지 그림자(떠 있지 않고 물에 얹힌 느낌)

    var cameraAnimating = false;
    var cameraAnimStart = 0;
    var CAMERA_ANIM_DURATION = 2.0; // seconds

    // ── Camera preset animation state ──
    var camPresetAnim = null;  // { from: {x,y,z}, to: {x,y,z}, start: elapsed, duration: 1.2 }
    // 카메라 시점 프리셋 — UI 버튼과 AI(setCameraView)가 같은 정의를 공유한다.
    // pos는 선체-로컬(+x=선수, +z=우현); animateCameraToPreset가 heading으로 월드 회전.
    var CAM_PRESETS = [
        { id: 'beam', icon: 'fa-arrows-left-right', label: '측면', pos: { x: 0, y: 12, z: 45 } },
        { id: 'bow', icon: 'fa-arrow-up', label: '선수', pos: { x: 35, y: 15, z: 0 } },
        { id: 'stern', icon: 'fa-arrow-down', label: '선미', pos: { x: -35, y: 15, z: 0 } },
        { id: 'top', icon: 'fa-eye', label: '탑뷰', pos: { x: 0, y: 55, z: 1 } }
    ];

    // ── Turning scenario state ──
    var turnScenarioActive = false;
    var turnPhase = 'straight';   // 'straight' | 'entering' | 'turning' | 'exiting'
    var turnElapsed = 0;
    var turnHeading = 0;          // current heading in degrees (delta accumulated during a turn)
    var baseHeading = 0;          // 선수방위(도) — 파향 대비 배 방향. 조우각이 롤 크기를 좌우한다.
    var turnDirection = 1;        // 1 = starboard, -1 = port
    var _turnMaxRudder = 35;      // 최대 타각(도) — 시뮬레이션 패널 슬라이더로 조절
    var turnHudEl = null;
    var turnBtnEl = null;
    var shipSpeed = 12;           // knots — set from actual SOG, capped
    var shipWorldPos = { x: 0, z: 0 };  // ship position in world space
    var camFollow = { x: 0, z: 0 };     // smoothed camera target
    var camFollowHeading = 0;              // smoothed camera heading (radians)
    var _camHeadingSynced = false;         // false → 다음 프레임에 camFollowHeading를 현재 침로로 스냅(점프 방지)
    var smoothSpeed = 12;                  // lerp-smoothed current speed
    var smoothRoll = 0;                    // lerp-smoothed roll angle
    var smoothPitch = 0;                   // lerp-smoothed pitch angle
    // ── 부력 관성(heave 스프링-댐퍼) + 6-DOF 미세동요 상태 ──
    var _heavePos = 0, _heaveVel = 0;      // 수면에 즉시 안 붙고 고유주기로 출렁(지연/오버슈트)
    var _yawSmooth = 0;                    // 파도가 유도하는 미세 요(스무딩, rad)
    var predRoll = 0;                       // 예측 roll (원시)
    var predPitch = 0;                      // 예측 pitch (원시)
    // Gerstner 수평(choppy) 변위 — GLSL gerstnerDisplace의 acc.xy 와 동일.
    // 물 입자의 궤도 운동을 CPU에서 재현해 선체 서지/스웨이를 보이는 물결과 동기시킨다.
    function _gerstnerHoriz(waves, px, py, t) {
        var dx = 0, dy = 0;
        if (waves) for (var i = 0; i < waves.length; i++) {
            var w = waves[i];
            if (!(w.A > 0)) continue;
            var s = Math.sin(w.k * (w.dirX * px + w.dirY * py) - w.omega * t) * w.Q * w.A;
            dx += w.dirX * s; dy += w.dirY * s;
        }
        return { x: dx, y: dy };
    }
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

    var CAM_START = { x: 70, y: 18, z: 70 };   // 시작 위치도 조금 낮고 가깝게
    // 정착 시점 — water.png처럼 수면 가까이 낮게(y 13→9) + 살짝 더 당겨(거리 50→43) 파도가 전경에 크게.
    var CAM_END = { x: 26, y: 9, z: 34 };

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
        _heavePos = 0; _heaveVel = 0; _yawSmooth = 0;
        weather = Object.assign({}, _baseWeather);
        waterFlowOffset = { x: 0, z: 0 };

        // Build layout DOM — Composition B: 제목줄 / 3D 무대 / 하단 계기 콘솔
        var layout = document.createElement('div');
        layout.className = 'roll-viewer-layout rv-layout-b';

        var titlebar = buildTitleBar(ship);

        var canvasWrap = document.createElement('div');
        canvasWrap.className = 'roll-viewer-canvas-wrap';

        // 상세 정보 — 가운데 모달 카드 (모양·딤 배경은 CSS가 담당). 닫기 X 포함.
        var panel = buildInfoPanel(ship);
        var drawer = document.createElement('div');
        drawer.className = 'rv-drawer';
        drawer.id = 'rv-drawer';
        var _detailClose = document.createElement('button');
        _detailClose.className = 'rv-modal-close';
        _detailClose.setAttribute('aria-label', '닫기');
        _detailClose.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        drawer.appendChild(_detailClose);
        drawer.appendChild(panel);

        layout.appendChild(titlebar);
        layout.appendChild(canvasWrap);
        // 트레이스 리본 — 무대 아래 in-flow(오버레이 아님)라 캠 프리셋을 가리지 않는다
        layout.appendChild(buildTraceRibbon());
        layout.appendChild(drawer);
        container.appendChild(layout);

        // 횡요각/정확도 텔레메트리 — 하단 콘솔 바 대신 무대 좌상단 HUD로 (3D가 풀 높이를 차지).
        canvasWrap.appendChild(buildRollHud());

        // 수중 틴트 오버레이 — 카메라가 수면 아래로 내려가면 페이드인 (잠수 뷰).
        _underwaterTintEl = document.createElement('div');
        _underwaterTintEl.className = 'rv-underwater-tint';
        canvasWrap.appendChild(_underwaterTintEl);

        // AI 챗 FAB는 전역 유지하되, 하단 트레이스 리본과 겹치지 않게 무대 좌하단으로 올린다.
        var _cb = document.getElementById('chat-bubble');
        if (_cb) {
            _cb.classList.add('rv-chat-shift');
            _cb.classList.toggle('rv-chat-trace-collapsed', traceCollapsed);
        }

        // 시뮬레이션 제어 패널 (하단 슬라이드업, 기본 숨김) — 무대 아래 in-flow 막내로 붙어
        // 열리면 3D 무대를 위로 밀어 올린다 (오른쪽 오버레이로 화면을 덮지 않음).
        buildTurnScenarioUI(layout);

        // 제목줄 토글 배선
        // 시뮬=하단 바(보면서 조정), 상세=가운데 모달(읽고 닫기). 모달은 포커스형이라 시뮬과
        // 상호배타로 연다 (한쪽 열면 다른 쪽 닫힘). 배경 클릭·X로도 닫힌다.
        var simBtn = document.getElementById('rv-tb-sim');
        var scenarioEl = document.getElementById('rv-canvas-hud-scenario');
        var detailBtn = document.getElementById('rv-tb-detail');
        var _backdrop = document.createElement('div');
        _backdrop.className = 'rv-modal-backdrop';
        layout.appendChild(_backdrop);
        function _showSim(open) {
            if (scenarioEl) scenarioEl.classList.toggle('rv-sim-open', open);
            if (simBtn) simBtn.classList.toggle('active', open);
            // 시뮬 덱 + 트레이스 리본이 동시에 열리면 3D 무대 세로가 너무 좁아진다 —
            // 덱이 열리면 리본을 접고, 닫히면 사용자가 마지막으로 고른 상태로 복원.
            if (open) { _traceWasCollapsed = traceCollapsed; _setTraceCollapsed(true); }
            else _setTraceCollapsed(_traceWasCollapsed);
            // 하단 시뮬 덱이 열리면 좌하단 AI 챗 FAB/패널이 덱을 가린다 → 덱 동안 숨긴다(페이드).
            var _cb = document.getElementById('chat-bubble');
            if (_cb) _cb.classList.toggle('rv-chat-deck-hide', open);
            var _cp = document.getElementById('chat-panel');
            if (_cp) _cp.classList.toggle('rv-chat-deck-hide', open);
        }
        function _showDetail(open) {
            drawer.classList.toggle('rv-drawer-open', open);
            _backdrop.classList.toggle('rv-modal-on', open);
            if (detailBtn) detailBtn.classList.toggle('active', open);
        }
        if (simBtn && scenarioEl) {
            simBtn.addEventListener('click', function () {
                var open = !scenarioEl.classList.contains('rv-sim-open');
                if (open) _showDetail(false);
                _showSim(open);
            });
        }
        if (detailBtn) {
            detailBtn.addEventListener('click', function () {
                var open = !drawer.classList.contains('rv-drawer-open');
                if (open) _showSim(false);
                _showDetail(open);
            });
        }
        _backdrop.addEventListener('click', function () { _showDetail(false); });
        _detailClose.addEventListener('click', function () { _showDetail(false); });
        // 외부(LLM 등) 호환용 헬퍼
        _setRightPanel = function (which) { _showSim(which === 'sim'); _showDetail(which === 'detail'); };

        buildCanvasOverlays(canvasWrap);   // 카메라 프리셋 (무대에 떠 있음)

        // Init Three.js
        initScene(canvasWrap);
        buildSky();
        buildSun();   // sunPosition 따라가는 부드러운 태양 (위치 고정 + 톤다운)
        buildWater();
        buildCompass();
        buildShip(shipType);
        if (shipGroup) {
            shipGroupPred = shipGroup.clone(true);
            shipGroupPred.rotation.order = 'YXZ';   // clone이 상속하지만 명시 (yaw 최외곽 고정)
            scene.add(shipGroupPred);
            // 선체 위 attitude 사다리(가로선)는 제거함 — 정밀 각도는 하단 클리노미터가 담당하고,
            // 3D 무대는 선체가 직접 기우는 모습 + 단일 수평 기준선만으로 깔끔하게 비교한다.
            _buildHeelHorizon();   // 수평 0° 기준선 (유일하게 남는 가로 기준)
            _buildRollWedge();     // 실측↔예측 롤 각 오차 쐐기 (겹쳐보기)
            // 기본은 고스트 겹쳐보기 — 예측 선박을 반투명 하늘색으로 처리한다.
            setShipViewMode(!splitView);
        }
        // 초기 분위기(기본 한낮)에 맞춰 선실 창 발광을 끈다 — 대낮에 불 켜진 창 방지.
        _applyMoodToShipEmissive();

        buildSeaMarkers();
        buildDistantVessels();
        buildContactShadow();
        buildSpray();
        buildRadarIndicator();
        startAnimation();
        _initHistories();
    }

    function applyPanelViewOffset(w, h) {
        // 2분할 모드는 전체 캔버스를 쓰므로 패널 오프셋 불필요.
        // (드로우는 캔버스 위에 떠 있는 오버레이)
    }

    // ── initScene(container) ──
    function initScene(container) {
        var THREE = window.THREE;

        scene = new THREE.Scene();
        // 하늘 셰이더가 뜨기 전 초기 프레임 — 앱 배경(#0a0e16)과 톤을 맞춰 밝은 플래시 방지
        scene.background = new THREE.Color(0x0d1420);

        var w = container.clientWidth;
        var h = container.clientHeight;
        var aspect = w / (h || 1);

        camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
        camera.position.set(CAM_START.x, CAM_START.y, CAM_START.z);
        camera.lookAt(0, 2, 0);
        applyPanelViewOffset(w, h);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        var todPal = SKY_PALETTES[getActiveTod()];
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
        // 수면 아래로 내려가는 건 허용(수중 모드로 전환됨). 다만 완전 천저(nadir)까진 못 가게 제한.
        controls.maxPolarAngle = Math.PI * 0.9;
        controls.target.set(0, 2, 0);

        // Lights — adjusted by time of day
        var tod = getActiveTod();
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

        _fillLight = new THREE.DirectionalLight(0xaaccff, tod === 'night' ? 0.2 : 0.5);
        _fillLight.position.set(-20, 10, -10);
        scene.add(_fillLight);

        _ambLight = new THREE.AmbientLight(0xffffff, tod === 'night' ? 0.3 : 0.8);
        scene.add(_ambLight);

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
        // 컨테이너 자체 크기 변화(하단 시뮬 패널이 열리며 무대를 위로 밀어낼 때 등)도 감지해
        // 렌더러/카메라를 동기화한다 — window resize 만으론 flex 리플로우를 못 잡는다.
        if (window.ResizeObserver) {
            _resizeObserver = new ResizeObserver(function () { _resizeHandler(); });
            _resizeObserver.observe(container);
        }

        // ── Post-processing ──
        var renderPass = new THREE.RenderPass(scene, camera);
        var wxMod2 = getWeatherModifiers();
        var bloomStrength = wxMod2.bloomStrength;
        // 레퍼런스 예제엔 블룸이 없음 — 과한 번짐의 주범이라 확 낮춘다.
        // threshold를 높여 가장 밝은 것(태양)만 살짝 번지게.
        var bloomPass = new THREE.UnrealBloomPass(
            new THREE.Vector2(w, h),
            bloomStrength * 0.35,   // strength — 대폭 완화
            0.45,   // radius
            0.9     // threshold — 매우 밝은 표면(태양)만
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

    // The sky is now driven by an explicit user mood (시뮬레이션 패널 → 하늘), defaulting
    // to 'day' (golden / water.png) instead of the Seoul clock. getActiveTod() is what all
    // sky/sun/water/light builders read; the clock is only a fallback if no mood is set.
    var _activeMood = 'noon';    // default 한낮. 'day'(골든) | 'noon'(한낮) | 'dusk'(황혼) | 'night'(야간)
    function getActiveTod() { return _activeMood || getTimeOfDay(); }

    var SKY_PALETTES = {
        // exposure: ACESFilmic toneMappingExposure. The reference (Sean Bradley
        // gerstner-ocean / water.png) ships 0.5, but water.png itself reads brighter
        // than that here, so day = 0.78 — rich, contrasty water + warm horizon without
        // the washed-out 1.07 and without going dim. Other times warmed toward it.
        dawn: {
            top: 0x1a1a4a, mid: 0x4a3a6a, horizon: 0xd4856a, warm: 0xe8a070,
            bg: 0x3a3050, fog: 0x6a5060, sunColor: 0xffcc88, sunIntensity: 1.2,
            waterColor: 0x1a2a3d, exposure: 0.6
        },
        day: {
            top: 0x0055cc, mid: 0x0088ee, horizon: 0x40aaff, warm: 0x70c8ff,
            bg: 0x0077dd, fog: 0x3399ee, sunColor: 0xfffff0, sunIntensity: 2.0,
            // 0x001e0f(거의 검은 녹색)은 순백 글린트와 만나 '검은 유리'처럼 보였다 →
            // 딥 틸로 밝혀 물처럼. 여전히 어둑한 마린톤이되 검정은 아님.
            waterColor: 0x06303c, exposure: 0.78, bloom: 0,
            turbidity: 10, rayleigh: 2
        },
        // 한낮 — sun high, clear blue sky (low turbidity), bright bluer sea.
        noon: {
            top: 0x1a6fd0, mid: 0x3a9be0, horizon: 0xbfe3ff, warm: 0xe8f4ff,
            bg: 0x2a7fd0, fog: 0x9fcfff, sunColor: 0xffffff, sunIntensity: 2.4,
            waterColor: 0x064a6e, exposure: 0.62, bloom: 0,
            turbidity: 4, rayleigh: 1.2
        },
        // 황혼 — 골든과 확실히 구분: 태양을 수평선까지 내리고(elev 1°) 더 어둡게(exp 0.5),
        // 짙은 주황·적색(sunColor)·어두운 물. 골든은 밝은 금빛, 황혼은 어둑한 노을.
        dusk: {
            top: 0x0a1430, mid: 0x3a2050, horizon: 0xd2502a, warm: 0xe87038,
            bg: 0x201838, fog: 0x4a2c38, sunColor: 0xff6a2c, sunIntensity: 0.9,
            waterColor: 0x0a1322, exposure: 0.5, turbidity: 10, rayleigh: 3
        },
        night: {
            top: 0x020810, mid: 0x0a1520, horizon: 0x1a2a3a, warm: 0x2a3040,
            bg: 0x060c18, fog: 0x101828, sunColor: 0x8899bb, sunIntensity: 0.4,
            waterColor: 0x000a15, exposure: 0.8
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
                // 레퍼런스(Sean Bradley gerstner-ocean / water.png) 기본값 그대로:
                // elevation 2° + azimuth 180° + turbidity 10 + exposure 0.5.
                // 낮은 태양이 수면에 긴 정반사(글린트) 길을 만들고 수평선이 따뜻해진다.
                phi = THREE.MathUtils.degToRad(90 - 2);
                theta = THREE.MathUtils.degToRad(180);
                break;
            case 'noon':
                // 한낮 — 태양 고도 28°, 정면. 긴 글린트 대신 또렷한 반사점.
                phi = THREE.MathUtils.degToRad(90 - 28);
                theta = THREE.MathUtils.degToRad(180);
                break;
            case 'dusk':
                // 노을 — 태양을 수평선 바로 위로(elev 1°), 카메라 정면(az 180)에 둬 길고 붉은
                // 글린트와 함께 확실한 '해넘이'. 골든(elev 2·밝음)과 톤·밝기로 구분된다.
                phi = THREE.MathUtils.degToRad(90 - 1);
                theta = THREE.MathUtils.degToRad(180);
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
    var _skyEnvRT = null;          // PMREM render target holding the sky environment
    var sunPosition = null;
    var saturationPass = null;
    var godRaysShaderPass = null;

    // ── buildSky() — THREE.Sky for dawn/day/dusk, vertex-color dome for night ──
    function buildSky() {
        var THREE = window.THREE;
        var tod = getActiveTod();
        var pal = SKY_PALETTES[tod];

        // 안개 — 0.0004는 먼 바다를 회색으로 씻어버려 칙칙했다(레퍼런스엔 안개 없음).
        // 골든/한낮은 거의 0으로(맑은 수평선), 그 외 시간대는 약하게.
        scene.fog = new THREE.FogExp2(pal.fog, (tod === 'day' || tod === 'noon') ? 0.00006 : 0.0002);

        skyGroup = new THREE.Group();

        if (tod !== 'night' && THREE.Sky) {
            // Sky shader replaces scene.background
            scene.background = null;

            skyMesh = new THREE.Sky();
            skyMesh.scale.setScalar(450);

            var skyUniforms = skyMesh.material.uniforms;
            var wxMod = getWeatherModifiers();
            // turbidity/rayleigh per mood — 골든/황혼은 10/2(따뜻·뿌연), 한낮은 4/1.2(맑은 파랑).
            skyUniforms['turbidity'].value = pal.turbidity || 10;
            skyUniforms['rayleigh'].value = pal.rayleigh || 2;
            skyUniforms['mieCoefficient'].value = 0.005;
            skyUniforms['mieDirectionalG'].value = 0.8;

            sunPosition = calcSunPosition(tod);
            skyUniforms['sunPosition'].value.copy(sunPosition);

            // Render sky behind everything
            skyMesh.renderOrder = -1;

            skyGroup.add(skyMesh);

            // 노출은 시간대 팔레트값(day=0.5, 레퍼런스). 낮을수록 물이 진하고 글린트가 도드라진다.
            if (renderer) {
                renderer.toneMappingExposure = pal.exposure || 0.5;
            }

            // ── PMREM environment from the Sky (reference does this; the app didn't) ──
            // Gives the ship's PBR materials the same warm sky reflection so it sits
            // in the scene instead of looking flatly lit. (THREE.Water has its own
            // mirror reflection, so this is purely for the ship/other meshes.)
            try {
                if (renderer && THREE.PMREMGenerator) {
                    if (_skyEnvRT) { _skyEnvRT.dispose(); _skyEnvRT = null; }
                    var _pmrem = new THREE.PMREMGenerator(renderer);
                    _skyEnvRT = _pmrem.fromScene(skyMesh);
                    scene.environment = _skyEnvRT.texture;
                    _pmrem.dispose();
                }
            } catch (e) {
                console.warn('[roll-viewer] PMREM sky environment failed:', e);
            }
        } else {
            scene.background = new THREE.Color(pal.bg);
            // Night has no Sky shader → drop the (now stale, warm) daytime sky env so the
            // ship doesn't reflect a sunset at night.
            if (_skyEnvRT) { _skyEnvRT.dispose(); _skyEnvRT = null; }
            scene.environment = null;
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
                    // (어두운 바닥 그림자 제거 — NormalBlending 에선 이게 구름을 '먹구름'처럼
                    //  회색으로 깔아버렸다. 흰 구름은 밝게만 유지.)
                }));
            }

            // 구름 끔(0) — HDR THREE.Sky 위에 LDR 흰 구름 스프라이트를 합성하면 밝은 하늘보다
            // 어두워져 '먹구름 얼룩'이 된다. 참고 예제들처럼 깨끗한 하늘이 더 사실적.
            // (나중에 HDR-bright 구름으로 제대로 다시 넣을 수 있음)
            var cumulusCount = 0;
            for (var ci = 0; ci < cumulusCount; ci++) {
                var ca = (ci / cumulusCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
                var cd = 120 + Math.random() * 160;
                var cTex = cumulusTextures[ci % cumulusTextures.length];
                // NormalBlending — 구름은 빛을 더하는(가산) 게 아니라 가리는 것. 가산은
                // 겹칠수록 밝아져 '빛나는 가짜 덩어리'로 보였다. 일반 알파 합성으로 자연스럽게.
                var cMat = new THREE.SpriteMaterial({ map: cTex, transparent: true, opacity: 0.7 + Math.random() * 0.25, depthWrite: false, blending: THREE.NormalBlending });
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
        var tod = getActiveTod();
        // THREE.Sky already renders the sun through atmospheric scattering. A second
        // hand-built disc landed slightly off the Sky's sun and read as a weird "extra
        // sun" at golden hour, so for 골든/황혼 we let the Sky provide it. But at 한낮 the
        // high sun + clear (low-turbidity) sky barely shows a disc, so there we DO draw a
        // crisp one — placed exactly at the Sky's sunPosition so it reinforces, not doubles.
        if (skyMesh && tod !== 'noon') return;
        var isSun = (tod === 'day' || tod === 'noon' || tod === 'dawn' || tod === 'dusk');

        // 한낮은 맑은 파란 하늘이라 THREE.Sky 자체 해가 거의 안 보인다 → 크고 또렷한
        // 순백 디스크 + 큰 광륜으로 확실히 보이게. (다른 시간대는 종전대로 은은하게.)
        var isNoon = (tod === 'noon');
        var size = isNoon ? 10 : (isSun ? 6 : 4);
        var color = isNoon ? 0xffffff : tod === 'day' ? 0xfff2d0 : tod === 'dawn' ? 0xffcc88 : tod === 'dusk' ? 0xff8844 : 0xddeeff;

        var geo = new THREE.SphereGeometry(size, 24, 24);
        var mat = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: isNoon ? 1.0 : (tod === 'night' ? 0.6 : 0.75),
            depthWrite: false
        });
        sunMesh = new THREE.Mesh(geo, mat);

        // THREE.Sky 의 해와 같은 방향(sunPosition)에 배치 — 두 해가 어긋나지 않게.
        if (!sunPosition) return;
        sunMesh.position.copy(sunPosition).multiplyScalar(400);
        sunMesh.renderOrder = 1;   // 하늘 위에 확실히 그려지도록
        (skyGroup || scene).add(sunMesh);

        // Glow sprite around sun/moon — 한낮은 더 밝고 크게.
        var glowCanvas = document.createElement('canvas');
        glowCanvas.width = 128;
        glowCanvas.height = 128;
        var gCtx = glowCanvas.getContext('2d');
        var glowGrad = gCtx.createRadialGradient(64, 64, 0, 64, 64, 64);
        var glowColor = isSun ? 'rgba(255,250,225,' : 'rgba(200,220,255,';
        glowGrad.addColorStop(0, glowColor + (isNoon ? '0.85)' : '0.4)'));
        glowGrad.addColorStop(0.35, glowColor + (isNoon ? '0.32)' : '0.1)'));
        glowGrad.addColorStop(0.7, glowColor + (isNoon ? '0.08)' : '0.04)'));
        glowGrad.addColorStop(1, glowColor + '0)');
        gCtx.fillStyle = glowGrad;
        gCtx.fillRect(0, 0, 128, 128);

        var glowTex = new THREE.CanvasTexture(glowCanvas);
        var glowMat = new THREE.SpriteMaterial({
            map: glowTex,
            transparent: true,
            opacity: isNoon ? 0.85 : (isSun ? 0.35 : 0.2),
            depthWrite: false,
            blending: isNoon ? THREE.AdditiveBlending : THREE.NormalBlending
        });
        var glowSprite = new THREE.Sprite(glowMat);
        var glowScale = isNoon ? size * 7 : size * 5;
        glowSprite.scale.set(glowScale, glowScale, 1);
        glowSprite.position.copy(sunMesh.position);
        glowSprite.renderOrder = 1;
        (skyGroup || scene).add(glowSprite);
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

    // ── Distant vessel silhouettes — populate the horizon for scale & depth ──
    // Like water.png's scattered objects: a few far ships give the empty sea a sense
    // of scale and layered distance, with the hero ship still the clear focus. Far
    // enough that they don't need precise wave sampling — a gentle bob reads fine.
    // (Bobbing nav buoys riding the wave field are a deferred follow-up.)
    var distantVessels = [];
    function buildDistantVessels() {
        var THREE = window.THREE;
        // angle (rad), distance, scale — spread around, kept off the camera's front-centre
        var defs = [
            { ang: 0.55, dist: 175, scale: 1.3 },
            { ang: 2.35, dist: 235, scale: 1.8 },
            { ang: 3.9, dist: 150, scale: 1.0 },
            { ang: 5.2, dist: 205, scale: 1.45 }
        ];
        // Dark, lightly-reflective so it reads as a silhouette against the bright sky
        // yet still catches the sky env map in every mood.
        var hullMat = new THREE.MeshStandardMaterial({ color: 0x39434f, roughness: 0.72, metalness: 0.12 });
        var superMat = new THREE.MeshStandardMaterial({ color: 0x2c343f, roughness: 0.7, metalness: 0.1 });

        for (var i = 0; i < defs.length; i++) {
            var d = defs[i];
            var s = d.scale;
            var g = new THREE.Group();

            // Hull — long low block
            var hull = new THREE.Mesh(new THREE.BoxGeometry(22 * s, 2.4 * s, 4 * s), hullMat);
            hull.position.y = 1.0 * s;
            g.add(hull);
            // Bow taper — a wedge at the front
            var bow = new THREE.Mesh(new THREE.BoxGeometry(4 * s, 2.4 * s, 4 * s), hullMat);
            bow.position.set(12 * s, 1.0 * s, 0);
            bow.rotation.y = Math.PI / 4;
            g.add(bow);
            // Superstructure — block toward the stern
            var sup = new THREE.Mesh(new THREE.BoxGeometry(5 * s, 4 * s, 3.4 * s), superMat);
            sup.position.set(-6 * s, 3.6 * s, 0);
            g.add(sup);
            // Funnel
            var fun = new THREE.Mesh(new THREE.BoxGeometry(1.8 * s, 2.6 * s, 2 * s), superMat);
            fun.position.set(-8.5 * s, 5.4 * s, 0);
            g.add(fun);

            g.traverse(function (o) { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });

            var px = Math.cos(d.ang) * d.dist;
            var pz = Math.sin(d.ang) * d.dist;
            g.position.set(px, -0.6 * s, pz);
            g.rotation.y = d.ang + Math.PI / 2 + (i % 2 ? 0.5 : -0.4);   // varied headings
            scene.add(g);

            distantVessels.push({
                group: g,
                baseY: -0.6 * s,
                scale: s,
                phase: i * 1.7,
                bobAmp: 0.18 * s,
                bobFreq: 0.22 + i * 0.03
            });
        }
    }

    function animateDistantVessels(elapsed) {
        for (var i = 0; i < distantVessels.length; i++) {
            var v = distantVessels[i];
            v.group.position.y = v.baseY + Math.sin(elapsed * v.bobFreq + v.phase) * v.bobAmp;
            v.group.rotation.z = Math.sin(elapsed * v.bobFreq * 0.8 + v.phase) * 0.015;
        }
    }

    // ── Turning scenario ──
    function buildTurnScenarioUI(canvasWrap) {
        // 상단 중앙 선회 버튼은 제거됨 — 조작은 우상단 시뮬레이션 패널의 버튼으로 통합.
        // turnBtnEl은 null로 유지(모든 참조가 `if (turnBtnEl)` 가드라 안전).
        turnBtnEl = null;

        // (Bottom-left HUD removed — duplicated info that lives in the side panel and prediction modal.)


        // Top-right unified scenario status panel.
        // Shows when turn scenario is active OR any weather/speed/time override is set.
        // Holds: simulation badge, override list, turn state details — all in one place.
        // 상시 표시되는 통합 시뮬레이션 패널 (상태 + 조작 버튼). 접기(×) 가능.
        var scenarioOverlay = document.createElement('div');
        scenarioOverlay.className = 'rv-canvas-hud-scenario';
        scenarioOverlay.id = 'rv-canvas-hud-scenario';
        var _wv = (weather && weather.waveHeight != null) ? weather.waveHeight : 2.5;
        var _wp = (weather && weather.wavePeriod != null) ? weather.wavePeriod : 8;
        var _sp = (shipSpeed != null) ? shipSpeed : 10;
        // 타륜(ship's helm) 마크업 — 림 + 8개 스포크 + 8개 손잡이(peg). 손잡이는 cardinal 틱 사이(22.5° 오프셋)에 둔다.
        var _helmSVG = (function () {
            var grips = '', spokes = '';
            for (var i = 0; i < 8; i++) {
                var a = (i * 45 + 22.5) * Math.PI / 180;
                var s = Math.sin(a), c = Math.cos(a);
                spokes += '<line class="rv-helm-spoke" x1="' + (50 + 9 * s).toFixed(1) + '" y1="' + (50 - 9 * c).toFixed(1) +
                          '" x2="' + (50 + 36 * s).toFixed(1) + '" y2="' + (50 - 36 * c).toFixed(1) + '"/>';
                grips += '<line class="rv-helm-grip" x1="' + (50 + 37 * s).toFixed(1) + '" y1="' + (50 - 37 * c).toFixed(1) +
                         '" x2="' + (50 + 45 * s).toFixed(1) + '" y2="' + (50 - 45 * c).toFixed(1) + '"/>';
            }
            return '<g class="rv-helm-wheel" id="rv-helm-wheel">' +
                   '<circle class="rv-helm-rim" cx="50" cy="50" r="38"/>' + spokes + grips + '</g>';
        })();
        // 계기 베젤 — 고정 위치명 라벨(위=정면파 · 좌·우=옆파 · 아래=뒷파) + 옆파(직각)
        // 위치에만 빨간 레드라인 호. 가운데 타륜은 선수 따라 회전하지만 베젤은 고정이라,
        // 바늘이 어느 라벨 쪽을 향하는지로 "옆파=롤 최강"을 글자로 바로 읽게 한다(색 의존 X).
        var _bezelSVG = (function () {
            function _arc(R, d0, d1) {
                var r0 = d0 * Math.PI / 180, r1 = d1 * Math.PI / 180;
                var x0 = (50 + R * Math.sin(r0)).toFixed(2), y0 = (50 - R * Math.cos(r0)).toFixed(2);
                var x1 = (50 + R * Math.sin(r1)).toFixed(2), y1 = (50 - R * Math.cos(r1)).toFixed(2);
                return 'M' + x0 + ' ' + y0 + ' A' + R + ' ' + R + ' 0 0 1 ' + x1 + ' ' + y1;
            }
            var redR = '<path class="rv-bezel-redline" d="' + _arc(43, 70, 110) + '"/>';   // 우현 옆파
            var redL = '<path class="rv-bezel-redline" d="' + _arc(43, 250, 290) + '"/>';  // 좌현 옆파
            var labels =
                '<text class="rv-bezel-lab" x="50" y="4" text-anchor="middle">정면파</text>' +
                '<text class="rv-bezel-lab rv-bezel-lab-beam" x="3.5" y="51.5" text-anchor="middle">옆파</text>' +
                '<text class="rv-bezel-lab rv-bezel-lab-beam" x="96.5" y="51.5" text-anchor="middle">옆파</text>' +
                '<text class="rv-bezel-lab" x="50" y="99" text-anchor="middle">뒷파</text>';
            return '<g class="rv-compass-bezel">' + redR + redL + labels + '</g>';
        })();
        // 4-컬럼 오퍼레이터 레이아웃 — 하단 풀폭 바에 가로로 펼친다.
        // 모든 컨트롤 id는 유지되므로 아래 바인딩 코드는 그대로 동작한다.
        scenarioOverlay.innerHTML =
            '<div class="rv-scenario-header">' +
            '<span>시뮬레이션</span>' +
            '<button type="button" class="rv-scenario-collapse" id="rv-scenario-collapse" title="접기/펼치기"><i class="fa-solid fa-chevron-up"></i></button>' +
            '</div>' +
            '<div class="rv-scenario-body" id="rv-scenario-body">' +
            '<div class="rv-sim-cols">' +

            // ── 1. 환경 (해상 상태 + 하늘 분위기) ──
            // 하늘은 원래 별도 컬럼이었지만 버튼 한 줄뿐이라 컬럼이 텅 비어 보였다.
            // 파고·파주기와 같은 행 문법(label + control)으로 환경 그룹에 병합.
            '<div class="rv-sim-group rv-sim-group-sea">' +
            '<div class="rv-sim-eyebrow"><i class="fa-solid fa-water rv-eyebrow-ic"></i>환경<span class="rv-sea-state" id="rv-sea-state" data-level="safe">—</span></div>' +
            '<div class="rv-sim-rows">' +
            '<div class="rv-sim-row"><label>파고</label><input type="range" id="rv-sim-wave" min="0.5" max="8" step="0.1" data-warn="5" data-danger="6.5" value="' + _wv + '"><span class="rv-sim-val" id="rv-sim-wave-val">' + _wv.toFixed(1) + ' m</span></div>' +
            '<div class="rv-sim-row"><label>파주기</label><input type="range" id="rv-sim-period" min="4" max="16" step="0.5" value="' + _wp + '"><span class="rv-sim-val" id="rv-sim-period-val">' + _wp.toFixed(1) + ' s</span></div>' +
            '<div class="rv-sim-row rv-sim-row-sky"><label>하늘</label>' +
            '<div class="rv-scn-seg rv-sky-seg" role="group" aria-label="하늘 분위기">' +
            '<button type="button" class="rv-scn-btn" data-sky="day">골든</button>' +
            '<button type="button" class="rv-scn-btn active" data-sky="noon">한낮</button>' +
            '<button type="button" class="rv-scn-btn" data-sky="dusk">황혼</button>' +
            '<button type="button" class="rv-scn-btn" data-sky="night">야간</button>' +
            '</div>' +
            '</div>' +
            '</div>' +
            '</div>' +

            // ── 2. 선박 (속도 + 선수 조우각 컴퍼스 다이얼) ──
            '<div class="rv-sim-group rv-sim-group-vessel">' +
            '<div class="rv-sim-eyebrow"><i class="fa-solid fa-ship rv-eyebrow-ic"></i>선박</div>' +
            '<div class="rv-sim-vessel">' +
            '<div class="rv-sim-vessel-left">' +
            '<div class="rv-sim-rows">' +
            '<div class="rv-sim-row"><label>속도</label><input type="range" id="rv-sim-speed" min="0" max="25" step="0.5" value="' + _sp + '"><span class="rv-sim-val" id="rv-sim-speed-val">' + _sp.toFixed(1) + ' kt</span></div>' +
            '</div>' +
            // 롤 강도 게이지 — 우측 컴퍼스가 아니라 좌측(속도) 옆에 둔다
            '<div class="rv-roll-gauge" title="조우각에 따른 횡요(좌우 흔들림) 강도 — 옆파일수록 강하고, 정면파면 대신 종요(앞뒤 끄덕임)가 커진다">' +
            '<span class="rv-roll-gauge-label">횡요 강도</span>' +
            '<span class="rv-roll-gauge-track"><span class="rv-roll-gauge-fill" id="rv-roll-intensity"></span></span>' +
            '<span class="rv-roll-gauge-val" id="rv-roll-intensity-val">약함</span>' +
            '</div>' +
            '</div>' +
            '<div class="rv-compass-wrap">' +
            '<div class="rv-compass" id="rv-compass" tabindex="0" role="slider" aria-label="선수 조우각" aria-valuemin="0" aria-valuemax="359" aria-valuenow="0">' +
            '<input type="hidden" id="rv-sim-heading" value="0">' +
            '<svg viewBox="0 0 100 100" class="rv-compass-svg" aria-hidden="true">' +
            '<circle class="rv-compass-ring" cx="50" cy="50" r="38"/>' +
            _bezelSVG +
            _helmSVG +
            '<g class="rv-compass-ticks">' +
            '<line x1="50" y1="12" x2="50" y2="18"/>' +
            '<line x1="50" y1="82" x2="50" y2="88"/>' +
            '<line class="rv-compass-tick-beam" x1="82" y1="50" x2="88" y2="50"/>' +
            '<line class="rv-compass-tick-beam" x1="12" y1="50" x2="18" y2="50"/>' +
            '</g>' +
            '<g class="rv-compass-wave"><line x1="50" y1="5" x2="50" y2="16"/><path d="M45 13 L50 20 L55 13"/></g>' +
            '<g class="rv-compass-needle" id="rv-compass-needle">' +
            '<path class="rv-compass-bow" d="M50 20 L44 51 L56 51 Z"/>' +
            '<path class="rv-compass-stern" d="M44 51 L56 51 L50 62 Z"/>' +
            '</g>' +
            '<circle class="rv-compass-hub" cx="50" cy="50" r="3.5"/>' +
            '</svg>' +
            '</div>' +
            '<div class="rv-compass-cap"><span class="rv-compass-tag">선수</span><span class="rv-sim-val" id="rv-sim-heading-val">정면파 0°</span></div>' +
            '</div>' +   // /rv-compass-wrap
            '</div>' +   // /rv-sim-vessel
            '</div>' +   // /rv-sim-group-vessel

            // ── 3. 시나리오 (직진 기본 세그먼트 + 타각) ──
            '<div class="rv-sim-group rv-sim-group-scenario">' +
            '<div class="rv-sim-eyebrow"><i class="fa-solid fa-arrows-turn-right rv-eyebrow-ic"></i>시나리오</div>' +
            '<div class="rv-scn-seg" role="group" aria-label="시나리오 선택">' +
            '<button type="button" class="rv-scn-btn active" id="rv-scn-straight" data-scn="straight">직진</button>' +
            '<button type="button" class="rv-scn-btn" id="rv-scn-port" data-scn="port">좌현</button>' +
            '<button type="button" class="rv-scn-btn" id="rv-scn-stbd" data-scn="stbd">우현</button>' +
            '<button type="button" class="rv-scn-btn" id="rv-scn-capsize" data-scn="capsize">전복</button>' +
            '</div>' +
            '<div class="rv-sim-rows">' +
            '<div class="rv-sim-row rv-sim-row-rudder rv-disabled" id="rv-sim-rudder-row"><label>타각</label><input type="range" id="rv-sim-rudder" min="5" max="35" step="1" data-warn="25" data-danger="32" value="35" disabled><span class="rv-sim-val" id="rv-sim-rudder-val">35°</span></div>' +
            '</div>' +
            '</div>' +

            // ── 4. 실행 (시나리오에 따라 라벨 변경) ──
            '<div class="rv-sim-actions">' +
            '<div class="rv-sim-eyebrow"><i class="fa-solid fa-play rv-eyebrow-ic"></i>실행</div>' +
            '<div class="rv-sim-actions-btns">' +
            '<button type="button" class="rv-action-btn rv-action-primary" id="rv-act-run" disabled>직진 운항</button>' +
            '<button type="button" class="rv-action-btn" id="rv-act-clear">초기화</button>' +
            '</div>' +
            '</div>' +

            '</div>' +   // ── /.rv-sim-cols ──

            // ── 진행 상황 — 풀폭 얇은 띠(선회 중에만). 폭을 안 바꿔 덱 가운데가 안 밀린다. ──
            '<div class="rv-sim-progress" id="rv-sim-progress" hidden>' +
            '<span class="rv-sim-prog-item"><span class="rv-sim-prog-label">상태</span><span class="rv-scenario-turn-val" id="rv-turn-phase">직진</span></span>' +
            '<span class="rv-sim-prog-item"><span class="rv-sim-prog-label">침로</span><span class="rv-scenario-turn-val" id="rv-turn-heading">000°</span></span>' +
            '<span class="rv-sim-prog-item"><span class="rv-sim-prog-label">타각</span><span class="rv-scenario-turn-val" id="rv-turn-rudder">0°</span></span>' +
            '<span class="rv-turn-progress"><span class="rv-turn-progress-fill" id="rv-turn-progress-fill"></span></span>' +
            '</div>' +

            '</div>';   // ── /.rv-scenario-body ──
        canvasWrap.appendChild(scenarioOverlay);

        // 접기 토글
        var collapseBtn = document.getElementById('rv-scenario-collapse');
        if (collapseBtn) {
            collapseBtn.addEventListener('click', function (e) {
                e.preventDefault();
                scenarioOverlay.classList.toggle('collapsed');
                var icon = collapseBtn.querySelector('i');
                if (icon) {
                    if (scenarioOverlay.classList.contains('collapsed')) {
                        icon.className = 'fa-solid fa-chevron-down';
                    } else {
                        icon.className = 'fa-solid fa-chevron-up';
                    }
                }
            });
        }

        // 하늘 분위기 세그먼트 — 클릭 즉시 setSkyMood 적용 (clock 무시, 기본 골든)
        var skySeg = scenarioOverlay.querySelector('.rv-sky-seg');
        if (skySeg) {
            // reflect the active mood in case a prior session left a non-default one
            skySeg.querySelectorAll('.rv-scn-btn').forEach(function (b) {
                b.classList.toggle('active', b.getAttribute('data-sky') === _activeMood);
            });
            skySeg.addEventListener('click', function (e) {
                var btn = e.target.closest('.rv-scn-btn');
                if (!btn) return;
                var mood = btn.getAttribute('data-sky');
                if (!mood) return;
                skySeg.querySelectorAll('.rv-scn-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
                setSkyMood(mood);
            });
        }

        // 슬라이더 바인딩 — 입력 시 라벨 갱신 + 시뮬레이션 오버라이드 적용
        function _simFill(el) {
            var min = parseFloat(el.min) || 0, max = parseFloat(el.max) || 100;
            var val = parseFloat(el.value);
            el.style.setProperty('--rv-sim-fill', ((val - min) / (max - min) * 100) + '%');
            // 슬라이더 fill은 항상 --primary로 통일한다. 위험 구간 빨강/주황 틴트는 제거 —
            // 기본 타각 35°가 곧장 빨강으로 보여 오해를 샀고, 위험도는 해상상태 배지·선회상태가 따로 표시한다.
            el.style.setProperty('--rv-sim-fill-color', 'var(--primary)');
        }
        // Douglas sea-state label from wave height — context for the 해상 상태 group.
        function _updateSeaState(h) {
            var el = document.getElementById('rv-sea-state');
            if (!el) return;
            var grade, label, level;
            if (h < 1.25)      { grade = 3; label = '약한 너울'; level = 'safe'; }
            else if (h < 2.5)  { grade = 4; label = '약간 거침'; level = 'safe'; }
            else if (h < 4)    { grade = 5; label = '거침';      level = 'caution'; }
            else if (h < 6)    { grade = 6; label = '매우 거침'; level = 'warning'; }
            else               { grade = 7; label = '높은 파도'; level = 'danger'; }
            el.textContent = grade + ' · ' + label;
            el.dataset.level = level;
        }
        function _bindSimSlider(id, valId, fmt, apply) {
            var el = document.getElementById(id);
            var vEl = document.getElementById(valId);
            if (!el) return;
            _simFill(el);   // initial fill for the default value
            el.addEventListener('input', function () {
                var v = parseFloat(el.value);
                if (vEl) vEl.textContent = fmt(v);
                _simFill(el);
                apply(v);
            });
        }
        _bindSimSlider('rv-sim-wave', 'rv-sim-wave-val', function (v) { return v.toFixed(1) + ' m'; }, function (v) { setScenarioOverride({ waveHeight: v }); _updateSeaState(v); });
        _updateSeaState(parseFloat((document.getElementById('rv-sim-wave') || {}).value) || _wv);   // initial sea-state label
        _bindSimSlider('rv-sim-period', 'rv-sim-period-val', function (v) { return v.toFixed(1) + ' s'; }, function (v) { setScenarioOverride({ wavePeriod: v }); });
        _bindSimSlider('rv-sim-speed', 'rv-sim-speed-val', function (v) { return v.toFixed(1) + ' kt'; }, function (v) { setScenarioOverride({ shipSpeed: v }); });
        _bindSimSlider('rv-sim-rudder', 'rv-sim-rudder-val', function (v) { return v.toFixed(0) + '°'; }, function (v) { _turnMaxRudder = v; });

        // 선수방위 — 파향 대비 조우각으로 라벨링(정면/옆/뒷파). baseHeading이 롤 크기를 좌우한다.
        function _encLabel(h) {
            var wd = (weather && weather.waveDirection) || 0;
            var rel = (((wd - h) % 360) + 360) % 360;       // 0–360
            var off = rel > 180 ? 360 - rel : rel;          // 0(정면)–180(뒷) off-bow
            var ang = Math.round(off);
            if (off < 35) return '정면파 ' + ang + '°';
            if (off > 145) return '뒷파 ' + ang + '°';
            if (off >= 55 && off <= 125) return '옆파 ' + ang + '°';
            return '사파 ' + ang + '°';
        }
        // ── 선수 컴퍼스 다이얼 — 조우각(파향 대비)을 회전으로 설정 ──
        // 화면각 θ(상=0, 시계방향)을 끌면 baseHeading=(파향-θ). θ=rel 이라 _encLabel과 정합:
        // θ=0 정면파 · θ=90 옆파(우현) · θ=180 뒷파 · θ=270 옆파(좌현).
        var compassEl = document.getElementById('rv-compass');
        var needleEl = document.getElementById('rv-compass-needle');
        var helmEl = document.getElementById('rv-helm-wheel');
        var headingInput = document.getElementById('rv-sim-heading');
        var headingValEl = document.getElementById('rv-sim-heading-val');
        var intensityFill = document.getElementById('rv-roll-intensity');
        var intensityValEl = document.getElementById('rv-roll-intensity-val');
        var _needleAngle = 0;   // 연속 니들 각(도) — 0/360 경계에서 한 바퀴 도는 것 방지(최단 경로 추적)
        function _compassSet(deg) {
            deg = ((Math.round(deg) % 360) + 360) % 360;
            baseHeading = deg;
            if (headingInput) headingInput.value = deg;
            if (compassEl) compassEl.setAttribute('aria-valuenow', deg);
            var wd = (weather && weather.waveDirection) || 0;
            var theta = (((wd - deg) % 360) + 360) % 360;   // 화면 니들 각(0~360)
            // 최단 경로로 연속 각 갱신 → CSS 전환이 경계에서 빙 돌지 않고 매끄럽게 미끄러진다.
            var d = theta - (((_needleAngle % 360) + 360) % 360);
            if (d > 180) d -= 360; else if (d < -180) d += 360;
            _needleAngle += d;
            if (needleEl) needleEl.setAttribute('transform', 'rotate(' + _needleAngle + ' 50 50)');
            // 타륜도 선수와 함께 회전 → 손잡이가 돌아 '키를 돌린' 듯한 피드백
            if (helmEl) helmEl.setAttribute('transform', 'rotate(' + _needleAngle + ' 50 50)');
            if (headingValEl) headingValEl.textContent = _encLabel(deg);
            // 예상 롤 강도 — 4120 라인의 롤 물리와 동일한 beamFactor(0.2~1.0). 옆파일수록 강함.
            var beamFactor = 0.2 + 0.8 * Math.abs(Math.sin(theta * Math.PI / 180));
            if (intensityFill) {
                intensityFill.style.width = Math.round(beamFactor * 100) + '%';
                var lvl = beamFactor >= 0.82 ? 'danger' : beamFactor >= 0.5 ? 'caution' : 'safe';
                intensityFill.dataset.level = lvl;
                if (intensityValEl) {
                    intensityValEl.textContent = lvl === 'danger' ? '강함' : lvl === 'caution' ? '보통' : '약함';
                    intensityValEl.dataset.level = lvl;
                }
            }
        }
        // ── 타륜(helm) 조작 — 절대각 점프가 아니라 '잡고 돌리는' 상대 회전 ──
        // 포인터의 각도 변화량(Δ)만큼 선수를 돌린다. 잡은 손잡이가 포인터를 따라와 실제 키를 돌리는 느낌.
        var _lastPtrAngle = null;
        var _helmTurned = false;   // 이번 드래그에서 실제 회전을 시작했는지(선미 뷰 1회 전환용)
        function _ptrAngle(ev) {
            var r = compassEl.getBoundingClientRect();
            var px = ev.clientX - (r.left + r.width / 2);
            var py = ev.clientY - (r.top + r.height / 2);
            return { ang: Math.atan2(px, -py) * 180 / Math.PI, rad: Math.sqrt(px * px + py * py), w: r.width };
        }
        function _helmDrag(ev) {
            if (!compassEl) return;
            var a = _ptrAngle(ev);
            // 중심 근처 데드존 — 미세 이동에도 각도가 휙 튀므로 기준만 갱신하고 회전은 보류.
            if (a.rad < a.w * 0.12) { _lastPtrAngle = a.ang; return; }
            if (_lastPtrAngle === null) { _lastPtrAngle = a.ang; return; }
            var d = a.ang - _lastPtrAngle;
            if (d > 180) d -= 360; else if (d < -180) d += 360;   // 최단 경로(한 바퀴 넘김 처리)
            _lastPtrAngle = a.ang;
            if (Math.abs(d) < 0.01) return;
            // 실제로 돌리기 시작하면 카메라를 선미 뒤로 → 조타석에서 직접 조종하는 시점
            if (!_helmTurned) { _helmTurned = true; animateCameraToPreset({ x: -32, y: 13, z: 0 }); }
            _compassSet(baseHeading - d);   // 포인터가 시계방향이면 선수도 따라 돈다
        }
        if (compassEl) {
            // Pointer capture → 드래그 중 포인터가 벗어나도 추적, window 리스너 누수 없음.
            compassEl.addEventListener('pointerdown', function (ev) {
                ev.preventDefault();
                try { compassEl.setPointerCapture(ev.pointerId); } catch (e) {}
                _lastPtrAngle = _ptrAngle(ev).ang;   // 잡은 지점 기준 — 점프 없이 여기서부터 회전
                _helmTurned = false;
                compassEl.classList.add('rv-compass-turning');
            });
            compassEl.addEventListener('pointermove', function (ev) {
                if (compassEl.hasPointerCapture && compassEl.hasPointerCapture(ev.pointerId)) _helmDrag(ev);
            });
            var _helmRelease = function (ev) {
                _lastPtrAngle = null;
                compassEl.classList.remove('rv-compass-turning');
                try { compassEl.releasePointerCapture(ev.pointerId); } catch (e) {}
            };
            compassEl.addEventListener('pointerup', _helmRelease);
            compassEl.addEventListener('pointercancel', _helmRelease);
            compassEl.addEventListener('keydown', function (ev) {
                if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') { _compassSet(baseHeading - 5); ev.preventDefault(); }
                else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') { _compassSet(baseHeading + 5); ev.preventDefault(); }
            });
        }
        // 초기 = 정면파(조우각 0). baseHeading=파향이라야 encounter=0 → 바우가 위쪽 wave 마커를 정면으로 본다.
        _compassSet((weather && weather.waveDirection) || 0);

        // 슬라이더 값 복원 헬퍼
        function _resetSim(id, valId, val, fmt) {
            var el = document.getElementById(id);
            var vEl = document.getElementById(valId);
            if (el) { el.value = val; _simFill(el); }
            if (vEl) vEl.textContent = fmt(val);
        }

        // ── 시나리오 세그먼트 (직진 기본) + 실행 ──
        // simScenario = 의도(직진/좌현/우현/전복). 실행 버튼이 실제 시작/정지를 담당.
        var simScenario = 'straight';
        var scnBtns = {
            straight: document.getElementById('rv-scn-straight'),
            port: document.getElementById('rv-scn-port'),
            stbd: document.getElementById('rv-scn-stbd'),
            capsize: document.getElementById('rv-scn-capsize')
        };
        var runBtn = document.getElementById('rv-act-run');
        var rudderRow = document.getElementById('rv-sim-rudder-row');
        var rudderInput = document.getElementById('rv-sim-rudder');
        function _syncSimUI() {
            Object.keys(scnBtns).forEach(function (k) {
                if (scnBtns[k]) scnBtns[k].classList.toggle('active', k === simScenario);
            });
            var rudderOn = (simScenario === 'port' || simScenario === 'stbd');
            if (rudderRow) rudderRow.classList.toggle('rv-disabled', !rudderOn);
            if (rudderInput) rudderInput.disabled = !rudderOn;
            if (!runBtn) return;
            runBtn.classList.remove('active');
            if (simScenario === 'straight') {
                runBtn.textContent = '직진 운항';
                runBtn.disabled = true;
            } else if (simScenario === 'capsize') {
                runBtn.disabled = false;
                if (_capsize) { runBtn.textContent = '정지'; runBtn.classList.add('active'); }
                else runBtn.textContent = '전복 시작';
            } else {   // port | stbd
                runBtn.disabled = false;
                if (turnScenarioActive) { runBtn.textContent = '선회 정지'; runBtn.classList.add('active'); }
                else runBtn.textContent = '선회 시작';
            }
        }
        function _selectScenario(scn) {
            simScenario = scn;
            // 좌현↔우현 전환은 선회 진행 중이면 라이브 반영(정지 안 함).
            if (scn === 'straight') { setTurnScenario(false); clearCapsize(); }
            else if (scn === 'port') { turnDirection = -1; clearCapsize(); }
            else if (scn === 'stbd') { turnDirection = 1; clearCapsize(); }
            else if (scn === 'capsize') { setTurnScenario(false); }
            _syncSimUI();
        }
        Object.keys(scnBtns).forEach(function (k) {
            if (scnBtns[k]) scnBtns[k].addEventListener('click', function () { _selectScenario(k); });
        });
        if (runBtn) runBtn.addEventListener('click', function () {
            if (simScenario === 'capsize') {
                if (_capsize) { clearCapsize(); simScenario = 'straight'; }
                else triggerCapsize(turnDirection || 1, 0);
            } else if (simScenario === 'port' || simScenario === 'stbd') {
                if (turnScenarioActive) { setTurnScenario(false); simScenario = 'straight'; }
                else setTurnScenario(true, turnDirection);
            }
            _syncSimUI();
        });

        // 초기화 = 완전 복귀: 선회 정지 + 전복 취소 + 날씨/속도 해제 + 슬라이더·선수·시나리오 원복
        var actClear = document.getElementById('rv-act-clear');
        if (actClear) actClear.addEventListener('click', function () {
            setTurnScenario(false);
            clearCapsize();
            clearScenarioOverride();
            var bw = _baseWeather || {};
            _resetSim('rv-sim-wave', 'rv-sim-wave-val', bw.waveHeight != null ? bw.waveHeight : 2.5, function (v) { return parseFloat(v).toFixed(1) + ' m'; });
            _resetSim('rv-sim-period', 'rv-sim-period-val', bw.wavePeriod != null ? bw.wavePeriod : 8, function (v) { return parseFloat(v).toFixed(1) + ' s'; });
            _resetSim('rv-sim-speed', 'rv-sim-speed-val', _baseShipSpeed != null ? _baseShipSpeed : 10, function (v) { return parseFloat(v).toFixed(1) + ' kt'; });
            _resetSim('rv-sim-rudder', 'rv-sim-rudder-val', 35, function (v) { return parseFloat(v).toFixed(0) + '°'; });
            _compassSet((weather && weather.waveDirection) || 0);   // 정면파로 복귀
            _turnMaxRudder = 35;
            turnDirection = 1;
            simScenario = 'straight';
            _syncSimUI();
        });

        _syncSimUI();   // 초기 상태 반영(직진)

        // 진행 상황 띠(선회 중에만) 토글 참조
        turnHudEl = document.getElementById('rv-sim-progress');
    }

    // ── Title bar (top): back · ship identity · view-mode + control toggles ──
    function buildTitleBar(ship) {
        var name = (ship && ship.name && ship.name !== 'UNKNOWN') ? _escHtml(ship.name) : ('MMSI ' + (ship && ship.mmsi || '—'));
        var typeKo = SHIP_TYPE_KO[getShipTypeKey(ship)] || '기타';
        var lenTxt = (ship && parseFloat(ship.length)) ? Math.round(parseFloat(ship.length)) + 'm' : '';
        var bar = document.createElement('div');
        bar.className = 'rv-titlebar';
        bar.innerHTML =
            '<button class="rv-tb-back" id="rv-tb-back" title="지구본으로"><i class="fa-solid fa-arrow-left"></i><span>지구본</span></button>' +
            '<div class="rv-tb-id">' +
                '<span class="rv-tb-name">' + name + '</span>' +
                '<span class="rv-tb-meta">' + typeKo + (lenTxt ? ' · ' + lenTxt : '') + '</span>' +
            '</div>' +
            '<div class="rv-tb-actions">' +
                '<div class="rv-viewseg" role="group" aria-label="3D 보기 방식">' +
                    '<button class="rv-viewseg-btn active" id="rv-view-overlay" title="실측·예측을 겹쳐서 비교"><i class="fa-solid fa-clone"></i><span>겹쳐보기</span></button>' +
                    '<button class="rv-viewseg-btn" id="rv-view-split" title="실측·예측을 좌우로 나눠보기"><i class="fa-solid fa-table-columns"></i><span>나눠보기</span></button>' +
                '</div>' +
                '<button class="rv-tb-btn" id="rv-tb-sim" title="시뮬레이션 제어"><i class="fa-solid fa-sliders"></i><span>시뮬레이션</span></button>' +
                '<button class="rv-tb-btn" id="rv-tb-detail" title="상세 정보"><i class="fa-solid fa-circle-info"></i><span>상세</span></button>' +
            '</div>';
        bar.querySelector('#rv-tb-back').addEventListener('click', function () {
            if (window.LayoutManager) LayoutManager.closeDedicatedPanel();
        });
        bar.querySelector('#rv-view-overlay').addEventListener('click', function () { setShipViewMode(true); });
        bar.querySelector('#rv-view-split').addEventListener('click', function () { setShipViewMode(false); });
        return bar;
    }

    // ── 횡요각 HUD — 무대 좌상단 카드 (하단 콘솔 바를 대체) ──
    // 위계: 히어로 = 실측 횡요각(배가 지금 얼마나 기울었나 — 안전 계기의 결론, 심각도 색)
    //      → 보조 쌍 = 예측·오차 → 하단 = 예측 정확도(RMSE·Δ Pitch, 누적 품질).
    // Δ Roll 행은 '오차'와 동일 값(실측−예측)이라 중복 표기를 없앴다.
    function buildRollHud() {
        var hud = document.createElement('div');
        hud.className = 'rv-hud';
        hud.id = 'rv-hud';
        hud.setAttribute('role', 'group');
        hud.setAttribute('aria-label', '횡요각 계기 — 실측·예측·오차');
        hud.innerHTML =
            '<div class="rv-hud-sec rv-hud-sec-primary">' +
                '<div class="rv-hud-eyebrow">횡요각 실측</div>' +
                // 히어로: 실측 횡요각. 파란 실선 점 = 3D의 실측 선체와 같은 인코딩(범례 겸용).
                '<div class="rv-hud-hero" title="AIS 실측 기반 현재 횡요각"><span class="rv-hud-dot rv-hud-dot-real"></span><span class="rv-clino-gap-val rv-roll-safe" id="rv-real-roll">0.0°</span></div>' +
                // 보조 쌍: 모델 예측값 + 실측과의 차이(오차)
                '<div class="rv-hud-pair">' +
                    '<span class="rv-hud-pair-item" title="모델 예측 횡요각 — 3D의 하늘색 고스트 선체"><span class="rv-hud-dot rv-hud-dot-pred"></span><span class="rv-hud-tag">예측</span><span class="rv-clino-val" id="rv-pred-roll">0.0°</span></span>' +
                    '<span class="rv-hud-pair-item" title="실측−예측 차이 — 지금 이 순간 모델이 빗나간 정도"><span class="rv-hud-tag">오차 Δ</span><span class="rv-clino-val rv-roll-safe" id="rv-clino-gap">0.0°</span></span>' +
                '</div>' +
            '</div>' +
            '<div class="rv-hud-sec rv-hud-sec-acc">' +
                '<div class="rv-hud-eyebrow">예측 정확도</div>' +
                '<div class="rv-pred-hud-row" title="최근 60프레임 실측·예측 횡요각의 RMSE"><span class="rv-pred-hud-label">RMSE</span><span class="rv-pred-hud-val" id="rv-rmse">0.0°</span><span class="rv-pred-hud-bar"><i class="rv-pred-hud-bar-fill" id="rv-rmse-bar"></i></span></div>' +
                '<div class="rv-pred-hud-row" title="종요(피치) 실측−예측 차이"><span class="rv-pred-hud-label">Δ Pitch</span><span class="rv-pred-hud-val" id="rv-d-pitch">0.0°</span><span class="rv-pred-hud-bar"><i class="rv-pred-hud-bar-fill" id="rv-d-pitch-bar"></i></span></div>' +
            '</div>';
        // 시나리오 진행 상황은 좌상단 HUD가 아니라 하단 액션 바 옆에 둔다(buildSimPanel의 .rv-sim-progress).
        return hud;
    }

    // ── Camera presets (float in the 3D stage) ──
    function buildCanvasOverlays(canvasWrap) {
        var camGroup = document.createElement('div');
        camGroup.className = 'rv-cam-presets';

        var presets = CAM_PRESETS;

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

        // 실측/예측 화면 라벨 — 겹쳐보기=중앙 범례, 나눠보기=좌/우 분할 위에 표시
        canvasWrap.classList.add(splitView ? 'rv-stage--split' : 'rv-stage--overlay');
        var labels = document.createElement('div');
        labels.className = 'rv-stage-labels';
        labels.innerHTML =
            '<span class="rv-vlabel rv-vlabel-real" id="rv-vlabel-real"><i class="rv-vlabel-dot"></i>실측</span>' +
            '<span class="rv-vlabel rv-vlabel-pred" id="rv-vlabel-pred"><i class="rv-vlabel-dot"></i>예측</span>';
        canvasWrap.appendChild(labels);

        // 예측 오차(Δ) — 두 선체가 벌어진 지점에 단일 라벨 (겹쳐보기 전용).
        // 같은 값이 HUD '오차 Δ'에 있으므로 보조기기에는 중복 낭독하지 않는다.
        var deg = document.createElement('div');
        deg.className = 'rv-deg-labels';
        deg.setAttribute('aria-hidden', 'true');
        deg.innerHTML = '<span class="rv-deg rv-deg-err" id="rv-deg-err" style="display:none">Δ 0.0°</span>';
        canvasWrap.appendChild(deg);
    }

    function animateCameraToPreset(targetPos) {
        if (!camera || cameraAnimating) return;
        var elapsed = (performance.now() - clockStart) / 1000;
        // 프리셋 좌표는 선체-로컬(+x=선수, +z=우현)이다. 현재 선수방위(heading)로 회전시켜
        // 월드 좌표로 옮겨야 배가 돌아가 있어도 '선미' 버튼이 진짜 선미 뒤를 잡는다.
        var _h = (baseHeading + (turnScenarioActive ? turnHeading : 0)) * Math.PI / 180;
        var _cos = Math.cos(_h), _sin = Math.sin(_h);
        var _wx = _cos * targetPos.x + _sin * targetPos.z;
        var _wz = -_sin * targetPos.x + _cos * targetPos.z;
        camPresetAnim = {
            fromPos: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
            toPos: { x: shipWorldPos.x + _wx, y: targetPos.y, z: shipWorldPos.z + _wz },
            fromTarget: controls ? { x: controls.target.x, y: controls.target.y, z: controls.target.z } : { x: 0, y: 2, z: 0 },
            toTarget: { x: shipWorldPos.x, y: 2, z: shipWorldPos.z },
            start: elapsed,
            duration: 1.0
        };
    }

    // AI 어시스턴트용 — 프리셋 id('beam'|'bow'|'stern'|'top')로 카메라 시점 전환.
    // 별칭(선수/선미/측면/탑/정면 등)도 받아 매핑한다.
    function setCameraView(view) {
        if (!view) return false;
        var key = String(view).trim().toLowerCase();
        var ALIAS = {
            '선수': 'bow', '선두': 'bow', '뱃머리': 'bow', '정면': 'bow', 'front': 'bow', 'bow': 'bow',
            '선미': 'stern', '후미': 'stern', '뒤': 'stern', 'back': 'stern', 'rear': 'stern', 'aft': 'stern', 'stern': 'stern',
            '측면': 'beam', '옆': 'beam', 'side': 'beam', 'beam': 'beam',
            '탑': 'top', '탑뷰': 'top', '위': 'top', '상단': 'top', 'top': 'top'
        };
        var id = ALIAS[key] || key;
        var preset = CAM_PRESETS.filter(function (p) { return p.id === id; })[0];
        if (!preset) return false;
        animateCameraToPreset(preset.pos);
        return true;
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
            _camHeadingSynced = false;   // 추종 재개 시 현재 침로로 스냅(오비트 점프 방지)
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
        // 선회 중에만 나타나는 진행(재생) 바가 짧아진 패널 안에서 컨트롤과 겹치지 않도록,
        // 선회 동안에는 덱을 살짝 키워 재생 바에 깨끗한 자리를 준다.
        var _deckPanel = document.getElementById('rv-canvas-hud-scenario');
        if (_deckPanel) _deckPanel.classList.toggle('rv-deck-turning', turnScenarioActive);
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
            var actTurnOn = document.getElementById('rv-act-turn');
            if (actTurnOn) { actTurnOn.textContent = '선회 정지'; actTurnOn.classList.add('active'); }
        } else {
            if (controls) {
                controls.target.set(shipWorldPos.x, 2, shipWorldPos.z);
                controls.enabled = true;
            }
            if (turnBtnEl) {
                turnBtnEl.innerHTML = '<i class="fa-solid fa-ship"></i> 선회 시나리오';
                turnBtnEl.classList.remove('active');
            }
            var actTurnOff = document.getElementById('rv-act-turn');
            if (actTurnOff) { actTurnOff.textContent = '선회 시작'; actTurnOff.classList.remove('active'); }
            turnHeading = 0;
            camFollowHeading = 0;
            _camHeadingSynced = false;   // 침로가 baseHeading로 복귀 → 카메라 재동기화(점프 방지)
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
        var maxTurnRate = 5 * (_turnMaxRudder / 35);   // 타각에 비례한 선회율 (deg/s)

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
            rudder = _turnMaxRudder * ease;
            rollMult = 1 + (TURN_ROLL_MULT[shipType] - 1) * ease;
        } else if (cycleTime < TURN_TIMING.straight + TURN_TIMING.entering + TURN_TIMING.turning) {
            // Full turn — max roll
            turnPhase = 'turning';
            phaseName = '선회 중';
            headingRate = maxTurnRate;
            rudder = _turnMaxRudder;
            rollMult = TURN_ROLL_MULT[shipType];
        } else {
            // Exiting turn — rudder decreasing, roll settling
            turnPhase = 'exiting';
            phaseName = '선회 탈출';
            var tExit = (cycleTime - TURN_TIMING.straight - TURN_TIMING.entering - TURN_TIMING.turning) / TURN_TIMING.exiting;
            var easeOut = 1 - tExit * tExit; // ease-out
            headingRate = maxTurnRate * easeOut;
            rudder = _turnMaxRudder * easeOut;
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

        // 우현(dir=+1) 타각 → 우회전. Three.js rotation.y 증가는 반시계(좌)라 부호를 뒤집는다.
        turnHeading -= headingRate * dir * dt;
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
        if (headingEl) {
            // 표시용 컴퍼스 침로 — 회전 로직(turnHeading=rotation.y)은 그대로 두고 숫자만 보정.
            // 정지 시 baseHeading, 우현(starboard) 선회 시 증가, 좌현 시 감소하도록 부호 반전.
            var _compass = (Math.round((baseHeading - turnHeading) % 360 + 360) % 360);
            headingEl.textContent = ('00' + _compass).slice(-3) + '°';
        }
        if (rudderEl) rudderEl.textContent = (rudder > 0.5 ? (dir > 0 ? 'S' : 'P') + Math.round(rudder) + '°' : '0°');
        if (progressFill) progressFill.style.width = ((cycleTime / TURN_TOTAL) * 100) + '%';

        return {
            headingDelta: -headingRate * dir * dt,
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
        ctx.font = '700 ' + fs.toFixed(0) + "px 'Rajdhani', 'S-CoreDream-6Bold', 'Pretendard Variable', sans-serif";
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
        ctx.font = "700 38px 'B612 Mono', 'JetBrains Mono', 'Pretendard Variable', monospace";
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
            cx.font = "600 88px 'Rajdhani', 'S-CoreDream-6Bold', 'Pretendard Variable', sans-serif";
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
        ctx.fillStyle = '#2f6fed';
        ctx.font = "700 20px 'Rajdhani', 'S-CoreDream-6Bold', 'Pretendard Variable', sans-serif";
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
    // ── buildSpray() — 선수 포말 입자(정상 bow wave + 슬램 스프레이). sprayPoints는 매 프레임
    //    shipWorldPos에 부착되고 좌표는 선체-로컬. 입자는 뱃머리에서 솟구쳐 중력으로 떨어진다. ──
    function buildSpray() {
        // 뱃머리 물보라·슬램 스프레이 비활성화 — 흰 포말이 인위적으로 보여 사용자 요청으로 제거.
        // sprayPoints를 만들지 않으면 호출부(if(sprayPoints))와 animateSpray가 자동으로 스킵된다.
        // 되살리려면 이 return 한 줄만 지우면 됨.
        return;
        var THREE = window.THREE;
        var geometry = new THREE.BufferGeometry();
        var positions = new Float32Array(SPRAY_COUNT * 3);
        sprayVelocities = [];
        for (var i = 0; i < SPRAY_COUNT; i++) {
            positions[i * 3] = 0; positions[i * 3 + 1] = -2; positions[i * 3 + 2] = 0;  // 처음엔 수면 아래(숨김)
            sprayVelocities.push({ vx: 0, vy: 0, vz: 0, life: Math.random() * 1.2, maxLife: 0.5 + Math.random() * 0.6 });
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        var material = new THREE.PointsMaterial({
            color: 0xeef4fb,         // 흰 포말
            size: 1.2,
            transparent: true,
            opacity: 0.0,
            blending: THREE.NormalBlending,
            depthWrite: false,
            sizeAttenuation: true
        });
        sprayPoints = new THREE.Points(geometry, material);
        sprayPoints.frustumCulled = false;   // 선체에 부착되어 항상 보이도록
        scene.add(sprayPoints);
    }

    // ── buildContactShadow() — 수면 위 옅은 타원 그림자. 선체 아래에 깔려 '물에 얹힌' 접지감을 준다. ──
    function buildContactShadow() {
        var THREE = window.THREE;
        var cv = document.createElement('canvas'); cv.width = cv.height = 128;
        var c = cv.getContext('2d');
        var g = c.createRadialGradient(64, 64, 4, 64, 64, 64);
        g.addColorStop(0, 'rgba(0,20,30,0.55)');
        g.addColorStop(0.5, 'rgba(0,15,25,0.26)');
        g.addColorStop(1, 'rgba(0,10,20,0)');
        c.fillStyle = g; c.fillRect(0, 0, 128, 128);
        var tex = new THREE.CanvasTexture(cv);
        var mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.6 });
        var plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        plane.rotation.x = -Math.PI / 2;
        plane.scale.set(22, 8, 1);          // 로컬 x=선수미 길이(→heading 0에서 +X), y=빔
        var grp = new THREE.Group();
        grp.add(plane);
        grp.renderOrder = 1;
        grp.frustumCulled = false;
        _contactShadow = grp;
        scene.add(grp);
    }

    // ── animateSpray(dt, heading, bowFoam, slam) — 뱃머리 포말 ──
    //  bowFoam: 속도 기반 상시 선수파(0~1), slam: 마루에 처박힐 때 물보라 버스트(0~1).
    //  입자는 선체-로컬 좌표(sprayPoints는 호출부에서 shipWorldPos에 부착). 중력으로 낙하.
    function animateSpray(dt, headingRad, bowFoam, slam) {
        if (!sprayPoints) return;
        var pos = sprayPoints.geometry.attributes.position;
        var fwdX = Math.cos(headingRad), fwdZ = -Math.sin(headingRad);
        var sideX = Math.sin(headingRad), sideZ = Math.cos(headingRad);
        var bowDist = 8.5;            // 뱃머리까지 거리(선체-로컬)
        var active = Math.max(bowFoam, slam);
        var GRAV = 7.0;

        for (var i = 0; i < SPRAY_COUNT; i++) {
            var v = sprayVelocities[i];
            v.life += dt;

            if (v.life >= v.maxLife) {
                if (active < 0.03) {
                    // 정지/표류 — 입자를 수면 아래로 치워 보이지 않게
                    pos.setXYZ(i, 0, -2, 0);
                    v.vx = v.vy = v.vz = 0; v.maxLife = 0.8 + Math.random() * 0.6; v.life = 0;
                    continue;
                }
                var burst = slam > 0.05 && Math.random() < (0.25 + slam * 0.65);
                var amp = burst ? (0.8 + slam * 1.0) : (0.15 + bowFoam * 0.5);
                var lateral = Math.random() * 2 - 1;                          // -1(좌) ~ +1(우)
                var along = bowDist + (Math.random() - 0.5) * 4;
                var beamOff = lateral * (1.6 + Math.abs(lateral) * 2.2);      // 가장자리일수록 넓게 → V 콧수염
                pos.setXYZ(i,
                    fwdX * along + sideX * beamOff,
                    0.1 + Math.random() * 0.2,
                    fwdZ * along + sideZ * beamOff);
                v.vx = sideX * lateral * (0.7 + amp * 0.9) + fwdX * (0.2 + amp * 0.5);
                v.vz = sideZ * lateral * (0.7 + amp * 0.9) + fwdZ * (0.2 + amp * 0.5);
                v.vy = burst ? (1.1 + slam * 2.4 + Math.random() * 0.8) : (0.25 + bowFoam * 0.8 + Math.random() * 0.3);
                v.maxLife = burst ? (0.5 + Math.random() * 0.6) : (0.4 + Math.random() * 0.6);
                v.life = 0;
                continue;
            }

            v.vy -= GRAV * dt;   // 중력 — 솟구쳤다 떨어진다
            var x = pos.getX(i) + v.vx * dt;
            var y = pos.getY(i) + v.vy * dt;
            var z = pos.getZ(i) + v.vz * dt;
            if (y < 0) { v.life = v.maxLife; y = 0; }   // 수면 도달 → 재활용
            pos.setXYZ(i, x, y, z);
        }

        sprayPoints.material.opacity = Math.min(0.75, 0.12 + active * 0.6);
        sprayPoints.material.size = 0.9 + slam * 1.3 + bowFoam * 0.4;
        pos.needsUpdate = true;
    }

    // Visual swell floor — a dead-calm sea (waveHeight ≈ 0) renders as a flat mirror
    // that just blows out the sky. The reference always carries gentle swell, so for
    // the *visual* wave field we floor the height; physics/labels still use real data.
    function _visualWeather() {
        if ((weather.waveHeight || 0) >= 0.8) return weather;
        return Object.assign({}, weather, { waveHeight: 0.8 });
    }

    // ── buildWater() — Three.js Water shader with reflection/refraction ──
    function buildWater() {
        var THREE = window.THREE;

        var waterGeometry = new THREE.PlaneGeometry(2000, 2000, 200, 200);

        var loader = new THREE.TextureLoader();
        waterNormals = loader.load(
            'https://raw.githubusercontent.com/mrdoob/three.js/r137/examples/textures/waternormals.jpg',
            function (texture) {
                texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
                // 타일링 완화 — 원거리에서 노멀맵 패턴이 규칙적으로 반복·반짝이는 걸
                // mipmap + anisotropy로 흐려 자연스럽게 섞는다(반복감의 주원인 제거).
                texture.minFilter = THREE.LinearMipmapLinearFilter;
                texture.magFilter = THREE.LinearFilter;
                texture.generateMipmaps = true;
                if (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
                    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
                }
                texture.needsUpdate = true;
            }
        );

        var tod = getActiveTod();
        var pal = SKY_PALETTES[tod];
        waterMesh = new THREE.Water(waterGeometry, {
            // 512 — reference resolution; sharper sky reflection / sun glint than 256.
            textureWidth: 512,
            textureHeight: 512,
            waterNormals: waterNormals,
            sunDirection: (sunPosition ? sunPosition.clone().normalize() : new THREE.Vector3(0.7, 0.5, 0.3).normalize()),
            // day 글린트를 순백(0xffffff)에서 살짝 웜화이트로 — 블로운된 하이라이트가
            // '금속 반사'처럼 읽히던 걸 누그러뜨린다.
            sunColor: (tod === 'day') ? 0xfff0e0 : pal.sunColor,
            waterColor: pal.waterColor,
            // floor 3.0→2.2 — 잔잔한 바다에서 정반사 왜곡(번들거림)을 줄여 덜 인위적으로.
            distortionScale: Math.max((weather.waveHeight || 0) * 1.5, 2.2),
            fog: scene.fog !== undefined
        });

        waterMesh.rotation.x = -Math.PI / 2;
        waterMesh.position.y = 0;
        if (waterMesh.material) waterMesh.material.side = THREE.DoubleSide;   // 수중에서 수면을 밑에서도 보이게
        scene.add(waterMesh);

        // ── Gerstner displacement injection ──
        // Reuse THREE.Water's reflection/refraction; patch its vertex shader to
        // displace vertices. Ship heave samples the same wave field (heightAt).
        _waves = (window.Gerstner) ? Gerstner.buildWaves(_visualWeather()) : [];
        _waterPatched = false;
        if (window.Gerstner) {
            try {
                var wmat = waterMesh.material;
                var vs = wmat.vertexShader;
                if (vs.indexOf('gerstnerDisplace') === -1) {
                    vs = vs.replace(
                        'uniform float time;',
                        'uniform float time;\nvarying vec3 vGerstnerNormal;\n' + Gerstner.GLSL_SNIPPET
                    );
                    vs = vs.replace(
                        'void main() {',
                        'void main() {\n\tvec3 gPos = position + gerstnerDisplace( position.xy );\n\tvGerstnerNormal = gerstnerNormal( position.xy );'
                    );
                    vs = vs.replace('modelMatrix * vec4( position, 1.0 )', 'modelMatrix * vec4( gPos, 1.0 )');
                    vs = vs.replace('modelViewMatrix * vec4( position, 1.0 )', 'modelViewMatrix * vec4( gPos, 1.0 )');
                    wmat.vertexShader = vs;

                    // ── Analytic normals — light follows the real wave shape ──
                    // Replace the flat normal-map surfaceNormal with the exact Gerstner
                    // normal, keeping a fraction of texture ripple for fine sparkle.
                    var fsh = wmat.fragmentShader;
                    fsh = fsh.replace(
                        'varying vec4 worldPosition;',
                        'varying vec4 worldPosition;\nvarying vec3 vGerstnerNormal;\nuniform float uCrestTilt;'
                    );
                    fsh = fsh.replace(
                        'vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );',
                        'vec3 detailN = normalize( noise.xzy * vec3( 1.2, 1.0, 1.2 ) );\n\tvec3 surfaceNormal = normalize( detailN + vec3( vGerstnerNormal.x, 0.0, vGerstnerNormal.z ) * uCrestTilt );'
                    );
                    // rf0은 레퍼런스(water.png)와 동일하게 THREE.Water 기본값 0.3 유지.
                    // (0.16으로 낮췄더니 정면 반사가 줄어 물이 어둡고 초록끼가 돌았다 → 되돌림)
                    wmat.fragmentShader = fsh;

                    var dirArr = [], parArr = [];
                    for (var wi = 0; wi < Gerstner.MAX_WAVES; wi++) {
                        dirArr.push(new THREE.Vector2());
                        parArr.push(new THREE.Vector4());
                    }
                    wmat.uniforms.uTime = { value: 0 };
                    wmat.uniforms.uWaveCount = { value: 0 };
                    wmat.uniforms.uWaveDir = { value: dirArr };
                    wmat.uniforms.uWaveParams = { value: parArr };
                    wmat.uniforms.uCrestTilt = { value: 0.6 };   // 0.85→0.6 — 정반사 과장(은박지 번들거림) 완화로 덜 인위적
                    wmat.needsUpdate = true;
                    _waterPatched = true;
                    _applyWavesToWater();
                }
            } catch (e) {
                console.warn('[roll-viewer] Gerstner water patch failed, using flat water:', e);
                _waterPatched = false;
            }
        }
    }

    // Push current _waves into the patched Water shader uniforms.
    function _applyWavesToWater() {
        if (!_waterPatched || !waterMesh || !waterMesh.material) return;
        if (!window.Gerstner) return;
        var u = waterMesh.material.uniforms;
        if (!u || !u.uWaveDir) return;
        var max = Gerstner.MAX_WAVES;
        for (var i = 0; i < max; i++) {
            var w = _waves[i];
            if (w) {
                u.uWaveDir.value[i].set(w.dirX, w.dirY);
                u.uWaveParams.value[i].set(w.k, w.A, w.omega, w.Q);
            } else {
                u.uWaveDir.value[i].set(0, 0);
                u.uWaveParams.value[i].set(0, 0, 0, 0);
            }
        }
        u.uWaveCount.value = Math.min(_waves.length, max);
    }

    // ── setSkyMood(mood) — live switch the sky/sun/water/lights to a preset ──
    // Driven by the 시뮬레이션 패널 → 하늘 segmented control. 'day'(골든) is the default.
    // Sky/clouds/sun are cheap so we rebuild them; the stateful Water is updated in place.
    function setSkyMood(mood) {
        if (!scene) return;
        if (!SKY_PALETTES[mood]) return;
        if (mood === _activeMood && skyGroup) return;   // no-op if already active
        _activeMood = mood;

        _disposeSkyVisuals();
        buildSky();    // rebuilds skyGroup + fog + exposure + PMREM env (reads getActiveTod)
        buildSun();    // disc only for the night dome; skips when Sky shader is active

        _applyMoodToWater();
        _applyMoodToLights();
        _refreshNavLights();
        _applyMoodToShipEmissive();
    }

    // Remove + dispose the current sky dome, clouds and sun disc before a rebuild.
    function _disposeSkyVisuals() {
        [skyGroup, cloudGroup].forEach(function (g) {
            if (!g) return;
            scene.remove(g);
            g.traverse(function (o) {
                if (o.geometry) o.geometry.dispose();
                if (o.material) {
                    if (o.material.map) o.material.map.dispose();
                    o.material.dispose();
                }
            });
        });
        skyGroup = null; skyMesh = null;
        cloudGroup = null; _cloudSprites = [];
        sunMesh = null;   // was a child of skyGroup, disposed above
    }

    // Retint the existing Water shader for the active mood (no rebuild — keeps the mirror).
    function _applyMoodToWater() {
        if (!waterMesh || !waterMesh.material || !waterMesh.material.uniforms) return;
        var mood = getActiveTod();
        var pal = SKY_PALETTES[mood];
        var u = waterMesh.material.uniforms;
        if (u['waterColor']) u['waterColor'].value.setHex(pal.waterColor);
        if (u['sunColor']) u['sunColor'].value.setHex(mood === 'day' ? 0xfff0e0 : (mood === 'noon' ? 0xffffff : pal.sunColor));
        if (u['sunDirection'] && sunPosition) u['sunDirection'].value.copy(sunPosition).normalize();
        if (u['distortionScale']) u['distortionScale'].value = Math.max((weather.waveHeight || 0) * 1.5, 2.2);
    }

    // Retune the scene lights (which light the ship) to the active mood.
    function _applyMoodToLights() {
        var mood = getActiveTod();
        var pal = SKY_PALETTES[mood];
        var wxMod = getWeatherModifiers();
        if (mainDirLight) {
            mainDirLight.color.setHex(pal.sunColor);
            mainDirLight.intensity = pal.sunIntensity * wxMod.sunIntensity;
            if (sunPosition) mainDirLight.position.copy(sunPosition).multiplyScalar(50);
        }
        if (_fillLight) _fillLight.intensity = (mood === 'night') ? 0.2 : 0.5;
        if (_ambLight) _ambLight.intensity = (mood === 'night') ? 0.3 : 0.8;
    }

    // Rebuild the ship's COLREG nav lights for the active mood (off at 골든/한낮).
    function _refreshNavLights() {
        if (!shipGroup) return;
        for (var i = 0; i < navLights.length; i++) {
            var n = navLights[i];
            [n.light, n.bulb, n.sprite].forEach(function (o) {
                if (!o) return;
                if (o.parent) o.parent.remove(o);
                if (o.geometry) o.geometry.dispose();
                if (o.material) o.material.dispose();
            });
        }
        navLights = [];
        buildNavLights(shipType);   // skips entirely for day/noon
    }

    // Lit windows/superstructure should glow only at dusk/night — dimmed in daylight,
    // otherwise a 한낮 ship looks like every cabin light is on at midday.
    function _applyMoodToShipEmissive() {
        var mood = getActiveTod();
        var factor = (mood === 'night') ? 1.0 : (mood === 'dusk' || mood === 'dawn') ? 0.55 : 0.0;
        [shipGroup, shipGroupPred].forEach(function (g) {
            if (!g) return;
            g.traverse(function (o) {
                if (!o.isMesh || !o.material || !o.material.emissive) return;
                var m = o.material;
                if (m.userData._baseEmis === undefined) {
                    m.userData._baseEmis = (m.emissiveIntensity != null) ? m.emissiveIntensity : 1;
                }
                m.emissiveIntensity = m.userData._baseEmis * factor;
            });
        });
    }

    // ── 수중 모드 토글 — 수면 아래로 내려가면 청록 fog + 화면 틴트로 잠수 뷰 ──
    function _setUnderwater(on) {
        if (on === _underwater) return;
        _underwater = on;
        if (on) {
            if (scene && scene.fog) {
                _savedFog = { color: scene.fog.color.getHex(), density: scene.fog.density };
                scene.fog.color.setHex(0x0a3f4f);
                scene.fog.density = 0.05;          // 깊이감 있는 청록 탁도
            }
            if (_underwaterTintEl) _underwaterTintEl.classList.add('rv-underwater-on');
        } else {
            if (scene && scene.fog && _savedFog) {
                scene.fog.color.setHex(_savedFog.color);
                scene.fog.density = _savedFog.density;
            }
            _savedFog = null;
            if (_underwaterTintEl) _underwaterTintEl.classList.remove('rv-underwater-on');
        }
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
        // Yaw(선수)를 최외곽 회전으로 둬야 roll(x)·pitch(z)가 선체 로컬축에 고정된다.
        // 기본 'XYZ'는 roll이 월드 X 기준이라 선수를 돌리면 roll/pitch가 뒤섞여 보인다.
        // (yaw=0에서는 'XYZ'와 수학적으로 동일 → 정면파 케이스는 불변.)
        shipGroup.rotation.order = 'YXZ';

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
        var tod = getActiveTod();
        // 항해등은 박명/야간에만 켠다. 골든·한낮(대낮)엔 끈다 — 한낮에 빨강·초록 등이
        // 켜져 '시간 따라 변한다'처럼 보였던 버그.
        if (tod === 'day' || tod === 'noon') return;

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
            var headingRad = (baseHeading + (turnScenarioActive ? turnHeading : 0)) * Math.PI / 180;
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
            animateDistantVessels(elapsed);

            animateWater(elapsed);
            // (old static wake removed — wakeTrail handles this now)
            // (wakeTrail removed — water reflections provide sufficient visual cue)

            // Weather-dynamic fog & clouds (수중일 땐 수중 fog를 유지하므로 건너뜀)
            var wxDyn = getWeatherModifiers();
            if (scene.fog && !_underwater) scene.fog.density = wxDyn.fogDensity;
            if (_cloudSprites) {
                for (var ci = 0; ci < _cloudSprites.length; ci++) {
                    var cs = _cloudSprites[ci];
                    cs.mat.opacity = Math.min(1, cs.baseOpacity * (wxDyn.cloudOpacity / 0.5));
                }
            }

            // Speed is now updated via updateCanvasHUD

            // Advance simulated wave time (separate from elapsed so timeScale only affects waves, not clouds/water)
            simWaveTime += dt * _timeScale;

            // Gerstner surface time — same value the ship heave samples below (kept in sync)
            if (_waterPatched && waterMesh && waterMesh.material.uniforms && waterMesh.material.uniforms.uTime) {
                waterMesh.material.uniforms.uTime.value = simWaveTime;
            }

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

            // 조우각(encounter angle) — 피치 계산에 사용(롤은 아래 실제 빔 경사로 직접 구동).
            var encRel = ((weather.waveDirection || 0) - (baseHeading + (turnScenarioActive ? turnHeading : 0))) * Math.PI / 180;

            // Wave groups(파도 세트) — 느리고 서로 무관한 두 엔벨로프(주기 ~72s·~153s)로
            // 흔들림 폭이 차오르고 잦아든다. 실제 바다의 '몇 번 크게 → 잠잠' 리듬.
            var groupEnv = 0.78 + 0.22 * Math.sin(simWaveTime * 0.087) * Math.sin(simWaveTime * 0.041 + 0.6);

            // ── 롤 구동 = 실제 빔(좌우) 방향 파경사 ──
            // 피치가 선수방향 수면을 샘플하듯, 롤도 좌우현 지점의 실제 Gerstner 높이차로
            // 구동한다 → 보이는 옆파와 위상이 동기되고, 조우각도 자동 반영(정면/뒷파면 좌우
            // 파고차≈0 → 롤 작음, 옆파면 최대). 공진 배수·파도세트 엔벨로프는 그대로 곱한다.
            var ROLL_GAIN = 2.4;   // 수면 경사(rad→deg)를 현실적 롤 진폭으로 키우는 게인 — 시각 튜닝값
            var waveRoll;
            if (window.Gerstner && _waves.length) {
                var _rbL = 10;                                          // 빔 샘플 거리(좌우현 m)
                var _rbx = -Math.sin(headingRad), _rby = Math.cos(headingRad);
                var _hPort = Gerstner.heightAt(_waves, _rbL * _rbx, _rbL * _rby, simWaveTime);
                var _hStbd = Gerstner.heightAt(_waves, -_rbL * _rbx, -_rbL * _rby, simWaveTime);
                var beamSlopeDeg = Math.atan2(_hPort - _hStbd, 2 * _rbL) * 180 / Math.PI;
                waveRoll = beamSlopeDeg * ROLL_GAIN * resonanceMult * groupEnv;
            } else {
                // Gerstner 부재 — 옛 파라메트릭 모델로 폴백(조우각은 beamFactor로 반영).
                var beamFactor = 0.2 + 0.8 * Math.abs(Math.sin(encRel));
                var primaryRoll = rollParams.amp * waveScale * resonanceMult * Math.sin(w1);
                var secondaryRoll = rollParams.amp * 0.35 * waveScale * Math.sin(w1 * 0.63 + 1.2);
                var tertiaryRoll = rollParams.amp * 0.18 * waveScale * Math.sin(w1 * 1.47 + 2.7);
                waveRoll = (primaryRoll + secondaryRoll + tertiaryRoll) * beamFactor * groupEnv;
            }

            // Turn-induced heel: 선회 방향으로 기울임 (좌선회→좌로 기울고 메트로놈도 좌로)
            var turnHeel = 0;
            if (turnScenarioActive && turnState.rudderAngle !== 0) {
                turnHeel = turnState.rudderAngle * 0.32;   // 0.22→0.32 — 선회 heel 강화
            }
            // 좌현/우현 고정 선회는 주기의 '직진' 구간(8s)에도 그쪽으로 최소 7° 기본 list 를 유지한다.
            // → 직진과 확실히 구분되고 횡요가 더 잘 보인다. (turnDirection: +1 우현 / -1 좌현)
            if (turnScenarioActive && (turnDirection === 1 || turnDirection === -1)) {
                if (Math.abs(turnHeel) < 7) turnHeel = turnDirection * 7;
            }

            // Combined roll — cap to realistic max ~20°
            var rawRoll = waveRoll * turnState.rollMultiplier + turnHeel;
            if (rawRoll > 20) rawRoll = 20;
            if (rawRoll < -20) rawRoll = -20;

            // Pitch: longer period, smaller amplitude, deterministic noise.
            // 조우각상 정면·뒷파(|cos|=1)에서 피치 최대, 옆파에서 최소 — 롤과 상보적.
            var pitchScale = turnScenarioActive ? Math.min(waveScale, 0.6) : waveScale;
            pitchScale *= (0.35 + 0.65 * Math.abs(Math.cos(encRel)));
            // 자연 피치(앞뒤 끄덕임) — 실제 Gerstner 표면을 뱃머리/선미에서 샘플해 그 경사에
            // 맞춘다(예제의 floating과 동일 원리). 긴 선체(±_hl)라 짧은 파엔 덜, 긴 swell엔 더
            // 끄덕여 사실적. 같은 simWaveTime 이라 보이는 물결과 동기. (롤은 물리 모델 유지)
            var rawPitch;
            var _bowCrest = 0;   // 뱃머리 지점의 파고(>0이면 마루) — 슬램 스프레이 트리거용
            if (window.Gerstner && _waves.length) {
                var _hl = 16;                                   // 선체 앞뒤 절반 길이(샘플 거리)
                var _fx = Math.cos(headingRad), _fy = Math.sin(headingRad);  // fore-aft (plane-local)
                var _hBow = Gerstner.heightAt(_waves, _hl * _fx, _hl * _fy, simWaveTime);
                var _hStern = Gerstner.heightAt(_waves, -_hl * _fx, -_hl * _fy, simWaveTime);
                _bowCrest = _hBow;
                rawPitch = Math.atan2(_hBow - _hStern, 2 * _hl) * 180 / Math.PI;
                if (rawPitch > 12) rawPitch = 12; else if (rawPitch < -12) rawPitch = -12;
            } else {
                rawPitch = (rollParams.amp * 0.35) * pitchScale * Math.sin(w1 * 0.6)
                    + rollParams.amp * 0.12 * pitchScale * Math.sin(w1 * 1.3 + 0.8);
            }

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

            // ── 부력 관성 + 6-DOF 미세동요 ──
            // Heave: 수면을 즉시 추종하지 않고 스프링-댐퍼로 고유주기 출렁(지연·오버슈트 → 무게감).
            // 타깃은 선체 원점(0,0)의 실제 Gerstner 높이. Gerstner 부재 시 옛 sin bob.
            var _haveG = (window.Gerstner && _waves.length);
            var targetHeave = _haveG
                ? Gerstner.heightAt(_waves, 0, 0, simWaveTime)
                : weather.waveHeight * 0.1 * Math.sin(elapsed * 0.8);
            var _capArmed = !!(_capsize && _capsize.armed);
            if (_capArmed) {                 // 전복 중엔 침몰 곡선이 주도 → 관성 끄고 타깃에 스냅
                _heavePos = targetHeave; _heaveVel = 0;
            } else {
                var _Tn = 3.4, _zeta = 0.5;  // 고유주기 3.4s, ζ=0.5(약한 오버슈트)
                var _wn = 2 * Math.PI / _Tn;
                _heaveVel += (_wn * _wn * (targetHeave - _heavePos) - 2 * _zeta * _wn * _heaveVel) * dt;
                _heavePos += _heaveVel * dt;
            }
            // 서지/스웨이 — 물 입자 수평 궤도운동을 따라 살짝 떠밀림(보이는 물결과 동기). 요 — 측면 파경사.
            var _swayX = 0, _swayZ = 0, _yawTarget = 0;
            if (_haveG && !_capArmed) {
                var _hz = _gerstnerHoriz(_waves, 0, 0, simWaveTime);
                _swayX = _hz.x * 0.45; _swayZ = _hz.y * 0.45;   // 자유 입자보다 둔하게(선체 저항)
                var _bL = 10;
                var _bx = -Math.sin(headingRad), _by = Math.cos(headingRad);   // 빔(좌우) 방향
                var _hP = Gerstner.heightAt(_waves, _bL * _bx, _bL * _by, simWaveTime);
                var _hS = Gerstner.heightAt(_waves, -_bL * _bx, -_bL * _by, simWaveTime);
                _yawTarget = Math.atan2(_hP - _hS, 2 * _bL) * 0.6;   // 라디안, 과하지 않게 0.6배
            }
            _yawSmooth += (_yawTarget - _yawSmooth) * (1 - Math.pow(0.05, dt));

            // ── Apply ship world position + rotations ──
            if (shipGroup) {
                shipGroup.position.x = shipWorldPos.x + _swayX;
                shipGroup.position.z = shipWorldPos.z + _swayZ;
                shipGroup.position.y = -0.8 + _heavePos + capsizeSinkY;
                shipGroup.rotation.y = headingRad + _yawSmooth;
                shipGroup.rotation.x = smoothRoll * (Math.PI / 180);
                shipGroup.rotation.z = smoothPitch * (Math.PI / 180);
                if (shipGroupPred) {
                    shipGroupPred.position.copy(shipGroup.position);
                    shipGroupPred.rotation.y = headingRad + _yawSmooth;
                    shipGroupPred.rotation.x = smoothPredRoll * (Math.PI / 180);
                    shipGroupPred.rotation.z = smoothPredPitch * (Math.PI / 180);
                }
                // 수평 기준선은 위치만 따라가고 자세(롤/피치)는 따라가지 않는다 → 항상 수평.
                if (heelRefGroup) {
                    heelRefGroup.position.copy(shipGroup.position);
                    heelRefGroup.rotation.y = headingRad;
                }
            }

            // ── 선수 포말(정상 bow wave) + 슬램 스프레이 ──
            // bowFoam: 속도 클수록 상시 뱃머리 포말. slam: 마루(_bowCrest>0)에 속도로 처박힐 때 물보라.
            if (sprayPoints) {
                var _bowFoam = Math.min(smoothSpeed / 14, 1) * 0.85;
                var _slam = Math.min(1, Math.max(0, _bowCrest) / Math.max(weather.waveHeight * 0.6, 0.6))
                            * Math.min(smoothSpeed / 7, 1);
                sprayPoints.position.set(shipWorldPos.x, 0, shipWorldPos.z);   // 선체에 부착
                animateSpray(dt, headingRad, _bowFoam, _slam);
            }

            // ── 접지 그림자 — 수면 위 옅은 타원. 선체가 떠오르면 옅고 넓게, 가라앉으면 짙고 좁게. ──
            if (_contactShadow) {
                _contactShadow.position.set(shipWorldPos.x, targetHeave + 0.05, shipWorldPos.z);
                _contactShadow.rotation.y = headingRad;
                var _gap = Math.max(-0.35, Math.min(0.4, _heavePos - targetHeave));
                var _csm = _contactShadow.children[0];
                _csm.material.opacity = Math.max(0.22, 0.6 - _gap * 0.5);
                var _csc = 1 + _gap * 0.4;
                _csm.scale.set(22 * _csc, 8 * _csc, 1);
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
            // 프리셋 전환(camPresetAnim) 중엔 그 애니메이션이 카메라를 전담 → 추종 보류(충돌 방지)
            if (!cameraAnimating && !camPresetAnim && controls) {
                var lerpFactor = 1 - Math.pow(0.02, dt);
                camFollow.x += (shipWorldPos.x - camFollow.x) * lerpFactor;
                camFollow.z += (shipWorldPos.z - camFollow.z) * lerpFactor;

                var dx = camFollow.x - controls.target.x;
                var dz = camFollow.z - controls.target.z;
                controls.target.x += dx;
                controls.target.z += dz;
                camera.position.x += dx;
                camera.position.z += dz;

                // Orbit camera to track the bow heading so the ship stays at a constant
                // viewing angle — 선수를 돌리면 카메라가 같이 돌아 롤(출렁임) 변화만 또렷이 보인다.
                // 선회뿐 아니라 정지(직진) 상태의 컴퍼스 회전도 추종한다.
                if (!_camHeadingSynced) {
                    // 첫 프레임/리셋 직후 — 현재 침로로 스냅(회전 없이) → 시작 점프 방지
                    camFollowHeading = headingRad;
                    _camHeadingSynced = true;
                } else {
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
            updateMetronomes(smoothRoll, smoothPredRoll);
            _updateHeelLabels(smoothRoll, smoothPredRoll);
            _updateRollWedge(smoothRoll, smoothPredRoll);
            _setRollValue('rv-real-roll', absRoll, 'rv-clino-gap-val');   // HUD 히어로 — 크기 유지
            _setRollValue('rv-pred-roll', Math.abs(smoothPredRoll));
            _traceSample(dt, elapsed, smoothRoll, smoothPredRoll);        // 트레이스 리본 (부호 있는 값)
            if (window.RollPrediction) {
                var _d = RollPrediction.computeDelta(
                    { roll: smoothRoll, pitch: smoothPitch },
                    { roll: smoothPredRoll, pitch: smoothPredPitch }
                );
                // (값, 막대) = 오차 / 만점스케일 / 경고임계 / 위험임계
                _setErrBar('rv-rmse', 'rv-rmse-bar', RollPrediction.computeRMSE(rollHistory, predRollHistory), 6, 2, 4);
                // Δ Roll 행은 HUD '오차 Δ'(rv-clino-gap)와 동일 값이라 표기 제거
                _setErrBar('rv-d-pitch', 'rv-d-pitch-bar', _d.dPitch, 3, 1, 2);
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

            // (선수 추종 카메라는 위 'Camera follows ship' 블록의 camFollowHeading에서 처리)

            // ── Camera roll sync — tilt camera with ship roll ──
            var camRollRad = smoothRoll * (Math.PI / 180) * 0.3;  // 30% of ship roll
            camera.up.set(Math.sin(camRollRad), Math.cos(camRollRad), 0);

            if (controls) controls.update();

            // ── 수중 모드 전환 — 카메라가 수면보다 낮아지면 잠수 뷰 ──
            _setUnderwater(camera.position.y < SURFACE_Y);

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
        var relAngle = ((weather && weather.waveDirection) || 0) - (baseHeading + (turnScenarioActive ? turnHeading : 0));
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
            '<div class="roll-viewer-section-title">선박 정보</div>' +
            '<div class="rv-info-row"><span class="rv-info-label">선명</span><span class="rv-info-value">' + (ship.name || 'UNKNOWN') + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">MMSI</span><span class="rv-info-value">' + (ship.mmsi || currentMmsi) + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">선종</span><span class="rv-info-value">' + typeLabel + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">속력</span><span class="rv-info-value">' + sogVal + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">침로</span><span class="rv-info-value">' + hdgVal + '</span></div>' +
            '</div>' +
            '<div class="roll-viewer-section">' +
            '<div class="roll-viewer-section-title">항해 정보</div>' +
            '<div class="rv-info-row"><span class="rv-info-label">목적지</span><span class="rv-info-value">' + destination + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">ETA</span><span class="rv-info-value">' + eta + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">상태</span><span class="rv-info-value">' + statusLabel + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">호출부호</span><span class="rv-info-value">' + callsign + '</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">IMO</span><span class="rv-info-value">' + imo + '</span></div>' +
            '</div>' +
            // ROLL/PITCH sections relocated to the prediction modal on the canvas — they are
            // simulation OUTPUT, not real data. The side panel keeps only observed values.
            '<div class="roll-viewer-section">' +
            '<div class="roll-viewer-section-title">기상</div>' +
            '<div class="rv-info-row"><span class="rv-info-label">풍속</span><span class="rv-info-value" id="rv-weather-wind">' + weather.windSpeed + ' kt</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">파고</span><span class="rv-info-value" id="rv-weather-wave">' + weather.waveHeight + ' m</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">주기</span><span class="rv-info-value" id="rv-weather-period">' + weather.wavePeriod + ' s</span></div>' +
            '<div class="rv-info-row"><span class="rv-info-label">파향</span><span class="rv-info-value" id="rv-weather-direction">' + Math.round(weather.waveDirection) + '°</span></div>' +
            '</div>' +
            '<div class="roll-viewer-section">' +
            '<div class="roll-viewer-section-title">횡요각 분석</div>' +
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

    // ── 클리노미터(경사계) 계기 ──
    // 하나의 부채꼴 눈금 위에 실측(인광 청록 바늘)과 예측(황동 바늘)을 겹쳐 표시한다.
    // 두 바늘 사이의 빨간 부채꼴이 곧 예측 오차다. ±40° 범위, 위험 임계 15°.
    var _CLINO = { cx: 160, cy: 158, R: 140, Lr: 134, Lp: 120, range: 40, caution: 10, danger: 15 };

    function _cpt(deg, r) {
        var a = deg * Math.PI / 180;
        return [(_CLINO.cx + r * Math.sin(a)), (_CLINO.cy - r * Math.cos(a))];
    }
    function _arc(d0, d1, r) {
        var s = _cpt(d0, r), e = _cpt(d1, r);
        return 'M ' + s[0].toFixed(2) + ' ' + s[1].toFixed(2) +
            ' A ' + r + ' ' + r + ' 0 0 1 ' + e[0].toFixed(2) + ' ' + e[1].toFixed(2);
    }

    // 정적 계기면(등급 부채꼴 + 눈금 림 + 눈금선 + 라벨) + 동적 바늘 2 + 오차 부채꼴
    function _clinoSvg() {
        var C = _CLINO, R = C.R, band = R - 5;
        // Etched severity sectors — calm recedes, danger is the only loud step.
        var sectors =
            '<path class="rv-clino-band rv-clino-band-safe" d="' + _arc(-C.caution, C.caution, band) + '"/>' +
            '<path class="rv-clino-band rv-clino-band-caution" d="' + _arc(-C.danger, -C.caution, band) + '"/>' +
            '<path class="rv-clino-band rv-clino-band-caution" d="' + _arc(C.caution, C.danger, band) + '"/>' +
            '<path class="rv-clino-band rv-clino-band-danger" d="' + _arc(-C.range, -C.danger, band) + '"/>' +
            '<path class="rv-clino-band rv-clino-band-danger" d="' + _arc(C.danger, C.range, band) + '"/>';
        var rim = '<path class="rv-clino-rim" d="' + _arc(-C.range, C.range, R) + '"/>';
        var ticks = '', labels = '';
        for (var d = -C.range; d <= C.range; d += 5) {
            var major = (d % 10 === 0);
            var a = _cpt(d, R - (major ? 9 : 5)), b = _cpt(d, R + 1);
            ticks += '<line class="rv-clino-tick' + (major ? ' rv-clino-tick-major' : '') + '" x1="' +
                a[0].toFixed(2) + '" y1="' + a[1].toFixed(2) + '" x2="' + b[0].toFixed(2) + '" y2="' + b[1].toFixed(2) + '"/>';
            if (major && Math.abs(d) <= 30) {
                var t = _cpt(d, R - 21);
                labels += '<text class="rv-clino-num" x="' + t[0].toFixed(2) + '" y="' + (t[1] + 3).toFixed(2) + '">' + Math.abs(d) + '</text>';
            }
        }
        // Danger-threshold ticks (±15°) emphasised — the heel angle that matters.
        var thr = '';
        [-C.danger, C.danger].forEach(function (dd) {
            var a = _cpt(dd, R - 11), b = _cpt(dd, R + 3);
            thr += '<line class="rv-clino-thr" x1="' + a[0].toFixed(2) + '" y1="' + a[1].toFixed(2) +
                '" x2="' + b[0].toFixed(2) + '" y2="' + b[1].toFixed(2) + '"/>';
        });
        var plumbTop = _cpt(0, R - 2);
        var plumb = '<line class="rv-clino-plumb" x1="' + C.cx + '" y1="' + C.cy + '" x2="' + C.cx + '" y2="' + plumbTop[1].toFixed(2) + '"/>';
        // Needles are drawn pointing up at 0° and rotated about the pivot each frame.
        var realNeedle =
            '<g class="rv-clino-real" id="rv-clino-real" transform="rotate(0 ' + C.cx + ' ' + C.cy + ')">' +
                '<line x1="' + C.cx + '" y1="' + C.cy + '" x2="' + C.cx + '" y2="' + (C.cy - C.Lr) + '"/>' +
                '<circle cx="' + C.cx + '" cy="' + (C.cy - C.Lr) + '" r="4.5"/>' +
            '</g>';
        var predNeedle =
            '<g class="rv-clino-pred" id="rv-clino-pred" transform="rotate(0 ' + C.cx + ' ' + C.cy + ')">' +
                '<line x1="' + C.cx + '" y1="' + C.cy + '" x2="' + C.cx + '" y2="' + (C.cy - C.Lp) + '"/>' +
                '<polygon points="' + C.cx + ',' + (C.cy - C.Lp - 7) + ' ' + (C.cx - 5) + ',' + (C.cy - C.Lp) +
                    ' ' + C.cx + ',' + (C.cy - C.Lp + 7) + ' ' + (C.cx + 5) + ',' + (C.cy - C.Lp) + '"/>' +
            '</g>';
        return '<svg class="rv-clino" viewBox="0 0 320 178" preserveAspectRatio="xMidYMid meet">' +
            sectors + rim + ticks + thr + labels + plumb +
            '<polygon class="rv-clino-wedge" id="rv-clino-wedge" points="' + C.cx + ',' + C.cy + '"/>' +
            predNeedle + realNeedle +
            '<circle class="rv-clino-hub" cx="' + C.cx + '" cy="' + C.cy + '" r="6"/>' +
            '</svg>';
    }

    // 실측·예측 바늘을 동일 눈금 위에서 회전시키고, 두 바늘 사이를 오차 부채꼴로 채운다.
    function updateMetronomes(realDeg, predDeg) {
        var C = _CLINO;
        var clamp = function (dv) { return Math.max(-C.range, Math.min(C.range, dv)); };
        var rc = clamp(realDeg), pc = clamp(predDeg);
        var realEl = document.getElementById('rv-clino-real');
        var predEl = document.getElementById('rv-clino-pred');
        var wedgeEl = document.getElementById('rv-clino-wedge');
        if (realEl) realEl.setAttribute('transform', 'rotate(' + rc.toFixed(2) + ' ' + C.cx + ' ' + C.cy + ')');
        if (predEl) predEl.setAttribute('transform', 'rotate(' + pc.toFixed(2) + ' ' + C.cx + ' ' + C.cy + ')');
        if (wedgeEl) {
            var r = _cpt(rc, C.Lp), p = _cpt(pc, C.Lp);
            wedgeEl.setAttribute('points', C.cx + ',' + C.cy + ' ' + r[0].toFixed(2) + ',' + r[1].toFixed(2) +
                ' ' + p[0].toFixed(2) + ',' + p[1].toFixed(2));
            var err = Math.min(Math.abs(realDeg - predDeg) / 8, 1);   // 8° 이상이면 최대 강도
            wedgeEl.setAttribute('opacity', (0.12 + 0.5 * err).toFixed(3));
        }
        // 오차 수치 = |실측 − 예측| — HUD 보조 쌍의 '오차 Δ' (히어로는 실측이 차지)
        var gapEl = document.getElementById('rv-clino-gap');
        if (gapEl) {
            var gap = Math.abs(realDeg - predDeg);
            gapEl.textContent = gap.toFixed(1) + '°';
            var glvl = gap < 2 ? 'safe' : gap < 4 ? 'caution' : gap < 8 ? 'warning' : 'danger';
            gapEl.className = 'rv-clino-val rv-roll-' + glvl;
        }
    }

    // 횡요각 수치 갱신 (심각도 색상). baseClass로 크기 클래스 지정(히어로=rv-clino-gap-val).
    function _setRollValue(id, absRoll, baseClass) {
        var el = document.getElementById(id);
        if (!el) return;
        el.textContent = absRoll.toFixed(1) + '°';
        var level = absRoll < 5 ? 'safe' : absRoll < 10 ? 'caution' : absRoll < 15 ? 'warning' : 'danger';
        el.className = (baseClass || 'rv-clino-val') + ' rv-roll-' + level;
    }

    // 오차 지표 1줄 갱신: 숫자 + 막대 길이(오차/스케일) + 색(녹/황/적)
    function _setErrBar(valId, barId, value, maxScale, warnT, badT) {
        var v = Math.abs(value);
        var lvl = v < warnT ? 'rv-ok' : v < badT ? 'rv-warn' : 'rv-bad';
        var valEl = document.getElementById(valId);
        var barEl = document.getElementById(barId);
        if (valEl) { valEl.textContent = v.toFixed(1) + '°'; valEl.className = 'rv-pred-hud-val ' + lvl; }
        if (barEl) { barEl.style.width = (Math.min(v / maxScale, 1) * 100).toFixed(0) + '%'; barEl.className = 'rv-pred-hud-bar-fill ' + lvl; }
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

    // ── RMSE 계산용 히스토리 버퍼 초기화 (60프레임 창) ──
    function _initHistories() {
        rollHistory = [];
        pitchHistory = [];
        predRollHistory = [];
        predPitchHistory = [];
        for (var i = 0; i < 60; i++) {
            rollHistory.push(0); pitchHistory.push(0);
            predRollHistory.push(0); predPitchHistory.push(0);
        }
    }

    // ── 횡요 트레이스 리본 — 실측(실선) vs 예측(점선) 최근 90초 + 오차 밴드 ──
    // 순간 오차 숫자는 진동 신호라 반 주기마다 0↔최대를 오간다. 시간축 겹침은
    // 위상 지연(점선의 가로 밀림)·진폭 오차(봉우리 높이차)·바이어스(세로 오프셋)를
    // 형태로 구분해 보여준다. 선 인코딩은 HUD·3D와 동일(실측=primary 실선, 예측=하늘 점선).
    function buildTraceRibbon() {
        var el = document.createElement('div');
        el.className = 'rv-trace' + (traceCollapsed ? ' rv-trace--collapsed' : '');
        el.id = 'rv-trace';
        el.innerHTML =
            '<div class="rv-trace-head">' +
                '<span class="rv-trace-title">횡요 트레이스 · 최근 ' + TRACE_WINDOW + '초</span>' +
                '<span class="rv-trace-legend" aria-hidden="true">' +
                    '<span class="rv-trace-key"><i class="rv-trace-swatch"></i>실측</span>' +
                    '<span class="rv-trace-key"><i class="rv-trace-swatch rv-trace-swatch-pred"></i>예측</span>' +
                    '<span class="rv-trace-key"><i class="rv-trace-swatch rv-trace-swatch-band"></i>오차</span>' +
                '</span>' +
                '<button class="rv-trace-toggle" id="rv-trace-toggle" title="트레이스 접기/펼치기" aria-expanded="' + String(!traceCollapsed) + '"><i class="fa-solid fa-chevron-down"></i></button>' +
            '</div>' +
            '<div class="rv-trace-body"><canvas></canvas></div>';
        traceCanvas = el.querySelector('canvas');
        traceCtx = traceCanvas.getContext('2d');
        traceBuf = [];
        traceAccum = 0;
        var toggle = el.querySelector('#rv-trace-toggle');
        toggle.addEventListener('click', function () {
            _setTraceCollapsed(!traceCollapsed);
            _traceWasCollapsed = traceCollapsed;   // 수동 조작은 '사용자 선호'로 기억
        });
        // 캔버스 백버퍼를 CSS 크기 × DPR로 동기화 — 접었다 펴도, 심 패널 리플로우에도 추종
        if (window.ResizeObserver) {
            traceRO = new ResizeObserver(_traceResize);
            traceRO.observe(el.querySelector('.rv-trace-body'));
        }
        return el;
    }

    // 리본 접힘 상태 일원화 — 클래스·aria·챗 FAB 오프셋을 함께 동기화
    function _setTraceCollapsed(v) {
        traceCollapsed = !!v;
        var el = document.getElementById('rv-trace');
        if (el) el.classList.toggle('rv-trace--collapsed', traceCollapsed);
        var tg = document.getElementById('rv-trace-toggle');
        if (tg) tg.setAttribute('aria-expanded', String(!traceCollapsed));
        var cb = document.getElementById('chat-bubble');
        if (cb) cb.classList.toggle('rv-chat-trace-collapsed', traceCollapsed);
    }

    function _traceResize() {
        if (!traceCanvas) return;
        var dpr = window.devicePixelRatio || 1;
        var w = traceCanvas.clientWidth, h = traceCanvas.clientHeight;
        if (!w || !h) return;
        traceCanvas.width = Math.round(w * dpr);
        traceCanvas.height = Math.round(h * dpr);
    }

    // 애니메이션 루프에서 호출 — TRACE_DT 간격으로 샘플을 쌓고 다시 그린다(≈10fps).
    function _traceSample(dt, now, real, pred) {
        if (!traceCtx) return;
        traceAccum += dt;
        if (traceAccum < TRACE_DT) return;
        traceAccum = 0;
        traceBuf.push({ t: now, r: real, p: window.RollPrediction ? pred : null });
        var cut = now - TRACE_WINDOW;
        while (traceBuf.length && traceBuf[0].t < cut) traceBuf.shift();
        if (!traceCollapsed) _traceDraw(now);
    }

    function _traceDraw(now) {
        var ctx = traceCtx, cv = traceCanvas;
        if (!ctx || !cv || !cv.width || traceBuf.length < 2) return;
        if (!traceCol) {
            var cs = getComputedStyle(document.documentElement);
            var _v = function (name, fb) { var v = cs.getPropertyValue(name).trim(); return v || fb; };
            traceCol = {
                real: _v('--primary', '#2f6fed'),
                pred: _v('--accent-glow', '#7cb9f4'),
                danger: _v('--sev-danger', '#ef4444'),
                band: 'rgba(217, 164, 65, 0.20)',   // --sev-caution 저투명 — 오차만 웜 톤(쐐기와 동일 문법)
                grid: 'rgba(148, 170, 190, 0.14)',
                zero: 'rgba(148, 170, 190, 0.35)',
                text: 'rgba(148, 170, 190, 0.75)',
                font: _v('--font-data', 'monospace')
            };
        }
        var dpr = window.devicePixelRatio || 1;
        var w = cv.width, h = cv.height;
        var pad = 4 * dpr;
        ctx.clearRect(0, 0, w, h);

        // y-스케일: 대칭 ±(5° 배수). 커지면 즉시 확장, 줄어들 땐 0.55× 여유 — 축 덜컹임 방지.
        var maxAbs = 0;
        for (var i = 0; i < traceBuf.length; i++) {
            var b = traceBuf[i];
            var m = Math.max(Math.abs(b.r), b.p != null ? Math.abs(b.p) : 0);
            if (m > maxAbs) maxAbs = m;
        }
        var target = Math.max(5, Math.ceil(maxAbs / 5) * 5);
        if (target > traceYMax || maxAbs < traceYMax * 0.55) traceYMax = target;

        var t0 = now - TRACE_WINDOW;
        function X(t) { return (t - t0) / TRACE_WINDOW * w; }
        function Y(v) { return h / 2 - (v / traceYMax) * (h / 2 - pad); }

        // 30초 세로 그리드 + 0° 기준선 + 위험 임계 ±15°(스케일 안에 들어올 때만)
        ctx.lineWidth = 1;
        ctx.strokeStyle = traceCol.grid;
        for (var g = Math.ceil(t0 / 30) * 30; g <= now; g += 30) {
            ctx.beginPath(); ctx.moveTo(X(g), pad); ctx.lineTo(X(g), h - pad); ctx.stroke();
        }
        ctx.strokeStyle = traceCol.zero;
        ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke();
        if (traceYMax >= 15) {
            ctx.strokeStyle = traceCol.danger;
            ctx.globalAlpha = 0.3;
            ctx.setLineDash([3 * dpr, 4 * dpr]);
            ctx.beginPath(); ctx.moveTo(0, Y(15)); ctx.lineTo(w, Y(15)); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, Y(-15)); ctx.lineTo(w, Y(-15)); ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
        }

        // 오차 밴드 — 실측 곡선을 따라간 뒤 예측 곡선을 따라 되돌아오는 닫힌 면
        var hasPred = traceBuf[traceBuf.length - 1].p != null;
        if (hasPred) {
            ctx.beginPath();
            for (var a = 0; a < traceBuf.length; a++) {
                var pa = traceBuf[a];
                if (a === 0) ctx.moveTo(X(pa.t), Y(pa.r)); else ctx.lineTo(X(pa.t), Y(pa.r));
            }
            for (var z = traceBuf.length - 1; z >= 0; z--) {
                var pz = traceBuf[z];
                ctx.lineTo(X(pz.t), Y(pz.p != null ? pz.p : pz.r));
            }
            ctx.closePath();
            ctx.fillStyle = traceCol.band;
            ctx.fill();
        }

        // 실측 실선
        ctx.lineWidth = 1.6 * dpr;
        ctx.strokeStyle = traceCol.real;
        ctx.beginPath();
        for (var r = 0; r < traceBuf.length; r++) {
            var pr = traceBuf[r];
            if (r === 0) ctx.moveTo(X(pr.t), Y(pr.r)); else ctx.lineTo(X(pr.t), Y(pr.r));
        }
        ctx.stroke();
        // 예측 점선
        if (hasPred) {
            ctx.lineWidth = 1.3 * dpr;
            ctx.strokeStyle = traceCol.pred;
            ctx.setLineDash([5 * dpr, 4 * dpr]);
            ctx.beginPath();
            var started = false;
            for (var q = 0; q < traceBuf.length; q++) {
                var pq = traceBuf[q];
                if (pq.p == null) continue;
                if (started) ctx.lineTo(X(pq.t), Y(pq.p)); else ctx.moveTo(X(pq.t), Y(pq.p));
                started = true;
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // y-스케일 라벨
        ctx.fillStyle = traceCol.text;
        ctx.font = (9 * dpr) + 'px ' + traceCol.font;
        ctx.textBaseline = 'top';
        ctx.fillText('+' + traceYMax + '°', 4 * dpr, pad);
        ctx.textBaseline = 'bottom';
        ctx.fillText('−' + traceYMax + '°', 4 * dpr, h - pad);
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

    // ── 횡요 HUD 수평계(attitude ladder) ──
    // 두꺼운 판 대신, 갑판 위 선폭(로컬 Z축)을 가로지르는 가느다란 발광 라인 + 눈금 +
    // 가운데 ^자세 마커 + 끝단 핍으로 구성된 항공 HUD 스타일 인디케이터. 선박 롤을
    // 그대로 물려받아 기운다. 실측=primary 파랑, 예측=하늘색. 두 사다리의 사이각이 오차.
    function _addHeelPlane(group, hexColor, ghost) {
        var THREE = window.THREE;
        if (!group || !THREE) return null;
        var beam = 17, half = beam / 2, deckY = 5.0, gap = 2.2;
        var g = new THREE.Group();
        g.userData._heelMast = true;   // 고스트 처리 제외 플래그
        var mat = new THREE.LineBasicMaterial({
            color: hexColor, transparent: true, opacity: ghost ? 0.85 : 1.0,
            depthTest: false, depthWrite: false
        });
        var V = function (y, z) { return new THREE.Vector3(0, deckY + y, z); };
        var P = [];
        // 메인 바 — 가운데 갭을 둔 좌/우 두 날개
        P.push(V(0, -half), V(0, -gap));
        P.push(V(0, gap), V(0, half));
        // 눈금 — 2.5 간격 아래 방향(끝단은 길게)
        for (var z = -half; z <= half + 0.01; z += 2.5) {
            if (Math.abs(z) < gap) continue;
            var major = Math.abs(z) >= half - 0.01;
            P.push(V(0, z), V(major ? -1.2 : -0.5, z));
        }
        // 가운데 자세 마커 — 위를 향한 ^ 셰브런 (롤 축 표시)
        P.push(V(0, -1.0), V(0.95, 0));
        P.push(V(0.95, 0), V(0, 1.0));
        var seg = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(P), mat);
        seg.userData._heelMast = true; seg.renderOrder = 999;
        g.add(seg);
        // 끝단 발광 핍 — 디지털 터미네이터
        [-half, half].forEach(function (z) {
            var pip = new THREE.Mesh(
                new THREE.SphereGeometry(ghost ? 0.22 : 0.26, 10, 10),
                new THREE.MeshBasicMaterial({ color: hexColor, transparent: true,
                    opacity: ghost ? 0.9 : 1.0, depthTest: false, depthWrite: false }));
            pip.position.set(0, deckY, z); pip.userData._heelMast = true; pip.renderOrder = 999;
            g.add(pip);
        });
        group.add(g);
        return g;
    }

    // ── 수평(0°) 기준선 ──
    // 선박 위치만 따라가고 롤은 따라가지 않는 '항상 수평'인 기준선. 이 선 대비 두 사다리가
    // 몇 도 기울었는지를 눈으로 비교하게 해준다 (인공 수평의 horizon 역할).
    function _buildHeelHorizon() {
        var THREE = window.THREE;
        if (!THREE || !scene) return;
        heelRefGroup = new THREE.Group();
        var W = 11, deckY = _HEEL.deckY;
        var mat = new THREE.LineDashedMaterial({
            color: 0x9fb2c8, transparent: true, opacity: 0.5, dashSize: 0.7, gapSize: 0.5,
            depthTest: false, depthWrite: false
        });
        var line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, deckY, -W), new THREE.Vector3(0, deckY, W)]), mat);
        line.computeLineDistances(); line.renderOrder = 998;
        heelRefGroup.add(line);
        // 작은 수평 기준 핍(중앙)
        scene.add(heelRefGroup);
    }

    // ── 오차 쐐기 ──
    // apex 를 롤 축(원점)에 두고, 실측/예측 헐의 같은 갑판 끝점까지 삼각형을 친다.
    // → 쐐기가 벌어진 각이 곧 롤 오차(Δ). 매 프레임 _updateHeelLabels 에서 갱신.
    function _buildRollWedge() {
        var THREE = window.THREE;
        if (!THREE || !scene) return;
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
        _rollWedgeMat = new THREE.MeshBasicMaterial({
            color: 0x22c55e, transparent: true, opacity: 0.0,
            side: THREE.DoubleSide, depthTest: false, depthWrite: false
        });
        _rollWedge = new THREE.Mesh(geo, _rollWedgeMat);
        _rollWedge.renderOrder = 997;     // 헐 위, 사다리/라벨 아래
        _rollWedge.frustumCulled = false;
        _rollWedge.visible = false;
        scene.add(_rollWedge);
    }

    // gap(도)에 따른 쐐기 색 — HUD/라벨 severity 램프와 동일 계열
    var _WEDGE_COLORS = { safe: 0x22c55e, caution: 0xd9a441, warning: 0xec7a2c, danger: 0xef4444 };
    function _updateRollWedge(realDeg, predDeg) {
        var THREE = window.THREE;
        if (!_rollWedge || !THREE) return;
        if (splitView || !shipGroup || !shipGroupPred) { _rollWedge.visible = false; return; }
        var deckY = _HEEL.deckY, z = _HEEL.half;
        var apex = shipGroup.localToWorld(new THREE.Vector3(0, 0, 0));        // 롤 축(원점)
        var rTip = shipGroup.localToWorld(new THREE.Vector3(0, deckY, z));    // 실측 우현 끝
        var pTip = shipGroupPred.localToWorld(new THREE.Vector3(0, deckY, z));// 예측 우현 끝
        var pos = _rollWedge.geometry.attributes.position;
        pos.setXYZ(0, apex.x, apex.y, apex.z);
        pos.setXYZ(1, rTip.x, rTip.y, rTip.z);
        pos.setXYZ(2, pTip.x, pTip.y, pTip.z);
        pos.needsUpdate = true;
        var gap = Math.abs(realDeg - predDeg);
        var lvl = gap < 2 ? 'safe' : gap < 4 ? 'caution' : gap < 8 ? 'warning' : 'danger';
        _rollWedgeMat.color.setHex(_WEDGE_COLORS[lvl]);
        _rollWedgeMat.opacity = 0.16 + 0.44 * Math.min(gap / 8, 1);   // 차이 클수록 진하게
        _rollWedge.visible = true;
    }

    // 사다리 끝점(월드)→화면 투영 후, 각 선박의 횡요각을 라벨로 표시 (겹쳐보기에서만).
    function _projTip(group, z) {
        var THREE = window.THREE;
        var v = new THREE.Vector3(0, _HEEL.deckY, z);
        group.localToWorld(v); v.project(camera);
        var el = renderer.domElement;
        return { x: (v.x * 0.5 + 0.5) * el.clientWidth, y: (-v.y * 0.5 + 0.5) * el.clientHeight, infront: v.z < 1 };
    }
    // 가장 중요한 값 = 오차. 두 사다리 사이 벌어진 지점(같은 현 끝점의 중점)에 Δ 하나만 표시.
    function _updateHeelLabels(realDeg, predDeg) {
        var el = document.getElementById('rv-deg-err');
        if (!el) return;
        if (splitView || !shipGroup || !shipGroupPred || !camera) { el.style.display = 'none'; return; }
        var rp = _projTip(shipGroup, _HEEL.half);        // 실측 우현 끝
        var pp = _projTip(shipGroupPred, _HEEL.half);    // 예측 우현 끝 (같은 현 → 수직 간격이 곧 오차)
        if (!rp.infront || !pp.infront) { el.style.display = 'none'; return; }
        var gap = Math.abs(realDeg - predDeg);
        el.textContent = 'Δ ' + gap.toFixed(1) + '°';
        el.style.left = ((rp.x + pp.x) / 2 + 14) + 'px';
        el.style.top = ((rp.y + pp.y) / 2) + 'px';
        el.style.display = '';
        var lvl = gap < 2 ? 'safe' : gap < 4 ? 'caution' : gap < 8 ? 'warning' : 'danger';
        el.className = 'rv-deg rv-deg-err rv-roll-' + lvl;
    }

    // ── 고스트 겹쳐보기 / 나눠보기 ──
    // 예측 선박(클론)의 머티리얼을 한 번만 자체 복제해 둔다 (실측 선박과 공유 방지).
    function _prepGhostMaterials() {
        var THREE = window.THREE;
        _predGhostMats = [];
        _predEdgeMats = [];
        if (!shipGroupPred) return;
        var edgeAdds = [];   // traverse 중 add 하면 순회가 꼬이므로 사후 일괄 추가
        shipGroupPred.traverse(function (o) {
            if (!o.isMesh || !o.material) return;
            if (o.userData && o.userData._heelMast) return;   // 피뢰침 마스트는 고스트 처리 제외
            if (Array.isArray(o.material)) {
                o.material = o.material.map(function (m) { var c = m.clone(); _predGhostMats.push(c); return c; });
            } else {
                o.material = o.material.clone();
                _predGhostMats.push(o.material);
            }
            // 예측 헐 외곽선 — EdgesGeometry(특징 모서리만)로 깔끔한 와이어 실루엣.
            // depthTest:false + 높은 renderOrder → 겹쳐도 실측 위에 항상 또렷이 그려진다.
            if (THREE && THREE.EdgesGeometry && o.geometry && !o.userData._predEdgeBuilt) {
                try {
                    // depthTest:true → 깊이를 따라 가려질 모서리는 가려진다(덧칠/스티커 느낌 제거).
                    // 임계 45° → 주요 실루엣 모서리만(촘촘한 패널선 제거), opacity 0.55 → 은은하게.
                    var em = new THREE.LineBasicMaterial({
                        color: 0x8fd0ff, transparent: true, opacity: 0.55,
                        depthTest: true, depthWrite: false
                    });
                    var edges = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 45), em);
                    edges.userData._heelMast = true;   // 고스트 머티리얼 재처리 대상에서 제외
                    edges.userData._predEdge = true;
                    edges.renderOrder = 1000;
                    o.userData._predEdgeBuilt = true;
                    edgeAdds.push({ parent: o, child: edges });
                    _predEdgeMats.push(em);
                } catch (e) { /* geometry 없는 메시는 스킵 */ }
            }
        });
        edgeAdds.forEach(function (e) { e.parent.add(e.child); });
        _predGhostReady = true;
    }

    // 예측 선박을 '명확한 하늘색 홀로그램 고스트'로 만든다. 선체 형태/색을 통일된
    // 하늘색 반투명으로 덮어, 다채로운 실측 선박과 한눈에 구분된다. 겹쳐보기·나눠보기
    // 모두에서 항상 고스트로 유지한다 (solid=실측, ghost=예측 의미를 일관되게).
    function _setGhost() {
        // 외곽선(EdgesGeometry)이 예측 실루엣을 담당하므로 fill 볼륨은 아주 옅게 깔아
        // 실측 솔리드 헐이 그대로 비치게 한다 (와이어 홀로그램).
        _predGhostMats.forEach(function (m) {
            m.transparent = true;
            m.opacity = 0.14;
            m.depthWrite = false;
            if (m.color) m.color.setHex(0x6fb4ff);              // 통일된 하늘색 홀로그램
            if (m.emissive) { m.emissive.setHex(0x4d9bff); m.emissiveIntensity = 0.6; }
            if ('metalness' in m) m.metalness = 0.0;
            if ('roughness' in m) m.roughness = 1.0;
            if ('map' in m) m.map = null;                       // 텍스처 제거 → 홀로그램 느낌
            m.needsUpdate = true;
        });
        // 외곽선 가시성 유지(나눠보기/겹쳐보기 동일)
        _predEdgeMats.forEach(function (em) { em.opacity = 0.55; em.needsUpdate = true; });
    }

    // overlay=true → 겹쳐보기, false → 좌우 나눠보기(스시저 분할 렌더).
    // 어느 모드든 예측 선박은 항상 고스트로 유지한다.
    function setShipViewMode(overlay) {
        splitView = !overlay;
        if (shipGroupPred && !_predGhostReady) _prepGhostMaterials();
        _setGhost();
        var btnO = document.getElementById('rv-view-overlay');
        var btnS = document.getElementById('rv-view-split');
        if (btnO) btnO.classList.toggle('active', overlay);
        if (btnS) btnS.classList.toggle('active', !overlay);
        var stage = document.querySelector('.rv-layout-b .roll-viewer-canvas-wrap');
        if (stage) {
            stage.classList.toggle('rv-stage--overlay', overlay);
            stage.classList.toggle('rv-stage--split', !overlay);
        }
    }

    // ── dispose() ──
    function dispose() {
        // AI 챗 FAB 위치 원복
        var _cb = document.getElementById('chat-bubble');
        if (_cb) _cb.classList.remove('rv-chat-shift', 'rv-chat-deck-hide', 'rv-chat-trace-collapsed');
        var _cp = document.getElementById('chat-panel');
        if (_cp) _cp.classList.remove('rv-chat-deck-hide');

        // Stop animation loop
        if (animFrameId !== null) {
            cancelAnimationFrame(animFrameId);
            animFrameId = null;
        }

        // 트레이스 리본 정리 (traceCollapsed는 세션 내 사용자 선호로 유지)
        if (traceRO) {
            traceRO.disconnect();
            traceRO = null;
        }
        traceCanvas = null;
        traceCtx = null;
        traceBuf = [];
        traceAccum = 0;
        traceYMax = 5;

        // Remove window resize handler
        if (_resizeHandler) {
            window.removeEventListener('resize', _resizeHandler);
            _resizeHandler = null;
        }
        if (_resizeObserver) {
            _resizeObserver.disconnect();
            _resizeObserver = null;
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

        // Dispose sky environment render target
        if (_skyEnvRT) { _skyEnvRT.dispose(); _skyEnvRT = null; }
        if (scene) scene.environment = null;

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
        _underwater = false;
        _underwaterTintEl = null;
        _savedFog = null;
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
        for (var _dv = 0; _dv < distantVessels.length; _dv++) {
            var _dvg = distantVessels[_dv].group;
            if (_dvg) _dvg.traverse(function (o) {
                if (o.geometry) o.geometry.dispose();
                if (o.material) o.material.dispose();
            });
        }
        distantVessels = [];
        navLights = [];
        radarSweep = null;
        sprayPoints = null;
        sprayVelocities = [];
        _contactShadow = null;
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
        _camHeadingSynced = false;
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

        // 예측 선박/이력 정리
        shipGroupPred = null;
        heelRefGroup = null;
        _rollWedge = null;
        _rollWedgeMat = null;
        _predGhostMats = [];
        _predEdgeMats = [];
        _predGhostReady = false;
        predRollHistory = [];
        predPitchHistory = [];
        smoothPredRoll = 0;
        smoothPredPitch = 0;
        predRoll = 0;
        predPitch = 0;

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

        // 시뮬레이션 패널은 상시 표시 (조작 버튼이 들어있음). 내부 섹션만 상태에 따라 토글.

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

        // Show/hide turn progress panel based on turn scenario state
        var turnSection = document.getElementById('rv-sim-progress');
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
        if (window.Gerstner) { _waves = Gerstner.buildWaves(_visualWeather()); _applyWavesToWater(); }
        return true;
    }

    function clearScenarioOverride() {
        if (!_baseWeather) return false;
        _scenarioOverride = null;
        _timeScale = 1.0;
        if (_baseShipSpeed !== null) shipSpeed = _baseShipSpeed;
        Object.assign(weather, _baseWeather);
        _refreshWeatherDisplay();
        if (window.Gerstner) { _waves = Gerstner.buildWaves(_visualWeather()); _applyWavesToWater(); }
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
        setCameraView: setCameraView,
        isActive: isActive
    };

})();

window.RollViewer = RollViewer;
