// ── Maritime OSINT Sentry — Cesium 3D Globe ──

Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIzY2MxZDJjNC03MGIxLTQzZjAtODM1OS1hYzMyNDIzZWE5YjYiLCJpZCI6NDA2NDI4LCJpYXQiOjE3NzM5NzA2ODl9.1ndfOL5CbW4FcszgDSjQhZKQGK41z7xlFT4ikUEOfVk';

viewer = new Cesium.Viewer('cesiumContainer', {
    animation: true,
    timeline: true,
    infoBox: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
        url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        credit: '© Esri, Maxar, Earthstar Geographics, USDA FSA, USGS, Aerogrid, IGN, IGP, and the GIS User Community',
        minimumLevel: 0,
        maximumLevel: 19
    }))
});

// ── 렌더링 최적화 ──
// 변경 없을 때 렌더링 중단 — CPU/GPU 유휴 시 부하 ��폭 감소
viewer.scene.requestRenderMode = true;
viewer.scene.maximumRenderTimeChange = Infinity; // 변화 없으면 즉시 렌더 중단 (수동 requestRender로 제어)
// FXAA 비활성�� — 글로브에서 체감 미미, GPU 부하만 증가
viewer.scene.postProcessStages.fxaa.enabled = false;
// 타일 캐시 확대 + 비행 목적지 프리로드
viewer.scene.globe.preloadFlightDestinations = true;
viewer.scene.globe.tileCacheSize = 300;

// 줌/스크롤 관성 — 부드러운 조작감
var sscc = viewer.scene.screenSpaceCameraController;
sscc.inertiaZoom = 0.7;
sscc.inertiaSpin = 0.85;
sscc.inertiaTranslate = 0.85;
sscc.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH];
sscc.maximumZoomDistance = 50000000;

// 카메라 이동 중 타일 품질 동적 조절
var _defaultSSE = viewer.scene.globe.maximumScreenSpaceError; // 기본값 2
var _moving = false;
var _moveEndTimer = null;

viewer.camera.moveStart.addEventListener(function() {
    if (_moving) return;
    _moving = true;
    viewer.scene.globe.maximumScreenSpaceError = 6;
    if (google3DTileset) google3DTileset.maximumScreenSpaceError = 24;
});

viewer.camera.moveEnd.addEventListener(function() {
    clearTimeout(_moveEndTimer);
    _moveEndTimer = setTimeout(function() {
        _moving = false;
        viewer.scene.globe.maximumScreenSpaceError = _defaultSSE;
        if (google3DTileset) google3DTileset.maximumScreenSpaceError = 12;
    }, 200);
});

// ResizeObserver for map area
var mapResizeObserver = new ResizeObserver(function() {
    if (currentMapMode === '3d' && viewer) {
        viewer.resize();
    } else if (currentMapMode === '2d' && leafletMap) {
        leafletMap.invalidateSize();
    }
});
mapResizeObserver.observe(document.getElementById('mapArea'));

// ── Google Photorealistic 3D Tiles ──
var google3DTileset = null;
(async function() {
    try {
        google3DTileset = await Cesium.Cesium3DTileset.fromIonAssetId(2275207);
        google3DTileset.show = false;
        google3DTileset.maximumScreenSpaceError = 12;       // 타일 깨짐 방지 — 품질 우선
        google3DTileset.maximumMemoryUsage = 512;            // 타일 캐시 확대 (MB)
        google3DTileset.preloadWhenHidden = false;           // 숨겨진 상태에서 불필요한 로딩 방지
        google3DTileset.cullWithChildrenBounds = true;       // 자식 타일 경계로 컬링 최적화
        google3DTileset.skipLevelOfDetail = true;            // 중간 LOD 건너뛰어 빠른 로딩
        google3DTileset.loadSiblings = false;                // 불필요한 형제 타일 로딩 방지
        google3DTileset.foveatedScreenSpaceError = true;     // 화면 중심부 우선 로딩
        google3DTileset.foveatedConeSize = 0.1;
        google3DTileset.foveatedMinimumScreenSpaceErrorRelaxation = 0;
        viewer.scene.primitives.add(google3DTileset);

        viewer.camera.changed.addEventListener(function() {
            var height = viewer.camera.positionCartographic.height;
            google3DTileset.show = height < 50000;
        });
    } catch (e) {
        console.warn('Google 3D Tiles load failed:', e);
    }
})();

