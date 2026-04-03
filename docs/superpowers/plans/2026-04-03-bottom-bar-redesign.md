# Bottom Bar Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the bottom status bar with treemap, area sparkline, merged wind/wave, country distribution, and density heatmap cards — moving latency to the header.

**Architecture:** Replace 5 existing stat cards with 5 new ones. Pure HTML/CSS treemap replaces ECharts donut. SVG area sparkline with circular buffer for risk trends. Two new data-driven cards (FLAG, DENSITY) added. Latency moves to header. All rendering stays in `sparkline.js`.

**Tech Stack:** Vanilla JS, SVG, CSS Grid/Flexbox

---

### Task 1: Move LATENCY to Header

**Files:**
- Modify: `static/index.html:44-56` (header), `static/index.html:388-394` (remove statLatency)
- Modify: `static/css/main.css:388-391` (remove stat-card-status)
- Modify: `static/js/websocket.js:439` (latency target ID)
- Modify: `static/js/websocket.js:536-540` (WS LED target ID)
- Modify: `static/js/ui-controls.js:17-23` (setWsStatus target ID)

- [ ] **Step 1: Add latency indicator to header HTML**

In `static/index.html`, replace the `header-stats` div (lines 51-55):

```html
<div class="header-stats">
    <div class="header-clock">
        <span id="headerUtcClock">--:--:-- UTC</span>
    </div>
    <div class="header-latency">
        <div class="ws-led connected" id="headerWsLed"></div>
        <span class="header-latency-value" id="headerLatency">--<span class="stat-card-unit">ms</span></span>
    </div>
</div>
```

- [ ] **Step 2: Remove statLatency card from bottom bar HTML**

In `static/index.html`, remove lines 388-394 (the entire `statLatency` div):

```html
<!-- DELETE THIS BLOCK -->
<div class="stat-card stat-card-status" id="statLatency">
    <div class="ws-led connected" id="bottomWsLed"></div>
    <div class="stat-card-info">
        <span class="stat-card-label">LATENCY</span>
        <span class="stat-card-value" id="bottomLatency">--<span class="stat-card-unit">ms</span></span>
    </div>
</div>
```

- [ ] **Step 3: Add header-latency CSS**

In `static/css/main.css`, add after existing header styles:

```css
.header-latency {
    display: flex;
    align-items: center;
    gap: 4px;
}

.header-latency-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.6rem;
    color: var(--text-dim);
}
```

- [ ] **Step 4: Remove stat-card-status CSS**

In `static/css/main.css`, remove lines 388-391:

```css
/* DELETE */
.stat-card-status {
    flex: 0 0 auto;
    gap: 6px;
}
```

- [ ] **Step 5: Update JS references from bottom → header**

In `static/js/websocket.js` line 439, change:
```js
// FROM:
BottomBar.updateValue('bottomLatency', latency);
// TO:
BottomBar.updateValue('headerLatency', latency);
```

In `static/js/websocket.js` lines 536-537, change:
```js
// FROM:
var led = document.getElementById('bottomWsLed');
// TO:
var led = document.getElementById('headerWsLed');
```

In `static/js/ui-controls.js` line 18, change:
```js
// FROM:
var led = document.getElementById('bottomWsLed');
// TO:
var led = document.getElementById('headerWsLed');
```

- [ ] **Step 6: Verify visually**

Run the app and confirm:
- Header shows UTC clock + green LED + latency value
- Bottom bar has 4 cards (VESSELS, RISK, WIND, WAVE) — no LATENCY

- [ ] **Step 7: Commit**

```bash
git add static/index.html static/css/main.css static/js/websocket.js static/js/ui-controls.js
git commit -m "refactor(bottom-bar): move LATENCY indicator to header"
```

---

### Task 2: VESSELS — Donut → Treemap

**Files:**
- Modify: `static/index.html:359-366` (statVessels card HTML)
- Modify: `static/css/main.css:344-380` (remove donut CSS, add treemap CSS)
- Modify: `static/js/sparkline.js:55-122` (replace donut logic with treemap renderer)

