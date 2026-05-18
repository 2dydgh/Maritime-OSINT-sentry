// ── Maritime OSINT Sentry — Chat UI ──
// Floating bubble + panel chat interface for AI assistant.
// Communicates with POST /api/v1/chat and dispatches EventBus commands.

var ChatUI = (function () {
    var _bubble = null;
    var _panel = null;
    var _closeBtn = null;
    var _messages = null;
    var _input = null;
    var _sendBtn = null;
    var _isOpen = false;
    var _history = [];
    var _typing = null;

    function init() {
        _bubble = document.getElementById('chat-bubble');
        _panel = document.getElementById('chat-panel');
        _closeBtn = document.getElementById('chat-close-btn');
        _messages = document.getElementById('chat-messages');
        _input = document.getElementById('chat-input');
        _sendBtn = document.getElementById('chat-send-btn');

        if (!_bubble || !_panel || !_messages || !_input || !_sendBtn) {
            console.warn('[ChatUI] Required DOM elements not found.');
            return;
        }

        _bubble.addEventListener('click', open);
        if (_closeBtn) _closeBtn.addEventListener('click', close);

        _sendBtn.addEventListener('click', function () { send(); });

        _input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });
    }

    function open() {
        _isOpen = true;
        _panel.classList.add('chat-panel-open');
        _bubble.classList.add('chat-bubble-hidden');
        _input.focus();
    }

    function close() {
        _isOpen = false;
        _panel.classList.remove('chat-panel-open');
        _bubble.classList.remove('chat-bubble-hidden');
    }

    function toggle() {
        if (_isOpen) close();
        else open();
    }

    function send() {
        var text = _input.value.trim();
        if (!text) return;

        _input.value = '';
        _appendMessage('user', text);
        _history.push({ role: 'user', content: text });

        _showTyping();
        _sendBtn.disabled = true;
        _input.disabled = true;

        // Build a snapshot of current frontend state so the LLM knows what
        // "this ship" / "현재 선박" actually refers to.
        var context = {};
        if (window.RollViewer && window.RollViewer.isActive && window.RollViewer.isActive()) {
            var rvMmsi = window.RollViewer.getCurrentMmsi && window.RollViewer.getCurrentMmsi();
            if (rvMmsi && window.shipDataMap && window.shipDataMap[rvMmsi]) {
                var rvShip = window.shipDataMap[rvMmsi];
                context.roll_viewer = {
                    mmsi: rvMmsi,
                    name: rvShip.name || 'UNKNOWN',
                    type: rvShip.type || 'unknown',
                    is_capsizing: !!(window.RollViewer.isCapsizing && window.RollViewer.isCapsizing()),
                    is_turning: !!(window.RollViewer.isTurnActive && window.RollViewer.isTurnActive())
                };
            }
        }

        fetch('/api/v1/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, history: _history.slice(-10), context: context })
        })
        .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        })
        .then(function (data) {
            _hideTyping();
            var reply = (data && data.text) ? data.text : '응답을 받지 못했습니다.';
            _appendMessage('assistant', reply);
            _history.push({ role: 'assistant', content: reply });

            if (data && Array.isArray(data.actions)) {
                data.actions.forEach(function (action) {
                    _dispatchAction(action);
                });
            }
        })
        .catch(function (err) {
            _hideTyping();
            _appendMessage('assistant', '오류가 발생했습니다. 다시 시도해주세요.');
            console.error('[ChatUI] fetch error:', err);
        })
        .finally(function () {
            _sendBtn.disabled = false;
            _input.disabled = false;
            _input.focus();
        });
    }

    function _dispatchAction(action) {
        if (!action || !action.action) return;
        if (action.action === 'fly_to') {
            EventBus.emit('command:flyTo', { lat: action.lat, lon: action.lon });
        } else if (action.action === 'filter_ships') {
            EventBus.emit('command:filter', { shipType: action.ship_type || action.types });
        } else if (action.action === 'set_roll_scenario') {
            if (!window.RollViewer || !window.RollViewer.isActive || !window.RollViewer.isActive()) {
                _appendMessage('assistant', '횡요각 화면이 열려있지 않아 시나리오를 적용하지 못했습니다. 선박을 클릭하고 횡요각 화면을 먼저 열어주세요.');
                return;
            }
            if (action.clear) {
                window.RollViewer.clearScenarioOverride();
            } else if (action.params) {
                window.RollViewer.setScenarioOverride(action.params);
            }
        } else if (action.action === 'set_turn_scenario') {
            if (!window.RollViewer || !window.RollViewer.isActive || !window.RollViewer.isActive()) {
                _appendMessage('assistant', '횡요각 화면이 열려있지 않아 선회 시나리오를 시작할 수 없습니다. 선박을 클릭하고 횡요각 화면을 먼저 열어주세요.');
                return;
            }
            window.RollViewer.setTurnScenario(action.active, action.direction || 0);
        } else if (action.action === 'open_roll_viewer') {
            // Open the roll-viewer dedicated screen for the given MMSI.
            // Mirrors what clicking the model card does in the UI.
            if (!action.mmsi) return;
            if (window.RollViewer && window.RollViewer.isActive && window.RollViewer.isActive()
                && window.RollViewer.getCurrentMmsi && window.RollViewer.getCurrentMmsi() === action.mmsi) {
                return;  // already open for this ship
            }
            if (window.ModelRegistry && window.LayoutManager) {
                var rollModel = window.ModelRegistry.get && window.ModelRegistry.get('roll-prediction');
                if (rollModel) {
                    rollModel._selectedMmsi = action.mmsi;
                    window.LayoutManager.handleIconClick('roll-prediction', 'dedicated-screen');
                }
            }
        } else if (action.action === 'trigger_capsize') {
            if (!window.RollViewer || !window.RollViewer.isActive || !window.RollViewer.isActive()) {
                _appendMessage('assistant', '횡요각 화면이 열려있지 않아 전복 시뮬레이션을 시작할 수 없습니다. 선박을 클릭하고 횡요각 화면을 먼저 열어주세요.');
                return;
            }
            if (action.clear) {
                window.RollViewer.clearCapsize();
            } else {
                window.RollViewer.triggerCapsize(action.direction || 0, action.delay_seconds || 0);
            }
        } else if (action.action === 'return_to_globe') {
            if (window.LayoutManager && typeof window.LayoutManager.closeDedicatedPanel === 'function') {
                window.LayoutManager.closeDedicatedPanel();
            }
        }
    }

    function _appendMessage(role, text) {
        var el = document.createElement('div');
        el.className = 'chat-msg chat-msg-' + role;
        if (role === 'assistant' && window.marked) {
            el.innerHTML = window.marked.parse(text || '');
        } else {
            el.textContent = text;
        }
        _messages.appendChild(el);
        _messages.scrollTop = _messages.scrollHeight;
    }

    function _showTyping() {
        if (_typing) return;
        _typing = document.createElement('div');
        _typing.className = 'chat-msg chat-msg-typing';
        _typing.textContent = '생각 중...';
        _messages.appendChild(_typing);
        _messages.scrollTop = _messages.scrollHeight;
    }

    function _hideTyping() {
        if (_typing && _typing.parentNode) {
            _typing.parentNode.removeChild(_typing);
        }
        _typing = null;
    }

    return {
        init: init,
        open: open,
        close: close,
        toggle: toggle,
        send: send
    };
})();

document.addEventListener('DOMContentLoaded', function () {
    ChatUI.init();
});
