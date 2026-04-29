# Ship Model Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inline 3D ship model preview to the ship info panel, showing the vessel's procedural model with hover-activated dimension lines.

**Architecture:** New standalone module `ShipPreview3D` creates a lightweight Three.js scene (no water/sky/post-processing) inside the ship info panel. Ship building functions are extracted from `roll-viewer.js` into a shared module `ship-builders.js` so both roll-viewer and preview can use them. The preview initializes when `showShipInfo()` renders, and disposes when the panel closes.

**Tech Stack:** Three.js 0.137.0 (already loaded), OrbitControls, procedural geometry

---

### Task 1: Extract Ship Builders into Shared Module

**Files:**
- Create: `static/js/ship-builders.js`
- Modify: `static/js/roll-viewer.js`
- Modify: `static/index.html`

The ship builder functions (`buildTanker`, `buildCargo`, `buildPassenger`, `buildFishing`, `buildMilitary`, `buildTug`, `buildGenericShip`) and their helpers are currently trapped inside `RollViewer`'s IIFE closure. Extract them into a shared module that accepts a `THREE.Group` target.

- [ ] **Step 1: Create `ship-builders.js` with the shared API**

Create the module skeleton that exposes a single entry point. The key change: instead of relying on closure variables `shipGroup` and `shipEnvMap`, each builder receives a `group` parameter. Helper functions (`shipMat`, `addToShip`, `createHullGeometry`, `addWaterline`, `addDeckRailing`, `addBulbousBow`, `addAnchor`, `addHawsepipe`, `addRudder`, `addStemBar`, `rustHullMat`, `createRustTexture`) are all included.

```js
// static/js/ship-builders.js
// Shared procedural ship model builders for roll-viewer and ship-preview.
var ShipBuilders = (function () {
    'use strict';

    var _shipMatCache = {};
    var _rustTextureCache = {};
    var _envMap = null;

    function setEnvMap(envMap) {
        _envMap = envMap;
    }

    // --- Material helpers (copied from roll-viewer.js lines 1815-1843) ---
    function shipMat(color, opts) {
        opts = opts || {};
        var r = opts.roughness !== undefined ? opts.roughness : 0.45;
        var m = opts.metalness !== undefined ? opts.metalness : 0.35;
        var emi = opts.envMapIntensity !== undefined ? opts.envMapIntensity : 0.4;
        var e = opts.emissive || null;
        var ei = opts.emissiveIntensity;
        var key = color + '|' + r + '|' + m + '|' + (e || '') + '|' + (ei || '');
        if (_shipMatCache[key]) return _shipMatCache[key];
        var THREE = window.THREE;
        var params = { color: new THREE.Color(color), roughness: r, metalness: m };
        if (_envMap) { params.envMap = _envMap; params.envMapIntensity = emi; }
        if (e) { params.emissive = new THREE.Color(e); params.emissiveIntensity = ei || 0.8; }
        var mat = new THREE.MeshStandardMaterial(params);
        _shipMatCache[key] = mat;
        return mat;
    }

    // --- createRustTexture (from roll-viewer.js lines 1851-1908) ---
    // Copy the full function body here.

    // --- RUST_INTENSITY map ---
    var RUST_INTENSITY = {
        cargo: 0.6, tanker: 0.5, passenger: 0.15,
        fishing: 0.8, military: 0.12, tug: 0.7, other: 0.4
    };

    function rustHullMat(baseColor, type) {
        var THREE = window.THREE;
        var intensity = RUST_INTENSITY[type] || 0.4;
        var texture = createRustTexture(baseColor, intensity);
        var params = { map: texture, roughness: 0.55, metalness: 0.3, side: THREE.DoubleSide };
        if (_envMap) { params.envMap = _envMap; params.envMapIntensity = 0.35; }
        return new THREE.MeshStandardMaterial(params);
    }

    // --- createHullGeometry (from roll-viewer.js lines 2018-2078) ---
    // Copy the full function body here.

    // --- Detail helpers (from roll-viewer.js lines 1933-2086) ---
    // addDeckRailing, addBulbousBow, addAnchor, addHawsepipe, addRudder, addStemBar, addWaterline
    // Each takes a `group` parameter instead of using closure `shipGroup`.
    // Replace `addToShip(mesh)` with `group.add(mesh); return mesh;`

    // --- Ship type builders ---
    // buildTanker(THREE, group, color), buildCargo(THREE, group, color), etc.
    // Each receives `group` as second parameter.
    // All internal `addToShip(mesh)` calls become `group.add(mesh)`.
    // All helper calls pass `group` as well.

    // --- Main entry point ---
    function buildShipModel(type, color) {
        var THREE = window.THREE;
        var group = new THREE.Group();
        color = color || (window.SHIP_COLORS && window.SHIP_COLORS[type]) || '#6b7280';

        switch (type) {
            case 'tanker':    buildTanker(THREE, group, color); break;
            case 'cargo':     buildCargo(THREE, group, color); break;
            case 'passenger': buildPassenger(THREE, group, color); break;
            case 'fishing':   buildFishing(THREE, group, color); break;
            case 'military':  buildMilitary(THREE, group, color); break;
            case 'tug':       buildTug(THREE, group, color); break;
            default:          buildGenericShip(THREE, group, color); break;
        }

        // Waterline
        var wlMap = {
            tanker: [16, 4.2, 1.6], cargo: [14, 3.8, 1.6], passenger: [16, 4.5, 1.4],
            fishing: [8, 2.8, 1.4], military: [14, 3.2, 1.6], tug: [6, 3.2, 1.6], other: [10, 3.2, 1.5]
        };
        var wl = wlMap[type] || wlMap['other'];
        addWaterline(THREE, group, wl[0], wl[1], wl[2]);

        return group;
    }

    // --- Ship type key resolver (from roll-viewer.js lines 144-164) ---
    function getShipTypeKey(ship) {
        if (!ship || !ship.type) return 'other';
        var t = ship.type.toLowerCase();
        if (t.indexOf('cargo') !== -1) return 'cargo';
        if (t.indexOf('tanker') !== -1) return 'tanker';
        if (t.indexOf('passenger') !== -1) return 'passenger';
        if (t.indexOf('fishing') !== -1) return 'fishing';
        if (t.indexOf('military') !== -1) return 'military';
        if (t.indexOf('tug') !== -1) return 'tug';
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

    return {
        buildShipModel: buildShipModel,
        getShipTypeKey: getShipTypeKey,
        setEnvMap: setEnvMap
    };
})();
```

