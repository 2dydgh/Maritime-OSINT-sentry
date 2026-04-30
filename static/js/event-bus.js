// ── Maritime OSINT Sentry — Event Bus ──
// Lightweight publish/subscribe for decoupling modules.
// Loaded before all other application scripts.

window.EventBus = {
    _handlers: {},
    on: function(event, fn) {
        (this._handlers[event] = this._handlers[event] || []).push(fn);
    },
    off: function(event, fn) {
        var list = this._handlers[event];
        if (list) this._handlers[event] = list.filter(function(f) { return f !== fn; });
    },
    emit: function(event, data) {
        (this._handlers[event] || []).forEach(function(fn) {
            try { fn(data); } catch (e) { console.error('[EventBus] Error in handler for "' + event + '":', e); }
        });
    }
};
