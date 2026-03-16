# Timeline UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered timeline UI elements with a unified bottom control bar containing mode toggle, playback controls, speed indicator, and time display.

**Architecture:** CSS-hide the Cesium animation widget, reposition the Cesium timeline bar, add a custom glassmorphism control bar to its left. Rewire existing `setTimeMode()` and clock tick handlers to new DOM elements. No backend changes.

**Tech Stack:** CesiumJS 1.114, vanilla JS/CSS

---

## File Structure

All changes in a single file:
- **Modify:** `static/index.html`
  - CSS: remove old styles, add new control bar styles, update Cesium overrides (~60 lines changed)
  - HTML: remove old elements, add `#timeControlBar` (~20 lines changed)
  - JS: add playback handlers, update `setTimeMode()`, update clock tick listener (~40 lines changed)

No new files. No backend changes.

---

## Chunk 1: CSS & HTML restructure

### Task 1: Remove old CSS and add new control bar styles

**Files:**
- Modify: `static/index.html:259-274` (Cesium overrides)
- Modify: `static/index.html:538-601` (mode-toggle, history-indicator CSS)

- [ ] **Step 1: Update Cesium widget CSS overrides**

Replace lines 259-274 (the `.cesium-viewer-timelineContainer` and `.cesium-viewer-animationContainer` blocks):

Old:
```css
.cesium-viewer-timelineContainer {
    z-index: 10;
    bottom: 25px !important;
    left: 580px !important;
    right: 20px !important;
    width: auto !important;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--panel-border);
}

.cesium-viewer-animationContainer {
    z-index: 10;
    bottom: 20px !important;
    left: 390px !important;
}
```

New:
```css
.cesium-viewer-timelineContainer {
    z-index: 10;
    bottom: 25px !important;
    left: 480px !important;
    right: 20px !important;
    width: auto !important;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--panel-border);
}

.cesium-viewer-animationContainer {
    display: none !important;
}
```

- [ ] **Step 2: Remove old mode-toggle, mode-btn, and history-indicator CSS**

Delete the following CSS blocks (lines ~538-601):
- `.mode-toggle` (lines 538-543)
- `.mode-btn` (lines 545-558)
- `.mode-btn.active` (lines 560-564)
- `.mode-btn:hover:not(.active)` (lines 566-568)
- `.mode-btn.history-mode.active` (lines 570-574)
- `.history-indicator` (lines 577-591)
- `.history-indicator.visible` (lines 593-597)
- `.history-indicator i` (lines 599-601)

- [ ] **Step 3: Add `#timeControlBar` CSS**

Insert in the same CSS location where the old blocks were removed:

```css
/* Time Control Bar */
#timeControlBar {
    position: fixed;
    bottom: 25px;
    left: 20px;
    display: flex;
    align-items: center;
    gap: 2px;
    background: var(--panel-bg);
    backdrop-filter: blur(12px);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 6px 10px;
    z-index: 10;
    transition: border-color 0.3s;
    min-width: 440px;
}

#timeControlBar.history-active {
    border-color: rgba(168, 85, 247, 0.3);
}

.tcb-divider {
    width: 1px;
    height: 24px;
    background: var(--panel-border);
    margin: 0 8px;
    transition: background 0.3s;
}

#timeControlBar.history-active .tcb-divider {
    background: rgba(168, 85, 247, 0.3);
}

/* TCB Mode Buttons */
.tcb-mode-btn {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--panel-border);
    color: var(--text-dim);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-family: 'Inter', sans-serif;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 5px;
}

.tcb-mode-btn.active {
    background: rgba(56, 189, 248, 0.2);
    border-color: var(--accent-cyan);
    color: var(--accent-cyan);
}

.tcb-mode-btn.history.active {
    background: rgba(168, 85, 247, 0.2);
    border-color: #a855f7;
    color: #a855f7;
}

.tcb-mode-btn:hover:not(.active) {
    background: rgba(56, 189, 248, 0.1);
}

/* TCB Playback Buttons */
.tcb-play-btn {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--panel-border);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text-dim);
    font-size: 0.7rem;
    transition: all 0.2s;
}

.tcb-play-btn.main {
    width: 34px;
    height: 34px;
    font-size: 0.85rem;
}

.tcb-play-btn:disabled {
    opacity: 0.3;
    cursor: default;
    pointer-events: none;
}

.tcb-play-btn.enabled {
    color: #a855f7;
    border-color: rgba(168, 85, 247, 0.25);
    background: rgba(168, 85, 247, 0.1);
}

.tcb-play-btn.enabled:hover {
    background: rgba(168, 85, 247, 0.2);
}

.tcb-play-btn.enabled.main {
    border-color: rgba(168, 85, 247, 0.4);
    background: rgba(168, 85, 247, 0.2);
}

.tcb-play-btn.enabled.active-reverse {
    background: rgba(168, 85, 247, 0.3);
    border-color: #a855f7;
}

#tcb-speed {
    color: var(--text-dim);
    font-size: 0.72rem;
    font-family: 'JetBrains Mono', monospace;
    min-width: 36px;
    text-align: center;
    transition: color 0.3s;
}

#tcb-speed.active {
    color: #a855f7;
    font-weight: 700;
}

#tcb-time-display {
    color: var(--accent-cyan);
    font-size: 0.78rem;
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.03em;
    transition: color 0.3s;
    white-space: nowrap;
}

#tcb-time-display.history {
    color: #a855f7;
}
```

