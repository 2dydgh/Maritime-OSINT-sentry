// ── Shared procedural ship model builders ──
// Extracted from roll-viewer.js for reuse by ship-preview-3d.js
var ShipBuilders = (function () {
    'use strict';

    var _shipMatCache = {};
    var _rustTextureCache = {};
    var _envMap = null;

    function setEnvMap(envMap) {
        _envMap = envMap;
    }

    // Helper — group.add() returns group, but we need the mesh back
    function _add(group, mesh) {
        group.add(mesh);
        return mesh;
    }

    function shipMat(color, opts) {
        var r = (opts && opts.roughness !== undefined) ? opts.roughness : 0.55;
        var m = (opts && opts.metalness !== undefined) ? opts.metalness : 0.35;
        var e = (opts && opts.emissive) ? opts.emissive : '';
        var ei = (opts && opts.emissiveIntensity) ? opts.emissiveIntensity : 0;
        var emi = (opts && opts.envMapIntensity !== undefined) ? opts.envMapIntensity : 0.4;
        var key = color + '|' + r + '|' + m + '|' + e + '|' + ei + '|' + emi;
        if (_shipMatCache[key]) return _shipMatCache[key];

        var THREE = window.THREE;
        var params = {
            color: new THREE.Color(color),
            roughness: r,
            metalness: m
        };
        if (_envMap) {
            params.envMap = _envMap;
            params.envMapIntensity = emi;
        }
        if (e) {
            params.emissive = new THREE.Color(e);
            params.emissiveIntensity = ei || 0.8;
        }
        var mat = new THREE.MeshStandardMaterial(params);
        _shipMatCache[key] = mat;
        return mat;
    }

    // ── Procedural rust/weathering canvas texture ──
    function createRustTexture(baseColor, intensity) {
        var key = baseColor + '|' + intensity;
        if (_rustTextureCache[key]) return _rustTextureCache[key];

        var THREE = window.THREE;
        var sz = 256;
        var canvas = document.createElement('canvas');
        canvas.width = sz; canvas.height = sz;
        var ctx = canvas.getContext('2d');

        ctx.fillStyle = baseColor;
        ctx.fillRect(0, 0, sz, sz);

        var rustColors = ['#8B4513', '#A0522D', '#6B3410', '#CD853F', '#D2691E'];

        var patchCount = Math.floor(25 * intensity);
        for (var i = 0; i < patchCount; i++) {
            var rx = Math.random() * sz;
            var ry = Math.random() * sz;
            var rw = 4 + Math.random() * 18;
            var rh = 8 + Math.random() * 35;
            ctx.globalAlpha = 0.08 + Math.random() * 0.25 * intensity;
            ctx.fillStyle = rustColors[Math.floor(Math.random() * rustColors.length)];
            ctx.beginPath();
            ctx.ellipse(rx, ry, rw, rh, Math.random() * Math.PI, 0, Math.PI * 2);
            ctx.fill();
        }

        var streakCount = Math.floor(6 * intensity);
        for (var s = 0; s < streakCount; s++) {
            var sx = Math.random() * sz;
            var sy = Math.random() * sz * 0.5;
            var sw = 1.5 + Math.random() * 3;
            var sh = 25 + Math.random() * 70;
            ctx.globalAlpha = 0.12 + Math.random() * 0.18 * intensity;
            ctx.fillStyle = rustColors[Math.floor(Math.random() * rustColors.length)];
            ctx.fillRect(sx, sy, sw, sh);
        }

        for (var d = 0; d < 150; d++) {
            ctx.globalAlpha = Math.random() * 0.04 * intensity;
            ctx.fillStyle = Math.random() > 0.5 ? '#2a2a2a' : '#4a3a2a';
            ctx.fillRect(Math.random() * sz, Math.random() * sz, 1 + Math.random() * 2, 1 + Math.random() * 2);
        }
        ctx.globalAlpha = 1.0;

        var texture = new THREE.CanvasTexture(canvas);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        _rustTextureCache[key] = texture;
        return texture;
    }

    var RUST_INTENSITY = {
        cargo: 0.6, tanker: 0.5, passenger: 0.15,
        fishing: 0.8, military: 0.12, tug: 0.7, other: 0.4
    };

    function rustHullMat(baseColor, type) {
        var THREE = window.THREE;
        var intensity = RUST_INTENSITY[type] || 0.4;
        var texture = createRustTexture(baseColor, intensity);
        var params = {
            map: texture,
            roughness: 0.55,
            metalness: 0.3,
            side: THREE.DoubleSide
        };
        if (_envMap) {
            params.envMap = _envMap;
            params.envMapIntensity = 0.35;
        }
        return new THREE.MeshStandardMaterial(params);
    }

    // ── createHullGeometry — parametric hull with curved cross-section ──
    function createHullGeometry(THREE, opts) {
        var L = opts.length, B = opts.beam, D = opts.depth;
        var bowFine = opts.bowFineness || 1.5;
        var sternFull = opts.sternFullness || 0.7;

        var hp = [
            [1.00, 0.00], [1.02, 0.08], [1.00, 0.25],
            [0.94, 0.42], [0.80, 0.60], [0.55, 0.78],
            [0.25, 0.92], [0.00, 1.00]
        ];
        var ring = [];
        for (var i = 0; i < hp.length; i++) ring.push(hp[i]);
        for (var i = hp.length - 2; i >= 0; i--) ring.push([-hp[i][0], hp[i][1]]);
        var NR = ring.length;
        var NS = 14;
        var sternX = -(L * 0.45), bowX = L * 0.55;
        var positions = [];

        for (var s = 0; s <= NS; s++) {
            var t = s / NS;
            var x = sternX + t * (bowX - sternX);
            var wf;
            if (t < 0.3) {
                wf = sternFull + (1 - sternFull) * Math.pow(t / 0.3, 0.8);
            } else if (t < 0.55) {
                wf = 1.0;
            } else {
                wf = Math.pow(Math.max(1 - (t - 0.55) / 0.45, 0), bowFine);
            }
            wf = Math.max(wf, 0.015);
            var halfB = B / 2 * wf;
            var localD = D * Math.min(0.4 + 0.6 * wf / Math.max(sternFull, 0.3), 1.0);
            for (var r = 0; r < NR; r++) {
                positions.push(x, -ring[r][1] * localD, ring[r][0] * halfB);
            }
        }
        var indices = [];
        for (var s = 0; s < NS; s++) {
            for (var r = 0; r < NR - 1; r++) {
                var a = s * NR + r, b = a + 1;
                var c = (s + 1) * NR + r, d = c + 1;
                indices.push(a, c, b);
                indices.push(b, c, d);
            }
        }
        var sci = positions.length / 3;
        positions.push(sternX, -D * sternFull * 0.5, 0);
        for (var r = 0; r < NR - 1; r++) indices.push(r + 1, r, sci);

        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        return geo;
    }

    // ── Detail helpers ──
    function addDeckRailing(THREE, group, opts) {
        var startX = opts.startX, endX = opts.endX;
        var y = opts.y;
        var z = opts.z;
        var count = opts.postCount || 7;
        var height = opts.postHeight || 0.8;
        var color = opts.color || '#a1a1aa';
        var length = Math.abs(endX - startX);
        var midX = (startX + endX) / 2;

        var mat = shipMat(color, { metalness: 0.4, roughness: 0.6 });

        var postGeo = new THREE.CylinderGeometry(0.02, 0.025, height, 4);
        for (var i = 0; i <= count; i++) {
            var x = startX + (endX - startX) * i / count;
            _add(group, new THREE.Mesh(postGeo, mat)).position.set(x, y + height / 2, z);
        }

        var topGeo = new THREE.CylinderGeometry(0.015, 0.015, length, 4);
        topGeo.rotateZ(Math.PI / 2);
        _add(group, new THREE.Mesh(topGeo, mat)).position.set(midX, y + height, z);

        var midGeo = new THREE.CylinderGeometry(0.012, 0.012, length, 4);
        midGeo.rotateZ(Math.PI / 2);
        _add(group, new THREE.Mesh(midGeo, mat)).position.set(midX, y + height * 0.5, z);
    }

    function addBulbousBow(THREE, group, bowX, y, radius, color) {
        var geo = new THREE.SphereGeometry(radius, 12, 8);
        geo.scale(2.2, 0.7, 0.9);
        _add(group, new THREE.Mesh(geo, shipMat(color, { roughness: 0.6 }))).position.set(bowX, y, 0);
    }

    function addAnchor(THREE, group, x, y, z, scale) {
        var mat = shipMat('#1a1a1a', { metalness: 0.8, roughness: 0.4 });
        _add(group, new THREE.Mesh(new THREE.BoxGeometry(0.05 * scale, 0.7 * scale, 0.05 * scale), mat)).position.set(x, y, z);
        _add(group, new THREE.Mesh(new THREE.BoxGeometry(0.04 * scale, 0.04 * scale, 0.35 * scale), mat)).position.set(x, y - 0.35 * scale, z);
        var flukeGeo = new THREE.BoxGeometry(0.04 * scale, 0.22 * scale, 0.04 * scale);
        var f1 = _add(group, new THREE.Mesh(flukeGeo, mat));
        f1.position.set(x, y - 0.42 * scale, z + 0.15 * scale);
        f1.rotation.x = 0.6;
        var f2 = _add(group, new THREE.Mesh(flukeGeo.clone(), mat));
        f2.position.set(x, y - 0.42 * scale, z - 0.15 * scale);
        f2.rotation.x = -0.6;
        var ring = new THREE.TorusGeometry(0.06 * scale, 0.015 * scale, 6, 8);
        _add(group, new THREE.Mesh(ring, mat)).position.set(x, y + 0.38 * scale, z);
    }

    function addHawsepipe(THREE, group, x, y, z, scale) {
        var outerGeo = new THREE.CylinderGeometry(0.14 * scale, 0.14 * scale, 0.15 * scale, 8);
        outerGeo.rotateX(Math.PI / 2);
        _add(group, new THREE.Mesh(outerGeo, shipMat('#374151', { metalness: 0.6 }))).position.set(x, y, z);
        var innerGeo = new THREE.CylinderGeometry(0.10 * scale, 0.10 * scale, 0.17 * scale, 8);
        innerGeo.rotateX(Math.PI / 2);
        _add(group, new THREE.Mesh(innerGeo, shipMat('#0a0a0a'))).position.set(x, y, z);
    }

    function addRudder(THREE, group, sternX, y, height, color) {
        var bladeGeo = new THREE.BoxGeometry(0.5, height, 0.06);
        _add(group, new THREE.Mesh(bladeGeo, shipMat(color, { roughness: 0.7 }))).position.set(sternX, y, 0);
        var stockGeo = new THREE.CylinderGeometry(0.04, 0.04, height * 0.6, 6);
        _add(group, new THREE.Mesh(stockGeo, shipMat('#4b5563', { metalness: 0.5 }))).position.set(sternX + 0.1, y + height * 0.5, 0);
    }

    function addStemBar(THREE, group, bowX, yBottom, yTop) {
        var height = yTop - yBottom;
        var geo = new THREE.BoxGeometry(0.08, height, 0.08);
        _add(group, new THREE.Mesh(geo, shipMat('#27272a', { metalness: 0.5 }))).position.set(bowX, yBottom + height / 2, 0);
    }

    function addWaterline(THREE, group, hullLength, hullWidth, yPos) {
        var stripeGeo = new THREE.BoxGeometry(hullLength * 0.85, 0.15, hullWidth + 0.05);
        var stripe = new THREE.Mesh(stripeGeo, shipMat('#991b1b', { roughness: 0.8, metalness: 0.1, envMapIntensity: 0.1 }));
        stripe.position.set(0, yPos, 0);
        group.add(stripe);
    }

    // ── Ship type builders ──

    function buildTanker(THREE, group, color) {
        var hullGeo = createHullGeometry(THREE, {
            length: 18, beam: 4.4, depth: 3.0,
            bowFineness: 1.0, sternFullness: 0.8
        });
        var hull = new THREE.Mesh(hullGeo, rustHullMat('#e2e8f0', 'tanker'));
        hull.position.set(0, 3.0, 0);
        group.add(hull);

        var deckGeo = new THREE.BoxGeometry(16, 0.2, 4.2);
        _add(group, new THREE.Mesh(deckGeo, shipMat('#3f3f46'))).position.set(0, 3.0, 0);

        for (var td = -2; td <= 2; td++) {
            var domeGeo = new THREE.SphereGeometry(1.4, 12, 6, 0, Math.PI * 2, 0, Math.PI / 3);
            _add(group, new THREE.Mesh(domeGeo, shipMat('#52525b', { roughness: 0.7, metalness: 0.3 }))).position.set(td * 3, 3.1, 0);
        }

        var catwalkGeo = new THREE.BoxGeometry(14, 0.06, 0.4);
        _add(group, new THREE.Mesh(catwalkGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(0, 3.8, 0);
        for (var cs = -3; cs <= 3; cs++) {
            var csGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.7, 4);
            _add(group, new THREE.Mesh(csGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(cs * 2, 3.45, 0);
        }

        for (var p = -1; p <= 1; p++) {
            var pipeGeo = new THREE.CylinderGeometry(0.08, 0.08, 12, 8);
            pipeGeo.rotateZ(Math.PI / 2);
            _add(group, new THREE.Mesh(pipeGeo, shipMat('#71717a', { metalness: 0.6 }))).position.set(0, 3.3, p * 1.2);
        }

        var manifoldGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 12);
        _add(group, new THREE.Mesh(manifoldGeo, shipMat('#52525b', { metalness: 0.7 }))).position.set(0, 3.5, 0);

        for (var r = -1; r <= 1; r++) {
            var riserGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.8, 6);
            _add(group, new THREE.Mesh(riserGeo, shipMat('#71717a', { metalness: 0.6 }))).position.set(0, 3.5, r * 1.2);
        }

        for (var vp = -2; vp <= 2; vp++) {
            var ventGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6);
            _add(group, new THREE.Mesh(ventGeo, shipMat('#a1a1aa', { metalness: 0.4 }))).position.set(vp * 3, 4.0, 1.5);
            var capGeo = new THREE.CylinderGeometry(0.12, 0.08, 0.15, 6);
            _add(group, new THREE.Mesh(capGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(vp * 3, 4.55, 1.5);
        }

        var bridgeGeo = new THREE.BoxGeometry(3.5, 2.0, 3.5);
        _add(group, new THREE.Mesh(bridgeGeo, shipMat('#3f3f46'))).position.set(-5.5, 4.0, 0);
        var bridgeUpperGeo = new THREE.BoxGeometry(3.0, 1.0, 3.2);
        _add(group, new THREE.Mesh(bridgeUpperGeo, shipMat('#4a4a52'))).position.set(-5.5, 5.5, 0);

        var wingGeo = new THREE.BoxGeometry(1.0, 0.8, 0.6);
        _add(group, new THREE.Mesh(wingGeo, shipMat('#3f3f46'))).position.set(-5.5, 5.4, 2.2);
        _add(group, new THREE.Mesh(wingGeo.clone(), shipMat('#3f3f46'))).position.set(-5.5, 5.4, -2.2);

        var winGeo = new THREE.BoxGeometry(0.1, 0.5, 2.8);
        _add(group, new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-3.7, 5.5, 0);
        var winSideGeo = new THREE.BoxGeometry(2.5, 0.4, 0.08);
        _add(group, new THREE.Mesh(winSideGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-5.5, 5.5, 1.62);
        _add(group, new THREE.Mesh(winSideGeo.clone(), shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-5.5, 5.5, -1.62);

        var funnelGeo = new THREE.CylinderGeometry(0.4, 0.5, 2.2, 8);
        _add(group, new THREE.Mesh(funnelGeo, shipMat('#27272a'))).position.set(-6.5, 5.5, 0);
        var stripeGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.3, 8);
        _add(group, new THREE.Mesh(stripeGeo, shipMat(color))).position.set(-6.5, 5.8, 0);
        var fCapGeo = new THREE.CylinderGeometry(0.45, 0.38, 0.2, 8);
        _add(group, new THREE.Mesh(fCapGeo, shipMat('#1e1e1e'))).position.set(-6.5, 6.65, 0);

        var mastGeo = new THREE.CylinderGeometry(0.04, 0.06, 3, 6);
        _add(group, new THREE.Mesh(mastGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(-5.5, 7.5, 0);
        var radarGeo = new THREE.BoxGeometry(1.5, 0.06, 0.3);
        _add(group, new THREE.Mesh(radarGeo, shipMat('#94a3b8', { metalness: 0.4 }))).position.set(-5.5, 8.8, 0);

        addDeckRailing(THREE, group, { startX: -6.6, endX: 7, y: 3.1, z: 2.1, postCount: 7, postHeight: 0.8 });
        addDeckRailing(THREE, group, { startX: -6.6, endX: 7, y: 3.1, z: -2.1, postCount: 7, postHeight: 0.8 });

        var bowBollardGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.3, 8);
        _add(group, new THREE.Mesh(bowBollardGeo, shipMat('#4b5563', { metalness: 0.6 }))).position.set(7, 3.2, 0.6);
        _add(group, new THREE.Mesh(bowBollardGeo.clone(), shipMat('#4b5563', { metalness: 0.6 }))).position.set(7, 3.2, -0.6);

        addStemBar(THREE, group, 10.5, 1.2, 3.2);
        addAnchor(THREE, group, 8.5, 2.0, 2.0, 1.0);
        addHawsepipe(THREE, group, 8.8, 2.6, 2.0, 1.0);
        addAnchor(THREE, group, 8.5, 2.0, -2.0, 1.0);
        addHawsepipe(THREE, group, 8.8, 2.6, -2.0, 1.0);
        addRudder(THREE, group, -8.8, 0.8, 1.8, color);
    }

    function buildCargo(THREE, group, color) {
        var hullGeo = createHullGeometry(THREE, {
            length: 17, beam: 3.8, depth: 3.0,
            bowFineness: 1.3, sternFullness: 0.7
        });
        var hull = new THREE.Mesh(hullGeo, rustHullMat('#e2e8f0', 'cargo'));
        hull.position.set(0, 3.0, 0);
        group.add(hull);

        var deckGeo = new THREE.BoxGeometry(15, 0.2, 3.8);
        _add(group, new THREE.Mesh(deckGeo, shipMat('#3f3f46'))).position.set(0.5, 3.0, 0);

        var holdCoverGeo = new THREE.BoxGeometry(1.4, 0.08, 3.4);
        for (var hc = 0; hc < 4; hc++) {
            _add(group, new THREE.Mesh(holdCoverGeo, shipMat('#52525b', { roughness: 0.7 }))).position.set(3.5 - hc * 2, 3.15, 0);
        }

        var containerColors = ['#dc2626', '#2563eb', '#16a34a', '#ca8a04', '#9333ea', '#0891b2'];
        var rows = [
            { x: 3.5, layers: 3 },
            { x: 1.5, layers: 2 },
            { x: -0.5, layers: 3 },
            { x: -2.5, layers: 2 }
        ];

        rows.forEach(function (row) {
            for (var layer = 0; layer < row.layers; layer++) {
                for (var z = -1; z <= 1; z++) {
                    var cGeo = new THREE.BoxGeometry(1.6, 0.9, 1.1);
                    var cColor = containerColors[Math.floor(Math.random() * containerColors.length)];
                    var container = new THREE.Mesh(cGeo, shipMat(cColor, { roughness: 0.8, metalness: 0.2 }));
                    container.position.set(row.x, 3.6 + layer * 0.95, z * 1.2);
                    group.add(container);
                }
            }
            var lashGeo = new THREE.BoxGeometry(0.15, 0.6, 3.6);
            _add(group, new THREE.Mesh(lashGeo, shipMat('#fbbf24', { metalness: 0.4 }))).position.set(row.x + 0.9, 3.5, 0);
        });

        var craneBaseGeo = new THREE.BoxGeometry(0.3, 3, 0.3);
        _add(group, new THREE.Mesh(craneBaseGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-4, 4.5, 1.2);
        _add(group, new THREE.Mesh(craneBaseGeo.clone(), shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-4, 4.5, -1.2);
        var crossGeo = new THREE.BoxGeometry(0.15, 0.15, 2.4);
        _add(group, new THREE.Mesh(crossGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-4, 5.8, 0);

        var craneBoomGeo = new THREE.CylinderGeometry(0.08, 0.1, 4, 6);
        craneBoomGeo.rotateZ(Math.PI / 4);
        _add(group, new THREE.Mesh(craneBoomGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-3, 6.5, 0);
        var cableGeo = new THREE.CylinderGeometry(0.015, 0.015, 3, 4);
        _add(group, new THREE.Mesh(cableGeo, shipMat('#71717a'))).position.set(-1.8, 5.8, 0);

        var bridgeLowerGeo = new THREE.BoxGeometry(3, 2.5, 3.5);
        _add(group, new THREE.Mesh(bridgeLowerGeo, shipMat('#3f3f46'))).position.set(-5.5, 4.3, 0);
        var bridgeUpperGeo = new THREE.BoxGeometry(2.5, 1.2, 3.2);
        _add(group, new THREE.Mesh(bridgeUpperGeo, shipMat('#4a4a52'))).position.set(-5.5, 6.2, 0);

        var bWingGeo = new THREE.BoxGeometry(0.8, 0.6, 0.5);
        _add(group, new THREE.Mesh(bWingGeo, shipMat('#3f3f46'))).position.set(-5.5, 6.1, 2.1);
        _add(group, new THREE.Mesh(bWingGeo.clone(), shipMat('#3f3f46'))).position.set(-5.5, 6.1, -2.1);

        var winGeo = new THREE.BoxGeometry(0.1, 0.6, 2.8);
        _add(group, new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-3.95, 6.2, 0);
        var winSideGeo = new THREE.BoxGeometry(2.0, 0.4, 0.08);
        _add(group, new THREE.Mesh(winSideGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-5.5, 6.2, 1.62);
        _add(group, new THREE.Mesh(winSideGeo.clone(), shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-5.5, 6.2, -1.62);

        var funnelGeo = new THREE.CylinderGeometry(0.35, 0.45, 2, 8);
        _add(group, new THREE.Mesh(funnelGeo, shipMat('#27272a'))).position.set(-6.5, 6.5, 0);
        var fCapGeo = new THREE.CylinderGeometry(0.4, 0.33, 0.2, 8);
        _add(group, new THREE.Mesh(fCapGeo, shipMat('#1e1e1e'))).position.set(-6.5, 7.55, 0);

        var mastGeo = new THREE.CylinderGeometry(0.04, 0.06, 2.5, 6);
        _add(group, new THREE.Mesh(mastGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(-5.5, 8.0, 0);
        var radarGeo = new THREE.BoxGeometry(1.2, 0.06, 0.25);
        _add(group, new THREE.Mesh(radarGeo, shipMat('#94a3b8', { metalness: 0.4 }))).position.set(-5.5, 9.1, 0);

        addDeckRailing(THREE, group, { startX: -6, endX: 6, y: 3.1, z: 1.9, postCount: 7, postHeight: 0.7 });
        addDeckRailing(THREE, group, { startX: -6, endX: 6, y: 3.1, z: -1.9, postCount: 7, postHeight: 0.7 });

        var bowBollardGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.25, 8);
        _add(group, new THREE.Mesh(bowBollardGeo, shipMat('#4b5563', { metalness: 0.6 }))).position.set(6, 3.2, 0.5);
        _add(group, new THREE.Mesh(bowBollardGeo.clone(), shipMat('#4b5563', { metalness: 0.6 }))).position.set(6, 3.2, -0.5);

        addStemBar(THREE, group, 9.5, 1.2, 3.2);
        addAnchor(THREE, group, 7.5, 2.0, 1.8, 1.0);
        addHawsepipe(THREE, group, 7.8, 2.6, 1.8, 1.0);
        addAnchor(THREE, group, 7.5, 2.0, -1.8, 1.0);
        addHawsepipe(THREE, group, 7.8, 2.6, -1.8, 1.0);
        addRudder(THREE, group, -7.8, 0.8, 1.6, color);
    }

    function buildPassenger(THREE, group, color) {
        var hullGeo = createHullGeometry(THREE, {
            length: 18, beam: 5.0, depth: 3.0,
            bowFineness: 1.5, sternFullness: 0.6
        });
        var hull = new THREE.Mesh(hullGeo, rustHullMat('#f8fafc', 'passenger'));
        hull.position.set(0, 3.4, 0);
        group.add(hull);

        var deckWidths = [13, 12, 10, 8];
        var deckDepths = [4.5, 4.0, 3.5, 2.8];
        for (var d = 0; d < 4; d++) {
            var dGeo = new THREE.BoxGeometry(deckWidths[d], 1.0, deckDepths[d]);
            var deck = new THREE.Mesh(dGeo, shipMat('#e2e8f0', { roughness: 0.6 }));
            deck.position.set(-0.5 + d * 0.3, 3.4 + d * 1.05, 0);
            group.add(deck);

            var winStripGeo = new THREE.BoxGeometry(deckWidths[d] - 1, 0.15, deckDepths[d] + 0.02);
            var winStrip = new THREE.Mesh(winStripGeo, shipMat('#fbbf24', { emissive: '#fbbf24', emissiveIntensity: 0.5, roughness: 0.3 }));
            winStrip.position.set(-0.5 + d * 0.3, 3.7 + d * 1.05, 0);
            group.add(winStrip);

            var rlX = -0.5 + d * 0.3;
            var rlY = 3.9 + d * 1.05;
            addDeckRailing(THREE, group, { startX: rlX - 4, endX: rlX + 4, y: rlY, z: deckDepths[d] / 2 + 0.02, postCount: 5, postHeight: 0.5, color: '#d4d4d8' });
            addDeckRailing(THREE, group, { startX: rlX - 4, endX: rlX + 4, y: rlY, z: -deckDepths[d] / 2 - 0.02, postCount: 5, postHeight: 0.5, color: '#d4d4d8' });
        }

        var lifeboatGeo = new THREE.CylinderGeometry(0.15, 0.2, 1.2, 8);
        lifeboatGeo.rotateZ(Math.PI / 2);
        for (var lb = 0; lb < 3; lb++) {
            _add(group, new THREE.Mesh(lifeboatGeo, shipMat('#f97316', { roughness: 0.7 }))).position.set(-2 + lb * 2.5, 5.0, 2.3);
            _add(group, new THREE.Mesh(lifeboatGeo.clone(), shipMat('#f97316', { roughness: 0.7 }))).position.set(-2 + lb * 2.5, 5.0, -2.3);
            var davitGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.0, 4);
            _add(group, new THREE.Mesh(davitGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(-2 + lb * 2.5, 5.6, 2.1);
            _add(group, new THREE.Mesh(davitGeo.clone(), shipMat('#71717a', { metalness: 0.5 }))).position.set(-2 + lb * 2.5, 5.6, -2.1);
        }

        var bridgeGeo = new THREE.BoxGeometry(3, 1.5, 2.5);
        _add(group, new THREE.Mesh(bridgeGeo, shipMat('#cbd5e1'))).position.set(-1, 8.2, 0);
        var bwGeo = new THREE.BoxGeometry(0.8, 0.6, 0.5);
        _add(group, new THREE.Mesh(bwGeo, shipMat('#cbd5e1'))).position.set(-1, 8.2, 1.7);
        _add(group, new THREE.Mesh(bwGeo.clone(), shipMat('#cbd5e1'))).position.set(-1, 8.2, -1.7);

        var winGeo = new THREE.BoxGeometry(3.02, 0.4, 2.52);
        _add(group, new THREE.Mesh(winGeo, shipMat('#0ea5e9', { emissive: '#0ea5e9', emissiveIntensity: 0.8 }))).position.set(-1, 8.5, 0);

        var funnelGeo = new THREE.CylinderGeometry(0.6, 0.8, 3, 12);
        _add(group, new THREE.Mesh(funnelGeo, shipMat(color))).position.set(-3, 8.5, 0);
        var topGeo = new THREE.CylinderGeometry(0.7, 0.6, 0.5, 12);
        _add(group, new THREE.Mesh(topGeo, shipMat('#1e293b'))).position.set(-3, 10.1, 0);

        var radarDomeGeo = new THREE.SphereGeometry(0.4, 12, 8);
        _add(group, new THREE.Mesh(radarDomeGeo, shipMat('#e2e8f0', { roughness: 0.3 }))).position.set(-1, 9.3, 0);

        var mastGeo = new THREE.CylinderGeometry(0.04, 0.06, 2, 6);
        _add(group, new THREE.Mesh(mastGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(-1, 10.0, 0);
        var antGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.6, 4);
        antGeo.rotateX(Math.PI / 2);
        _add(group, new THREE.Mesh(antGeo, shipMat('#a1a1aa'))).position.set(-1, 10.8, 0);

        var poolGeo = new THREE.BoxGeometry(1.5, 0.05, 1.2);
        _add(group, new THREE.Mesh(poolGeo, shipMat('#22d3ee', { emissive: '#22d3ee', emissiveIntensity: 0.3, roughness: 0.2 }))).position.set(2, 7.6, 0);

        var bowBollGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.25, 8);
        _add(group, new THREE.Mesh(bowBollGeo, shipMat('#4b5563', { metalness: 0.6 }))).position.set(7.5, 3.1, 0.5);
        _add(group, new THREE.Mesh(bowBollGeo.clone(), shipMat('#4b5563', { metalness: 0.6 }))).position.set(7.5, 3.1, -0.5);

        addStemBar(THREE, group, 10.5, 1.0, 3.2);
        addAnchor(THREE, group, 8.5, 2.0, 2.2, 0.9);
        addHawsepipe(THREE, group, 8.8, 2.6, 2.2, 0.9);
        addAnchor(THREE, group, 8.5, 2.0, -2.2, 0.9);
        addHawsepipe(THREE, group, 8.8, 2.6, -2.2, 0.9);
        addRudder(THREE, group, -7.8, 0.6, 1.6, '#cbd5e1');
    }

    function buildFishing(THREE, group, color) {
        var hullGeo = createHullGeometry(THREE, {
            length: 10, beam: 2.8, depth: 2.0,
            bowFineness: 1.5, sternFullness: 0.8
        });
        var hull = new THREE.Mesh(hullGeo, rustHullMat('#e2e8f0', 'fishing'));
        hull.position.set(0, 2.5, 0);
        group.add(hull);

        var deckGeo = new THREE.BoxGeometry(8, 0.15, 2.8);
        _add(group, new THREE.Mesh(deckGeo, shipMat('#4b5563'))).position.set(0.5, 2.5, 0);

        var bulwarkGeo = new THREE.BoxGeometry(7, 0.4, 0.08);
        _add(group, new THREE.Mesh(bulwarkGeo, shipMat('#cbd5e1', { roughness: 0.7 }))).position.set(0.5, 2.8, 1.4);
        _add(group, new THREE.Mesh(bulwarkGeo.clone(), shipMat('#cbd5e1', { roughness: 0.7 }))).position.set(0.5, 2.8, -1.4);

        var bridgeGeo = new THREE.BoxGeometry(2, 1.8, 2);
        _add(group, new THREE.Mesh(bridgeGeo, shipMat('#374151'))).position.set(-2, 3.5, 0);
        var roofGeo = new THREE.BoxGeometry(2.2, 0.1, 2.2);
        _add(group, new THREE.Mesh(roofGeo, shipMat('#52525b'))).position.set(-2, 4.45, 0);

        var winGeo = new THREE.BoxGeometry(0.1, 0.35, 1.5);
        _add(group, new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(-0.95, 3.7, 0);
        var winSideGeo = new THREE.BoxGeometry(1.2, 0.3, 0.08);
        _add(group, new THREE.Mesh(winSideGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-2, 3.7, 1.02);
        _add(group, new THREE.Mesh(winSideGeo.clone(), shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-2, 3.7, -1.02);

        var mastGeo = new THREE.CylinderGeometry(0.04, 0.06, 5, 6);
        _add(group, new THREE.Mesh(mastGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(0, 5.0, 0);

        var navLightGeo = new THREE.SphereGeometry(0.08, 6, 6);
        _add(group, new THREE.Mesh(navLightGeo, shipMat('#22c55e', { emissive: '#22c55e', emissiveIntensity: 1.0 }))).position.set(0, 7.5, 0);

        var crossTreeGeo = new THREE.CylinderGeometry(0.02, 0.02, 1.5, 4);
        crossTreeGeo.rotateX(Math.PI / 2);
        _add(group, new THREE.Mesh(crossTreeGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(0, 6.5, 0);

        var boomGeo = new THREE.CylinderGeometry(0.03, 0.05, 5, 6);
        var boom1 = new THREE.Mesh(boomGeo, shipMat('#9ca3af', { metalness: 0.5 }));
        boom1.position.set(0, 5.5, 1.5);
        boom1.rotation.x = -0.5;
        boom1.rotation.z = 0.3;
        group.add(boom1);
        var boom2 = new THREE.Mesh(boomGeo.clone(), shipMat('#9ca3af', { metalness: 0.5 }));
        boom2.position.set(0, 5.5, -1.5);
        boom2.rotation.x = 0.5;
        boom2.rotation.z = 0.3;
        group.add(boom2);

        var aFrameGeo = new THREE.CylinderGeometry(0.04, 0.06, 2.5, 6);
        var aFrame1 = new THREE.Mesh(aFrameGeo, shipMat('#fbbf24', { metalness: 0.5 }));
        aFrame1.position.set(-3.8, 3.5, 0.6);
        aFrame1.rotation.z = -0.2;
        group.add(aFrame1);
        var aFrame2 = new THREE.Mesh(aFrameGeo.clone(), shipMat('#fbbf24', { metalness: 0.5 }));
        aFrame2.position.set(-3.8, 3.5, -0.6);
        aFrame2.rotation.z = -0.2;
        group.add(aFrame2);
        var aCrossGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.3, 4);
        aCrossGeo.rotateX(Math.PI / 2);
        _add(group, new THREE.Mesh(aCrossGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-4.1, 4.6, 0);

        var reelGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.5, 10);
        reelGeo.rotateX(Math.PI / 2);
        _add(group, new THREE.Mesh(reelGeo, shipMat('#6b7280', { metalness: 0.4 }))).position.set(-3.5, 2.8, 0);
        var flangeGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.05, 10);
        flangeGeo.rotateX(Math.PI / 2);
        _add(group, new THREE.Mesh(flangeGeo, shipMat('#52525b', { metalness: 0.5 }))).position.set(-3.5, 2.8, 0.75);
        _add(group, new THREE.Mesh(flangeGeo.clone(), shipMat('#52525b', { metalness: 0.5 }))).position.set(-3.5, 2.8, -0.75);

        var exhaustGeo = new THREE.CylinderGeometry(0.12, 0.15, 0.8, 6);
        _add(group, new THREE.Mesh(exhaustGeo, shipMat('#27272a'))).position.set(-2.5, 4.8, 0);

        var bollGeo = new THREE.CylinderGeometry(0.06, 0.08, 0.2, 6);
        _add(group, new THREE.Mesh(bollGeo, shipMat('#374151', { metalness: 0.6 }))).position.set(3.5, 2.7, 0.8);
        _add(group, new THREE.Mesh(bollGeo.clone(), shipMat('#374151', { metalness: 0.6 }))).position.set(3.5, 2.7, -0.8);

        addStemBar(THREE, group, 5.5, 1.0, 2.8);
        addAnchor(THREE, group, 4.5, 1.8, 1.2, 0.7);
        addHawsepipe(THREE, group, 4.7, 2.3, 1.2, 0.7);
        addRudder(THREE, group, -4.5, 0.6, 1.2, color);
    }

    function buildMilitary(THREE, group, color) {
        var hullGeo = createHullGeometry(THREE, {
            length: 18, beam: 3.2, depth: 2.5,
            bowFineness: 2.5, sternFullness: 0.5
        });
        var hull = new THREE.Mesh(hullGeo, rustHullMat('#9ca3af', 'military'));
        hull.position.set(0, 2.9, 0);
        group.add(hull);

        var deckGeo = new THREE.BoxGeometry(15, 0.15, 3.2);
        _add(group, new THREE.Mesh(deckGeo, shipMat('#4b5563'))).position.set(0.5, 2.9, 0);

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
        group.add(superstructure);

        var bridgeUpperGeo = new THREE.BoxGeometry(3.5, 0.8, 2.5);
        _add(group, new THREE.Mesh(bridgeUpperGeo, shipMat('#4a4a52'))).position.set(-2, 5.7, 0);

        var winGeo = new THREE.BoxGeometry(3.5, 0.2, 2.3);
        _add(group, new THREE.Mesh(winGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(-2, 5.9, 0);

        var turretBase = new THREE.CylinderGeometry(0.6, 0.7, 0.5, 12);
        _add(group, new THREE.Mesh(turretBase, shipMat('#4b5563', { metalness: 0.5 }))).position.set(4, 3.3, 0);
        var shieldGeo = new THREE.SphereGeometry(0.5, 8, 6, 0, Math.PI, 0, Math.PI / 2);
        shieldGeo.rotateZ(Math.PI / 2);
        _add(group, new THREE.Mesh(shieldGeo, shipMat('#4b5563', { metalness: 0.5 }))).position.set(4.3, 3.5, 0);
        var barrelGeo = new THREE.CylinderGeometry(0.06, 0.08, 2.5, 6);
        barrelGeo.rotateZ(-Math.PI / 2);
        _add(group, new THREE.Mesh(barrelGeo, shipMat('#374151', { metalness: 0.6 }))).position.set(5.5, 3.5, 0);

        var ciwsBase = new THREE.CylinderGeometry(0.25, 0.3, 0.4, 8);
        _add(group, new THREE.Mesh(ciwsBase, shipMat('#52525b', { metalness: 0.5 }))).position.set(-4.5, 5.5, 0);
        var ciwsBarrelGeo = new THREE.CylinderGeometry(0.03, 0.04, 1.0, 6);
        ciwsBarrelGeo.rotateZ(-Math.PI / 4);
        _add(group, new THREE.Mesh(ciwsBarrelGeo, shipMat('#374151', { metalness: 0.7 }))).position.set(-4.1, 6.0, 0);
        var ciwsDomeGeo = new THREE.SphereGeometry(0.2, 8, 6);
        _add(group, new THREE.Mesh(ciwsDomeGeo, shipMat('#e2e8f0', { roughness: 0.3 }))).position.set(-4.5, 5.9, 0);

        var vlsGeo = new THREE.BoxGeometry(1.5, 0.15, 1.5);
        _add(group, new THREE.Mesh(vlsGeo, shipMat('#4b5563', { roughness: 0.7 }))).position.set(2, 3.1, 0);
        for (var vi = 0; vi < 3; vi++) {
            var vLineGeo = new THREE.BoxGeometry(1.5, 0.17, 0.02);
            _add(group, new THREE.Mesh(vLineGeo, shipMat('#374151'))).position.set(2, 3.1, -0.5 + vi * 0.5);
        }

        var mastGeo = new THREE.CylinderGeometry(0.05, 0.08, 4, 6);
        _add(group, new THREE.Mesh(mastGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(-2, 7.3, 0);
        var strutGeo = new THREE.CylinderGeometry(0.03, 0.03, 2.5, 4);
        strutGeo.rotateZ(0.15);
        _add(group, new THREE.Mesh(strutGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(-1.6, 6.5, 0.3);
        _add(group, new THREE.Mesh(strutGeo.clone(), shipMat('#71717a', { metalness: 0.5 }))).position.set(-1.6, 6.5, -0.3);

        var radarGeo = new THREE.BoxGeometry(0.08, 1.0, 0.8);
        _add(group, new THREE.Mesh(radarGeo, shipMat('#94a3b8', { metalness: 0.4 }))).position.set(-1.4, 7.5, 0);
        _add(group, new THREE.Mesh(radarGeo.clone(), shipMat('#94a3b8', { metalness: 0.4 }))).position.set(-2.6, 7.5, 0);
        var rotRadarGeo = new THREE.BoxGeometry(2, 0.08, 0.5);
        _add(group, new THREE.Mesh(rotRadarGeo, shipMat('#94a3b8', { metalness: 0.4 }))).position.set(-2, 9.2, 0);

        var funnelGeo = new THREE.BoxGeometry(1.2, 1.5, 1.8);
        _add(group, new THREE.Mesh(funnelGeo, shipMat('#3f3f46'))).position.set(-5, 4.5, 0);
        var grillGeo = new THREE.BoxGeometry(1.0, 0.06, 1.6);
        _add(group, new THREE.Mesh(grillGeo, shipMat('#27272a'))).position.set(-5, 5.28, 0);

        var heliPadGeo = new THREE.BoxGeometry(3, 0.05, 3);
        _add(group, new THREE.Mesh(heliPadGeo, shipMat('#4b5563', { roughness: 0.8 }))).position.set(-6, 3.0, 0);
        var hMarkGeo = new THREE.BoxGeometry(0.8, 0.06, 0.1);
        _add(group, new THREE.Mesh(hMarkGeo, shipMat('#fbbf24'))).position.set(-6, 3.05, 0.3);
        _add(group, new THREE.Mesh(hMarkGeo.clone(), shipMat('#fbbf24'))).position.set(-6, 3.05, -0.3);
        var hCrossGeo = new THREE.BoxGeometry(0.1, 0.06, 0.7);
        _add(group, new THREE.Mesh(hCrossGeo, shipMat('#fbbf24'))).position.set(-6, 3.05, 0);
        var netGeo = new THREE.RingGeometry(1.0, 1.05, 16);
        netGeo.rotateX(-Math.PI / 2);
        _add(group, new THREE.Mesh(netGeo, shipMat('#fbbf24', { roughness: 0.9 }))).position.set(-6, 3.06, 0);

        addDeckRailing(THREE, group, { startX: -6, endX: 8, y: 3.0, z: 1.6, postCount: 8, postHeight: 0.6, color: '#71717a' });
        addDeckRailing(THREE, group, { startX: -6, endX: 8, y: 3.0, z: -1.6, postCount: 8, postHeight: 0.6, color: '#71717a' });

        addStemBar(THREE, group, 10.5, 1.2, 3.0);
        addAnchor(THREE, group, 8.5, 2.0, 1.5, 0.9);
        addHawsepipe(THREE, group, 8.8, 2.6, 1.5, 0.9);
        addAnchor(THREE, group, 8.5, 2.0, -1.5, 0.9);
        addHawsepipe(THREE, group, 8.8, 2.6, -1.5, 0.9);
        var twinRudderMat = shipMat('#6b7280', { roughness: 0.7 });
        var rBlade1 = new THREE.BoxGeometry(0.45, 1.4, 0.05);
        _add(group, new THREE.Mesh(rBlade1, twinRudderMat)).position.set(-7.8, 0.8, 0.5);
        _add(group, new THREE.Mesh(rBlade1.clone(), twinRudderMat)).position.set(-7.8, 0.8, -0.5);
        var sonarGeo = new THREE.SphereGeometry(0.5, 10, 8);
        sonarGeo.scale(1.5, 0.8, 0.8);
        _add(group, new THREE.Mesh(sonarGeo, shipMat('#52525b', { roughness: 0.4 }))).position.set(10.5, 1.0, 0);
    }

    function buildTug(THREE, group, color) {
        var hullGeo = createHullGeometry(THREE, {
            length: 8, beam: 3.6, depth: 2.8,
            bowFineness: 0.8, sternFullness: 0.9
        });
        var hull = new THREE.Mesh(hullGeo, rustHullMat('#e2e8f0', 'tug'));
        hull.position.set(0, 3.0, 0);
        group.add(hull);

        var deckGeo = new THREE.BoxGeometry(6, 0.2, 3.2);
        _add(group, new THREE.Mesh(deckGeo, shipMat('#4b5563'))).position.set(0.5, 3.0, 0);

        var kneeGeo = new THREE.BoxGeometry(0.3, 1.5, 3.0);
        _add(group, new THREE.Mesh(kneeGeo, shipMat('#374151', { roughness: 0.8, metalness: 0.3 }))).position.set(3.5, 2.5, 0);

        var bridgeGeo = new THREE.BoxGeometry(2.5, 2.8, 2.8);
        _add(group, new THREE.Mesh(bridgeGeo, shipMat('#374151'))).position.set(0, 4.5, 0);
        var roofGeo = new THREE.BoxGeometry(2.8, 0.12, 3.0);
        _add(group, new THREE.Mesh(roofGeo, shipMat('#52525b'))).position.set(0, 5.96, 0);

        var winFront = new THREE.BoxGeometry(0.1, 0.5, 2.2);
        _add(group, new THREE.Mesh(winFront, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.8 }))).position.set(1.3, 4.8, 0);
        var winBack = new THREE.BoxGeometry(0.1, 0.4, 1.8);
        _add(group, new THREE.Mesh(winBack, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.5 }))).position.set(-1.3, 4.8, 0);
        var winSide1 = new THREE.BoxGeometry(2, 0.5, 0.1);
        _add(group, new THREE.Mesh(winSide1, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(0, 4.8, 1.45);
        _add(group, new THREE.Mesh(winSide1.clone(), shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(0, 4.8, -1.45);

        var slBaseGeo = new THREE.CylinderGeometry(0.12, 0.15, 0.2, 8);
        _add(group, new THREE.Mesh(slBaseGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(0.8, 6.15, 0);
        var slLampGeo = new THREE.CylinderGeometry(0.08, 0.12, 0.2, 8);
        slLampGeo.rotateZ(-Math.PI / 2);
        _add(group, new THREE.Mesh(slLampGeo, shipMat('#fbbf24', { emissive: '#fbbf24', emissiveIntensity: 0.4 }))).position.set(1.0, 6.25, 0);

        var funnelGeo = new THREE.CylinderGeometry(0.35, 0.4, 1.5, 8);
        _add(group, new THREE.Mesh(funnelGeo, shipMat('#1e293b'))).position.set(-1.5, 5.5, 0);
        var fCapGeo = new THREE.CylinderGeometry(0.4, 0.33, 0.15, 8);
        _add(group, new THREE.Mesh(fCapGeo, shipMat('#0f0f0f'))).position.set(-1.5, 6.3, 0);

        var mastGeo = new THREE.CylinderGeometry(0.03, 0.04, 1.5, 4);
        _add(group, new THREE.Mesh(mastGeo, shipMat('#9ca3af', { metalness: 0.5 }))).position.set(0, 6.8, 0);
        var antGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.5, 4);
        antGeo.rotateX(Math.PI / 2);
        _add(group, new THREE.Mesh(antGeo, shipMat('#a1a1aa'))).position.set(0, 7.4, 0);

        var winchGeo = new THREE.CylinderGeometry(0.4, 0.4, 1.2, 10);
        winchGeo.rotateX(Math.PI / 2);
        _add(group, new THREE.Mesh(winchGeo, shipMat('#fbbf24', { metalness: 0.5 }))).position.set(-2.5, 3.3, 0);
        var wFlangeGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.05, 10);
        wFlangeGeo.rotateX(Math.PI / 2);
        _add(group, new THREE.Mesh(wFlangeGeo, shipMat('#d97706', { metalness: 0.5 }))).position.set(-2.5, 3.3, 0.6);
        _add(group, new THREE.Mesh(wFlangeGeo.clone(), shipMat('#d97706', { metalness: 0.5 }))).position.set(-2.5, 3.3, -0.6);

        var bittGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.6, 6);
        _add(group, new THREE.Mesh(bittGeo, shipMat('#374151', { metalness: 0.6 }))).position.set(-3, 3.3, 0.5);
        _add(group, new THREE.Mesh(bittGeo.clone(), shipMat('#374151', { metalness: 0.6 }))).position.set(-3, 3.3, -0.5);

        var hookGeo = new THREE.TorusGeometry(0.15, 0.04, 6, 8, Math.PI);
        hookGeo.rotateX(Math.PI / 2);
        _add(group, new THREE.Mesh(hookGeo, shipMat('#374151', { metalness: 0.7 }))).position.set(-3.2, 3.4, 0);

        var fenderGeo = new THREE.TorusGeometry(0.25, 0.1, 8, 12);
        for (var f = -1; f <= 2; f++) {
            var fender1 = new THREE.Mesh(fenderGeo, shipMat('#1e293b', { roughness: 0.9 }));
            fender1.position.set(f * 1.5, 2.0, 1.9);
            fender1.rotation.y = Math.PI / 2;
            group.add(fender1);
            var fender2 = new THREE.Mesh(fenderGeo.clone(), shipMat('#1e293b', { roughness: 0.9 }));
            fender2.position.set(f * 1.5, 2.0, -1.9);
            fender2.rotation.y = Math.PI / 2;
            group.add(fender2);
        }

        var bowBollGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.25, 8);
        _add(group, new THREE.Mesh(bowBollGeo, shipMat('#4b5563', { metalness: 0.6 }))).position.set(2.5, 3.2, 0.8);
        _add(group, new THREE.Mesh(bowBollGeo.clone(), shipMat('#4b5563', { metalness: 0.6 }))).position.set(2.5, 3.2, -0.8);

        addStemBar(THREE, group, 4.5, 1.2, 3.2);
        addAnchor(THREE, group, 3.5, 1.8, 1.6, 0.7);
        addHawsepipe(THREE, group, 3.7, 2.4, 1.6, 0.7);
        addRudder(THREE, group, -3.5, 0.6, 1.4, color);
    }

    function buildGenericShip(THREE, group, color) {
        var hullGeo = createHullGeometry(THREE, {
            length: 11, beam: 3.2, depth: 2.5,
            bowFineness: 1.2, sternFullness: 0.7
        });
        var hull = new THREE.Mesh(hullGeo, rustHullMat('#e2e8f0', 'other'));
        hull.position.set(0, 2.8, 0);
        group.add(hull);

        var deckGeo = new THREE.BoxGeometry(10, 0.15, 3.2);
        _add(group, new THREE.Mesh(deckGeo, shipMat('#52525b'))).position.set(0, 2.8, 0);

        var bulwarkGeo = new THREE.BoxGeometry(9, 0.35, 0.06);
        _add(group, new THREE.Mesh(bulwarkGeo, shipMat('#cbd5e1', { roughness: 0.7 }))).position.set(0, 3.05, 1.6);
        _add(group, new THREE.Mesh(bulwarkGeo.clone(), shipMat('#cbd5e1', { roughness: 0.7 }))).position.set(0, 3.05, -1.6);

        var cabinGeo = new THREE.BoxGeometry(3, 1.8, 2.4);
        _add(group, new THREE.Mesh(cabinGeo, shipMat('#e8e8e8'))).position.set(0, 3.9, 0);

        var roofGeo = new THREE.BoxGeometry(3.4, 0.15, 2.8);
        _add(group, new THREE.Mesh(roofGeo, shipMat('#71717a'))).position.set(0, 4.9, 0);

        var winFrontGeo = new THREE.BoxGeometry(0.08, 0.5, 2.0);
        _add(group, new THREE.Mesh(winFrontGeo, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(1.5, 4.0, 0);
        var winSide1 = new THREE.BoxGeometry(2.0, 0.5, 0.08);
        _add(group, new THREE.Mesh(winSide1, shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(0, 4.0, 1.2);
        _add(group, new THREE.Mesh(winSide1.clone(), shipMat('#38bdf8', { emissive: '#38bdf8', emissiveIntensity: 0.6 }))).position.set(0, 4.0, -1.2);

        var antGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.2, 4);
        _add(group, new THREE.Mesh(antGeo, shipMat('#a1a1aa'))).position.set(-0.5, 5.6, 0);
        var navLightGeo = new THREE.SphereGeometry(0.06, 6, 6);
        _add(group, new THREE.Mesh(navLightGeo, shipMat('#22c55e', { emissive: '#22c55e', emissiveIntensity: 1.0 }))).position.set(-0.5, 6.2, 0);

        var exhaustGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.6, 6);
        _add(group, new THREE.Mesh(exhaustGeo, shipMat('#27272a'))).position.set(-1.2, 5.2, 0);

        for (var fb = 0; fb < 2; fb++) {
            var bollGeo = new THREE.CylinderGeometry(0.12, 0.15, 0.4, 8);
            _add(group, new THREE.Mesh(bollGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(4 - fb * 1.5, 3.1, 0);
        }

        addDeckRailing(THREE, group, { startX: -4, endX: 4, y: 2.9, z: 1.6, postCount: 5, postHeight: 0.8 });
        addDeckRailing(THREE, group, { startX: -4, endX: 4, y: 2.9, z: -1.6, postCount: 5, postHeight: 0.8 });

        var sternRailMat = shipMat('#a1a1aa', { metalness: 0.4, roughness: 0.6 });
        var sRailPostGeo = new THREE.CylinderGeometry(0.02, 0.025, 0.8, 4);
        for (var sp = -1; sp <= 1; sp++) {
            _add(group, new THREE.Mesh(sRailPostGeo, sternRailMat)).position.set(-4.5, 3.3, sp * 1.0);
        }
        var sTopGeo = new THREE.CylinderGeometry(0.015, 0.015, 2.2, 4);
        sTopGeo.rotateX(Math.PI / 2);
        _add(group, new THREE.Mesh(sTopGeo, sternRailMat)).position.set(-4.5, 3.7, 0);
        var sMidGeo = new THREE.CylinderGeometry(0.012, 0.012, 2.2, 4);
        sMidGeo.rotateX(Math.PI / 2);
        _add(group, new THREE.Mesh(sMidGeo, sternRailMat)).position.set(-4.5, 3.3, 0);

        var davitGeo = new THREE.CylinderGeometry(0.04, 0.05, 1.5, 6);
        davitGeo.rotateZ(0.3);
        _add(group, new THREE.Mesh(davitGeo, shipMat('#71717a', { metalness: 0.5 }))).position.set(2.5, 3.6, 0.8);

        addStemBar(THREE, group, 6.5, 1.2, 3.0);
        addAnchor(THREE, group, 5.0, 1.8, 1.4, 0.8);
        addHawsepipe(THREE, group, 5.2, 2.4, 1.4, 0.8);
        addRudder(THREE, group, -5.5, 0.6, 1.2, color);
    }

    // ── Main entry point ──
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

        var wlMap = {
            tanker: [16, 4.2, 1.6], cargo: [14, 3.8, 1.6], passenger: [16, 4.5, 1.4],
            fishing: [8, 2.8, 1.4], military: [14, 3.2, 1.6], tug: [6, 3.2, 1.6], other: [10, 3.2, 1.5]
        };
        var wl = wlMap[type] || wlMap['other'];
        addWaterline(THREE, group, wl[0], wl[1], wl[2]);

        return group;
    }

    // ── Ship type key resolver ──
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
