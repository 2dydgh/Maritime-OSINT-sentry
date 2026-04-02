// ── Maritime Weather Overlay ──

var _wxData = { marine: null, wind: null };
var _wxLayers = { waveHeight: null, wind: null };
var _wxInterval = null;

function _oceanRegionName(lat, lon) {
    // Korean peninsula & nearby seas
    if (lat >= 33 && lat <= 43 && lon >= 124 && lon <= 132) return '동해/서해';
    if (lat >= 25 && lat <= 35 && lon >= 120 && lon <= 132) return '동중국해';
    if (lat >= 33 && lat <= 46 && lon >= 127 && lon <= 142) return '동해';
    // Major oceans by lat/lon
    if (lat >= 0 && lat <= 30 && lon >= 100 && lon <= 150) return '서태평양';
    if (lat >= 30 && lat <= 60 && lon >= 100 && lon <= 180) return '북태평양';
    if (lat >= -60 && lat < 0 && lon >= 100 && lon <= 180) return '남태평양';
    if (lat >= 0 && lat <= 30 && lon >= -80 && lon <= 0) return '대서양';
    if (lat >= 30 && lat <= 70 && lon >= -80 && lon <= 0) return '북대서양';
    if (lat >= -60 && lat < 0 && lon >= -70 && lon <= 20) return '남대서양';
    if (lat >= -40 && lat <= 30 && lon >= 20 && lon <= 100) return '인도양';
    if (lat >= 0 && lat <= 35 && lon >= -180 && lon <= -100) return '동태평양';
    if (lat >= 50 && lon >= -10 && lon <= 30) return '북해/발트해';
    if (lat >= 30 && lat <= 46 && lon >= -6 && lon <= 36) return '지중해';
    // No region match
    return '';
}

// Cesium imagery layers
var _wxWaveImagery = null;
var _wxWindImagery = null;

async function fetchWeatherData() {
    try {
        var [marineResp, windResp] = await Promise.all([
            fetch('/api/v1/weather/marine'),
            fetch('/api/v1/weather/wind')
        ]);
        _wxData.marine = await marineResp.json();
        _wxData.wind = await windResp.json();

        // Bottom bar weather updates — show max values with location
        if (typeof BottomBar !== 'undefined') {
            var windPoints = (_wxData.wind && _wxData.wind.points) || [];
            var marinePoints = (_wxData.marine && _wxData.marine.points) || [];

            var maxWind = { val: 0, lat: 0, lon: 0 };
            windPoints.forEach(function(p) {
                if ((p.wind_speed || 0) > maxWind.val) {
                    maxWind = { val: p.wind_speed, lat: p.lat, lon: p.lon };
                }
            });

            var maxWave = { val: 0, lat: 0, lon: 0 };
            marinePoints.forEach(function(p) {
                if ((p.wave_height || 0) > maxWave.val) {
                    maxWave = { val: p.wave_height, lat: p.lat, lon: p.lon };
                }
            });

            BottomBar.updateValue('bottomWind', maxWind.val.toFixed(1));
            BottomBar.updateValue('bottomWave', maxWave.val.toFixed(1));

            var windLocEl = document.getElementById('bottomWindLoc');
            var waveLocEl = document.getElementById('bottomWaveLoc');
            if (windLocEl && maxWind.val > 0) {
                var wr = _oceanRegionName(maxWind.lat, maxWind.lon);
                var wc = Math.abs(maxWind.lat).toFixed(1) + '°' + (maxWind.lat >= 0 ? 'N' : 'S') +
                    ' ' + Math.abs(maxWind.lon).toFixed(1) + '°' + (maxWind.lon >= 0 ? 'E' : 'W');
                windLocEl.textContent = wr ? wr + ' ' + wc : wc;
            }
            if (waveLocEl && maxWave.val > 0) {
                var mr = _oceanRegionName(maxWave.lat, maxWave.lon);
                var mc = Math.abs(maxWave.lat).toFixed(1) + '°' + (maxWave.lat >= 0 ? 'N' : 'S') +
                    ' ' + Math.abs(maxWave.lon).toFixed(1) + '°' + (maxWave.lon >= 0 ? 'E' : 'W');
                waveLocEl.textContent = mr ? mr + ' ' + mc : mc;
            }
        }

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
        renderWindLabels(_wxData.wind.points, _wxData.marine ? _wxData.marine.points : null);
    } else {
        clearWindLabels();
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

// ── Wind Speed Labels (canvas imagery) ──

function _windSpeedColor(speed) {
    if (speed < 5) return '#60a5fa';
    if (speed < 10) return '#34d399';
    if (speed < 20) return '#fbbf24';
    return '#ef4444';
}

function _buildWindLabelCanvas(points, marinePoints) {
    var W = 720, H = 360;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');

    // 바다 좌표 셋
    var oceanSet = {};
    if (marinePoints) {
        marinePoints.forEach(function(m) {
            if (m.wave_height && m.wave_height > 0) oceanSet[m.lat + ',' + m.lon] = true;
        });
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    points.forEach(function(p) {
        if (p.wind_speed <= 0) return;
        if (marinePoints && !oceanSet[p.lat + ',' + p.lon]) return;

        var px = ((p.lon + 180) / 360) * W;
        var py = ((90 - p.lat) / 180) * H;

        var label = Math.round(p.wind_speed) + '';
        var color = _windSpeedColor(p.wind_speed);

        // 배경 원
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fill();

        // 숫자
        ctx.font = 'bold 7px JetBrains Mono, monospace';
        ctx.fillStyle = color;
        ctx.fillText(label, px, py);
    });

    return canvas;
}

function renderWindLabels(points, marinePoints) {
    clearWindLabels();

    var canvas = _buildWindLabelCanvas(points, marinePoints);

    // 3D Cesium
    if (typeof viewer !== 'undefined' && viewer) {
        var provider = new Cesium.SingleTileImageryProvider({
            url: canvas.toDataURL(),
            rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90)
        });
        _wxWindImagery = viewer.imageryLayers.addImageryProvider(provider);
        _wxWindImagery.alpha = 0.9;
    }

    // 2D Leaflet
    if (typeof leafletMap !== 'undefined' && leafletMap && currentMapMode === '2d') {
        var url = canvas.toDataURL();
        _wxLayers.wind = L.imageOverlay(url, [[-90, -180], [90, 180]], { opacity: 0.9 });
        _wxLayers.wind.addTo(leafletMap);
    }
}

function clearWindLabels() {
    if (_wxWindImagery && typeof viewer !== 'undefined' && viewer) {
        viewer.imageryLayers.remove(_wxWindImagery);
        _wxWindImagery = null;
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