- [ ] **Step 4: Commit**

```bash
git add static/index.html
git commit -m "style: add time control bar CSS, hide Cesium animation widget"
```

---

### Task 2: Update HTML — remove old elements, add control bar

**Files:**
- Modify: `static/index.html:617-646` (header + history indicator)

- [ ] **Step 1: Remove mode-toggle and UTC clock from header**

Remove the `mode-toggle` div (lines 618-626) and the UTC CLOCK stat-item (lines 635-638) from the header. Keep Events and Assets stat-items.

The header `header-stats` div should become:
```html
        <div class="header-stats">
            <div class="stat-item">
                <span class="stat-value" id="stat-events">0</span>
                <span class="stat-label">Active Events</span>
            </div>
            <div class="stat-item">
                <span class="stat-value" id="stat-assets">7</span>
                <span class="stat-label">Tracked Assets</span>
            </div>
        </div>
```

- [ ] **Step 2: Remove history indicator**

Delete the `#historyIndicator` div (lines 642-646):
```html
    <!-- History Mode Indicator -->
    <div id="historyIndicator" class="history-indicator">
        <i class="fa-solid fa-clock-rotate-left"></i>
        <span id="historyTimeDisplay">--</span>
    </div>
```

- [ ] **Step 3: Add `#timeControlBar` HTML**

Insert before the closing `</body>` tag (before `<script>`), right after the `#loading` div:

```html
    <!-- Time Control Bar -->
    <div id="timeControlBar">
        <div style="display:flex;gap:3px;margin-right:2px;">
            <button id="tcb-btn-live" class="tcb-mode-btn active">
                <i class="fa-solid fa-broadcast-tower"></i> LIVE
            </button>
            <button id="tcb-btn-history" class="tcb-mode-btn history">
                <i class="fa-solid fa-clock-rotate-left"></i> HISTORY
            </button>
        </div>
        <div class="tcb-divider"></div>
        <div style="display:flex;align-items:center;gap:6px;">
            <button id="tcb-reverse" class="tcb-play-btn" disabled title="Reverse">
                <i class="fa-solid fa-backward"></i>
            </button>
            <button id="tcb-playpause" class="tcb-play-btn main" disabled title="Play/Pause">
                <i class="fa-solid fa-play" id="tcb-playpause-icon"></i>
            </button>
            <button id="tcb-ff" class="tcb-play-btn" disabled title="Speed Up">
                <i class="fa-solid fa-forward"></i>
            </button>
        </div>
        <div class="tcb-divider"></div>
        <span id="tcb-speed">1x</span>
        <div class="tcb-divider"></div>
        <span id="tcb-time-display">--:--:-- Z</span>
    </div>
```

- [ ] **Step 4: Commit**

```bash
git add static/index.html
git commit -m "feat: add time control bar HTML, remove old header controls"
```

---

## Chunk 2: JavaScript wiring

### Task 3: Add playback control handlers and speed cycling

**Files:**
- Modify: `static/index.html` — insert after `updateClock()` function (line ~837)

- [ ] **Step 1: Add playback state and handlers**

Replace the `updateClock` block (lines 832-837):

Old:
```javascript
function updateClock() {
    const now = new Date();
    document.getElementById('stat-time').textContent = now.toISOString().substring(11, 19) + " Z";
}
setInterval(updateClock, 1000);
updateClock();
```