// ── Vision Mode Filters (PostProcessStage GLSL Shaders) ──
var visionShaders = {
    normal: null,

    nv: '\n\
        uniform sampler2D colorTexture;\n\
        in vec2 v_textureCoordinates;\n\
        out vec4 fragColor;\n\
\n\
        float rand(vec2 co) {\n\
            return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);\n\
        }\n\
\n\
        void main() {\n\
            vec2 uv = v_textureCoordinates;\n\
            vec4 color = texture(colorTexture, uv);\n\
            float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));\n\
            lum = pow(lum, 0.6) * 1.4;\n\
            float noise = (rand(uv + fract(czm_frameNumber * 0.01)) - 0.5) * 0.06;\n\
            lum = clamp(lum + noise, 0.0, 1.0);\n\
            vec2 p = uv * 2.0 - 1.0;\n\
            float vig = 1.0 - dot(p, p) * 0.35;\n\
            lum *= vig;\n\
            fragColor = vec4(lum * 0.08, lum, lum * 0.18, 1.0);\n\
        }\n\
    ',

    flir: '\n\
        uniform sampler2D colorTexture;\n\
        in vec2 v_textureCoordinates;\n\
        out vec4 fragColor;\n\
\n\
        vec3 flirPalette(float t) {\n\
            t = clamp(t, 0.0, 1.0);\n\
            vec3 col;\n\
            if (t < 0.25) {\n\
                col = mix(vec3(0.0,0.0,0.0), vec3(0.4,0.0,0.5), t*4.0);\n\
            } else if (t < 0.5) {\n\
                col = mix(vec3(0.4,0.0,0.5), vec3(0.9,0.1,0.0), (t-0.25)*4.0);\n\
            } else if (t < 0.75) {\n\
                col = mix(vec3(0.9,0.1,0.0), vec3(1.0,0.7,0.0), (t-0.5)*4.0);\n\
            } else {\n\
                col = mix(vec3(1.0,0.7,0.0), vec3(1.0,1.0,1.0), (t-0.75)*4.0);\n\
            }\n\
            return col;\n\
        }\n\
\n\
        void main() {\n\
            vec2 uv = v_textureCoordinates;\n\
            vec4 color = texture(colorTexture, uv);\n\
            float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));\n\
            lum = pow(lum, 0.75);\n\
            fragColor = vec4(flirPalette(lum), 1.0);\n\
        }\n\
    ',

    crt: '\n\
        uniform sampler2D colorTexture;\n\
        in vec2 v_textureCoordinates;\n\
        out vec4 fragColor;\n\
\n\
        void main() {\n\
            vec2 uv = v_textureCoordinates;\n\
            vec2 cc = uv - 0.5;\n\
            float dist = dot(cc, cc);\n\
            uv = uv + cc * dist * 0.12;\n\
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {\n\
                fragColor = vec4(0.0, 0.0, 0.0, 1.0);\n\
                return;\n\
            }\n\
            vec4 color = texture(colorTexture, uv);\n\
            float scanline = sin(uv.y * 800.0) * 0.5 + 0.5;\n\
            float sl = mix(0.75, 1.0, scanline);\n\
            color.rgb *= sl;\n\
            color.r  *= 0.85;\n\
            color.g  *= 1.05;\n\
            color.b  *= 1.10;\n\
            vec2 p = uv * 2.0 - 1.0;\n\
            float vig = 1.0 - dot(p, p) * 0.25;\n\
            color.rgb *= vig;\n\
            fragColor = vec4(color.rgb, 1.0);\n\
        }\n\
    '
};

