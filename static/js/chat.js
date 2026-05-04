// ── Maritime OSINT Sentry — Chat UI ──
// IIFE module providing a collapsible AI assistant chat panel.
// Communicates with POST /api/v1/chat and dispatches EventBus commands.

var ChatUI = (function () {
    var _panel = null;
    var _toggleBtn = null;
    var _messages = null;
    var _input = null;
    var _sendBtn = null;
    var _isOpen = false;
    var _history = [];
    var _typing = null;

    function init() {
        _panel = document.getElementById('chat-panel');
        _toggleBtn = document.getElementById('chat-toggle-btn');
        _messages = document.getElementById('chat-messages');
        _input = document.getElementById('chat-input');
        _sendBtn = document.getElementById('chat-send-btn');

        if (!_panel || !_toggleBtn || !_messages || !_input || !_sendBtn) {
            console.warn('[ChatUI] Required DOM elements not found.');
            return;
        }

        _toggleBtn.addEventListener('click', toggle);

        _sendBtn.addEventListener('click', function () {
            send();
        });

        _input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });
    }

    function toggle() {
        _isOpen = !_isOpen;
        if (_isOpen) {
            _panel.classList.add('chat-panel-open');
        } else {
            _panel.classList.remove('chat-panel-open');
        }
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

        fetch('/api/v1/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, history: _history })
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
            _appendMessage('assistant', '오류가 발생했습니다: ' + err.message);
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
        }
    }

    function _appendMessage(role, text) {
        var el = document.createElement('div');
        el.className = 'chat-msg chat-msg-' + role;
        el.textContent = text;
        _messages.appendChild(el);
        _messages.scrollTop = _messages.scrollHeight;
    }

    function _showTyping() {
        if (_typing) return;
        _typing = document.createElement('div');
        _typing.className = 'chat-msg chat-msg-typing';
        _typing.textContent = '입력 중...';
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
        toggle: toggle,
        send: send
    };
})();

document.addEventListener('DOMContentLoaded', function () {
    ChatUI.init();
});
