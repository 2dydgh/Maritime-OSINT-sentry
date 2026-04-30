// ── Ship Preview 3D — Thumbnail + Modal 3D ship model viewer ──
// Uses same ship builders & envMap as roll-viewer for identical look.
var ShipPreview3D = (function () {
    'use strict';

    var scene = null;
    var camera = null;
    var renderer = null;
    var controls = null;
    var shipGroup = null;
    var animFrameId = null;
    var activeContainer = null;
    var _resizeObserver = null;
    var modal = null;

    var _shipType = null;
    var _dimensions = null;

    function initThumbnail(containerEl, shipType, dimensions) {
        _shipType = shipType;
        _dimensions = dimensions;
        _initScene(containerEl, false);
    }

    function openModal() {
        if (modal) closeModal();
        _disposeRenderer();

        modal = document.createElement('div');
        modal.className = 'ship-preview-modal-backdrop';
        modal.innerHTML =
            '<div class="ship-preview-modal">' +
                '<div class="ship-preview-modal-header">' +
                    '<span class="ship-preview-modal-title">3D Model Viewer</span>' +
                    '<button class="ship-preview-modal-close" title="Close">&times;</button>' +
                '</div>' +
                '<div class="ship-preview-modal-body" id="shipPreviewModalBody"></div>' +
                '<div class="ship-preview-modal-footer" id="shipPreviewModalFooter"></div>' +
            '</div>';
        document.body.appendChild(modal);

        modal.querySelector('.ship-preview-modal-close').addEventListener('click', closeModal);
        modal.addEventListener('click', function (e) {
            if (e.target === modal) closeModal();
        });

        var footer = modal.querySelector('#shipPreviewModalFooter');
        if (_dimensions) {
            var parts = [];
            if (_dimensions.length) parts.push('<span class="modal-dim"><span class="modal-dim-label">Length</span><span class="modal-dim-val">' + _dimensions.length + ' m</span></span>');
            if (_dimensions.beam) parts.push('<span class="modal-dim"><span class="modal-dim-label">Beam</span><span class="modal-dim-val">' + _dimensions.beam + ' m</span></span>');
            if (_dimensions.draught) parts.push('<span class="modal-dim"><span class="modal-dim-label">Draught</span><span class="modal-dim-val">' + _dimensions.draught + ' m</span></span>');
            footer.innerHTML = parts.join('');
        }

        var body = modal.querySelector('#shipPreviewModalBody');
        setTimeout(function () { _initScene(body, true); }, 50);
    }

    function closeModal() {
        _disposeRenderer();
        if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
        modal = null;

        var thumb = document.getElementById('shipPreview3d');
        if (thumb && _shipType) {
            setTimeout(function () { _initScene(thumb, false); }, 50);
        }
    }

    function _initScene(containerEl, isModal) {
        _disposeRenderer();
        activeContainer = containerEl;
        var THREE = window.THREE;

        // ── Scene ──
        scene = new THREE.Scene();

        var w = containerEl.clientWidth;
        var h = containerEl.clientHeight;
        camera = new THREE.PerspectiveCamera(isModal ? 35 : 30, w / (h || 1), 0.1, 500);

        // ── Renderer — same settings as roll-viewer ──
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(w, h);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.1;
        renderer.domElement.style.display = 'block';
        renderer.domElement.style.maxWidth = '100%';
        renderer.domElement.style.height = 'auto';
        containerEl.appendChild(renderer.domElement);

        // ── Controls ──
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.enableZoom = isModal;
        controls.enablePan = false;
        controls.minPolarAngle = Math.PI * 0.1;
        controls.maxPolarAngle = Math.PI * 0.7;
        controls.autoRotate = true;
        controls.autoRotateSpeed = isModal ? 0.4 : 0.8;
        if (isModal) {
            controls.minDistance = 10;
            controls.maxDistance = 60;
        }

        // ── Lighting — matches roll-viewer day palette ──
        // Main sun (directional with shadow)
        var sunLight = new THREE.DirectionalLight(0xfffff0, 2.0);
        sunLight.position.set(30, 40, 20);
        sunLight.castShadow = true;
        sunLight.shadow.mapSize.width = 512;
        sunLight.shadow.mapSize.height = 512;
        sunLight.shadow.camera.near = 1;
        sunLight.shadow.camera.far = 100;
        sunLight.shadow.camera.left = -25;
        sunLight.shadow.camera.right = 25;
        sunLight.shadow.camera.top = 25;
        sunLight.shadow.camera.bottom = -25;
        sunLight.shadow.bias = -0.002;
        scene.add(sunLight);

        // Fill light
        var fillLight = new THREE.DirectionalLight(0xaaccff, 0.5);
        fillLight.position.set(-20, 10, -10);
        scene.add(fillLight);

        // Rim light (same as roll-viewer buildShip)
        var rimLight = new THREE.DirectionalLight(0x88aacc, 0.6);
        rimLight.position.set(-15, 8, -10);
        scene.add(rimLight);

        // Ambient
        scene.add(new THREE.AmbientLight(0xffffff, 0.8));

        // ── EnvMap — same gradient as roll-viewer ──
        _buildEnvMap(THREE);

        // ── Build ship ──
        shipGroup = ShipBuilders.buildShipModel(_shipType);

        // Enable shadows (same as roll-viewer)
        shipGroup.traverse(function (child) {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        scene.add(shipGroup);

        // ── Camera fit ──
        var box = new THREE.Box3().setFromObject(shipGroup);
        var size = new THREE.Vector3();
        box.getSize(size);
        var center = box.getCenter(new THREE.Vector3());
        var maxDim = Math.max(size.x, size.z);
        var dist = maxDim * (isModal ? 1.5 : 1.7);
        camera.position.set(0, dist * 0.4, dist);
        controls.target.copy(center);
        controls.update();

        // ── Background — transparent for thumbnail, gradient for modal ──
        if (isModal) {
            var bgGeo = new THREE.PlaneGeometry(200, 150);
            var bgMat = new THREE.ShaderMaterial({
                uniforms: {
                    colorTop: { value: new THREE.Color(0x2a2e35) },
                    colorBot: { value: new THREE.Color(0x16181c) }
                },
                vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
                fragmentShader: 'uniform vec3 colorTop; uniform vec3 colorBot; varying vec2 vUv; void main(){ gl_FragColor=vec4(mix(colorBot,colorTop,vUv.y),1.0); }',
                depthWrite: false, side: THREE.DoubleSide
            });
            var bgPlane = new THREE.Mesh(bgGeo, bgMat);
            bgPlane.position.set(center.x, center.y, -50);
            bgPlane.renderOrder = -1;
            scene.add(bgPlane);
        } else {
            renderer.setClearColor(0x000000, 0);
        }

        // ── Ground shadow plane (subtle) ──
        var groundMat = new THREE.ShadowMaterial({ opacity: 0.2 });
        var ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.set(center.x, box.min.y - 0.1, center.z);
        ground.receiveShadow = true;
        scene.add(ground);

        // ── Dimension lines (modal only) ──
        if (isModal) {
            _buildDimensionLines(THREE, box, center);
        }

        // ── Resize ──
        _resizeObserver = new ResizeObserver(function () {
            if (!renderer || !camera) return;
            var ww = activeContainer.clientWidth;
            var hh = activeContainer.clientHeight;
            camera.aspect = ww / (hh || 1);
            camera.updateProjectionMatrix();
            renderer.setSize(ww, hh);
        });
        _resizeObserver.observe(containerEl);

        animate();
    }

    function _buildEnvMap(THREE) {
        var size = 64;
        var faces = [];
        for (var f = 0; f < 6; f++) {
            var canvas = document.createElement('canvas');
            canvas.width = size; canvas.height = size;
            var ctx = canvas.getContext('2d');
            var grad = ctx.createLinearGradient(0, 0, 0, size);
            grad.addColorStop(0, '#4a6fa5');
            grad.addColorStop(0.5, '#1a2a3a');
            grad.addColorStop(1, '#0a1520');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, size, size);
            faces.push(canvas);
        }
        var cubeTexture = new THREE.CubeTexture(faces);
        cubeTexture.needsUpdate = true;
        ShipBuilders.setEnvMap(cubeTexture);
    }

    function _buildDimensionLines(THREE, box, center) {
        if (!_dimensions || !_dimensions.length) return;

        var dimGroup = new THREE.Group();
        var dimColor = 0x38bdf8;

        var y = box.min.y - 1.0;
        var z = box.max.z + 1.5;
        var xMin = box.min.x;
        var xMax = box.max.x;
        var xMid = (xMin + xMax) / 2;

        var lineMat = new THREE.LineDashedMaterial({
            color: dimColor, dashSize: 0.3, gapSize: 0.15,
            transparent: true, opacity: 0.8, depthTest: false
        });

        // Main line
        var lg = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(xMin, y, z), new THREE.Vector3(xMax, y, z)
        ]);
        var mainLine = new THREE.Line(lg, lineMat);
        mainLine.computeLineDistances();
        dimGroup.add(mainLine);

        // Ticks + extension lines
        var tickH = 0.6;
        var tickMat = new THREE.LineBasicMaterial({ color: dimColor, transparent: true, opacity: 0.8, depthTest: false });
        var extMat = new THREE.LineDashedMaterial({
            color: dimColor, dashSize: 0.15, gapSize: 0.1, transparent: true, opacity: 0.35, depthTest: false
        });

        [xMin, xMax].forEach(function (xx) {
            var tg = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(xx, y - tickH / 2, z), new THREE.Vector3(xx, y + tickH / 2, z)
            ]);
            dimGroup.add(new THREE.Line(tg, tickMat));

            var eg = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(xx, box.min.y, z), new THREE.Vector3(xx, y + tickH / 2, z)
            ]);
            var el = new THREE.Line(eg, extMat);
            el.computeLineDistances();
            dimGroup.add(el);
        });

        // Length label
        var sprite = _makeSprite(THREE, _dimensions.length + ' m', 44);
        sprite.position.set(xMid, y - 1.0, z);
        sprite.scale.set(2.8, 1.0, 1);
        dimGroup.add(sprite);

        // Beam
        if (_dimensions.beam) {
            var bx = xMax + 1.5;
            var zMin = box.min.z, zMax = box.max.z, zMid = (zMin + zMax) / 2;
            var by = center.y;

            var bg = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(bx, by, zMin), new THREE.Vector3(bx, by, zMax)
            ]);
            var bLine = new THREE.Line(bg, lineMat.clone());
            bLine.computeLineDistances();
            dimGroup.add(bLine);

            [zMin, zMax].forEach(function (zz) {
                var tg = new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(bx - 0.3, by, zz), new THREE.Vector3(bx + 0.3, by, zz)
                ]);
                dimGroup.add(new THREE.Line(tg, tickMat));
            });

            var bs = _makeSprite(THREE, _dimensions.beam + ' m', 36);
            bs.position.set(bx + 0.5, by + 0.8, zMid);
            bs.scale.set(2.2, 0.9, 1);
            dimGroup.add(bs);
        }

        scene.add(dimGroup);
    }

    function _makeSprite(THREE, text, fontSize) {
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        var pad = 10;
        ctx.font = 'bold ' + fontSize + 'px "JetBrains Mono", monospace';
        var tw = ctx.measureText(text).width + pad * 2;
        var th = fontSize * 1.3 + pad * 2;
        canvas.width = Math.ceil(tw);
        canvas.height = Math.ceil(th);

        ctx.fillStyle = 'rgba(10,21,32,0.85)';
        _rr(ctx, 0, 0, canvas.width, canvas.height, 5);
        ctx.fill();
        ctx.strokeStyle = 'rgba(56,189,248,0.35)';
        ctx.lineWidth = 2;
        _rr(ctx, 1, 1, canvas.width - 2, canvas.height - 2, 5);
        ctx.stroke();

        ctx.font = 'bold ' + fontSize + 'px "JetBrains Mono", monospace';
        ctx.fillStyle = '#7dd3fc';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, canvas.width / 2, canvas.height / 2);

        var tex = new THREE.CanvasTexture(canvas);
        tex.minFilter = THREE.LinearFilter;
        return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    }

    function _rr(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function animate() {
        animFrameId = requestAnimationFrame(animate);
        if (!renderer || !scene || !camera) return;
        if (controls) controls.update();
        renderer.render(scene, camera);
    }

    function _disposeRenderer() {
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
        if (_resizeObserver) { _resizeObserver.disconnect(); _resizeObserver = null; }
        if (controls) { controls.dispose(); controls = null; }
        if (renderer) {
            renderer.dispose();
            if (renderer.domElement && renderer.domElement.parentNode)
                renderer.domElement.parentNode.removeChild(renderer.domElement);
            renderer = null;
        }
        if (scene) {
            scene.traverse(function (obj) {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    if (Array.isArray(obj.material)) obj.material.forEach(function (m) { m.dispose(); });
                    else obj.material.dispose();
                }
            });
            scene = null;
        }
        shipGroup = null; camera = null; activeContainer = null;
    }

    function dispose() {
        if (modal) closeModal();
        _disposeRenderer();
        _shipType = null;
        _dimensions = null;
    }

    return {
        init: initThumbnail,
        openModal: openModal,
        closeModal: closeModal,
        dispose: dispose
    };
})();
