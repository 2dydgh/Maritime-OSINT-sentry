// ── Maritime Weather Overlay ──

var _wxData = { marine: null, wind: null };
var _wxLayers = { waveHeight: null, wind: null };
var _wxInterval = null;

// Cesium primitives
var _wxWavePoints = null;   // PointPrimitiveCollection
var _wxWindBillboards = null; // BillboardCollection

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
        renderWindArrows(_wxData.wind.points);
    } else {
        clearWindArrows();
    }

    updateWxLegend();
}

// ── Wave Height ──

function waveHeightColor(h) {
    // 0m=파랑, 1m=초록, 2m=노랑, 3m=주황, 5m+=빨강
    if (h <= 0.5) return { r: 0.1, g: 0.4, b: 0.8, a: 0.6 };
    if (h <= 1.0) return { r: 0.1, g: 0.7, b: 0.5, a: 0.65 };
    if (h <= 2.0) return { r: 0.9, g: 0.8, b: 0.1, a: 0.7 };
    if (h <= 3.0) return { r: 0.95, g: 0.5, b: 0.1, a: 0.75 };
    return { r: 0.95, g: 0.2, b: 0.2, a: 0.8 };
}

function renderWaveHeight(points) {
    clearWaveHeight();

    if (typeof viewer === 'undefined' || !viewer) return;

    _wxWavePoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());

    points.forEach(function(p) {
        if (p.wave_height <= 0) return;
        var c = waveHeightColor(p.wave_height);
        _wxWavePoints.add({
            position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
            pixelSize: Math.max(12, Math.min(30, p.wave_height * 8)),
            color: new Cesium.Color(c.r, c.g, c.b, c.a),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        });
    });

    // 2D Leaflet 오버레이
    if (typeof leafletMap !== 'undefined' && leafletMap && currentMapMode === '2d') {
        _wxLayers.waveHeight = L.layerGroup();
        points.forEach(function(p) {
            if (p.wave_height <= 0) return;
            var c = waveHeightColor(p.wave_height);
            var color = 'rgba(' + Math.round(c.r*255) + ',' + Math.round(c.g*255) + ',' + Math.round(c.b*255) + ',' + c.a + ')';
            L.circleMarker([p.lat, p.lon], {
                radius: Math.max(8, Math.min(20, p.wave_height * 5)),
                fillColor: color,
                fillOpacity: c.a,
                stroke: false
            }).bindTooltip(p.wave_height.toFixed(1) + 'm', { className: 'ship-tooltip-2d' })
              .addTo(_wxLayers.waveHeight);
        });
        _wxLayers.waveHeight.addTo(leafletMap);
    }
}

function clearWaveHeight() {
    if (_wxWavePoints && typeof viewer !== 'undefined' && viewer) {
        viewer.scene.primitives.remove(_wxWavePoints);
        _wxWavePoints = null;
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

function renderWindArrows(points) {
    clearWindArrows();

    if (typeof viewer === 'undefined' || !viewer) return;

    _wxWindBillboards = viewer.scene.primitives.add(new Cesium.BillboardCollection());

    points.forEach(function(p) {
        if (p.wind_speed <= 0) return;
        var canvas = _createWindArrowCanvas(p.wind_speed, p.wind_direction);
        _wxWindBillboards.add({
            position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 50000),
            image: canvas,
            width: 32,
            height: 32,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        });
    });

    // 2D Leaflet
    if (typeof leafletMap !== 'undefined' && leafletMap && currentMapMode === '2d') {
        _wxLayers.wind = L.layerGroup();
        points.forEach(function(p) {
            if (p.wind_speed <= 0) return;
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
    if (_wxWindBillboards && typeof viewer !== 'undefined' && viewer) {
        viewer.scene.primitives.remove(_wxWindBillboards);
        _wxWindBillboards = null;
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
