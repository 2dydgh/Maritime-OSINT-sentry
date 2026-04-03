# Roll Viewer 비주얼 업그레이드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roll viewer의 3D 씬을 시뮬레이터급 비주얼로 업그레이드 — Water 셰이더, Bloom, 시네마틱 카메라, 물보라 파티클, 선종별 고퀄리티 선박 모델.

**Architecture:** 기존 `roll-viewer.js`의 IIFE 구조 유지. Water/PostProcessing은 Three.js 0.137.0 CDN에서 추가 로드. 선박 모델은 `buildShip(type)` 내부에서 선종별 분기. 패널 CSS만 리디자인.

**Tech Stack:** Three.js 0.137.0 (CDN, legacy `examples/js/` pattern), vanilla JS, CSS

**Spec:** `docs/superpowers/specs/2026-04-03-roll-viewer-visual-upgrade-design.md`

**Note:** 이 프로젝트는 vanilla JS 프론트엔드로 테스트 프레임워크가 없음. 각 태스크의 검증은 브라우저에서 시각적 확인으로 수행.

---

### Task 1: Three.js 추가 모듈 CDN 로드

**Files:**
- Modify: `static/index.html:30-31` (Three.js 스크립트 태그 영역)

- [ ] **Step 1: index.html에 추가 스크립트 태그 삽입**

기존 Three.js 스크립트 태그 뒤에 추가:

```html
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/objects/Water.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/shaders/CopyShader.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/shaders/LuminosityHighPassShader.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/postprocessing/EffectComposer.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/postprocessing/RenderPass.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/postprocessing/UnrealBloomPass.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/postprocessing/ShaderPass.js"></script>
```

전체 스크립트 영역은 이렇게 됨:
```html
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/build/three.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/controls/OrbitControls.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/objects/Water.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/shaders/CopyShader.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/shaders/LuminosityHighPassShader.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/postprocessing/EffectComposer.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/postprocessing/RenderPass.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/postprocessing/UnrealBloomPass.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/postprocessing/ShaderPass.js"></script>
```

- [ ] **Step 2: 브라우저 콘솔에서 로드 확인**

브라우저 개발자 도구 콘솔에서 확인:
```
THREE.Water        // function 이면 OK
THREE.EffectComposer  // function 이면 OK
THREE.UnrealBloomPass // function 이면 OK
```

- [ ] **Step 3: Commit**

```bash
git add static/index.html
git commit -m "feat(roll-viewer): add Three.js Water and PostProcessing CDN imports"
```

---

### Task 2: Water Shader 교체

**Files:**
- Modify: `static/js/roll-viewer.js` — `buildWater()`, `animateWater()`, `initScene()`, `dispose()`

기존 PlaneGeometry + MeshPhongMaterial 바다를 Three.js Water 셰이더로 교체한다.

- [ ] **Step 1: 상단 state에 composer 변수 추가**

`var waterMesh = null;` 아래에 추가:

```javascript
    var composer = null;
    var waterNormals = null;
```

- [ ] **Step 2: `buildWater()` 함수를 Water 셰이더로 교체**

기존 `buildWater()` 전체를 이 코드로 교체:

```javascript
    // ── buildWater() — Three.js Water shader with reflection/refraction ──
    function buildWater() {
        var THREE = window.THREE;

        var waterGeometry = new THREE.PlaneGeometry(2000, 2000);

        // Load water normal map
        var loader = new THREE.TextureLoader();
        waterNormals = loader.load(
            'https://raw.githubusercontent.com/mrdoob/three.js/r137/examples/textures/waternormals.jpg',
            function(texture) {
                texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
            }
        );

        waterMesh = new THREE.Water(waterGeometry, {
            textureWidth: 512,
            textureHeight: 512,
            waterNormals: waterNormals,
            sunDirection: new THREE.Vector3(0.7, 0.5, 0.3).normalize(),
            sunColor: 0xffffff,
            waterColor: 0x001e3d,
            distortionScale: Math.max(weather.waveHeight * 1.5, 1.0),
            fog: scene.fog !== undefined
        });

        waterMesh.rotation.x = -Math.PI / 2;
        waterMesh.position.y = 0;
        scene.add(waterMesh);
    }
```

- [ ] **Step 3: `animateWater()` 함수를 Water uniform 업데이트로 교체**

기존 `animateWater(time)` 전체를 이 코드로 교체:

```javascript
    // ── animateWater(time) — update Water shader uniforms ──
    function animateWater(time) {
        if (!waterMesh || !waterMesh.material || !waterMesh.material.uniforms) return;
        // Wave speed derived from period (longer period = slower)
        var speed = 0.8 / Math.max(weather.wavePeriod || 8, 1);
        waterMesh.material.uniforms['time'].value = time * speed;
    }
```

- [ ] **Step 4: `initScene()`에서 renderer 설정 보강**

`initScene()` 함수 내 `renderer = new THREE.WebGLRenderer(...)` 생성 직후, `renderer.setPixelRatio(...)` 줄 앞에 추가:

```javascript
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.6;
```

- [ ] **Step 5: `buildSky()`의 하단 horizon glow ring 제거**

`buildSky()` 함수 내에서 `// Horizon glow ring` 주석부터 `scene.add(ring);`까지 삭제. Water 셰이더가 수평선을 자체적으로 처리하므로 중복됨.

