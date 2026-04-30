// ── Maritime OSINT Sentry — Data Service ──
// Centralized state management. All data mutations go through here.
// Emits events so subscribers (map, UI, bottom bar) can react independently.

window.DataService = {
    ships: {},
    aircraft: {},
    collision: { distance: { risks: [] }, ml: { risks: [] } },
    latestShipMmsis: new Set(),

    updateShips: function(ships) {
        var counts = {};
        ships.forEach(function(s) {
            DataService.ships[s.mmsi] = s;
            var type = s.type || 'other';
            counts[type] = (counts[type] || 0) + 1;
        });
        // Preserve Set reference — clear and re-populate instead of replacing
        DataService.latestShipMmsis.clear();
        ships.forEach(function(s) { DataService.latestShipMmsis.add(s.mmsi); });
        EventBus.emit('ships:updated', { ships: ships, counts: counts });
    },

    updateAircraft: function(aircraft) {
        var counts = {};
        aircraft.forEach(function(ac) {
            DataService.aircraft[ac.icao24] = ac;
            var type = ac.category || 'other';
            counts[type] = (counts[type] || 0) + 1;
        });
        EventBus.emit('aircraft:updated', { aircraft: aircraft, counts: counts });
    },

    updateCollision: function(data) {
        // Preserve object reference for compatibility bridge
        DataService.collision.distance = data.distance || { risks: [] };
        DataService.collision.ml = data.ml || { risks: [] };
        EventBus.emit('collision:updated', DataService.collision);
    }
};