- [ ] **Step 2: Copy all builder functions from roll-viewer.js into ship-builders.js**

Copy these functions from `roll-viewer.js` into the `ShipBuilders` IIFE, modifying each to accept `group` parameter instead of using closure `shipGroup`:

| Function | Source Lines | Change |
|----------|-------------|--------|
| `createRustTexture` | 1853-1908 | No change (no shipGroup dependency) |
| `rustHullMat` | 1916-1931 | Use `_envMap` instead of `shipEnvMap` |
| `createHullGeometry` | 2019-2078 | No change (pure geometry) |
| `addWaterline` | 2081-2086 | Add `group` param, `group.add(stripe)` |
| `addDeckRailing` | 1934-1962 | Add `group` param, replace `addToShip` |
| `addBulbousBow` | 1967-1971 | Add `group` param |
| `addAnchor` | 1974-1991 | Add `group` param |
| `addHawsepipe` | 1994-2001 | Add `group` param |
| `addRudder` | 2004-2009 | Add `group` param |
| `addStemBar` | 2012-2016 | Add `group` param |
| `buildTanker` | ~2460-2560 | Add `group` param |
| `buildCargo` | 2562-2669 | Add `group` param |
| `buildPassenger` | ~2670-2800 | Add `group` param |
| `buildFishing` | ~2800-2900 | Add `group` param |
| `buildMilitary` | ~2900-3000 | Add `group` param |
| `buildTug` | ~3000-3105 | Add `group` param |
| `buildGenericShip` | 3106-3187 | Add `group` param |

For each function, the pattern is:
- Old: `function buildCargo(THREE, color) { ... addToShip(mesh) ... }`
- New: `function buildCargo(THREE, group, color) { ... group.add(mesh) ... }`