해당 코드 (삭제 대상):
```javascript
        // Horizon glow ring — thin ring at water level for soft horizon line
        var ringGeo = new THREE.RingGeometry(180, 400, 64);
        ringGeo.rotateX(-Math.PI / 2);
        var ringMat = new THREE.MeshBasicMaterial({
            color: 0x4a6a8a,
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide
        });
        var ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.y = -0.1;
        scene.add(ring);
```

- [ ] **Step 6: 브라우저에서 확인**

롤 뷰어를 열어서 반사/굴절이 보이는 사실적 바다가 렌더링되는지 확인. 하늘이 수면에 비치고, 파도가 시간에 따라 움직여야 함.

- [ ] **Step 7: Commit**

```bash
git add static/js/roll-viewer.js
git commit -m "feat(roll-viewer): replace flat water with Three.js Water shader"
```

---

### Task 3: Post-Processing Pipeline (Bloom + 색보정)

**Files:**
- Modify: `static/js/roll-viewer.js` — `initScene()` 하단, `startAnimation()` 내 render 호출, `dispose()`

- [ ] **Step 1: `initScene()` 함수 끝에 EffectComposer 설정 추가**

`initScene()` 함수의 맨 끝 (`window.addEventListener('resize', _resizeHandler);` 줄 뒤)에 추가:

```javascript
        // ── Post-processing ──
        var renderPass = new THREE.RenderPass(scene, camera);
        var bloomPass = new THREE.UnrealBloomPass(
            new THREE.Vector2(w, h),
            0.4,   // strength — 은은하게
            0.5,   // radius
            0.7    // threshold — 밝은 부분만
        );

        composer = new THREE.EffectComposer(renderer);
        composer.addPass(renderPass);
        composer.addPass(bloomPass);
```

- [ ] **Step 2: `startAnimation()` 내 렌더 호출 교체**

`startAnimation()` 함수 내 loop() 끝 부분에서:

기존:
```javascript
            if (renderer && scene && camera) renderer.render(scene, camera);
```

교체:
```javascript
            if (composer) {
                composer.render();
            } else if (renderer && scene && camera) {
                renderer.render(scene, camera);
            }
```

- [ ] **Step 3: resize 핸들러에 composer 리사이즈 추가**

`_resizeHandler` 함수 내 `renderer.setSize(ww, hh);` 줄 뒤에 추가:

```javascript
            if (composer) composer.setSize(ww, hh);
```

- [ ] **Step 4: `dispose()`에 composer 정리 추가**

`dispose()` 함수 내 `// Dispose controls` 주석 바로 앞에 추가:

```javascript
        // Dispose composer
        if (composer) {
            composer.dispose();
            composer = null;
        }
```

- [ ] **Step 5: 브릿지 창문 emissive 강화**

`buildShip()` 함수(및 이후 Task 6의 선종별 빌드 함수)에서 브릿지 창문의 emissiveIntensity를 0.3 → 0.8로 올려서 Bloom 효과가 잘 드러나게 함. 현재 코드:

기존:
```javascript
            emissiveIntensity: 0.3
```

교체:
```javascript
            emissiveIntensity: 0.8
```

- [ ] **Step 6: 브라우저에서 확인**

롤 뷰어를 열어서 브릿지 창문 주변에 은은한 글로우가 보이는지, 수면 반사 하이라이트에 블룸이 걸리는지 확인.

- [ ] **Step 7: Commit**

```bash
git add static/js/roll-viewer.js
git commit -m "feat(roll-viewer): add Bloom post-processing pipeline"
```

---

### Task 4: Cinematic Camera Entry

**Files:**
- Modify: `static/js/roll-viewer.js` — `startAnimation()`, 새 함수 `animateCamera()`

- [ ] **Step 1: 상단 state에 카메라 애니메이션 변수 추가**

`var rollParams = null;` 아래에 추가:

```javascript
    var cameraAnimating = false;
    var cameraAnimStart = 0;
    var CAMERA_ANIM_DURATION = 2.0; // seconds
```

- [ ] **Step 2: easeOutCubic 헬퍼 + animateCamera 함수 추가**

`// ── Helpers ──` 섹션 내 `getShipTypeKey()` 함수 뒤에 추가:

```javascript
    function easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    // Camera start/end positions for cinematic entry
    var CAM_START = { x: 80, y: 40, z: 80 };
    var CAM_END   = { x: 30, y: 20, z: 40 };

    function animateCamera(elapsed) {
        if (!cameraAnimating) return;

        var t = Math.min((elapsed - cameraAnimStart) / CAMERA_ANIM_DURATION, 1);
        var e = easeOutCubic(t);

        camera.position.set(
            CAM_START.x + (CAM_END.x - CAM_START.x) * e,
            CAM_START.y + (CAM_END.y - CAM_START.y) * e,
            CAM_START.z + (CAM_END.z - CAM_START.z) * e
        );
        camera.lookAt(0, 2, 0);

        if (t >= 1) {
            cameraAnimating = false;
            if (controls) {
                controls.enabled = true;
                controls.update();
            }
        }
    }
```

- [ ] **Step 3: `startAnimation()`에서 카메라 애니메이션 시작**

`startAnimation()` 함수 내 `clockStart = performance.now();` 줄 뒤에 추가:

```javascript
        // Start cinematic camera zoom-in
        cameraAnimating = true;
        cameraAnimStart = 0;
        camera.position.set(CAM_START.x, CAM_START.y, CAM_START.z);
        camera.lookAt(0, 2, 0);
        if (controls) controls.enabled = false;
```