var currentVisionStage = null;
var currentVisionMode = 'normal';

function applyVisionMode(mode) {
    if (currentVisionStage) {
        viewer.scene.postProcessStages.remove(currentVisionStage);
        currentVisionStage = null;
    }

    if (mode !== 'normal' && visionShaders[mode]) {
        currentVisionStage = new Cesium.PostProcessStage({
            fragmentShader: visionShaders[mode]
        });
        viewer.scene.postProcessStages.add(currentVisionStage);
    }

    document.querySelectorAll('.vmode-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    currentVisionMode = mode;

    var leafletEl = document.getElementById('leafletContainer');
    if (leafletEl) {
        leafletEl.classList.remove('vision-nv', 'vision-flir', 'vision-crt');
        if (mode !== 'normal') {
            leafletEl.classList.add('vision-' + mode);
        }
    }
}

// Bind vision mode buttons
document.querySelectorAll('.vmode-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { applyVisionMode(btn.dataset.mode); });
});

// ── Hybrid Map ──
var baseLayer = viewer.imageryLayers.get(0);
baseLayer.brightness = 1.0;
baseLayer.saturation = 1.0;
baseLayer.contrast = 1.0;

var fallbackLayer = viewer.imageryLayers.addImageryProvider(
    new Cesium.UrlTemplateImageryProvider({
        url: 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
        credit: '© CartoDB © OpenStreetMap contributors',
        minimumLevel: 0,
        maximumLevel: 20
    })
);
fallbackLayer.alpha = 0;
fallbackLayer.brightness = 0.5;
fallbackLayer.saturation = 0.3;

// Throttled camera change handler (max once per 200ms)
var _cameraChangeTimer = null;
viewer.camera.changed.addEventListener(function() {
    if (_cameraChangeTimer) return;
    _cameraChangeTimer = setTimeout(function() {
        _cameraChangeTimer = null;
        var height = viewer.camera.positionCartographic.height;
        if (height < 10000) {
            var t = Math.max(0, Math.min(1, (10000 - height) / 8000));
            fallbackLayer.alpha = t;
        } else {
            fallbackLayer.alpha = 0;
        }
    }, 200);
});

// ── Map Navigation: Zoom/Pan buttons + Keyboard shortcuts ──
var NAV_PAN_PIXELS = 200;
var NAV_ZOOM_FACTOR = 0.4;

function navZoom(direction) {
    var height = viewer.camera.positionCartographic.height;
    var delta = height * NAV_ZOOM_FACTOR;
    if (direction > 0) {
        viewer.camera.zoomIn(delta);
    } else {
        viewer.camera.zoomOut(delta);
    }
}

function navPan(dx, dy) {
    var ellipsoid = viewer.scene.globe.ellipsoid;
    var cam = viewer.camera;
    var width = viewer.canvas.clientWidth;
    var height = viewer.canvas.clientHeight;
    var centerX = width / 2;
    var centerY = height / 2;

    var startRay = cam.getPickRay(new Cesium.Cartesian2(centerX, centerY));
    var endRay = cam.getPickRay(new Cesium.Cartesian2(centerX - dx, centerY - dy));
    if (!startRay || !endRay) return;

    var startPos = viewer.scene.globe.pick(startRay, viewer.scene);
    var endPos = viewer.scene.globe.pick(endRay, viewer.scene);
    if (!startPos || !endPos) return;

    var diff = Cesium.Cartesian3.subtract(endPos, startPos, new Cesium.Cartesian3());
    var camPos = cam.positionWC;
    cam.position = Cesium.Cartesian3.add(camPos, diff, new Cesium.Cartesian3());
}

// Button handlers
document.getElementById('navZoomIn').addEventListener('click', function() { navZoom(1); });
document.getElementById('navZoomOut').addEventListener('click', function() { navZoom(-1); });
document.getElementById('navUp').addEventListener('click', function() { navPan(0, NAV_PAN_PIXELS); });
document.getElementById('navDown').addEventListener('click', function() { navPan(0, -NAV_PAN_PIXELS); });
document.getElementById('navLeft').addEventListener('click', function() { navPan(NAV_PAN_PIXELS, 0); });
document.getElementById('navRight').addEventListener('click', function() { navPan(-NAV_PAN_PIXELS, 0); });