Helper calls inside builders also need the `group` parameter passed:
- Old: `addDeckRailing(THREE, opts)`
- New: `addDeckRailing(THREE, group, opts)`

- [ ] **Step 3: Update roll-viewer.js to use ShipBuilders**

In `roll-viewer.js`, replace `buildCodeShip` (line 2297) to delegate to `ShipBuilders`:

```js
function buildCodeShip(type, color) {
    var model = ShipBuilders.buildShipModel(type, color);
    // Transfer all children to shipGroup
    while (model.children.length > 0) {
        shipGroup.add(model.children[0]);
    }
}
```

Also replace `getShipTypeKey` (line 144) usage to delegate:
```js
function getShipTypeKey(ship) {
    return ShipBuilders.getShipTypeKey(ship);
}
```

Remove the duplicated builder functions, helpers, and `_shipMatCache` / `_rustTextureCache` from `roll-viewer.js`. Keep only the functions that are roll-viewer-specific (water, sky, spray, compass, nav lights, animation).

- [ ] **Step 4: Add script tag to index.html**

Add `ship-builders.js` before `roll-viewer.js` (line 478):

```html
<script src="js/ship-builders.js?v=1"></script>
<script src="js/roll-viewer.js?v=3"></script>
```

- [ ] **Step 5: Verify roll-viewer still works**

Run the app, open a ship, click the roll prediction model card, verify:
- Ship model renders correctly
- All ship types build without errors
- Roll animation works
- No console errors

- [ ] **Step 6: Commit**

```bash
git add static/js/ship-builders.js static/js/roll-viewer.js static/index.html
git commit -m "refactor: extract ship builders into shared module"
```

---

### Task 2: Create Ship Preview 3D Module

**Files:**
- Create: `static/js/ship-preview-3d.js`

Build the standalone preview renderer that creates a mini Three.js scene inside a container element.

- [ ] **Step 1: Create `ship-preview-3d.js` with scene setup**

