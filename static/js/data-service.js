// ── Maritime OSINT Sentry — Data Service ──
// Centralized state management. All data mutations go through here.
// Emits events so subscribers (map, UI, bottom bar) can react independently.

window.DataService = {
    ships: {},
    aircraft: {},
    collision: { distance: { risks: [] }, ml: { risks: [] } },
    latestShipMmsis: new Set(),

    _TYPE_MAP: { military_vessel: 'military', unknown: 'other', yacht: 'other' },

    updateShips: function(ships) {
        var counts = {};
        var TYPE_MAP = DataService._TYPE_MAP;
        ships.forEach(function(s) {
            var raw = s.type || 'other';
            s.type = TYPE_MAP[raw] || raw;
            DataService.ships[s.mmsi] = s;
            counts[s.type] = (counts[s.type] || 0) + 1;
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