// Camera orbit rotation
var NAV_ROTATE_DEG = 5;
var NAV_TILT_DEG = 5;

function navOrbit(deltaLon, deltaLat) {
    var cam = viewer.camera;
    var pos = cam.positionCartographic;
    var newLon = pos.longitude + Cesium.Math.toRadians(deltaLon);
    var newLat = Cesium.Math.clamp(
        pos.latitude + Cesium.Math.toRadians(deltaLat),
        Cesium.Math.toRadians(-85),
        Cesium.Math.toRadians(85)
    );
    cam.setView({
        destination: Cesium.Cartesian3.fromRadians(newLon, newLat, pos.height),
        orientation: {
            heading: cam.heading,
            pitch: cam.pitch,
            roll: cam.roll
        }
    });
}

function navTilt(deltaDeg) {
    var cam = viewer.camera;
    var newPitch = Cesium.Math.clamp(
        cam.pitch + Cesium.Math.toRadians(deltaDeg),
        Cesium.Math.toRadians(-90),
        Cesium.Math.toRadians(-25)
    );
    cam.setView({
        orientation: {
            heading: cam.heading,
            pitch: newPitch,
            roll: cam.roll
        }
    });
}

viewer.scene.screenSpaceCameraController.minimumZoomDistance = 50;
viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    switch (e.key) {
        case 'ArrowUp': e.preventDefault(); navPan(0, NAV_PAN_PIXELS); break;
        case 'ArrowDown': e.preventDefault(); navPan(0, -NAV_PAN_PIXELS); break;
        case 'ArrowLeft': e.preventDefault(); navPan(NAV_PAN_PIXELS, 0); break;
        case 'ArrowRight': e.preventDefault(); navPan(-NAV_PAN_PIXELS, 0); break;
        case '+': case '=': e.preventDefault(); navZoom(1); break;
        case '-': case '_': e.preventDefault(); navZoom(-1); break;
        case 'a': case 'A': e.preventDefault(); navOrbit(-NAV_ROTATE_DEG, 0); break;
        case 'd': case 'D': e.preventDefault(); navOrbit(NAV_ROTATE_DEG, 0); break;
        case 'w': case 'W': e.preventDefault(); navTilt(NAV_TILT_DEG); break;
        case 's': case 'S': e.preventDefault(); navTilt(-NAV_TILT_DEG); break;
    }
});

// ── Globe appearance ──
var scene = viewer.scene;
var globe = viewer.scene.globe;

globe.enableLighting = false;

var now = Cesium.JulianDate.now();
viewer.clock.currentTime = now;
viewer.clock.shouldAnimate = false;

globe.baseColor = Cesium.Color.fromCssColorString('#1a3a5c');

viewer.cesiumWidget.creditContainer.style.display = 'none';