그리고 loop() 내 `animateWater(elapsed);` 줄 뒤에 추가:

```javascript
            animateCamera(elapsed);
```

- [ ] **Step 4: `initScene()`의 초기 카메라 위치를 시작점으로 변경**

`initScene()` 내:

기존:
```javascript
        camera.position.set(30, 20, 40);
        camera.lookAt(0, 0, 0);
```

교체:
```javascript
        camera.position.set(CAM_START.x, CAM_START.y, CAM_START.z);
        camera.lookAt(0, 2, 0);
```

- [ ] **Step 5: dispose()에서 카메라 상태 초기화**

`dispose()` 함수 내 `clockStart = null;` 줄 뒤에 추가:

```javascript
        cameraAnimating = false;
```

- [ ] **Step 6: 브라우저에서 확인**

롤 뷰어를 열면 멀리서 선박 쪽으로 2초간 부드럽게 줌인되는지 확인. 줌인 완료 후 OrbitControls로 마우스 조작 가능해야 함.

- [ ] **Step 7: Commit**

```bash
git add static/js/roll-viewer.js
git commit -m "feat(roll-viewer): add cinematic camera zoom-in on entry"
```

---

### Task 5: Spray Particles (물보라)

**Files:**
- Modify: `static/js/roll-viewer.js` — 새 함수 `buildSpray()`, `animateSpray()`, `startAnimation()` 수정, `dispose()` 수정

- [ ] **Step 1: 상단 state에 파티클 변수 추가**

`var waterNormals = null;` 아래에 추가:

```javascript
    var sprayPoints = null;
    var sprayVelocities = [];
    var SPRAY_COUNT = 80;
```

- [ ] **Step 2: `buildSpray()` 함수 추가**

`buildCompass()` 함수 뒤에 추가:

```javascript
    // ── buildSpray() — bow spray particle system ──
    function buildSpray() {
        var THREE = window.THREE;

        var geometry = new THREE.BufferGeometry();
        var positions = new Float32Array(SPRAY_COUNT * 3);
        var sizes = new Float32Array(SPRAY_COUNT);
        var opacities = new Float32Array(SPRAY_COUNT);

        sprayVelocities = [];

        for (var i = 0; i < SPRAY_COUNT; i++) {
            // Start at bow position (x ~8, y ~2, z ~0 in ship space)
            positions[i * 3]     = 7 + Math.random() * 2;      // x: bow area
            positions[i * 3 + 1] = 1 + Math.random() * 0.5;    // y: just above waterline
            positions[i * 3 + 2] = (Math.random() - 0.5) * 3;  // z: slight spread

            sizes[i] = 0.3 + Math.random() * 0.5;
            opacities[i] = 0;

            sprayVelocities.push({
                vx: 0.5 + Math.random() * 1.5,
                vy: 2 + Math.random() * 3,
                vz: (Math.random() - 0.5) * 2,
                life: 0,
                maxLife: 0.8 + Math.random() * 1.2
            });
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

        var material = new THREE.PointsMaterial({
            color: 0xffffff,
            size: 0.4,
            transparent: true,
            opacity: 0.6,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            sizeAttenuation: true
        });

        sprayPoints = new THREE.Points(geometry, material);
        scene.add(sprayPoints);
    }

    // ── animateSpray(dt) — update spray particles each frame ──
    function animateSpray(dt) {
        if (!sprayPoints) return;

        var pos = sprayPoints.geometry.attributes.position;
        var intensity = Math.min(weather.waveHeight / 3, 1) * 0.8 + 0.2; // 0.2 ~ 1.0
        var gravity = -6;

        for (var i = 0; i < SPRAY_COUNT; i++) {
            var v = sprayVelocities[i];
            v.life += dt;

            if (v.life >= v.maxLife) {
                // Reset particle to bow
                pos.setXYZ(i,
                    7 + Math.random() * 2,
                    1 + Math.random() * 0.5,
                    (Math.random() - 0.5) * 3
                );
                v.vx = (0.5 + Math.random() * 1.5) * intensity;
                v.vy = (2 + Math.random() * 3) * intensity;
                v.vz = (Math.random() - 0.5) * 2 * intensity;
                v.life = 0;
                v.maxLife = 0.8 + Math.random() * 1.2;
                continue;
            }

            var x = pos.getX(i) + v.vx * dt;
            var y = pos.getY(i) + v.vy * dt;
            var z = pos.getZ(i) + v.vz * dt;

            // Apply gravity
            v.vy += gravity * dt;

            // Kill if below water
            if (y < 0) {
                v.life = v.maxLife; // force reset next frame
                y = 0;
            }

            pos.setXYZ(i, x, y, z);
        }

        // Fade overall opacity by wave intensity
        sprayPoints.material.opacity = 0.5 * intensity;
        pos.needsUpdate = true;
    }
```

- [ ] **Step 3: `load()` 함수에서 `buildSpray()` 호출 추가**

`load()` 함수 내 `buildShip(shipType);` 줄 뒤에 추가:

```javascript
        buildSpray();
```

- [ ] **Step 4: `startAnimation()` 내 loop()에서 `animateSpray()` 호출**

loop() 내 `animateCamera(elapsed);` 줄 뒤에 추가:

```javascript
            animateSpray(1 / 60); // ~60fps delta
```

- [ ] **Step 5: `dispose()`에 파티클 정리 추가**

