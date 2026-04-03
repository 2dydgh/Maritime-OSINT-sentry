// ── OVERWATCH 4D — Model Registry ──
// Plugin framework for AI model visualization.
// Each model registers with metadata + lifecycle callbacks.
// Layout manager delegates to this registry for model-related actions.

var ModelRegistry = (function() {
    var models = {};
    var initialized = false;

    // ── Model Definitions ──
    // type: 'globe-layer' → overlay on CesiumJS globe
    // type: 'dedicated-screen' → full-screen takeover (Three.js, charts, etc.)

    var MODEL_DEFS = {
        'route-inference': {
            name: '관습 항로 추론',
            icon: 'fa-solid fa-route',
            label: '항로',
            type: 'dedicated-screen',
            title: '관습 항로 추론',
            init: function() {},
            activate: function() {
                if (window.RouteViewer) RouteViewer.activate();
            },
            deactivate: function() {
                if (window.RouteViewer) RouteViewer.deactivate();
            },
            getShipSummary: function(mmsi) {
                return { label: '항로', status: '정상', level: 'safe', icon: 'fa-route' };
            }
        },
        'accident-zones': {
            name: '사고다발 해역',
            icon: 'fa-solid fa-burst',
            label: '사고',
            type: 'globe-layer',
            title: '사고다발 해역',
            init: function() {},
            activate: function() {
                // TODO: show accident heatmap/polygon entities
            },
            deactivate: function() {
                // TODO: hide accident entities
            },
            getShipSummary: function(mmsi) {
                return { label: '사고해역', status: '안전', level: 'safe', icon: 'fa-burst' };
            }
        },
        'dark-ship': {
            name: 'Dark Ship 탐지',
            icon: 'fa-solid fa-ghost',
            label: 'Dark',
            type: 'globe-layer',
            title: 'Dark Ship 탐지',
            init: function() {},
            activate: function() {
                // TODO: show dark ship markers + uncertainty circles
            },
            deactivate: function() {
                // TODO: hide dark ship entities
            },
            getShipSummary: function(mmsi) {
                return { label: 'Dark', status: '정상', level: 'safe', icon: 'fa-ghost' };
            }
        },
        'roll-prediction': {
            name: '횡요각 예측',
            icon: 'fa-solid fa-compass-drafting',
            label: '횡요각',
            type: 'dedicated-screen',
            title: '횡요각 예측',
            _selectedMmsi: null,
            init: function() {},
            activate: function() {
                var mmsi = this._selectedMmsi;
                if (window.RollViewer) RollViewer.load(mmsi);
            },
            deactivate: function() {
                if (window.RollViewer) RollViewer.dispose();
            },
            getShipSummary: function(mmsi) {
                return { label: '횡요각', status: '4.2°', level: 'safe', icon: 'fa-compass-drafting' };
            }
        },
        'carbon-emission': {
            name: '탄소 배출량',
            icon: 'fa-solid fa-leaf',
            label: '탄소',
            type: 'dedicated-screen',
            title: '탄소 배출',
            init: function() {
                // TODO: init ECharts dashboard
            },
            activate: function() {
                // TODO: render/refresh charts
            },
            deactivate: function() {
                // TODO: dispose ECharts instances
            },
            getShipSummary: function(mmsi) {
                return { label: '탄소', status: '8.1t/h', level: 'warning', icon: 'fa-leaf' };
            }
        }
    };

    // ── Init: generate sidebar buttons + dedicated screen containers ──
    function init() {
        if (initialized) return;
        initialized = true;

        // Copy definitions into registry
        Object.keys(MODEL_DEFS).forEach(function(id) {
            models[id] = MODEL_DEFS[id];
        });

        generateSidebarButtons();
        generateDedicatedScreens();

        // Call each model's init
        Object.keys(models).forEach(function(id) {
            if (typeof models[id].init === 'function') {
                models[id].init();
            }
        });
    }

    function generateSidebarButtons() {
        var rail = document.querySelector('.icon-rail');
        if (!rail) return;

        // Find the MODELS section placeholder
        var modelsTitle = rail.querySelector('.rail-group-title-models');
        if (!modelsTitle) return;

        // Remove existing model buttons (between MODELS title and spacer)
        var sibling = modelsTitle.nextElementSibling;
        while (sibling && !sibling.classList.contains('rail-spacer')) {
            var next = sibling.nextElementSibling;
            sibling.remove();
            sibling = next;
        }

        // Insert generated buttons before the spacer
        var spacer = rail.querySelector('.rail-spacer');
        Object.keys(models).forEach(function(id) {
            var m = models[id];
            var btn = document.createElement('button');
            btn.className = 'rail-icon';
            btn.dataset.panel = id;
            btn.dataset.action = m.type;
            btn.title = m.title;
            btn.innerHTML =
                '<i class="' + m.icon + '"></i>' +
                '<span class="rail-label">' + m.label + '</span>';
            rail.insertBefore(btn, spacer);
        });
    }

    function generateDedicatedScreens() {
        var ds = document.getElementById('dedicatedScreen');
        if (!ds) return;

        // Clear existing dedicated views
        ds.innerHTML = '';

        // Generate a container for each dedicated-screen model
        Object.keys(models).forEach(function(id) {
            var m = models[id];
            if (m.type !== 'dedicated-screen') return;
            var div = document.createElement('div');
            div.id = 'dedicated-' + id;
            div.className = 'dedicated-view';
            ds.appendChild(div);
        });
    }

    // ── Lifecycle: called by LayoutManager ──
    function activateModel(id) {
        var m = models[id];
        if (!m) return;
        if (typeof m.activate === 'function') m.activate();
    }

    function deactivateModel(id) {
        var m = models[id];
        if (!m) return;
        if (typeof m.deactivate === 'function') m.deactivate();
    }

    // ── Ship Panel: render model summary cards ──
    function renderShipModelCards(mmsi, container) {
        if (!container) return;

        // Clear previous cards
        var existing = container.querySelector('.model-cards-grid');
        if (existing) existing.remove();

        var grid = document.createElement('div');
        grid.className = 'model-cards-grid';

        Object.keys(models).forEach(function(id) {
            var m = models[id];
            if (typeof m.getShipSummary !== 'function') return;

            var summary = m.getShipSummary(mmsi);
            if (!summary) return;

            var card = document.createElement('div');
            card.className = 'model-card model-card-' + (summary.level || 'safe');
            card.dataset.modelId = id;
            card.innerHTML =
                '<div class="model-card-icon"><i class="fa-solid ' + (summary.icon || 'fa-circle') + '"></i></div>' +
                '<div class="model-card-label">' + summary.label + '</div>' +
                '<div class="model-card-value">' + summary.status + '</div>';

            // Click card → navigate to that model
            card.addEventListener('click', function() {
                var action = m.type;
                // Pass MMSI to dedicated-screen models
                if (m.type === 'dedicated-screen' && m._selectedMmsi !== undefined) {
                    m._selectedMmsi = mmsi;
                }
                if (window.LayoutManager) {
                    LayoutManager.handleIconClick(id, action);
                }
            });

            grid.appendChild(card);
        });

        container.appendChild(grid);
    }

    // ── Query ──
    function get(id) {
        return models[id] || null;
    }

    function getAll() {
        return models;
    }

    function isModel(panelId) {
        return !!models[panelId];
    }

    function getType(panelId) {
        var m = models[panelId];
        return m ? m.type : null;
    }

    return {
        init: init,
        activateModel: activateModel,
        deactivateModel: deactivateModel,
        renderShipModelCards: renderShipModelCards,
        get: get,
        getAll: getAll,
        isModel: isModel,
        getType: getType
    };
})();

window.ModelRegistry = ModelRegistry;
