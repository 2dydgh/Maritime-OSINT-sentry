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
|  [LIVE] [HISTORY]  |  ◄  ▶  ►►  |  60x  |  14:32:15 Z  |  [===Cesium Timeline Bar===]  |
|--- custom control bar (glassmorphism) ---|                |--- Cesium timeline (kept) ---|
```

- Custom control bar: `position: fixed; bottom: 12px; left: 20px`
- Cesium timeline: repositioned to start right of the control bar

### Mode Theming

- **LIVE mode**: cyan accent (`#38bdf8`), border color, button highlights
- **HISTORY mode**: purple accent (`#a855f7`), border color shifts, playback controls become active

### Control Bar Contents

| Element | LIVE Mode | HISTORY Mode |
|---------|-----------|--------------|
| Mode toggle | LIVE active (cyan) | HISTORY active (purple) |
| Playback buttons (◄ ▶ ►►) | Dimmed/disabled | Active (purple) |
| Speed display | `1x` (dimmed) | `60x` (purple, bold) |
| Time display | UTC clock `HH:MM:SS Z` (cyan) | History timestamp `YYYY-MM-DD HH:MM:SS Z` (purple) |

### Playback Buttons

- **Reverse** (◄): `viewer.clock.multiplier = -Math.abs(viewer.clock.multiplier)`
- **Play/Pause** (▶/❚❚): toggle `viewer.clock.shouldAnimate`
- **Fast Forward** (►►): cycle through multipliers `[1, 10, 60, 300, 600]`

### What Gets Removed

- Cesium circular animation widget (hide via CSS `display: none`)
- LIVE/HISTORY buttons from the header `mode-toggle` div
- History indicator badge (`#historyIndicator`)
- UTC CLOCK stat item from header

### What Stays

- Cesium timeline bar (repositioned)
- Header Events / Assets counts
- All existing `setTimeMode()` logic (just rewired to new buttons)

## Implementation Approach

### CSS Changes
- Hide `.cesium-viewer-animationContainer` with `display: none !important`
- Reposition `.cesium-viewer-timelineContainer` left edge to accommodate the new control bar
- New `#timeControlBar` styles matching glassmorphism theme
- Mode-specific border/accent color transitions

### HTML Changes
- Remove `mode-toggle` div and `stat-time` from header
- Remove `#historyIndicator` div
- Add new `#timeControlBar` div before `</body>` with buttons and display spans

### JS Changes
- New playback control handlers (play/pause, reverse, speed cycle)
- Update `setTimeMode()` to use new elements instead of old ones
- Update clock tick listener to write current time to the control bar
- Speed cycling: click ►► to step through `[1, 10, 60, 300, 600]`, wraps around
- Play/Pause button icon toggles between ▶ and ❚❚ based on `viewer.clock.shouldAnimate`

### Interactions with Existing Code
- `setTimeMode('live'|'history')` function signature unchanged, only UI element references updated
- `viewer.clock.onTick` listener already exists — extend to update time display in control bar
- History sliding window logic unchanged — just UI layer changes
- Alert polling, proximity, satellite propagation — no changes needed
