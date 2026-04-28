// ── Ship 3D Models on Globe ──
// Swaps 2D billboard icons for 3D GLB models when camera is zoomed in.

(function() {
    'use strict';

    // ── Camera height monitoring ──
    // Check camera height on moveEnd and toggle 3D model mode
    function initShip3dModels() {
        if (!viewer) return;

        viewer.camera.moveEnd.addEventListener(function() {
            var height = viewer.camera.positionCartographic.height;
            var shouldEnable = height < SHIP_3D_HEIGHT_THRESHOLD;

            if (shouldEnable !== ship3dEnabled) {
                ship3dEnabled = shouldEnable;
                toggleShip3dMode(shouldEnable);
            }

            // Update 3D models if enabled and we have ship data
            if (ship3dEnabled && _lastShipsData) {
                updateShip3dModels(_lastShipsData);
            }
        });
    }

    // ── Toggle billboard visibility vs 3D model visibility ──
    function toggleShip3dMode(enable3d) {
        // Show/hide the 3D DataSource
        if (ship3dDataSource) {
            ship3dDataSource.show = enable3d;
        }

        if (enable3d) {
            // Hide billboards and labels — 3D models take over
            SHIP_TYPES.forEach(function(type) {
                if (shipBillboards[type]) shipBillboards[type].show = false;
                if (shipLabels[type]) shipLabels[type].show = false;
            });
            // Immediately populate 3D models
            if (_lastShipsData) {
                updateShip3dModels(_lastShipsData);
            }
        } else {
            // Restore billboards and labels per checkbox state
            SHIP_TYPES.forEach(function(type) {
                var checkbox = document.querySelector(
                    '.ship-type-filter[data-type="' + type + '"]'
                );
                var checked = checkbox ? checkbox.checked : true;
                if (shipBillboards[type]) shipBillboards[type].show = checked;
                if (shipLabels[type]) shipLabels[type].show = checked;
            });
            // Remove all 3D entities
            clearShip3dModels();
        }

        viewer.scene.requestRender();
    }

    // ── Find nearest ships to camera center ──
    function getNearestShips(ships, maxCount) {
        var camCart = viewer.camera.positionCartographic;
        var camLat = Cesium.Math.toDegrees(camCart.latitude);
        var camLng = Cesium.Math.toDegrees(camCart.longitude);

        // Filter to visible types (checked in sidebar)
        var visibleTypes = {};
        SHIP_TYPES.forEach(function(type) {
            var checkbox = document.querySelector(
                '.ship-type-filter[data-type="' + type + '"]'
            );
            visibleTypes[type] = checkbox ? checkbox.checked : true;
        });

        var TYPE_MAP = { military_vessel: 'military', unknown: 'other', yacht: 'other' };

        var withDist = [];
        ships.forEach(function(ship) {
            var rawType = ship.type || 'other';
            var type = TYPE_MAP[rawType] || rawType;
            if (!visibleTypes[type]) return;

            var dLat = ship.lat - camLat;
            var dLng = (ship.lng - camLng) * Math.cos(camCart.latitude);
            var dist2 = dLat * dLat + dLng * dLng;
            withDist.push({ ship: ship, dist2: dist2 });
        });

        withDist.sort(function(a, b) { return a.dist2 - b.dist2; });
        return withDist.slice(0, maxCount).map(function(d) { return d.ship; });
    }

    // ── Update 3D model entities ──
    function updateShip3dModels(ships) {
        if (!ship3dDataSource) return;
        if (timeMode !== 'live') return;

        var nearest = getNearestShips(ships, SHIP_3D_MAX_COUNT);
        var seenMmsis = new Set();

        nearest.forEach(function(ship) {
            var mmsiKey = String(ship.mmsi);
            seenMmsis.add(mmsiKey);

            var position = Cesium.Cartesian3.fromDegrees(ship.lng, ship.lat, 10);
            var heading = Cesium.Math.toRadians(ship.heading || 0);
            var hpr = new Cesium.HeadingPitchRoll(heading, 0, 0);
            var orientation = Cesium.Transforms.headingPitchRollQuaternion(position, hpr);

            // Ship length for scale (fallback 100m)
            var lengthM = ship.length || 100;
            // cargo.glb native size — adjust if model looks wrong
            var modelNativeLength = 1;
            var scaleFactor = lengthM / modelNativeLength;

            var existing = ship3dEntityMap[mmsiKey];
            if (existing) {
                existing.position = position;
                existing.orientation = orientation;
                existing.model.scale = scaleFactor;
            } else {
                var entity = ship3dDataSource.entities.add({
                    id: mmsiKey,
                    name: ship.name || 'MMSI ' + ship.mmsi,
                    position: position,
                    orientation: orientation,
                    model: {
                        uri: SHIP_3D_MODEL_URL,
                        scale: scaleFactor,
                        silhouetteColor: Cesium.Color.fromCssColorString(
                            SHIP_COLORS[ship.type] || SHIP_COLORS['other']
                        ),
                        silhouetteSize: 1.5,
                        colorBlendMode: Cesium.ColorBlendMode.MIX,
                        colorBlendAmount: 0.3,
                        color: Cesium.Color.fromCssColorString(
                            SHIP_COLORS[ship.type] || SHIP_COLORS['other']
                        )
                    },
                    label: {
                        text: ship.name || '',
                        font: '12px Inter, sans-serif',
                        fillColor: Cesium.Color.WHITE,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 3,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                        pixelOffset: new Cesium.Cartesian2(0, -30),
                        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 50000)
                    }
                });
                ship3dEntityMap[mmsiKey] = entity;
            }
        });

        // Remove entities that are no longer in nearest set
        var toRemove = [];
        for (var mmsi in ship3dEntityMap) {
            if (!seenMmsis.has(mmsi)) {
                toRemove.push(mmsi);
            }
        }
        toRemove.forEach(function(mmsi) {
            ship3dDataSource.entities.removeById(mmsi);
            delete ship3dEntityMap[mmsi];
        });

        viewer.scene.requestRender();
    }

    // ── Clear all 3D entities ──
    function clearShip3dModels() {
        if (ship3dDataSource) {
            ship3dDataSource.entities.removeAll();
        }
        ship3dEntityMap = {};
    }

    // ── Expose globally ──
    window.initShip3dModels = initShip3dModels;
    window.updateShip3dModels = updateShip3dModels;
    window.clearShip3dModels = clearShip3dModels;
    window.toggleShip3dMode = toggleShip3dMode;

    // Self-init: viewer is already created by map-cesium.js which loads before this script
    initShip3dModels();

})();
