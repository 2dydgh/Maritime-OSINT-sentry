# Timeline UI Redesign — Hybrid Bottom Bar

## Purpose

Consolidate four scattered timeline-related UI elements (mode toggle in header, history indicator badge, Cesium animation widget, Cesium timeline bar) into a single cohesive bottom bar area. Improves usability by reducing eye movement and providing a unified, mode-aware control surface.

## Current Problems

1. **Mode toggle** (LIVE/HISTORY) is in the top header, far from timeline controls
2. **History indicator** floats at top center, disconnected from playback controls
3. **Cesium animation widget** (circular) has a dated look that clashes with the glassmorphism design
4. **UTC clock** is in the header, separate from time-related controls
5. User must look at 4 different screen locations for time-related information

## Design: Hybrid Approach

Hide the Cesium circular animation widget. Keep the Cesium timeline bar for scrubbing. Add a custom control bar to the left of the timeline that combines mode toggle, playback controls, speed indicator, and current time display.

### Layout

```
|  [LIVE] [HISTORY]  |  ◄  ▶  ►►  |  60x  |  2026-03-15 08:30:00 Z  |  [===Cesium Timeline Bar===]  |
|---------- custom control bar (glassmorphism, min-width: 440px) ---------|  |--- Cesium timeline ---|
```

- Custom control bar: `position: fixed; bottom: 25px; left: 20px; min-width: 440px`
- Cesium timeline: `left: 480px !important` (fixed offset, accommodates max time display width)
- Both elements share `bottom: 25px` for vertical alignment

### Mode Theming

- **LIVE mode**: cyan accent (`#38bdf8`), border color, button highlights
- **HISTORY mode**: purple accent (`#a855f7`), border color shifts, playback controls become active

### Control Bar Contents

| Element | LIVE Mode | HISTORY Mode |
|---------|-----------|--------------|
| Mode toggle | LIVE active (cyan) | HISTORY active (purple) |
| Playback buttons (◄ ▶ ►►) | Dimmed/disabled (pointer-events: none) | Active (purple) |
| Speed display | `1x` (dimmed) | `60x` (purple, bold) |
| Time display | UTC clock `HH:MM:SS Z` (cyan) | History timestamp `YYYY-MM-DD HH:MM:SS Z` (purple) |

### Playback Button Behavior

- **Reverse** (◄): Toggle. First click sets `multiplier = -Math.abs(multiplier)`. Second click sets `multiplier = Math.abs(multiplier)`. Button gets a visual active state (filled background) while in reverse.
- **Play/Pause** (▶/❚❚): Toggle `viewer.clock.shouldAnimate`. Icon switches between ▶ and ❚❚. Initializes as ❚❚ when entering history mode (since `shouldAnimate` starts `true`).
- **Fast Forward** (►►): Cycle through speed steps `[1, 10, 60, 300, 600]`, wraps around to 1. Always applies to absolute value of multiplier (preserves reverse direction). Resets to `60x` (index 2) on mode switch to history.

### What Gets Removed

- Cesium circular animation widget (hide via CSS `display: none !important`, also remove dead positioning CSS)
- LIVE/HISTORY buttons from the header `mode-toggle` div
- History indicator badge (`#historyIndicator`) element and its CSS
- UTC CLOCK stat item (`stat-time`) from header
- Note: `animation: true` stays in viewer constructor (low-risk; CSS hide is sufficient)

### What Stays

- Cesium timeline bar (repositioned with `left: 480px`)
- Header Events / Assets counts
- `#last-update` element in filter panel (unchanged, fed by WebSocket handler)
- All existing `setTimeMode()` logic (rewired to new DOM elements)

## DOM References to Migrate

These element references in JS must be updated to point to new control bar elements:

| Old Reference | Location | New Target |
|---|---|---|
| `document.getElementById('btn-live')` | setTimeMode() line ~1144 | `#tcb-btn-live` |
| `document.getElementById('btn-history')` | setTimeMode() line ~1145 | `#tcb-btn-history` |
| `document.getElementById('historyIndicator')` | setTimeMode() line ~1146 | Remove (no longer needed) |
| `document.getElementById('historyTimeDisplay')` | setTimeMode() line ~1221, tick handler ~1236 | `#tcb-time-display` |
| `document.getElementById('stat-time')` | updateClock() line ~834 | `#tcb-time-display` |

## State Management

### Speed Index
- `let currentSpeedIndex = 2;` — index into `SPEED_STEPS = [1, 10, 60, 300, 600]`
- Reset to `2` (60x) when entering history mode
- Display updates on every change

### Play/Pause Icon
- Driven by `viewer.clock.shouldAnimate`
- Updated on: button click, mode transition, timeline scrub
- Check state in clock tick listener to catch external changes

### Mode Transition Effects on Controls
- **→ LIVE**: playback buttons dimmed, speed display shows `1x` dimmed, time display switches to UTC clock via `setInterval(updateClock, 1000)`
- **→ HISTORY**: playback buttons active, speed resets to 60x, time display switches to history timestamp via `viewer.clock.onTick`, play/pause icon shows ❚❚

## Implementation Approach

### CSS Changes
- `.cesium-viewer-animationContainer { display: none !important; }` (replace existing positioning rules)
- `.cesium-viewer-timelineContainer { left: 480px !important; bottom: 25px !important; }` (update existing)
- New `#timeControlBar` styles: glassmorphism, flex row, gap dividers, mode-aware border color
- Remove `.history-indicator` CSS block
- Remove `.mode-toggle`, `.mode-btn` CSS blocks

### HTML Changes
- Remove `<div class="mode-toggle">` and children from header
- Remove `<div class="stat-item">` for UTC CLOCK from header
- Remove `<div id="historyIndicator">` element
- Add `<div id="timeControlBar">` with: mode buttons, divider, playback buttons, divider, speed span, divider, time span

### JS Changes
- New `SPEED_STEPS` array and `currentSpeedIndex` state
- Playback button handlers wired to `viewer.clock` properties
- `setTimeMode()` updated to reference new element IDs, manage playback button states
- `updateClock()` updated to write to `#tcb-time-display`
- `viewer.clock.onTick` handler extended to update `#tcb-time-display` in history mode and sync play/pause icon
- Event listeners for new buttons replace old `btn-live`/`btn-history` listeners

### Interactions with Existing Code
- `setTimeMode('live'|'history')` function signature unchanged
- History sliding window logic unchanged — just UI layer changes
- Alert polling, proximity, satellite propagation — no changes needed
- `#last-update` in filter panel — no changes