New:
```javascript
// ── Time Control Bar Logic ───────────────────────────────────────────
const SPEED_STEPS = [1, 10, 60, 300, 600];
let currentSpeedIndex = 2; // default 60x
let _lastPlayingState = null;
let _lastReverseState = null;

function updateClock() {
    if (timeMode !== 'live') return; // guard: don't overwrite history time display
    const now = new Date();
    document.getElementById('tcb-time-display').textContent = now.toISOString().substring(11, 19) + " Z";
}
setInterval(updateClock, 1000);
updateClock();

function updatePlaybackUI() {
    const playing = viewer.clock.shouldAnimate;
    const isReverse = viewer.clock.multiplier < 0;

    // Skip DOM updates if state hasn't changed (called on every tick)
    if (playing === _lastPlayingState && isReverse === _lastReverseState) return;
    _lastPlayingState = playing;
    _lastReverseState = isReverse;

    const icon = document.getElementById('tcb-playpause-icon');
    icon.className = playing ? 'fa-solid fa-pause' : 'fa-solid fa-play';

    const reverseBtn = document.getElementById('tcb-reverse');
    if (isReverse) {
        reverseBtn.classList.add('active-reverse');
    } else {
        reverseBtn.classList.remove('active-reverse');
    }

    const speed = Math.abs(viewer.clock.multiplier);
    document.getElementById('tcb-speed').textContent = speed + 'x';
}

function enablePlaybackButtons(enabled) {
    const btns = ['tcb-reverse', 'tcb-playpause', 'tcb-ff'];
    btns.forEach(id => {
        const btn = document.getElementById(id);
        if (enabled) {
            btn.disabled = false;
            btn.classList.add('enabled');
        } else {
            btn.disabled = true;
            btn.classList.remove('enabled', 'active-reverse');
        }
    });
    if (enabled) {
        document.getElementById('tcb-speed').classList.add('active');
    } else {
        document.getElementById('tcb-speed').classList.remove('active');
        document.getElementById('tcb-speed').textContent = '1x';
    }
}

function forceUpdatePlaybackUI() {
    _lastPlayingState = null; // reset cache to force DOM update
    _lastReverseState = null;
    updatePlaybackUI();
}

// Play/Pause
document.getElementById('tcb-playpause').addEventListener('click', () => {
    viewer.clock.shouldAnimate = !viewer.clock.shouldAnimate;
    forceUpdatePlaybackUI();
});

// Reverse toggle
document.getElementById('tcb-reverse').addEventListener('click', () => {
    const m = viewer.clock.multiplier;
    viewer.clock.multiplier = m < 0 ? Math.abs(m) : -Math.abs(m);
    if (!viewer.clock.shouldAnimate) {
        viewer.clock.shouldAnimate = true;
    }
    forceUpdatePlaybackUI();
});

// Fast Forward — cycle speed steps
document.getElementById('tcb-ff').addEventListener('click', () => {
    currentSpeedIndex = (currentSpeedIndex + 1) % SPEED_STEPS.length;
    const sign = viewer.clock.multiplier < 0 ? -1 : 1;
    viewer.clock.multiplier = sign * SPEED_STEPS[currentSpeedIndex];
    if (!viewer.clock.shouldAnimate) {
        viewer.clock.shouldAnimate = true;
    }
    forceUpdatePlaybackUI();
});
// ── End Time Control Bar Logic ───────────────────────────────────────
```

- [ ] **Step 2: Commit**

```bash
git add static/index.html
git commit -m "feat: add playback control handlers and speed cycling logic"
```

---

### Task 4: Rewire `setTimeMode()` to use new elements

**Files:**
- Modify: `static/index.html` — the `setTimeMode()` function (line ~1143)

- [ ] **Step 1: Update `setTimeMode()` function**

Replace the full `setTimeMode()` function. Key changes:
- Reference `tcb-btn-live` / `tcb-btn-history` instead of `btn-live` / `btn-history`
- Remove `historyIndicator` references
- Add `#timeControlBar` class toggle for mode theming
- Call `enablePlaybackButtons()` and `updatePlaybackUI()`
- Reset speed index on history mode entry
- Update time display element ID

Replace the function (from `async function setTimeMode(mode) {` to its closing `}`):