`dispose()` 내 `waterMesh = null;` 줄 뒤에 추가:

```javascript
        sprayPoints = null;
        sprayVelocities = [];
```

- [ ] **Step 6: 브라우저에서 확인**

롤 뷰어에서 선수 부근에 흰색 물보라 파티클이 위로 튀었다가 중력으로 떨어지는지 확인. 파고가 높으면 파티클이 더 크고 많아야 함.

- [ ] **Step 7: Commit**

```bash
git add static/js/roll-viewer.js
git commit -m "feat(roll-viewer): add bow spray particle system"
```

---

### Task 6: 선종별 고퀄리티 Ship Model (6종)

**Files:**
- Modify: `static/js/roll-viewer.js` — `buildShip(type)` 전체 교체

이 태스크는 기존 `buildShip(type)` 함수를 선종별 전용 빌더로 교체한다. 모든 모델은 MeshStandardMaterial(PBR)로 업그레이드하며, 각 선종의 특징적 구조물을 표현한다.

- [ ] **Step 1: 공통 머티리얼 헬퍼 추가**

`buildCompass()` 함수 앞에 추가:

```javascript
    // ── Ship model helpers ──
    function shipMat(color, opts) {
        var THREE = window.THREE;
        var params = {
            color: new THREE.Color(color),
            roughness: (opts && opts.roughness !== undefined) ? opts.roughness : 0.7,
            metalness: (opts && opts.metalness !== undefined) ? opts.metalness : 0.3
        };
        if (opts && opts.emissive) {
            params.emissive = new THREE.Color(opts.emissive);
            params.emissiveIntensity = opts.emissiveIntensity || 0.8;
        }
        return new THREE.MeshStandardMaterial(params);
    }

    function addToShip(mesh) {
        shipGroup.add(mesh);
        return mesh;
    }
```

- [ ] **Step 2: `buildShip(type)` 함수를 분기 구조로 교체**

기존 `buildShip(type)` 함수 전체를 삭제하고, 다음 코드로 교체:

```javascript
    // ── buildShip(type) — high-quality ship model per type ──
    function buildShip(type) {
        var THREE = window.THREE;
        var color = (window.SHIP_COLORS && window.SHIP_COLORS[type]) || '#6b7280';

        shipGroup = new THREE.Group();

        switch (type) {
            case 'tanker':    buildTanker(THREE, color); break;
            case 'cargo':     buildCargo(THREE, color); break;
            case 'passenger': buildPassenger(THREE, color); break;
            case 'fishing':   buildFishing(THREE, color); break;
            case 'military':  buildMilitary(THREE, color); break;
            case 'tug':       buildTug(THREE, color); break;
            default:          buildGenericShip(THREE, color); break;
        }

        shipGroup.position.y = 1;
        scene.add(shipGroup);
    }
```

- [ ] **Step 3: buildTanker() 구현**

`buildShip()` 함수 바로 뒤에 추가:

```javascript
    // ── Tanker: 낮고 긴 선체, 파이프라인, 매니폴드 ──
    function buildTanker(THREE, color) {
        // Hull — long, low profile, gentle bow
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-8, -2.2);
        hullShape.lineTo(-8, 2.2);
        hullShape.quadraticCurveTo(6, 2, 10, 0);
        hullShape.quadraticCurveTo(6, -2, -8, -2.2);

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 3.5, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.2, bevelSegments: 3 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat(color));
        hull.position.set(0, 1.2, -1.75);
        addToShip(hull);

        // Deck
        var deckGeo = new THREE.BoxGeometry(16, 0.2, 4.2);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#3f3f46'))).position.set(0, 3.0, 0);

        // Tanker pipes — 3 parallel pipes running along deck
        for (var p = -1; p <= 1; p++) {
            var pipeGeo = new THREE.CylinderGeometry(0.08, 0.08, 12, 8);
            pipeGeo.rotateZ(Math.PI / 2);
            addToShip(new THREE.Mesh(pipeGeo, shipMat('#71717a', { metalness: 0.6 }))).position.set(0, 3.3, p * 1.2);
        }

        // Manifold — central hub
        var manifoldGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 12);
        addToShip(new THREE.Mesh(manifoldGeo, shipMat('#52525b', { metalness: 0.7 }))).position.set(0, 3.5, 0);

        // Pipe risers (vertical)
        for (var r = -1; r <= 1; r++) {
            var riserGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.8, 6);
            addToShip(new THREE.Mesh(riserGeo, shipMat('#71717a', { metalness: 0.6 }))).position.set(0, 3.5, r * 1.2);
        }

        // Bridge — low, at stern
        var bridgeGeo = new THREE.BoxGeometry(3.5, 2.5, 3.5);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#3f3f46'))).position.set(-5.5, 4.3, 0);

        // Bridge windows
        var winGeo = new THREE.BoxGeometry(0.1, 0.5, 2.8);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-3.7, 4.6, 0);

        // Funnel
        var funnelGeo = new THREE.CylinderGeometry(0.4, 0.5, 2.2, 8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#27272a'))).position.set(-6.5, 5.5, 0);

        // Funnel stripe
        var stripeGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.3, 8);
        addToShip(new THREE.Mesh(stripeGeo, shipMat(color))).position.set(-6.5, 5.8, 0);
    }
```

- [ ] **Step 4: buildCargo() 구현**

`buildTanker()` 뒤에 추가:

