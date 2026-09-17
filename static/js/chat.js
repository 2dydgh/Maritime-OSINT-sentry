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

    var WELCOME_TEXT = '안녕하세요. 해양 상황 AI 어시스턴트입니다.\n선박, 위험 해역, 기상 상황 등 무엇이든 물어보세요.';
    var SUGGESTIONS = [
        '말라카해협 위험도 요약해줘',
        '부산 앞바다로 이동해줘',
        'Cargo 선박만 보여줘'
    ];

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

        _renderWelcome();
    }

    function _renderWelcome() {
        if (_messages.children.length) return;

        var hello = document.createElement('div');
        hello.className = 'chat-msg chat-msg-assistant chat-msg-welcome';
        hello.textContent = WELCOME_TEXT;
        _messages.appendChild(hello);

        var chips = document.createElement('div');
        chips.className = 'chat-suggestions';
        SUGGESTIONS.forEach(function (q) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chat-suggestion-btn';
            btn.textContent = q;
            btn.addEventListener('click', function () {
                _input.value = q;
                send();
            });
            chips.appendChild(btn);
        });
        _messages.appendChild(chips);
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

        var chips = _messages.querySelector('.chat-suggestions');
        if (chips) chips.parentNode.removeChild(chips);

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
        // 항로 화면 상태 (열려 있으면 출발/도착/크기를 LLM에 전달)
        if (window.RouteViewer && window.RouteViewer.getState) {
            var rs = window.RouteViewer.getState();
            if (rs && rs.active) context.route = rs;
        }
        // 사고 위험구역 오버레이 on/off
        if (typeof window.isHazardZonesActive === 'function') {
            context.hazard_zones_active = !!window.isHazardZonesActive();
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
            // Multi-step turns return an execution plan — surface it as a checklist
            // above the answer so the agent's reasoning is visible.
            if (data && data.plan && Array.isArray(data.plan.steps) && data.plan.steps.length) {
                _renderPlan(data.plan);
            }
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

    // ── Frontend action registry ──
    // Each agent tool result carries an "action"; one handler per action below.
    // Adding a new tool = one entry here (+ its backend @tool) — no growing if/else.

    function _rollViewerActive() {
        return !!(window.RollViewer && window.RollViewer.isActive && window.RollViewer.isActive());
    }

    // Run fn now if the route screen is open; otherwise open it first and run
    // once the panel/map has finished building.
    function _withRouteScreen(fn) {
        var open = window.RouteViewer && window.RouteViewer.getState && window.RouteViewer.getState().active;
        if (!open && window.LayoutManager) {
            window.LayoutManager.handleIconClick('route-inference', 'dedicated-screen');
            setTimeout(fn, 650);   // 패널 빌드 + 지도 초기화 대기
        } else {
            fn();
        }
    }

    var ACTION_HANDLERS = {
        fly_to: function (a) {
            EventBus.emit('command:flyTo', { lat: a.lat, lon: a.lon });
        },
        filter_ships: function (a) {
            EventBus.emit('command:filter', { shipType: a.ship_type || a.types });
        },
        set_roll_scenario: function (a) {
            if (!_rollViewerActive()) {
                _appendMessage('assistant', '횡요각 화면이 열려있지 않아 시나리오를 적용하지 못했습니다. 선박을 클릭하고 횡요각 화면을 먼저 열어주세요.');
                return;
            }
            if (a.clear) {
                window.RollViewer.clearScenarioOverride();
            } else if (a.params) {
                window.RollViewer.setScenarioOverride(a.params);
            }
        },
        set_turn_scenario: function (a) {
            if (!_rollViewerActive()) {
                _appendMessage('assistant', '횡요각 화면이 열려있지 않아 선회 시나리오를 시작할 수 없습니다. 선박을 클릭하고 횡요각 화면을 먼저 열어주세요.');
                return;
            }
            window.RollViewer.setTurnScenario(a.active, a.direction || 0);
        },
        open_roll_viewer: function (a) {
            // Open the roll-viewer dedicated screen for the given MMSI.
            // Mirrors what clicking the model card does in the UI.
            if (!a.mmsi) return;
            if (_rollViewerActive()
                && window.RollViewer.getCurrentMmsi && window.RollViewer.getCurrentMmsi() === a.mmsi) {
                return;  // already open for this ship
            }
            if (window.ModelRegistry && window.LayoutManager) {
                var rollModel = window.ModelRegistry.get && window.ModelRegistry.get('roll-prediction');
                if (rollModel) {
                    rollModel._selectedMmsi = a.mmsi;
                    window.LayoutManager.handleIconClick('roll-prediction', 'dedicated-screen');
                }
            }
        },
        set_roll_camera: function (a) {
            if (!_rollViewerActive()) {
                _appendMessage('assistant', '횡요각 화면이 열려있지 않아 카메라 시점을 바꿀 수 없습니다. 선박을 클릭하고 횡요각 화면을 먼저 열어주세요.');
                return;
            }
            if (window.RollViewer.setCameraView) window.RollViewer.setCameraView(a.view);
        },
        trigger_capsize: function (a) {
            if (!_rollViewerActive()) {
                _appendMessage('assistant', '횡요각 화면이 열려있지 않아 전복 시뮬레이션을 시작할 수 없습니다. 선박을 클릭하고 횡요각 화면을 먼저 열어주세요.');
                return;
            }
            if (a.clear) {
                window.RollViewer.clearCapsize();
            } else {
                window.RollViewer.triggerCapsize(a.direction || 0, a.delay_seconds || 0);
            }
        },
        return_to_globe: function () {
            if (window.LayoutManager && typeof window.LayoutManager.closeDedicatedPanel === 'function') {
                window.LayoutManager.closeDedicatedPanel();
            }
        },
        open_route_screen: function () {
            if (window.LayoutManager) window.LayoutManager.handleIconClick('route-inference', 'dedicated-screen');
        },
        plan_route: function (a) {
            _withRouteScreen(function () {
                if (window.RouteViewer && window.RouteViewer.planRoute) {
                    window.RouteViewer.planRoute({
                        fromLat: a.fromLat, fromLng: a.fromLng, fromName: a.fromName,
                        toLat: a.toLat, toLng: a.toLng, toName: a.toName,
                        sizeClass: a.sizeClass
                    });
                }
            });
        },
        set_route_size_class: function (a) {
            if (window.RouteViewer && window.RouteViewer.setSizeClass) {
                window.RouteViewer.setSizeClass(a.size_class);
            }
        },
        set_route_playback: function (a) {
            _withRouteScreen(function () {
                if (window.RouteViewer && window.RouteViewer.setPlayback) {
                    window.RouteViewer.setPlayback({ play: a.play, rate: a.rate });
                }
            });
        },
        toggle_hazard_zones: function (a) {
            // 사고 위험구역은 라이브 지도 오버레이 — 전용 화면이 열려 있으면 먼저 닫는다.
            if (window.LayoutManager && typeof window.LayoutManager.closeDedicatedPanel === 'function') {
                window.LayoutManager.closeDedicatedPanel();
            }
            if (a.on) {
                if (typeof window.activateHazardZones === 'function') window.activateHazardZones();
            } else {
                if (typeof window.deactivateHazardZones === 'function') window.deactivateHazardZones();
            }
        }
    };

    function _dispatchAction(action) {
        if (!action || !action.action) return;
        var handler = ACTION_HANDLERS[action.action];
        if (handler) handler(action);
    }

    // Friendly Korean labels for tools, used only when a step has no `why`.
    var TOOL_LABELS = {
        open_route_screen: '항로 화면 열기',
        plan_route: '항로 추론',
        set_route_size_class: '선박 등급 변경',
        get_hazard_summary: '사고 위험 요약',
        toggle_hazard_zones: '위험구역 표시',
        get_ships: '선박 조회',
        get_collision_risks: '충돌 위험 조회',
        get_area_status: '해역 현황',
        fly_to: '지도 이동',
        filter_ships: '선박 필터',
        get_ship_detail: '선박 상세',
        set_roll_scenario: '횡요각 시나리오',
        set_turn_scenario: '선회 시나리오',
        open_roll_viewer: '횡요각 화면 열기',
        trigger_capsize: '전복 시뮬레이션',
        return_to_globe: '지구본 복귀'
    };

    function _stepLabel(step) {
        if (step.why && step.why.trim()) return step.why.trim();
        return TOOL_LABELS[step.tool] || step.tool;
    }

    // Render the agent's executed plan as a checklist card. Steps tick in with a
    // calm staggered reveal (CSS-driven) so it reads as sequential execution.
    function _renderPlan(plan) {
        var card = document.createElement('div');
        card.className = 'chat-plan';

        var head = document.createElement('div');
        head.className = 'chat-plan-head';
        var label = document.createElement('span');
        label.className = 'chat-plan-label';
        label.textContent = '실행 계획';
        head.appendChild(label);
        if (plan.goal) {
            var goal = document.createElement('span');
            goal.className = 'chat-plan-goal';
            goal.textContent = plan.goal;
            head.appendChild(goal);
        }
        card.appendChild(head);

        var ol = document.createElement('ol');
        ol.className = 'chat-plan-steps';
        plan.steps.forEach(function (step, i) {
            var li = document.createElement('li');
            li.className = 'chat-plan-step';
            li.style.animationDelay = (i * 0.12) + 's';
            var check = document.createElement('span');
            check.className = 'chat-plan-check';
            check.textContent = '✓';
            var txt = document.createElement('span');
            txt.className = 'chat-plan-text';
            txt.textContent = _stepLabel(step);
            li.appendChild(check);
            li.appendChild(txt);
            ol.appendChild(li);
        });
        card.appendChild(ol);

        _messages.appendChild(card);
        _messages.scrollTop = _messages.scrollHeight;
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