- [ ] **Step 1: Replace VESSELS card HTML**

In `static/index.html`, replace the `statVessels` div (lines 359-366):

```html
<div class="stat-card stat-card-bar" id="statVessels">
    <div class="stat-card-info">
        <span class="stat-card-label">VESSELS</span>
        <span class="stat-card-value" id="bottomVessels">0</span>
    </div>
    <div class="vessel-treemap" id="vesselTreemap"></div>
</div>
```

- [ ] **Step 2: Replace donut CSS with treemap CSS**

In `static/css/main.css`, remove the donut-related CSS (lines 344-380: `.stat-card-donut`, `.donut-legend`, `.donut-legend-item`, `.donut-legend-dot`, `.donut-legend-count`) and replace with:

```css
.vessel-treemap {
    flex: 1;
    display: flex;
    gap: 2px;
    height: 34px;
    min-width: 0;
}

.treemap-cell {
    border-radius: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.35rem;
    color: rgba(255, 255, 255, 0.8);
    overflow: hidden;
    min-width: 0;
}
```

- [ ] **Step 3: Replace donut logic with treemap renderer in sparkline.js**

In `static/js/sparkline.js`, remove functions `initDonut` (lines 55-59), `setDonutData` (lines 61-76). Replace `updateVesselTypes` (lines 78-122) with:

```js
function updateVesselTypes(counts) {
    vesselCounts = counts;
    var container = document.getElementById('vesselTreemap');
    if (!container) return;

    var defaultColors = {
        cargo: '#3b82f6', tanker: '#f97316', passenger: '#a855f7',
        fishing: '#10b981', military: '#ef4444', tug: '#06b6d4', other: '#6b7280'
    };
    var types = ['cargo', 'tanker', 'passenger', 'fishing', 'military', 'tug', 'other'];

    var items = [];
    var total = 0;
    types.forEach(function(t) {
        var v = counts[t] || 0;
        if (t === 'other') v += (counts.yacht || 0);
        total += v;
        if (v > 0) {
            var c = (typeof SHIP_COLORS !== 'undefined' && SHIP_COLORS[t]) || defaultColors[t];
            items.push({ type: t, count: v, color: c });
        }
    });
    if (total === 0) { container.innerHTML = ''; return; }

    // Sort descending by count for treemap layout
    items.sort(function(a, b) { return b.count - a.count; });

    var html = '';
    items.forEach(function(item) {
        var flex = (item.count / total * 10).toFixed(2);
        var label = item.count >= 5 ? item.count : '';
        html += '<div class="treemap-cell" style="flex:' + flex + ';background:' + item.color + ';">' + label + '</div>';
    });
    container.innerHTML = html;
}
```