```javascript
    // ── Cargo: 컨테이너 적재, 크레인, 높은 브릿지 ──
    function buildCargo(THREE, color) {
        // Hull
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-7, -2);
        hullShape.lineTo(-7, 2);
        hullShape.lineTo(5, 1.5);
        hullShape.lineTo(9, 0);
        hullShape.lineTo(5, -1.5);
        hullShape.closePath();

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 3.8, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.2, bevelSegments: 3 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat(color));
        hull.position.set(0, 1.2, -1.9);
        addToShip(hull);

        // Deck
        var deckGeo = new THREE.BoxGeometry(15, 0.2, 3.8);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#3f3f46'))).position.set(0.5, 3.0, 0);

        // Containers — stacked 2-3 layers, random colors
        var containerColors = ['#dc2626', '#2563eb', '#16a34a', '#ca8a04', '#9333ea', '#0891b2'];
        var rows = [
            { x: 3.5, layers: 3 },
            { x: 1.5, layers: 2 },
            { x: -0.5, layers: 3 },
            { x: -2.5, layers: 2 }
        ];

        rows.forEach(function(row) {
            for (var layer = 0; layer < row.layers; layer++) {
                for (var z = -1; z <= 1; z++) {
                    var cGeo = new THREE.BoxGeometry(1.6, 0.9, 1.1);
                    var cColor = containerColors[Math.floor(Math.random() * containerColors.length)];
                    var container = new THREE.Mesh(cGeo, shipMat(cColor, { roughness: 0.8, metalness: 0.2 }));
                    container.position.set(row.x, 3.6 + layer * 0.95, z * 1.2);
                    addToShip(container);
                }
            }
        });

        // Crane — between containers and bridge
        var craneBaseGeo = new THREE.BoxGeometry(0.4, 3, 0.4);
        addToShip(new THREE.Mesh(craneBaseGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-4, 4.5, 1.2);
        addToShip(new THREE.Mesh(craneBaseGeo.clone(), shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-4, 4.5, -1.2);

        var craneBoomGeo = new THREE.CylinderGeometry(0.1, 0.1, 4, 6);
        craneBoomGeo.rotateZ(Math.PI / 4);
        addToShip(new THREE.Mesh(craneBoomGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-3, 6.5, 0);

        // Bridge — tall, at stern
        var bridgeGeo = new THREE.BoxGeometry(3, 3.5, 3.5);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#3f3f46'))).position.set(-5.5, 4.8, 0);

        // Bridge windows
        var winGeo = new THREE.BoxGeometry(0.1, 0.6, 2.8);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-3.95, 5.2, 0);

        // Funnel
        var funnelGeo = new THREE.CylinderGeometry(0.35, 0.45, 2, 8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#27272a'))).position.set(-6.5, 6.5, 0);
    }
```

- [ ] **Step 5: buildPassenger() 구현**

`buildCargo()` 뒤에 추가:

```javascript
    // ── Passenger: 다층 데크, 넓은 상부구조, 큰 펀넬 ──
    function buildPassenger(THREE, color) {
        // Hull — wide, streamlined bow
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-7, -2.5);
        hullShape.lineTo(-7, 2.5);
        hullShape.quadraticCurveTo(5, 2.2, 10, 0);
        hullShape.quadraticCurveTo(5, -2.2, -7, -2.5);

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 3.5, bevelEnabled: true, bevelThickness: 0.4, bevelSize: 0.3, bevelSegments: 4 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat('#f8fafc', { roughness: 0.5 }));
        hull.position.set(0, 1.0, -1.75);
        addToShip(hull);

        // Multi-deck superstructure (4 layers)
        var deckWidths = [13, 12, 10, 8];
        var deckDepths = [4.5, 4.0, 3.5, 2.8];
        for (var d = 0; d < 4; d++) {
            var dGeo = new THREE.BoxGeometry(deckWidths[d], 1.0, deckDepths[d]);
            var deck = new THREE.Mesh(dGeo, shipMat('#e2e8f0', { roughness: 0.6 }));
            deck.position.set(-0.5 + d * 0.3, 3.4 + d * 1.05, 0);
            addToShip(deck);

            // Window line on each deck — emissive strip
            var winStripGeo = new THREE.BoxGeometry(deckWidths[d] - 1, 0.15, deckDepths[d] + 0.02);
            var winStrip = new THREE.Mesh(winStripGeo, shipMat('#fbbf24', { emissive: '#fbbf24', emissiveIntensity: 0.5, roughness: 0.3 }));
            winStrip.position.set(-0.5 + d * 0.3, 3.7 + d * 1.05, 0);
            addToShip(winStrip);
        }

        // Bridge — top deck
        var bridgeGeo = new THREE.BoxGeometry(3, 1.5, 2.5);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#cbd5e1'))).position.set(-1, 8.2, 0);

        // Bridge windows
        var winGeo = new THREE.BoxGeometry(3.02, 0.4, 2.52);
        addToShip(new THREE.Mesh(winGeo, shipMat('#0ea5e9', { emissive: '#0ea5e9', emissiveIntensity: 0.8 }))).position.set(-1, 8.5, 0);

        // Funnel — large, cruise style
        var funnelGeo = new THREE.CylinderGeometry(0.6, 0.8, 3, 12);
        addToShip(new THREE.Mesh(funnelGeo, shipMat(color))).position.set(-3, 8.5, 0);

        // Funnel top
        var topGeo = new THREE.CylinderGeometry(0.7, 0.6, 0.5, 12);
        addToShip(new THREE.Mesh(topGeo, shipMat('#1e293b'))).position.set(-3, 10.1, 0);
    }
```