```js
// static/js/ship-preview-3d.js
// Lightweight 3D ship model preview for the ship info panel.
var ShipPreview3D = (function () {
    'use strict';

    var scene = null;
    var camera = null;
    var renderer = null;
    var controls = null;
    var shipGroup = null;
    var animFrameId = null;
    var container = null;
    var dimensionOverlay = null;
    var _resizeObserver = null;

    function init(containerEl, shipType, dimensions) {
        dispose(); // clean up any previous preview

        container = containerEl;
        var THREE = window.THREE;

        // Scene
        scene = new THREE.Scene();
        // Gradient background via two-color fog trick — or just solid
        scene.background = new THREE.Color(0x0a1628);

        // Camera
        var w = container.clientWidth;
        var h = container.clientHeight;
        camera = new THREE.PerspectiveCamera(40, w / (h || 1), 0.1, 500);
        camera.position.set(20, 12, 20);
        camera.lookAt(0, 2, 0);

        // Renderer
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(w, h);
        renderer.domElement.style.display = 'block';
        renderer.domElement.style.borderRadius = '6px';
        container.appendChild(renderer.domElement);

        // OrbitControls — drag rotate only, no zoom
        var OC = THREE.OrbitControls;
        controls = new OC(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.enableZoom = false;
        controls.enablePan = false;
        controls.target.set(0, 2, 0);
        controls.minPolarAngle = Math.PI * 0.2;
        controls.maxPolarAngle = Math.PI * 0.45;

        // Lighting — simple directional + ambient
        var dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
        dirLight.position.set(15, 20, 10);
        scene.add(dirLight);

        var fillLight = new THREE.DirectionalLight(0x8899bb, 0.4);
        fillLight.position.set(-10, 8, -5);
        scene.add(fillLight);

        var ambLight = new THREE.AmbientLight(0x334466, 0.6);
        scene.add(ambLight);

        // Build ship model
        shipGroup = ShipBuilders.buildShipModel(shipType);
        scene.add(shipGroup);

        // Auto-fit camera distance to ship bounding box
        var box = new THREE.Box3().setFromObject(shipGroup);
        var size = new THREE.Vector3();
        box.getSize(size);
        var maxDim = Math.max(size.x, size.z);
        var dist = maxDim * 1.4;
        camera.position.set(dist * 0.7, dist * 0.4, dist * 0.7);
        controls.target.copy(box.getCenter(new THREE.Vector3()));
        controls.update();

        // Dimension overlay (hover-activated)
        buildDimensionOverlay(dimensions);

        // Resize handling
        _resizeObserver = new ResizeObserver(function () {
            if (!renderer || !camera) return;
            var ww = container.clientWidth;
            var hh = container.clientHeight;
            camera.aspect = ww / (hh || 1);
            camera.updateProjectionMatrix();
            renderer.setSize(ww, hh);
        });
        _resizeObserver.observe(container);

        // Start render loop
        animate();
    }

    function animate() {
        animFrameId = requestAnimationFrame(animate);
        if (!renderer || !scene || !camera) return;
        if (controls) controls.update();
        renderer.render(scene, camera);
    }

    function buildDimensionOverlay(dimensions) {
        // HTML overlay for dimension lines — shown on hover
        dimensionOverlay = document.createElement('div');
        dimensionOverlay.className = 'ship-preview-dimensions';

        if (dimensions && (dimensions.length || dimensions.beam)) {
            var html = '<div class="dim-lines">';
            if (dimensions.length) {
                html += '<div class="dim-line dim-length">';
                html += '<span class="dim-arrow">&larr;</span>';
                html += '<span class="dim-value">' + dimensions.length + 'm</span>';
                html += '<span class="dim-arrow">&rarr;</span>';
                html += '<span class="dim-label">L</span>';
                html += '</div>';
            }
            if (dimensions.beam) {
                html += '<div class="dim-line dim-beam">';
                html += '<span class="dim-arrow">&uarr;</span>';
                html += '<span class="dim-value">' + dimensions.beam + 'm</span>';
                html += '<span class="dim-arrow">&darr;</span>';
                html += '<span class="dim-label">B</span>';
                html += '</div>';
            }
            if (dimensions.draught) {
                html += '<div class="dim-line dim-draught">';
                html += '<span class="dim-value">D: ' + dimensions.draught + 'm</span>';
                html += '</div>';
            }
            html += '</div>';
            dimensionOverlay.innerHTML = html;
        } else {
            dimensionOverlay.innerHTML = '<div class="dim-no-data">제원 정보 없음</div>';
        }

        dimensionOverlay.style.opacity = '0';
        container.appendChild(dimensionOverlay);

        // Hover events on the container
        container.addEventListener('mouseenter', function () {
            dimensionOverlay.style.opacity = '1';
        });
        container.addEventListener('mouseleave', function () {
            dimensionOverlay.style.opacity = '0';
        });
    }

    function dispose() {
        if (animFrameId) {
            cancelAnimationFrame(animFrameId);
            animFrameId = null;
        }
        if (_resizeObserver) {
            _resizeObserver.disconnect();
            _resizeObserver = null;
        }
        if (controls) { controls.dispose(); controls = null; }
        if (renderer) {
            renderer.dispose();
            if (renderer.domElement && renderer.domElement.parentNode) {
                renderer.domElement.parentNode.removeChild(renderer.domElement);
            }
            renderer = null;
        }
        if (dimensionOverlay && dimensionOverlay.parentNode) {
            dimensionOverlay.parentNode.removeChild(dimensionOverlay);
            dimensionOverlay = null;
        }
        if (scene) {
            scene.traverse(function (obj) {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    if (Array.isArray(obj.material)) {
                        obj.material.forEach(function (m) { m.dispose(); });
                    } else {
                        obj.material.dispose();
                    }
                }
            });
            scene = null;
        }
        shipGroup = null;
        camera = null;
        container = null;
    }

    return {
        init: init,
        dispose: dispose
    };
})();
```

- [ ] **Step 2: Verify the module loads without errors**

Add temporarily to `index.html` and check browser console for parse errors.

- [ ] **Step 3: Commit**

```bash
git add static/js/ship-preview-3d.js
git commit -m "feat: add ShipPreview3D module for inline ship model preview"
```

