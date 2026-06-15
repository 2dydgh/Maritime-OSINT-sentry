// ── Maritime Weather Overlay ──

var _wxData = { marine: null, wind: null };
var _wxLayers = { waveHeight: null, wind: null, precip: null };
var _wxInterval = null;

function _oceanRegionName(lat, lon) {
    // Korean peninsula & nearby seas
    if (lat >= 33 && lat <= 43 && lon >= 124 && lon <= 132) return '동해/서해';
    if (lat >= 25 && lat <= 35 && lon >= 120 && lon <= 132) return '동중국해';
    if (lat >= 33 && lat <= 46 && lon >= 127 && lon <= 142) return '동해';
    if (lat >= 50 && lon >= -10 && lon <= 30) return '북해/발트해';
    if (lat >= 30 && lat <= 46 && lon >= -6 && lon <= 36) return '지중해';
    // Polar
    if (lat >= 66) return '북극해';
    if (lat <= -60) return '남극해';
    // Major oceans — full longitude coverage so no point falls through to raw coords
    if (lon >= 20 && lon < 100) {
        if (lat <= 30) return '인도양';
        return '';  // inland Asia — no ocean label
    }
    if (lon >= 100 || lon < -70) {  // Pacific basin (incl. east Pacific negative lons)
        if (lat >= 30) return '북태평양';
        if (lat >= 0) return (lon >= 100 && lon <= 150) ? '서태평양' : '동태평양';
        return '남태평양';
    }
    // Atlantic basin: lon -70..20
    if (lat >= 30) return '북대서양';
    if (lat >= 0) return '대서양';
    return '남대서양';
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
                windLocEl.textContent = wr || wc;
                windLocEl.title = wc;
            }
            if (waveLocEl && maxWave.val > 0) {
                var mr = _oceanRegionName(maxWave.lat, maxWave.lon);
                var mc = Math.abs(maxWave.lat).toFixed(1) + '°' + (maxWave.lat >= 0 ? 'N' : 'S') +
                    ' ' + Math.abs(maxWave.lon).toFixed(1) + '°' + (maxWave.lon >= 0 ? 'E' : 'W');
                waveLocEl.textContent = mr || mc;
                waveLocEl.title = mc;
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

    renderPrecipitation();
    updateWxLegend();
}

// ── 강수 레이더 (RainViewer) ──
// 3D는 Cesium cloudLayer(websocket.js)가 담당. 여기서는 2D Leaflet 타일을 관리한다.
function renderPrecipitation() {
    if (typeof leafletMap === 'undefined' || !leafletMap) return;
    var wxPrecip = document.getElementById('wx-precipitation');
    var want = !!(wxPrecip && wxPrecip.checked) &&
               currentMapMode === '2d' && !!window._rainviewerTileUrl;
    if (_wxLayers.precip) {
        leafletMap.removeLayer(_wxLayers.precip);
        _wxLayers.precip = null;
    }
    if (want) {
        _wxLayers.precip = L.tileLayer(window._rainviewerTileUrl, { opacity: 0.55, zIndex: 250 });
        _wxLayers.precip.addTo(leafletMap);
    }
}
window.renderPrecipitation = renderPrecipitation;

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

// Reuse canvas across renders to avoid GC
var _waveHeatmapCanvas = null;
function _buildWaveHeatmapCanvas(points) {
    // IDW 보간 — 절반 해상도로 계산 후 업스케일 (4배 빠름, 시각적 차이 미미)
    var W = 360, H = 180;
    if (!_waveHeatmapCanvas) {
        _waveHeatmapCanvas = document.createElement('canvas');
    }
    var canvas = _waveHeatmapCanvas;
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

// ── Wind Speed Markers (말풍선 핀) ──

function _windSpeedColor(speed) {
    if (speed < 5) return '#60a5fa';
    if (speed < 10) return '#34d399';
    if (speed < 20) return '#fbbf24';
    return '#ef4444';
}

var _wxWindBillboards = null;   // 3D Cesium billboard collection
var _windBubbleCache = {};      // dataURL 캐시 (속도|방향 버킷)

function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// 풍속 알약(말풍선) + 풍향 화살표 핀을 캔버스로 생성. {url,w,h} 반환.
function _buildWindBubble(speed, dirDeg) {
    var sp = Math.round(speed);
    var dirB = Math.round(((dirDeg || 0) % 360) / 15) * 15;  // 15° 버킷
    var key = sp + '|' + dirB;
    if (_windBubbleCache[key]) return _windBubbleCache[key];

    var color = _windSpeedColor(speed);
    var S = 52, dpr = 2;
    var canvas = document.createElement('canvas');
    canvas.width = S * dpr; canvas.height = S * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    var cx = S / 2, cy = S / 2;

    // 풍향 화살표 — 바람이 불어가는 방향(from + 180°)을 가리킴
    var flow = (dirB + 180) * Math.PI / 180;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(flow);
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 2;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(0, -18);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -22);
    ctx.lineTo(-4, -15);
    ctx.lineTo(4, -15);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 알약 본체
    var pw = sp >= 100 ? 28 : (sp >= 10 ? 23 : 18), ph = 17;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
    _roundRect(ctx, cx - pw / 2, cy - ph / 2, pw, ph, ph / 2);
    ctx.fillStyle = 'rgba(15,23,42,0.86)';
    ctx.fill();
    ctx.restore();
    _roundRect(ctx, cx - pw / 2, cy - ph / 2, pw, ph, ph / 2);
    ctx.lineWidth = 1.5; ctx.strokeStyle = color; ctx.stroke();

    // 숫자
    ctx.fillStyle = '#fff';
    ctx.font = '700 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(sp), cx, cy + 0.5);

    var out = { url: canvas.toDataURL(), w: S, h: S };
    _windBubbleCache[key] = out;
    return out;
}