- [ ] **Step 6: buildFishing() 구현**

```javascript
    // ── Fishing: 작은 선체, 아웃리거/붐, 마스트 ──
    function buildFishing(THREE, color) {
        // Hull — short, wide
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-4, -1.5);
        hullShape.lineTo(-4, 1.5);
        hullShape.lineTo(2, 1);
        hullShape.lineTo(5, 0);
        hullShape.lineTo(2, -1);
        hullShape.closePath();

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 2.5, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.15, bevelSegments: 2 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat(color));
        hull.position.set(0, 1.0, -1.25);
        addToShip(hull);

        // Deck
        var deckGeo = new THREE.BoxGeometry(8, 0.15, 2.8);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#4b5563'))).position.set(0.5, 2.5, 0);

        // Small bridge
        var bridgeGeo = new THREE.BoxGeometry(2, 1.8, 2);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#374151'))).position.set(-2, 3.5, 0);

        // Bridge windows
        var winGeo = new THREE.BoxGeometry(0.1, 0.35, 1.5);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-0.95, 3.7, 0);

        // Mast — tall
        var mastGeo = new THREE.CylinderGeometry(0.04, 0.06, 5, 6);
        addToShip(new THREE.Mesh(mastGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(0, 5.0, 0);

        // Outrigger booms (2, angled outward)
        var boomGeo = new THREE.CylinderGeometry(0.03, 0.05, 5, 6);
        var boom1 = new THREE.Mesh(boomGeo, shipMat('#9ca3af', { metalness: 0.5 }));
        boom1.position.set(0, 5.5, 1.5);
        boom1.rotation.x = -0.5;
        boom1.rotation.z = 0.3;
        addToShip(boom1);

        var boom2 = new THREE.Mesh(boomGeo.clone(), shipMat('#9ca3af', { metalness: 0.5 }));
        boom2.position.set(0, 5.5, -1.5);
        boom2.rotation.x = 0.5;
        boom2.rotation.z = 0.3;
        addToShip(boom2);

        // Net reel at stern
        var reelGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.5, 8);
        reelGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(reelGeo, shipMat('#6b7280', { metalness: 0.4 }))).position.set(-3.5, 2.8, 0);
    }
```

- [ ] **Step 7: buildMilitary() 구현**

```javascript
    // ── Military: 날렵한 선체, 스텔스 상부구조, 무장 ──
    function buildMilitary(THREE, color) {
        // Hull — sharp V-bow, angular
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-7, -1.8);
        hullShape.lineTo(-7, 1.8);
        hullShape.lineTo(4, 1.0);
        hullShape.lineTo(10, 0);
        hullShape.lineTo(4, -1.0);
        hullShape.closePath();

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 2.8, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 2 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat('#6b7280', { roughness: 0.6 }));
        hull.position.set(0, 1.2, -1.4);
        addToShip(hull);

        // Deck
        var deckGeo = new THREE.BoxGeometry(15, 0.15, 3.2);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#4b5563'))).position.set(0.5, 2.9, 0);

        // Stealth superstructure — angled faces (trapezoid shape via extrude)
        var superShape = new THREE.Shape();
        superShape.moveTo(-3, -1.3);
        superShape.lineTo(-3, 1.3);
        superShape.lineTo(-2.5, 1.5);
        superShape.lineTo(2.5, 1.5);
        superShape.lineTo(3, 1.3);
        superShape.lineTo(3, -1.3);
        superShape.lineTo(2.5, -1.5);
        superShape.lineTo(-2.5, -1.5);
        superShape.closePath();

        var superGeo = new THREE.ExtrudeGeometry(superShape, { depth: 2.5, bevelEnabled: false });
        superGeo.rotateX(-Math.PI / 2);
        var superstructure = new THREE.Mesh(superGeo, shipMat('#52525b'));
        superstructure.position.set(-2, 3.0, -1.25);
        addToShip(superstructure);

        // Bridge windows — narrow slit
        var winGeo = new THREE.BoxGeometry(5, 0.25, 2.8);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(-2, 4.8, 0);

        // Forward turret
        var turretBase = new THREE.CylinderGeometry(0.6, 0.7, 0.5, 12);
        addToShip(new THREE.Mesh(turretBase, shipMat('#4b5563', { metalness: 0.5 }))).position.set(4, 3.3, 0);

        var barrelGeo = new THREE.CylinderGeometry(0.06, 0.08, 2.5, 6);
        barrelGeo.rotateZ(-Math.PI / 2);
        addToShip(new THREE.Mesh(barrelGeo, shipMat('#374151', { metalness: 0.6 }))).position.set(5.5, 3.5, 0);

        // Radar mast
        var mastGeo = new THREE.CylinderGeometry(0.05, 0.08, 4, 6);
        addToShip(new THREE.Mesh(mastGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(-2, 7.3, 0);

        // Radar dish
        var radarGeo = new THREE.BoxGeometry(2, 0.08, 0.5);
        addToShip(new THREE.Mesh(radarGeo, shipMat('#94a3b8', { metalness: 0.4 }))).position.set(-2, 9, 0);

        // Funnel — low, integrated
        var funnelGeo = new THREE.BoxGeometry(1.2, 1.5, 1.8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#3f3f46'))).position.set(-5, 4.5, 0);
    }
```

