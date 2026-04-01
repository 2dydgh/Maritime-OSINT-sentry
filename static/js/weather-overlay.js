// ── Maritime Weather Overlay ──

var _wxData = { marine: null, wind: null };
var _wxLayers = { waveHeight: null, wind: null };
var _wxInterval = null;

// Cesium primitives
var _wxWaveImagery = null;  // ImageryLayer (heatmap)
var _wxWindEntities = [];   // Entity array

async function fetchWeatherData() {
    try {
        var [marineResp, windResp] = await Promise.all([
            fetch('/api/v1/weather/marine'),
            fetch('/api/v1/weather/wind')
        ]);
        _wxData.marine = await marineResp.json();
        _wxData.wind = await windResp.json();
        renderWeatherOverlays();
    } catch (err) {
        console.warn('Weather fetch failed:', err);
    }
}

function renderWeatherOverlays() {
    var wxWave = document.getElementById('wx-wave-height');
    var wxWind = document.getElementById('wx-wind');

    if (wxWave && wxWave.checked && _wxData.marine) {
        renderWaveHeight(_wxData.marine.points);
    } else {
        clearWaveHeight();
    }

    if (wxWind && wxWind.checked && _wxData.wind) {
        renderWindArrows(_wxData.wind.points, _wxData.marine ? _wxData.marine.points : null);
    } else {
        clearWindArrows();
    }

    updateWxLegend();
}

// ── Wave Height ──

function waveHeightColorRGBA(h) {
    // 연속 보간 컬러맵: 0m=투명파랑 → 1m=시안 → 2m=노랑 → 3m=주황 → 5m+=빨강
    var r, g, b, a;
    if (h <= 0) return [0, 0, 0, 0];
    if (h <= 0.5) { var t = h / 0.5; r = 10 + t * 10; g = 60 + t * 80; b = 180 + t * 20; a = 80 + t * 40; }
    else if (h <= 1.0) { var t = (h - 0.5) / 0.5; r = 20 - t * 10; g = 140 + t * 60; b = 200 - t * 70; a = 120 + t * 20; }
    else if (h <= 2.0) { var t = (h - 1.0); r = 10 + t * 220; g = 200 - t * 10; b = 130 - t * 110; a = 140 + t * 15; }
    else if (h <= 3.0) { var t = (h - 2.0); r = 230 + t * 12; g = 190 - t * 70; b = 20 - t * 10; a = 155 + t * 15; }
    else { var t = Math.min((h - 3.0) / 2.0, 1.0); r = 242 - t * 10; g = 120 - t * 70; b = 10 + t * 30; a = 170 + t * 30; }
    return [Math.round(r), Math.round(g), Math.round(b), Math.round(a)];
}

function _buildWaveHeatmapCanvas(points) {
    // IDW 보간으로 360x180 캔버스에 히트맵 렌더링
    var W = 720, H = 360;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    var imgData = ctx.createImageData(W, H);
    var data = imgData.data;

    // 유효 포인트만 필터
    var valid = points.filter(function(p) { return p.wave_height && p.wave_height > 0; });
    if (valid.length === 0) return canvas;

    // 각 픽셀에 대해 IDW 보간 (바다만: 최근접 해양 포인트가 18° 이내)
    var MAX_DIST2 = 18 * 18; // 최대 보간 거리 (도 단위) 제곱
    for (var py = 0; py < H; py++) {
        var lat = 90 - (py / H) * 180;
        for (var px = 0; px < W; px++) {
            var lon = -180 + (px / W) * 360;
            var wSum = 0, vSum = 0, minD2 = 99999;
            for (var i = 0; i < valid.length; i++) {
                var dlat = lat - valid[i].lat;
                var dlon = lon - valid[i].lon;
                if (dlon > 180) dlon -= 360;
                if (dlon < -180) dlon += 360;
                var d2 = dlat * dlat + dlon * dlon;
                if (d2 < minD2) minD2 = d2;
                if (d2 < 0.1) { wSum = 1; vSum = valid[i].wave_height; break; }
                var w = 1.0 / (d2 * d2);
                wSum += w;
                vSum += w * valid[i].wave_height;
            }
            // 가장 가까운 해양 포인트가 너무 멀면 투명 (육지)
            if (minD2 > MAX_DIST2) continue;
            var val = wSum > 0 ? vSum / wSum : 0;
            var c = waveHeightColorRGBA(val);
            var idx = (py * W + px) * 4;
            data[idx] = c[0]; data[idx+1] = c[1]; data[idx+2] = c[2]; data[idx+3] = c[3];
        }
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
}

function renderWaveHeight(points) {
    clearWaveHeight();

    var canvas = _buildWaveHeatmapCanvas(points);

    // 3D Cesium
    if (typeof viewer !== 'undefined' && viewer) {
        var provider = new Cesium.SingleTileImageryProvider({
            url: canvas.toDataURL(),
            rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90)
        });
        _wxWaveImagery = viewer.imageryLayers.addImageryProvider(provider);
        _wxWaveImagery.alpha = 0.7;
    }

    // 2D Leaflet
    if (typeof leafletMap !== 'undefined' && leafletMap && currentMapMode === '2d') {
        var url = canvas.toDataURL();
        _wxLayers.waveHeight = L.imageOverlay(url, [[-90, -180], [90, 180]], { opacity: 0.7 });
        _wxLayers.waveHeight.addTo(leafletMap);
    }
}