```javascript
async function setTimeMode(mode) {
    const btnLive = document.getElementById('tcb-btn-live');
    const btnHistory = document.getElementById('tcb-btn-history');
    const controlBar = document.getElementById('timeControlBar');
    const timeDisplay = document.getElementById('tcb-time-display');

    if (mode === 'live') {
        timeMode = 'live';

        // Update UI
        btnLive.classList.add('active');
        btnHistory.classList.remove('active');
        controlBar.classList.remove('history-active');
        timeDisplay.classList.remove('history');

        // Disable playback buttons in live mode
        enablePlaybackButtons(false);

        // Stop animation and reset to live time
        viewer.clock.shouldAnimate = false;
        viewer.clock.currentTime = Cesium.JulianDate.now();

        // Restart live clock sync
        if (!liveClockIntervalId) {
            liveClockIntervalId = setInterval(() => {
                if (timeMode === 'live') {
                    viewer.clock.currentTime = Cesium.JulianDate.now();
                }
            }, 1000);
        }

        // Clear ship entities
        SHIP_TYPES.forEach(type => {
            if (shipDataSources[type]) {
                shipDataSources[type].entities.removeAll();
            }
        });

        // Reset sliding window state
        currentWindowCenter = null;
        currentWindowStart = null;
        currentWindowEnd = null;
        historyInterpolationLoaded = false;

        console.log('Switched to LIVE mode');

    } else if (mode === 'history') {
        timeMode = 'history';
        clearProximity();

        // Update UI
        btnLive.classList.remove('active');
        btnHistory.classList.add('active');
        controlBar.classList.add('history-active');
        timeDisplay.classList.add('history');

        // Enable playback buttons
        enablePlaybackButtons(true);

        // Reset speed to 60x
        currentSpeedIndex = 2;

        // Stop live clock sync
        if (liveClockIntervalId) {
            clearInterval(liveClockIntervalId);
            liveClockIntervalId = null;
        }

        // Clear existing ship entities (from LIVE mode)
        SHIP_TYPES.forEach(type => {
            if (shipDataSources[type]) {
                shipDataSources[type].entities.removeAll();
            }
        });

        // Load history range and setup timeline
        const rangeLoaded = await loadHistoryRange();

        if (rangeLoaded) {
            // Set initial time to most recent data point
            const initialCenter = new Date(historyRange.max);

            // Load 1-hour window around initial time
            await loadHistoryWindow(initialCenter);

            // Enable animation for smooth playback
            viewer.clock.shouldAnimate = true;
            viewer.clock.multiplier = 60; // 60x speed (1 min/sec)
            forceUpdatePlaybackUI();
        } else {
            // No history data available — return to LIVE after brief message
            timeDisplay.textContent = 'No history data — returning to LIVE';
            setTimeout(() => setTimeMode('live'), 2000);
        }

        console.log('Switched to HISTORY mode with sliding window');
    }
}
```

- [ ] **Step 2: Update mode button event listeners**

Replace old button listeners (lines ~1293-1294):

Old:
```javascript
document.getElementById('btn-live').addEventListener('click', () => setTimeMode('live'));
document.getElementById('btn-history').addEventListener('click', () => setTimeMode('history'));
```

New:
```javascript
document.getElementById('tcb-btn-live').addEventListener('click', () => setTimeMode('live'));
document.getElementById('tcb-btn-history').addEventListener('click', () => setTimeMode('history'));
```

- [ ] **Step 3: Commit**

```bash
git add static/index.html
git commit -m "feat: rewire setTimeMode() to use time control bar elements"
```

---

### Task 5: Update clock tick handler for time display

**Files:**
- Modify: `static/index.html` — the `viewer.clock.onTick` handler (line ~1230)

- [ ] **Step 1: Update clock tick handler**

Replace the time display update inside `viewer.clock.onTick.addEventListener` (lines 1230-1237):

Old:
```javascript
viewer.clock.onTick.addEventListener((clock) => {
    if (timeMode !== 'history') return;

    // Update time display
    const jsDate = Cesium.JulianDate.toDate(clock.currentTime);
    const displayTime = jsDate.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    document.getElementById('historyTimeDisplay').textContent = displayTime;
    document.getElementById('last-update').textContent = displayTime.substring(11, 19);
```

New:
```javascript
viewer.clock.onTick.addEventListener((clock) => {
    if (timeMode !== 'history') return;

    // Update time display in control bar
    const jsDate = Cesium.JulianDate.toDate(clock.currentTime);
    const displayTime = jsDate.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    document.getElementById('tcb-time-display').textContent = displayTime;
    document.getElementById('last-update').textContent = displayTime.substring(11, 19);

    // Sync play/pause icon state
    updatePlaybackUI();
```

- [ ] **Step 2: Commit**

```bash
git add static/index.html
git commit -m "feat: update clock tick handler for time control bar"
```

---

### Task 6: Manual testing

- [ ] **Step 1: Test LIVE mode**
1. Open app — control bar should show at bottom-left
2. LIVE button active (cyan), playback buttons dimmed/disabled
3. UTC clock ticking in the control bar
4. Cesium timeline bar visible to the right of control bar
5. No Cesium circular animation widget visible

- [ ] **Step 2: Test HISTORY mode**
1. Click HISTORY — button turns purple, control bar border turns purple
2. Playback buttons become active (purple)
3. Speed shows `60x`, time display shows history timestamp
4. Click Play/Pause — animation toggles, icon switches ▶/❚❚
5. Click Fast Forward — speed cycles 60→300→600→1→10→60...
6. Click Reverse — multiplier goes negative, reverse button highlighted
7. Click Reverse again — back to forward

- [ ] **Step 3: Test mode switching**
1. Switch HISTORY → LIVE: buttons disabled, time resets to UTC clock
2. Switch LIVE → HISTORY: speed resets to 60x, play/pause shows ❚❚

- [ ] **Step 4: Verify no old elements remain**
1. No LIVE/HISTORY buttons in top header
2. No purple history indicator badge at top center
3. No Cesium circular animation widget
4. No UTC CLOCK in header stats

- [ ] **Step 5: Final commit**

```bash
git add static/index.html
git commit -m "feat: complete timeline UI redesign — unified bottom control bar"
```