Also remove the `vesselDonut` variable declaration (line 16) and replace with nothing (it's no longer used).

- [ ] **Step 4: Verify visually**

Run the app and confirm:
- VESSELS card shows colored treemap blocks proportional to ship type counts
- Numbers show on blocks with ≥5 ships
- Colors match SHIP_COLORS

- [ ] **Step 5: Commit**

```bash
git add static/index.html static/css/main.css static/js/sparkline.js
git commit -m "feat(bottom-bar): replace VESSELS donut chart with CSS treemap"
```

---

### Task 3: RISK — Vertical Bars → Area Sparkline

**Files:**
- Modify: `static/index.html:367-373` (statRisk card HTML)
- Modify: `static/js/sparkline.js` (add risk history buffer, area sparkline renderer, update `updateRiskLevels`)
- Modify: `static/css/main.css` (add risk sparkline styles)

- [ ] **Step 1: Update RISK card HTML**

In `static/index.html`, replace the `statRisk` div (lines 367-373):

```html
<div class="stat-card stat-card-bar" id="statRisk">
    <div class="stat-card-info">
        <span class="stat-card-label">RISK</span>
        <span class="stat-card-value stat-card-value-risk" id="bottomRisk">0</span>
    </div>
    <div class="risk-sparkline-wrap" id="riskSparklineWrap">
        <svg class="risk-sparkline" id="riskSparkline" viewBox="0 0 80 30" preserveAspectRatio="none"></svg>
    </div>
</div>
```

- [ ] **Step 2: Add risk sparkline CSS**

In `static/css/main.css`, add:

```css
.stat-card-value-risk {
    color: #f43f5e;
}

.risk-sparkline-wrap {
    flex: 1;
    height: 30px;
    min-width: 0;
}

.risk-sparkline {
    width: 100%;
    height: 100%;
}
```

- [ ] **Step 3: Add risk history buffer and area sparkline to sparkline.js**

In `static/js/sparkline.js`, add a risk history buffer after the existing `buffers` declaration:

```js
// Risk total history (circular buffer, 60 entries ≈ 10 min at 10s interval)
var riskHistory = [];
var RISK_HISTORY_MAX = 60;
```

Replace the `updateRiskLevels` function with:

```js
function updateRiskLevels(danger, warning, caution) {
    riskCounts = { danger: danger, warning: warning, caution: caution };
    var total = danger + warning + caution;

    // Push to history buffer
    riskHistory.push(total);
    if (riskHistory.length > RISK_HISTORY_MAX) riskHistory.shift();

    // Update value display
    var valEl = document.getElementById('bottomRisk');
    if (valEl) {
        var unit = valEl.querySelector('.stat-card-unit');
        var unitText = unit ? unit.outerHTML : '';
        valEl.innerHTML = total + unitText;
    }

    // Render area sparkline
    var svg = document.getElementById('riskSparkline');
    if (!svg || riskHistory.length < 2) return;

    var data = riskHistory;
    var w = 80, h = 30;
    var max = Math.max.apply(null, data);
    if (max === 0) max = 1;

    var points = data.map(function(v, i) {
        var x = (i / (data.length - 1)) * w;
        var y = h - (v / max) * (h - 4) - 2;
        return x.toFixed(1) + ',' + y.toFixed(1);
    });

    var pathD = 'M' + points.join(' L');
    var fillD = pathD + ' L' + w + ',' + h + ' L0,' + h + 'Z';

    // Trend detection: compare last 10 vs previous 10
    var recent = data.slice(-10);
    var prior = data.slice(-20, -10);
    var recentAvg = recent.reduce(function(s, v) { return s + v; }, 0) / recent.length;
    var priorAvg = prior.length > 0 ? prior.reduce(function(s, v) { return s + v; }, 0) / prior.length : recentAvg;
    var increasing = recentAvg > priorAvg;
    var strokeColor = increasing ? '#f43f5e' : '#10b981';
    var fillColor = increasing ? '#f43f5e' : '#10b981';

    svg.innerHTML =
        '<defs><linearGradient id="rg-risk" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + fillColor + '" stop-opacity="0.3"/>' +
        '<stop offset="100%" stop-color="' + fillColor + '" stop-opacity="0"/>' +
        '</linearGradient></defs>' +
        '<path d="' + fillD + '" fill="url(#rg-risk)"/>' +
        '<path d="' + pathD + '" fill="none" stroke="' + strokeColor + '" stroke-width="1.5"/>';
}
```

- [ ] **Step 4: Remove old risk bar CSS if any**

In `static/css/main.css`, check for `.risk-bar-wrap` and `.mini-bar` styles. If present, remove them (they were rendered inline so may not exist in CSS).

- [ ] **Step 5: Verify visually**

Run the app and confirm:
- RISK card shows current total on left, area sparkline on right
- Sparkline is red when trending up, green when trending down
- Fills over time as data arrives

- [ ] **Step 6: Commit**

```bash
git add static/index.html static/css/main.css static/js/sparkline.js
git commit -m "feat(bottom-bar): replace RISK vertical bars with area sparkline"
```

---

### Task 4: WIND · WAVE — Merge into One Card

**Files:**
- Modify: `static/index.html:374-387` (replace statWind + statWave with merged card)
- Modify: `static/css/main.css` (add merged card styles)

- [ ] **Step 1: Replace WIND and WAVE cards with merged card**

In `static/index.html`, replace both `statWind` and `statWave` divs (lines 374-387):

```html
<div class="stat-card stat-card-compact" id="statWindWave">
    <div class="wind-wave-row">
        <span class="stat-card-label">WIND</span>
        <span class="stat-card-value" id="bottomWind">--<span class="stat-card-unit">kt</span></span>
    </div>
    <div class="wind-wave-divider"></div>
    <div class="wind-wave-row">
        <span class="stat-card-label">WAVE</span>
        <span class="stat-card-value" id="bottomWave">--<span class="stat-card-unit">m</span></span>
    </div>
</div>
```

- [ ] **Step 2: Add merged card CSS**

In `static/css/main.css`, add:

```css
.stat-card-compact {
    flex: 0.7;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
}

.wind-wave-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
}

.wind-wave-row .stat-card-value {
    font-size: 0.8rem;
}

.wind-wave-divider {
    height: 1px;
    background: rgba(148, 163, 184, 0.1);
}
```

- [ ] **Step 3: Verify visually**

Run the app and confirm:
- Single card with WIND on top, thin divider, WAVE on bottom
- Values right-aligned, labels left-aligned
- Card is narrower than before (flex: 0.7)

- [ ] **Step 4: Commit**

```bash
git add static/index.html static/css/main.css
git commit -m "feat(bottom-bar): merge WIND and WAVE into single compact card"
```

---

### Task 5: FLAG — Country Distribution Top 5 Bar (New)

**Files:**
- Modify: `static/index.html` (add FLAG card after wind/wave)
- Modify: `static/css/main.css` (add flag bar styles)
- Modify: `static/js/sparkline.js` (add `updateFlagDistribution` function)
- Modify: `static/js/websocket.js` (call flag update in ships_update handler)

- [ ] **Step 1: Add FLAG card HTML**

In `static/index.html`, add after the merged wind/wave card (before `</div><!-- bottomBar -->`):

```html
<div class="stat-card stat-card-bar" id="statFlag">
    <div class="stat-card-info">
        <span class="stat-card-label">FLAG</span>
        <span class="stat-card-value" id="bottomFlagCount">0</span>
    </div>
    <div class="flag-bars" id="flagBars"></div>
</div>
```

- [ ] **Step 2: Add FLAG bar CSS**

In `static/css/main.css`, add:

```css
.flag-bars {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    justify-content: center;
    min-width: 0;
}

.flag-row {
    display: flex;
    align-items: center;
    gap: 3px;
}

.flag-code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.35rem;
    color: var(--text-dim);
    width: 14px;
    flex-shrink: 0;
}

.flag-bar-bg {
    height: 4px;
    flex: 1;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 2px;
    overflow: hidden;
    min-width: 0;
}

.flag-bar-fill {
    height: 100%;
    border-radius: 2px;
}

.flag-count {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.35rem;
    color: var(--text-dim);
    min-width: 12px;
    text-align: right;
}
```

- [ ] **Step 3: Add updateFlagDistribution to sparkline.js**

In `static/js/sparkline.js`, add before the `return` statement:

```js
var FLAG_BAR_COLORS = ['#406FD8', '#5b8ce8', '#7ba3ff', '#9bb8ff', '#b8cdff'];

function updateFlagDistribution(vessels) {
    var container = document.getElementById('flagBars');
    var countEl = document.getElementById('bottomFlagCount');
    if (!container) return;

    // Count by country
    var countryMap = {};
    var uniqueCountries = 0;
    vessels.forEach(function(v) {
        var c = v.country || v.flag || '';
        if (!c) return;
        if (!countryMap[c]) { countryMap[c] = 0; uniqueCountries++; }
        countryMap[c]++;
    });

    if (countEl) countEl.textContent = uniqueCountries;

    // Sort and take top 5
    var sorted = Object.keys(countryMap).map(function(k) {
        return { code: k, count: countryMap[k] };
    }).sort(function(a, b) { return b.count - a.count; }).slice(0, 5);

    if (sorted.length === 0) { container.innerHTML = ''; return; }

    var maxCount = sorted[0].count;
    var html = '';
    sorted.forEach(function(item, i) {
        var pct = (item.count / maxCount * 100).toFixed(0);
        var color = FLAG_BAR_COLORS[i] || FLAG_BAR_COLORS[4];
        html += '<div class="flag-row">' +
            '<span class="flag-code">' + item.code + '</span>' +
            '<div class="flag-bar-bg"><div class="flag-bar-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>' +
            '<span class="flag-count">' + item.count + '</span>' +
            '</div>';
    });
    container.innerHTML = html;
}
```

Add `updateFlagDistribution` to the return object.

- [ ] **Step 4: Call updateFlagDistribution from WebSocket handler**

In `static/js/websocket.js`, inside the `ships_update` handler, after `BottomBar.updateVesselTypes(typeCounts);` (around line 493), add:

```js
BottomBar.updateFlagDistribution(_lastShipsData);
```

- [ ] **Step 5: Verify visually**

Run the app and confirm:
- FLAG card shows unique country count on left
- Top 5 countries displayed as horizontal bars with 2-letter codes
- Blue gradient from darkest (1st) to lightest (5th)

- [ ] **Step 6: Commit**

```bash
git add static/index.html static/css/main.css static/js/sparkline.js static/js/websocket.js
git commit -m "feat(bottom-bar): add FLAG country distribution Top 5 bar card"
```

---

### Task 6: DENSITY — 5x5 Heatmap Grid (New)

**Files:**
- Modify: `static/index.html` (add DENSITY card)
- Modify: `static/css/main.css` (add density grid styles)
- Modify: `static/js/sparkline.js` (add `updateDensityGrid` function)
- Modify: `static/js/websocket.js` (call density update in ships_update handler)

- [ ] **Step 1: Add DENSITY card HTML**

In `static/index.html`, add after the FLAG card (before `</div><!-- bottomBar -->`):

```html
<div class="stat-card stat-card-density" id="statDensity">
    <div class="stat-card-info">
        <span class="stat-card-label">DENSITY</span>
        <span class="stat-card-sublabel">5×5</span>
    </div>
    <div class="density-grid" id="densityGrid"></div>
</div>
```

- [ ] **Step 2: Add density grid CSS**

In `static/css/main.css`, add:

```css
.stat-card-density {
    flex: 0.8;
}

.stat-card-sublabel {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-dim);
}

.density-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 1px;
    flex: 1;
    height: 32px;
    min-width: 0;
}

.density-cell {
    border-radius: 1px;
    min-width: 0;
}
```

- [ ] **Step 3: Add updateDensityGrid to sparkline.js**

In `static/js/sparkline.js`, add before the `return` statement:

```js
function updateDensityGrid(vessels, viewBounds) {
    var container = document.getElementById('densityGrid');
    if (!container) return;

    var ROWS = 5, COLS = 5;
    var grid = [];
    for (var i = 0; i < ROWS * COLS; i++) grid[i] = 0;

    if (!viewBounds || !viewBounds.west) {
        container.innerHTML = '';
        return;
    }

    var west = viewBounds.west, east = viewBounds.east;
    var south = viewBounds.south, north = viewBounds.north;
    var lonRange = east - west;
    var latRange = north - south;
    if (lonRange <= 0 || latRange <= 0) return;

    vessels.forEach(function(v) {
        if (v.lng < west || v.lng > east || v.lat < south || v.lat > north) return;
        var col = Math.min(Math.floor((v.lng - west) / lonRange * COLS), COLS - 1);
        var row = Math.min(Math.floor((north - v.lat) / latRange * ROWS), ROWS - 1);
        grid[row * COLS + col]++;
    });

    var maxDensity = Math.max.apply(null, grid);
    if (maxDensity === 0) maxDensity = 1;

    var html = '';
    for (var i = 0; i < ROWS * COLS; i++) {
        var ratio = grid[i] / maxDensity;
        var color, opacity;
        if (ratio > 0.7) {
            color = '244,63,94';   // red for high density
            opacity = 0.3 + ratio * 0.6;
        } else if (ratio > 0.4) {
            color = '249,115,22';  // orange for medium
            opacity = 0.2 + ratio * 0.5;
        } else {
            color = '64,111,216'; // blue for low
            opacity = ratio * 0.5;
        }
        html += '<div class="density-cell" style="background:rgba(' + color + ',' + opacity.toFixed(2) + ');"></div>';
    }
    container.innerHTML = html;
}
```

Add `updateDensityGrid` to the return object.

- [ ] **Step 4: Call updateDensityGrid from WebSocket handler**

In `static/js/websocket.js`, after the `BottomBar.updateFlagDistribution` call, add:

```js
// Density grid from current viewport
var viewBounds = null;
if (typeof viewer !== 'undefined' && viewer.camera) {
    var rect = viewer.camera.computeViewRectangle();
    if (rect) {
        viewBounds = {
            west: Cesium.Math.toDegrees(rect.west),
            east: Cesium.Math.toDegrees(rect.east),
            south: Cesium.Math.toDegrees(rect.south),
            north: Cesium.Math.toDegrees(rect.north)
        };
    }
}
if (typeof leafletMap !== 'undefined' && leafletMap && currentMapMode === '2d') {
    var b = leafletMap.getBounds();
    viewBounds = {
        west: b.getWest(), east: b.getEast(),
        south: b.getSouth(), north: b.getNorth()
    };
}
BottomBar.updateDensityGrid(_lastShipsData, viewBounds);
```

- [ ] **Step 5: Verify visually**

Run the app and confirm:
- DENSITY card shows "5×5" sublabel and 25-cell grid
- High-density cells are red, medium orange, low blue
- Grid updates when ships data arrives

- [ ] **Step 6: Commit**

```bash
git add static/index.html static/css/main.css static/js/sparkline.js static/js/websocket.js
git commit -m "feat(bottom-bar): add DENSITY 5x5 heatmap grid card"
```

---

### Task 7: Final Cleanup and Integration Check

**Files:**
- Modify: `static/js/sparkline.js` (verify return object exports all new functions)
- Modify: `static/css/main.css` (remove unused styles: `.stat-card-loc`, old risk bar classes)

- [ ] **Step 1: Clean up sparkline.js exports**

Verify the return object at the end of `sparkline.js` includes all functions:

```js
return {
    pushData: pushData,
    updateVesselTypes: updateVesselTypes,
    updateRiskLevels: updateRiskLevels,
    updateValue: updateValue,
    updateFlagDistribution: updateFlagDistribution,
    updateDensityGrid: updateDensityGrid
};
```

- [ ] **Step 2: Remove unused CSS**

In `static/css/main.css`, remove `.stat-card-loc` styles (lines 325-333) since wind/wave no longer show location text.

- [ ] **Step 3: Remove unused sparkline.js code**

Remove the `renderSparkline` function's satellite/wind/wave buffers if they're no longer used by any caller. Check for `pushData` calls — if `satellite.js` still uses `pushData('satellites', ...)`, keep the buffer infrastructure. Only remove buffers for `wind` and `wave` since those cards no longer have sparklines.

- [ ] **Step 4: Full visual verification**

Run the app and verify the complete bottom bar:
```
[VESSELS treemap] [RISK sparkline] [WIND·WAVE merged] [FLAG Top5] [DENSITY 5×5]
```

And header shows: `MARITIME OSINT SENTRY | ... | 14:32:07 UTC ● 42ms`

- [ ] **Step 5: Commit**

```bash
git add static/js/sparkline.js static/css/main.css
git commit -m "chore(bottom-bar): clean up unused donut/latency styles and buffers"
```