---

### Task 3: Add CSS for Preview Container and Dimension Overlay

**Files:**
- Modify: `static/css/main.css`

- [ ] **Step 1: Add preview container styles**

Add at the end of `main.css` (near the ship info panel styles):

```css
/* ── Ship 3D Preview ── */
.ship-preview-container {
    position: relative;
    width: 100%;
    height: 170px;
    border-radius: 8px;
    overflow: hidden;
    background: linear-gradient(135deg, #0a1628, #1a3050);
    border: 1px solid var(--border);
    margin-top: 8px;
    cursor: grab;
}
.ship-preview-container:active {
    cursor: grabbing;
}

/* Dimension overlay — appears on hover */
.ship-preview-dimensions {
    position: absolute;
    inset: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 8px 12px;
    background: linear-gradient(to top, rgba(10,22,40,0.7) 0%, transparent 60%);
}

.dim-lines {
    display: flex;
    gap: 16px;
    align-items: center;
}

.dim-line {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.65rem;
    font-family: 'JetBrains Mono', monospace;
    color: var(--accent);
    letter-spacing: 0.5px;
}

.dim-arrow {
    color: var(--accent);
    opacity: 0.6;
    font-size: 0.7rem;
}

.dim-value {
    color: #e2e8f0;
    font-weight: 600;
}

.dim-label {
    color: var(--accent);
    opacity: 0.5;
    font-size: 0.55rem;
    margin-left: 2px;
}

.dim-no-data {
    font-size: 0.65rem;
    color: var(--text-dim);
    font-style: italic;
}
```

- [ ] **Step 2: Commit**

```bash
git add static/css/main.css
git commit -m "style: add ship 3D preview container and dimension overlay styles"
```

---

### Task 4: Integrate Preview into Ship Info Panel

**Files:**
- Modify: `static/js/ui-controls.js` (lines 1139-1144)
- Modify: `static/index.html` (line 478 area)

- [ ] **Step 1: Add script tag to index.html**

Insert `ship-preview-3d.js` after `ship-builders.js` and before `roll-viewer.js`:

```html
<script src="js/ship-builders.js?v=1"></script>
<script src="js/ship-preview-3d.js?v=1"></script>
<script src="js/roll-viewer.js?v=3"></script>
```

- [ ] **Step 2: Modify `showShipInfo()` to initialize the preview**

In `static/js/ui-controls.js`, after line 1139 (`body.innerHTML = statsHtml + detailHtml;`), add the preview container creation and initialization:

```js
// --- 3D Ship Model Preview ---
var previewContainer = document.createElement('div');
previewContainer.className = 'ship-preview-container';
previewContainer.id = 'shipPreview3d';
body.appendChild(previewContainer);

var shipTypeKey = ShipBuilders.getShipTypeKey(s);
var dims = {
    length: s.length ? parseFloat(s.length) : null,
    beam: s.beam ? parseFloat(s.beam) : null,
    draught: s.draught ? parseFloat(s.draught) : null
};
ShipPreview3D.init(previewContainer, shipTypeKey, dims);
```

This must go **before** the `ModelRegistry.renderShipModelCards` call (line 1142) so the preview appears between the detail card and the model cards.

The full modified section (lines 1139-1149):

```js
body.innerHTML = statsHtml + detailHtml;

// --- 3D Ship Model Preview ---
var previewContainer = document.createElement('div');
previewContainer.className = 'ship-preview-container';
previewContainer.id = 'shipPreview3d';
body.appendChild(previewContainer);

var shipTypeKey = ShipBuilders.getShipTypeKey(s);
var dims = {
    length: s.length ? parseFloat(s.length) : null,
    beam: s.beam ? parseFloat(s.beam) : null,
    draught: s.draught ? parseFloat(s.draught) : null
};
ShipPreview3D.init(previewContainer, shipTypeKey, dims);

// Render model summary cards from registry
if (window.ModelRegistry) {
    ModelRegistry.renderShipModelCards(s.mmsi, body);
}

if (typeof LayoutManager !== 'undefined') {
    LayoutManager.showShipInfo();
}
```