function _oceanWindPoints(points, marinePoints) {
    var oceanSet = null;
    if (marinePoints) {
        oceanSet = {};
        marinePoints.forEach(function(m) {
            if (m.wave_height && m.wave_height > 0) oceanSet[m.lat + ',' + m.lon] = true;
        });
    }
    return points.filter(function(p) {
        if (!(p.wind_speed > 0)) return false;
        if (oceanSet && !oceanSet[p.lat + ',' + p.lon]) return false;
        return true;
    });
}

function renderWindLabels(points, marinePoints) {
    clearWindLabels();
    var pts = _oceanWindPoints(points, marinePoints);

    // 3D Cesium — 빌보드 핀
    if (typeof viewer !== 'undefined' && viewer) {
        if (!_wxWindBillboards) {
            _wxWindBillboards = viewer.scene.primitives.add(new Cesium.BillboardCollection());
        }
        pts.forEach(function(p) {
            var bub = _buildWindBubble(p.wind_speed, p.wind_direction);
            _wxWindBillboards.add({
                position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
                image: bub.url,
                width: bub.w,
                height: bub.h,
                scaleByDistance: new Cesium.NearFarScalar(1.0e6, 1.0, 2.2e7, 0.5),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3.0e7)
            });
        });
    }

    // 2D Leaflet — 마커 핀
    if (typeof leafletMap !== 'undefined' && leafletMap && currentMapMode === '2d') {
        _wxLayers.wind = L.layerGroup();
        pts.forEach(function(p) {
            var bub = _buildWindBubble(p.wind_speed, p.wind_direction);
            var icon = L.icon({
                iconUrl: bub.url,
                iconSize: [bub.w, bub.h],
                iconAnchor: [bub.w / 2, bub.h / 2]
            });
            L.marker([p.lat, p.lon], { icon: icon, interactive: false, keyboard: false })
                .addTo(_wxLayers.wind);
        });
        _wxLayers.wind.addTo(leafletMap);
    }
}

function clearWindLabels() {
    if (_wxWindBillboards) _wxWindBillboards.removeAll();
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

var _WX_IDS = ['wx-precipitation', 'wx-wave-height', 'wx-wind'];

// 기상 = 단일 선택(라디오): 하나를 켜면 나머지는 끈다.
function _onWxToggle(e) {
    if (e.target.checked) {
        _WX_IDS.forEach(function(id) {
            if (id !== e.target.id) {
                var c = document.getElementById(id);
                if (c && c.checked) c.checked = false;
            }
        });
    }
    // 강수(cloudLayer) 표시는 wx-precipitation 체크 상태를 따른다
    if (typeof cloudLayer !== 'undefined' && cloudLayer) {
        var p = document.getElementById('wx-precipitation');
        cloudLayer.show = !!(p && p.checked);
        if (cloudLayer.show && typeof viewer !== 'undefined') viewer.imageryLayers.raiseToTop(cloudLayer);
    }
    renderWeatherOverlays();
}

document.addEventListener('DOMContentLoaded', function() {
    _WX_IDS.forEach(function(id) {
        var cb = document.getElementById(id);
        if (cb) cb.addEventListener('change', _onWxToggle);
    });

    // 초기 fetch + 10분 주기 갱신
    fetchWeatherData();
    _wxInterval = setInterval(fetchWeatherData, 10 * 60 * 1000);
});