- [ ] **Step 8: buildTug() 구현**

```javascript
    // ── Tug: 짧고 넓은 선체, 큰 브릿지, 예인 장비 ──
    function buildTug(THREE, color) {
        // Hull — short, wide, high freeboard
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-3, -1.8);
        hullShape.lineTo(-3, 1.8);
        hullShape.lineTo(2, 1.5);
        hullShape.lineTo(4, 0);
        hullShape.lineTo(2, -1.5);
        hullShape.closePath();

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 3.5, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.2, bevelSegments: 3 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat(color));
        hull.position.set(0, 1.2, -1.75);
        addToShip(hull);

        // Deck
        var deckGeo = new THREE.BoxGeometry(6, 0.2, 3.2);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#4b5563'))).position.set(0.5, 3.0, 0);

        // Bridge — large relative to hull
        var bridgeGeo = new THREE.BoxGeometry(2.5, 2.8, 2.8);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#374151'))).position.set(0, 4.5, 0);

        // Bridge windows — wrap-around
        var winFront = new THREE.BoxGeometry(0.1, 0.5, 2.2);
        addToShip(new THREE.Mesh(winFront, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(1.3, 4.8, 0);

        var winSide1 = new THREE.BoxGeometry(2, 0.5, 0.1);
        addToShip(new THREE.Mesh(winSide1, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(0, 4.8, 1.45);
        addToShip(new THREE.Mesh(winSide1.clone(), shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(0, 4.8, -1.45);

        // Funnel
        var funnelGeo = new THREE.CylinderGeometry(0.35, 0.4, 1.5, 8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#1e293b'))).position.set(-1.5, 5.5, 0);

        // Tow winch at stern
        var winchGeo = new THREE.CylinderGeometry(0.4, 0.4, 1.2, 10);
        winchGeo.rotateX(Math.PI / 2);
        addToShip(new THREE.Mesh(winchGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-2.5, 3.3, 0);

        // Tow hook/bitts
        var bittGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.6, 6);
        addToShip(new THREE.Mesh(bittGeo, shipMat('#374151', { metalness: 0.6 }))).position.set(-3, 3.3, 0.5);
        addToShip(new THREE.Mesh(bittGeo.clone(), shipMat('#374151', { metalness: 0.6 }))).position.set(-3, 3.3, -0.5);

        // Fenders — rubber bumpers on sides
        var fenderGeo = new THREE.TorusGeometry(0.25, 0.1, 8, 12);
        for (var f = -1; f <= 2; f++) {
            var fender1 = new THREE.Mesh(fenderGeo, shipMat('#1e293b', { roughness: 0.9 }));
            fender1.position.set(f * 1.5, 2.0, 1.9);
            fender1.rotation.y = Math.PI / 2;
            addToShip(fender1);

            var fender2 = new THREE.Mesh(fenderGeo.clone(), shipMat('#1e293b', { roughness: 0.9 }));
            fender2.position.set(f * 1.5, 2.0, -1.9);
            fender2.rotation.y = Math.PI / 2;
            addToShip(fender2);
        }
    }
```

- [ ] **Step 9: buildGenericShip() 구현 (기존 'other' 타입)**

```javascript
    // ── Generic/Other: 기본 선박 모델 ──
    function buildGenericShip(THREE, color) {
        // Hull
        var hullShape = new THREE.Shape();
        hullShape.moveTo(-6, -2);
        hullShape.lineTo(-6, 2);
        hullShape.lineTo(4, 1.2);
        hullShape.lineTo(8, 0);
        hullShape.lineTo(4, -1.2);
        hullShape.closePath();

        var hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 3, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.15, bevelSegments: 2 });
        hullGeo.rotateX(-Math.PI / 2);
        var hull = new THREE.Mesh(hullGeo, shipMat(color));
        hull.position.set(0, 1.5, -1.5);
        addToShip(hull);

        // Deck
        var deckGeo = new THREE.BoxGeometry(12, 0.2, 3.5);
        addToShip(new THREE.Mesh(deckGeo, shipMat('#3f3f46'))).position.set(0, 3.1, 0);

        // Bridge
        var bridgeGeo = new THREE.BoxGeometry(3, 2.5, 2.8);
        addToShip(new THREE.Mesh(bridgeGeo, shipMat('#52525b'))).position.set(-3, 4.5, 0);

        // Bridge windows
        var winGeo = new THREE.BoxGeometry(0.1, 0.6, 2.2);
        addToShip(new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-1.45, 4.8, 0);

        // Funnel
        var funnelGeo = new THREE.CylinderGeometry(0.4, 0.5, 2, 8);
        addToShip(new THREE.Mesh(funnelGeo, shipMat('#27272a'))).position.set(-4.5, 5, 0);

        // Mast
        var mastGeo = new THREE.CylinderGeometry(0.05, 0.05, 3, 4);
        addToShip(new THREE.Mesh(mastGeo, shipMat('#71717a'))).position.set(-3, 7, 0);
    }
```

- [ ] **Step 10: 브라우저에서 확인**

각 선종별로 롤 뷰어를 열어서 모델 형상이 다른지 확인. 탱커는 파이프라인, 화물선은 컨테이너, 여객선은 다층 데크 등이 보여야 함.

- [ ] **Step 11: Commit**