- [ ] **Step 3: Add cleanup when panel closes**

Find where the ship info panel is closed/hidden (in `layout-manager.js` or `ui-controls.js`). Add `ShipPreview3D.dispose()` to release the WebGL context. Search for `shipInfoBack` click handler or panel hide logic.

In `ui-controls.js`, find the back button handler for `#shipInfoBack` and add:

```js
document.getElementById('shipInfoBack').addEventListener('click', function () {
    ShipPreview3D.dispose();
    // ... existing back logic
});
```

Also add disposal when `showShipInfo` is called (it's already handled by `dispose()` call inside `init()`), and when navigating to other right panel views.

- [ ] **Step 4: Verify the full integration**

1. Open the app in browser
2. Click a ship on the map
3. Ship info panel slides in
4. Below the detail card, the 3D model preview should render
5. Drag to rotate the model
6. Hover to see dimension lines
7. Click back — preview disposes cleanly
8. Click another ship — new model renders
9. Check browser console for WebGL warnings or errors

- [ ] **Step 5: Commit**

```bash
git add static/js/ui-controls.js static/index.html
git commit -m "feat: integrate 3D ship model preview into ship info panel"
```

---

### Task 5: Polish and Edge Cases

**Files:**
- Modify: `static/js/ship-preview-3d.js`
- Modify: `static/css/main.css`

- [ ] **Step 1: Handle rapid ship switching**

Ensure clicking multiple ships quickly doesn't create multiple renderers. The `init()` function already calls `dispose()` first, but verify that the container element is properly cleaned up when `body.innerHTML = ...` overwrites it.

Add a check in `showShipInfo()`: before `body.innerHTML = ...`, call `ShipPreview3D.dispose()`:

```js
// At the top of showShipInfo, after the null checks (around line 1068):
if (window.ShipPreview3D) ShipPreview3D.dispose();
```

- [ ] **Step 2: Prevent scroll conflicts**

The canvas should not capture scroll events (they should pass through to the panel). OrbitControls zoom is already disabled (`enableZoom: false`). Verify this works by scrolling the panel when cursor is over the preview.

If needed, add to `ship-preview-3d.js` after controls setup:

```js
// Prevent scroll capture
renderer.domElement.addEventListener('wheel', function (e) {
    e.stopPropagation();
    container.parentElement.scrollTop += e.deltaY;
}, { passive: false });
```

Wait — we want scroll to pass through, not be blocked. Actually, since `enableZoom: false`, OrbitControls should not capture wheel events. Test and only add the workaround if needed.

- [ ] **Step 3: Add gradient background effect**

The single-color background is a bit flat. Add a subtle gradient using a second plane behind the ship:

In `ship-preview-3d.js` `init()`, after scene creation:

```js
// Gradient background plane
var bgGeo = new THREE.PlaneGeometry(200, 200);
var bgMat = new THREE.ShaderMaterial({
    uniforms: {
        colorTop: { value: new THREE.Color(0x1a3050) },
        colorBottom: { value: new THREE.Color(0x0a1628) }
    },
    vertexShader: [
        'varying vec2 vUv;',
        'void main() {',
        '  vUv = uv;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
    ].join('\n'),
    fragmentShader: [
        'uniform vec3 colorTop;',
        'uniform vec3 colorBottom;',
        'varying vec2 vUv;',
        'void main() {',
        '  gl_FragColor = vec4(mix(colorBottom, colorTop, vUv.y), 1.0);',
        '}'
    ].join('\n'),
    depthWrite: false
});
var bgMesh = new THREE.Mesh(bgGeo, bgMat);
bgMesh.position.set(0, 2, -30);
scene.add(bgMesh);
scene.background = null;
```

- [ ] **Step 4: Test all ship types**

Click ships of different types and verify each model renders correctly in the preview:
- Cargo
- Tanker
- Passenger
- Fishing
- Military
- Tug
- Other/Generic

- [ ] **Step 5: Commit**

```bash
git add static/js/ship-preview-3d.js static/js/ui-controls.js static/css/main.css
git commit -m "fix: polish ship preview edge cases and gradient background"
```