// ── 사용자 수동 카메라 조작 시 충돌 추적 해제 ──
// 클릭이 아닌 실제 드래그/스크롤만 감지
var _mouseDownForDrag = false;
var _userDragged = false;
var _cesiumInputHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
_cesiumInputHandler.setInputAction(function() {
    _mouseDownForDrag = true; _userDragged = false;
}, Cesium.ScreenSpaceEventType.LEFT_DOWN);
_cesiumInputHandler.setInputAction(function() {
    _mouseDownForDrag = true; _userDragged = false;
}, Cesium.ScreenSpaceEventType.MIDDLE_DOWN);
_cesiumInputHandler.setInputAction(function() {
    _mouseDownForDrag = true; _userDragged = false;
}, Cesium.ScreenSpaceEventType.RIGHT_DOWN);
_cesiumInputHandler.setInputAction(function() {
    if (_mouseDownForDrag) _userDragged = true;
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
_cesiumInputHandler.setInputAction(function() { _mouseDownForDrag = false; }, Cesium.ScreenSpaceEventType.LEFT_UP);
_cesiumInputHandler.setInputAction(function() { _mouseDownForDrag = false; }, Cesium.ScreenSpaceEventType.MIDDLE_UP);
_cesiumInputHandler.setInputAction(function() { _mouseDownForDrag = false; }, Cesium.ScreenSpaceEventType.RIGHT_UP);
// 마우스 휠 줌도 사용자 조작으로 간주
_cesiumInputHandler.setInputAction(function() { _userDragged = true; }, Cesium.ScreenSpaceEventType.WHEEL);
viewer.camera.moveEnd.addEventListener(function() {
    if (_userDragged) {
        _userDragged = false;
        _mouseDownForDrag = false;
        if (typeof stopCollisionTracking === 'function') stopCollisionTracking();
    }
});

// ── Smooth camera transition ──
function smoothFlyTo(options) {
    var destCart = Cesium.Cartographic.fromCartesian(options.destination);
    var destLat = Cesium.Math.toDegrees(destCart.latitude);
    var destLng = Cesium.Math.toDegrees(destCart.longitude);
    var destAlt = destCart.height;

    // 현재 카메라 위치에서 목적지까지 거리 계산
    var camCart = viewer.camera.positionCartographic;
    var camLat = Cesium.Math.toDegrees(camCart.latitude);
    var camLng = Cesium.Math.toDegrees(camCart.longitude);
    var camAlt = camCart.height;

    // 지표면 거리 (대략적 계산, km)
    var dLat = (destLat - camLat) * 111;
    var dLng = (destLng - camLng) * 111 * Math.cos(camCart.latitude);
    var surfaceDist = Math.sqrt(dLat * dLat + dLng * dLng);

    // 거리 기반 maximumHeight: 가까우면 낮게, 멀면 높게
    var maxH;
    if (surfaceDist < 50) {
        // 50km 이내: 현재 고도와 목적지 고도 중 큰 값의 1.3배
        maxH = Math.max(camAlt, destAlt) * 1.3;
    } else if (surfaceDist < 500) {
        // 50~500km: 거리에 비례하여 적당히
        maxH = Math.max(destAlt * 2, surfaceDist * 300);
    } else {
        // 500km+: 장거리 이동
        maxH = Math.min(surfaceDist * 500, 5000000);
    }
    // 최소한 목적지 고도보다는 높아야 함
    maxH = Math.max(maxH, destAlt * 1.2);

    // 거리 기반 duration: 가까우면 짧게, 멀면 길게
    var duration = options.duration;
    if (!duration) {
        if (surfaceDist < 20) {
            duration = 1.2;
        } else if (surfaceDist < 200) {
            duration = 1.8;
        } else if (surfaceDist < 1000) {
            duration = 2.5;
        } else {
            duration = 3.0;
        }
    }

    var userComplete = options.complete;
    viewer.camera.flyTo({
        ...options,
        duration: duration,
        maximumHeight: maxH,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
        complete: function() {
            // 카메라 이동 완료 후 선박 즉시 리렌더 (뷰포트 컬링 갱신)
            if (_lastShipsData && timeMode === 'live') {
                updateShipsLayer(_lastShipsData);
            }
            if (userComplete) userComplete();
        }
    });
}
window.smoothFlyTo = smoothFlyTo;

// ── Region dropdown ──
var REGIONS = {
    world: { label: '전체', lon: 30.0, lat: 20.0, alt: 20000000, pitch: -90 },
    korea: { label: '한국 해역', lon: 128.0, lat: 35.5, alt: 800000, pitch: -45 },
    arctic: { label: '북극항로', lon: 100.0, lat: 75.0, alt: 5000000, pitch: -60 },
    somalia: { label: '소말리아 / 아덴만', lon: 48.0, lat: 12.0, alt: 2000000, pitch: -45 },
    malacca: { label: '말라카 해협', lon: 101.5, lat: 2.5, alt: 800000, pitch: -45 },
    guinea: { label: '기니만', lon: 3.0, lat: 3.0, alt: 2500000, pitch: -45 },
};

var regionToggle = document.getElementById('regionToggle');
var regionDropdown = document.getElementById('regionDropdown');
var regionLabel = document.getElementById('regionLabel');
var currentRegionKey = null;

function flyToRegion(key) {
    var r = REGIONS[key];
    if (!r) return;
    smoothFlyTo({
        destination: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, r.alt),
        orientation: {
            heading: Cesium.Math.toRadians(0),
            pitch: Cesium.Math.toRadians(r.pitch),
            roll: 0
        }
    });
}

var regionChevron = document.getElementById('regionChevron');

function openRegionDropdown() {
    if (regionDropdown) regionDropdown.classList.add('open');
    if (regionToggle) regionToggle.classList.add('open');
}

function closeRegionDropdown() {
    if (regionDropdown) regionDropdown.classList.remove('open');
    if (regionToggle) regionToggle.classList.remove('open');
}

if (regionToggle) {
    regionToggle.addEventListener('click', function(e) {
        e.stopPropagation();
        closeRegionDropdown();
        if (currentRegionKey) {
            flyToRegion(currentRegionKey);
        } else {
            openRegionDropdown();
        }
    });
}

if (regionChevron) {
    regionChevron.addEventListener('click', function(e) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        var isOpen = regionDropdown && regionDropdown.classList.contains('open');
        if (isOpen) {
            closeRegionDropdown();
        } else {
            openRegionDropdown();
        }
    });
}