function clearWaveHeight() {
    if (_wxWaveImagery && typeof viewer !== 'undefined' && viewer) {
        viewer.imageryLayers.remove(_wxWaveImagery);
        _wxWaveImagery = null;
    }
    if (_wxLayers.waveHeight && typeof leafletMap !== 'undefined' && leafletMap) {
        leafletMap.removeLayer(_wxLayers.waveHeight);
        _wxLayers.waveHeight = null;
    }
}

// ── Wind Arrows ──

function _createWindArrowCanvas(speed, direction) {
    var size = 48;
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    var ctx = c.getContext('2d');

    ctx.translate(size / 2, size / 2);
    ctx.rotate((direction * Math.PI) / 180);

    // 풍속에 따른 색상
    var color = speed < 5 ? '#60a5fa' : speed < 10 ? '#34d399' : speed < 20 ? '#fbbf24' : '#ef4444';

    // 화살표
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 12);
    ctx.lineTo(0, -12);
    ctx.stroke();

    // 화살촉
    ctx.beginPath();
    ctx.moveTo(-5, -6);
    ctx.lineTo(0, -14);
    ctx.lineTo(5, -6);
    ctx.fill();

    return c;
}

function renderWindArrows(points, marinePoints) {
    clearWindArrows();

    // 바다 좌표 셋 구축 (marine API에서 파고 > 0인 좌표)
    var oceanSet = {};
    if (marinePoints) {
        marinePoints.forEach(function(m) {
            if (m.wave_height && m.wave_height > 0) oceanSet[m.lat + ',' + m.lon] = true;
        });
    }

    if (typeof viewer === 'undefined' || !viewer) return;

    points.forEach(function(p) {
        if (p.wind_speed <= 0) return;
        // 바다 위만 표시
        if (marinePoints && !oceanSet[p.lat + ',' + p.lon]) return;
        var canvas = _createWindArrowCanvas(p.wind_speed, p.wind_direction);
        var entity = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
            billboard: {
                image: canvas,
                width: 32,
                height: 32,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
        _wxWindEntities.push(entity);
    });

    // 2D Leaflet
    if (typeof leafletMap !== 'undefined' && leafletMap && currentMapMode === '2d') {
        _wxLayers.wind = L.layerGroup();
        points.forEach(function(p) {
            if (p.wind_speed <= 0) return;
            if (marinePoints && !oceanSet[p.lat + ',' + p.lon]) return;
            var color = p.wind_speed < 5 ? '#60a5fa' : p.wind_speed < 10 ? '#34d399' : p.wind_speed < 20 ? '#fbbf24' : '#ef4444';
            var icon = L.divIcon({
                className: '',
                html: '<div style="color:' + color + ';font-size:18px;transform:rotate(' + p.wind_direction + 'deg);text-shadow:0 0 4px rgba(0,0,0,0.8);">↑</div>',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });
            L.marker([p.lat, p.lon], { icon: icon, interactive: false }).addTo(_wxLayers.wind);
        });
        _wxLayers.wind.addTo(leafletMap);
    }
}

function clearWindArrows() {
    if (_wxWindEntities.length > 0 && typeof viewer !== 'undefined' && viewer) {
        _wxWindEntities.forEach(function(e) { viewer.entities.remove(e); });
        _wxWindEntities = [];
    }
    if (_wxLayers.wind && typeof leafletMap !== 'undefined' && leafletMap) {
        leafletMap.removeLayer(_wxLayers.wind);
        _wxLayers.wind = null;
    }
}

// ── Legend ──

function updateWxLegend() {
    var legend = document.getElementById('wxLegend');
    if (!legend) return;

    var wxWave = document.getElementById('wx-wave-height');
    var wxWind = document.getElementById('wx-wind');
    var showWave = wxWave && wxWave.checked;
    var showWind = wxWind && wxWind.checked;

    if (!showWave && !showWind) {
        legend.style.display = 'none';
        return;
    }

    var html = '';
    if (showWave) {
        html += '<div class="wx-legend-title">파고 (m)</div>';
        html += '<div class="wx-legend-bar" style="background:linear-gradient(90deg, #1a66cc, #1ab380, #e6cc1a, #f28019, #f23333);"></div>';
        html += '<div class="wx-legend-labels"><span>0</span><span>1</span><span>2</span><span>3</span><span>5+</span></div>';
    }
    if (showWind) {
        html += '<div class="wx-legend-title" style="margin-top:6px;">풍속 (m/s)</div>';
        html += '<div class="wx-legend-bar" style="background:linear-gradient(90deg, #60a5fa, #34d399, #fbbf24, #ef4444);"></div>';
        html += '<div class="wx-legend-labels"><span>0</span><span>5</span><span>10</span><span>20+</span></div>';
    }

    legend.innerHTML = html;
    legend.style.display = 'block';
}

// ── Event Bindings + Init ──

document.addEventListener('DOMContentLoaded', function() {
    var wxWave = document.getElementById('wx-wave-height');
    var wxWind = document.getElementById('wx-wind');
    var wxPrecip = document.getElementById('wx-precipitation');

    if (wxWave) wxWave.addEventListener('change', renderWeatherOverlays);
    if (wxWind) wxWind.addEventListener('change', renderWeatherOverlays);

    // 강수 레이더 = 기존 cloudLayer 토글
    if (wxPrecip) {
        wxPrecip.addEventListener('change', function(e) {
            if (typeof cloudLayer !== 'undefined' && cloudLayer) {
                cloudLayer.show = e.target.checked;
                if (e.target.checked && typeof viewer !== 'undefined') {
                    viewer.imageryLayers.raiseToTop(cloudLayer);
                }
            }
        });
    }

    // 초기 fetch + 10분 주기 갱신
    fetchWeatherData();
    _wxInterval = setInterval(fetchWeatherData, 10 * 60 * 1000);
});