```bash
git add static/js/roll-viewer.js
git commit -m "feat(roll-viewer): add 6 ship-type-specific 3D models with PBR materials"
```

---

### Task 7: Panel CSS 리디자인

**Files:**
- Modify: `static/css/main.css:522-762` (롤 뷰어 CSS 섹션)

패널의 정보 구성은 그대로 유지하면서, 시각적 스타일을 지구본 뷰 패널과 통일감 있게 다듬는다.

- [ ] **Step 1: 게이지 그라디언트 개선**

기존 단색 게이지 fill을 그라디언트로 교체:

기존:
```css
.roll-gauge-safe .roll-gauge-fill { background: var(--secondary); }
.roll-gauge-caution .roll-gauge-fill { background: var(--secondary); }
.roll-gauge-warning .roll-gauge-fill { background: var(--accent-amber); }
.roll-gauge-danger .roll-gauge-fill { background: var(--accent-red); }
```

교체:
```css
.roll-gauge-safe .roll-gauge-fill { background: linear-gradient(90deg, var(--secondary), rgba(64, 111, 216, 0.6)); }
.roll-gauge-caution .roll-gauge-fill { background: linear-gradient(90deg, var(--secondary), #fbbf24); }
.roll-gauge-warning .roll-gauge-fill { background: linear-gradient(90deg, #f59e0b, var(--accent-amber)); }
.roll-gauge-danger .roll-gauge-fill { background: linear-gradient(90deg, #f97316, var(--accent-red)); }
```

- [ ] **Step 2: 게이지 바 높이와 라운드 조정**

기존:
```css
.roll-gauge {
    position: relative;
    height: 24px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 4px;
    overflow: hidden;
    margin-top: 6px;
}
```

교체:
```css
.roll-gauge {
    position: relative;
    height: 20px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 6px;
    overflow: hidden;
    margin-top: 6px;
    border: 1px solid rgba(255, 255, 255, 0.06);
}
```

- [ ] **Step 3: 섹션 패딩/간격 미세 조정**

기존:
```css
.roll-viewer-section {
    padding: 14px 16px;
    border-bottom: 1px solid var(--panel-border);
}
```

교체:
```css
.roll-viewer-section {
    padding: 12px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
```

- [ ] **Step 4: 틸트 인디케이터 링 글로우 추가**

기존:
```css
.rv-tilt-ring {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    border: 2px solid var(--secondary);
    overflow: hidden;
    transition: border-color 0.3s ease;
}
```

교체:
```css
.rv-tilt-ring {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    border: 2px solid var(--secondary);
    overflow: hidden;
    transition: border-color 0.3s ease, box-shadow 0.3s ease;
    box-shadow: 0 0 8px rgba(64, 111, 216, 0.15);
}

.rv-tilt-indicator[data-level="warning"] .rv-tilt-ring { border-color: var(--accent-amber); box-shadow: 0 0 8px rgba(245, 158, 11, 0.2); }
.rv-tilt-indicator[data-level="danger"] .rv-tilt-ring { border-color: var(--accent-red); box-shadow: 0 0 12px rgba(239, 68, 68, 0.3); }
```

- [ ] **Step 5: 섹션 타이틀에 좌측 액센트 바 추가**

기존:
```css
.roll-viewer-section-title {
    font-size: 0.6rem;
    font-weight: 600;
    color: var(--text-dim);
    letter-spacing: 1px;
    text-transform: uppercase;
    margin-bottom: 8px;
}
```

교체:
```css
.roll-viewer-section-title {
    font-size: 0.6rem;
    font-weight: 600;
    color: var(--text-dim);
    letter-spacing: 1px;
    text-transform: uppercase;
    margin-bottom: 8px;
    padding-left: 8px;
    border-left: 2px solid var(--secondary);
}
```

- [ ] **Step 6: 브라우저에서 확인**

롤 뷰어 패널의 게이지 그라디언트, 섹션 구분, 틸트 링 글로우, 섹션 타이틀 액센트가 적용되었는지 확인.

- [ ] **Step 7: Commit**

```bash
git add static/css/main.css
git commit -m "feat(roll-viewer): redesign panel CSS with gradients and refined styling"
```

---

### Task 8: 최종 통합 검증 및 정리

**Files:**
- Review: `static/js/roll-viewer.js`, `static/css/main.css`, `static/index.html`

- [ ] **Step 1: 전체 기능 검증**

브라우저에서 다음을 확인:
1. 뷰어 진입 시 시네마틱 줌인 동작
2. Water 셰이더의 반사/굴절 렌더링
3. Bloom 효과 (브릿지 창문 글로우)
4. 물보라 파티클이 선수에서 발생
5. OrbitControls 정상 동작 (줌인 완료 후)
6. 패널 정보 표시 정상
7. ECharts 차트 업데이트 정상
8. 뒤로가기 버튼 동작
9. 다른 선박 선택 시 dispose/reload 정상

- [ ] **Step 2: 선종별 모델 검증**

최소 3개 선종에 대해 롤 뷰어를 열어서 모델이 다르게 보이는지 확인.

- [ ] **Step 3: 콘솔 에러 확인**

브라우저 개발자 도구에서 콘솔 에러가 없는지 확인. Three.js 관련 경고는 무시 가능하지만, 에러는 수정.

- [ ] **Step 4: 최종 Commit**

```bash
git add -A
git commit -m "feat(roll-viewer): complete visual upgrade — Water shader, Bloom, particles, 6 ship models"
```