document.addEventListener('click', function() {
    closeRegionDropdown();
});
if (regionDropdown) {
    regionDropdown.addEventListener('click', function(e) { e.stopPropagation(); });
}

document.querySelectorAll('.region-item').forEach(function(item) {
    item.addEventListener('click', function() {
        var key = item.dataset.region;
        var r = REGIONS[key];
        if (!r) return;

        document.querySelectorAll('.region-item').forEach(function(i) { i.classList.remove('active'); });
        item.classList.add('active');
        if (regionLabel) regionLabel.textContent = r.label;
        currentRegionKey = key;

        closeRegionDropdown();
        flyToRegion(key);
    });
});

// Default view
viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(53.0, 24.0, 3000000.0),
    duration: 2.0,
    easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT
});

// ── Initialize shared data sources ──
satDataSource = new Cesium.CustomDataSource('Satellites');
viewer.dataSources.add(satDataSource);
satDataSource.show = false;

proximityDataSource = new Cesium.CustomDataSource('Proximity');
viewer.dataSources.add(proximityDataSource);

// Proximity Primitive Collections
proximityLines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
proximityLabels = viewer.scene.primitives.add(new Cesium.LabelCollection());
proximityCogLines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
proximityCpaPoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
proximityCpaLabels = viewer.scene.primitives.add(new Cesium.LabelCollection());

// Ship Primitive Collections (라이브 3D용)
SHIP_TYPES.forEach(function(type) {
    shipBillboards[type] = viewer.scene.primitives.add(new Cesium.BillboardCollection());
    shipLabels[type] = viewer.scene.primitives.add(new Cesium.LabelCollection());
});
// COG 방향선 Collection
shipCogLines = viewer.scene.primitives.add(new Cesium.PolylineCollection());

// Aircraft Primitive Collections
AIRCRAFT_TYPES.forEach(function(type) {
    aircraftBillboards[type] = viewer.scene.primitives.add(new Cesium.BillboardCollection());
    aircraftLabels[type] = viewer.scene.primitives.add(new Cesium.LabelCollection());
    // Default hidden — user enables via filter checkboxes
    aircraftBillboards[type].show = false;
    aircraftLabels[type].show = false;
});

SHIP_TYPES.forEach(async function(type) {
    var ds = new Cesium.CustomDataSource('Ships - ' + type);
    shipDataSources[type] = ds;
    await viewer.dataSources.add(ds);
});
