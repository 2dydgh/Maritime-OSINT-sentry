// ── OVERWATCH 4D — Layout Manager ──
// Handles sidebar toggle, right panel, dedicated screen transitions

var LayoutManager = (function() {
    var activePanel = null;     // currently active sidebar icon panel name
    var activeAction = null;    // 'right-panel' | 'layer-toggle' | 'dedicated-screen'
    var prevPanel = null;       // panel to return to from ship info

    function init() {
        // Sidebar icon click delegation
        var rail = document.querySelector('.icon-rail');
        if (rail) {
            rail.addEventListener('click', function(e) {
                var btn = e.target.closest('.rail-icon');
                if (!btn) return;
                var panel = btn.dataset.panel;
                var action = btn.dataset.action;
                handleIconClick(panel, action);
            });
        }

        // Right panel close buttons
        document.querySelectorAll('.right-panel-close').forEach(function(btn) {
            btn.addEventListener('click', function() {
                closeRightPanel();
                deactivateAllIcons();
                activePanel = null;
                activeAction = null;
            });
        });

        // Ship info back button → return to previous panel
        var backBtn = document.getElementById('shipInfoBack');
        if (backBtn) {
            backBtn.addEventListener('click', function() {
                if (prevPanel) {
                    activePanel = prevPanel;
                    activeAction = 'right-panel';
                    highlightIcon(prevPanel);
                    openRightPanel(prevPanel);
                    prevPanel = null;
                } else {
                    closeRightPanel();
                    deactivateAllIcons();
                    activePanel = null;
                    activeAction = null;
                }
            });
        }
    }

    var _transitioning = false;

    function handleIconClick(panel, action) {
        if (_transitioning) return;

        // Same panel clicked again
        if (panel === activePanel) {
            // For dedicated-screen models, check if MMSI changed → re-activate
            if (action === 'dedicated-screen') {
                var m = window.ModelRegistry && ModelRegistry.get(panel);
                if (m && m._selectedMmsi !== undefined) {
                    _transitioning = true;
                    deactivate(panel, action);
                    setTimeout(function() {
                        activate(panel, action);
                        _transitioning = false;
                    }, 50);
                    return;
                }
            }
            // Otherwise toggle off
            deactivate(panel, action);
            activePanel = null;
            activeAction = null;
            return;
        }

        // Dedicated-screen → dedicated-screen: deactivate first, then activate after cleanup
        var prevAction = activeAction;
        if (activePanel && prevAction === 'dedicated-screen' && action === 'dedicated-screen') {
            _transitioning = true;
            deactivate(activePanel, prevAction);
            activePanel = null;
            activeAction = null;
            setTimeout(function() {
                activate(panel, action);
                activePanel = panel;
                activeAction = action;
                _transitioning = false;
            }, 100);
            return;
        }

        // Deactivate previous
        if (activePanel) {
            deactivate(activePanel, activeAction);
        }

        // Activate new
        activate(panel, action);
        activePanel = panel;
        activeAction = action;
    }

    function activate(panel, action) {
        highlightIcon(panel);

        if (action === 'right-panel') {
            showDedicatedScreen(null);
            openRightPanel(panel);
        } else if (action === 'layer-toggle') {
            toggleModelLayer(panel, true);
            // Notify registry
            if (window.ModelRegistry && ModelRegistry.isModel(panel)) {
                ModelRegistry.activateModel(panel);
            }
        } else if (action === 'dedicated-screen') {
            closeRightPanel();
            showDedicatedScreen(panel);
            // Notify registry
            if (window.ModelRegistry && ModelRegistry.isModel(panel)) {
                ModelRegistry.activateModel(panel);
            }
        }
    }

    function deactivate(panel, action) {
        deactivateAllIcons();

        if (action === 'right-panel') {
            closeRightPanel();
        } else if (action === 'layer-toggle') {
            toggleModelLayer(panel, false);
            if (window.ModelRegistry && ModelRegistry.isModel(panel)) {
                ModelRegistry.deactivateModel(panel);
            }
        } else if (action === 'dedicated-screen') {
            showDedicatedScreen(null);
            if (window.ModelRegistry && ModelRegistry.isModel(panel)) {
                ModelRegistry.deactivateModel(panel);
            }
        }
    }

    function highlightIcon(panel) {
        deactivateAllIcons();
        var icon = document.querySelector('.rail-icon[data-panel="' + panel + '"]');
        if (icon) icon.classList.add('active');
    }

    function deactivateAllIcons() {
        document.querySelectorAll('.rail-icon').forEach(function(i) {
            i.classList.remove('active');
        });
    }

    // ── Right Panel ──
    function openRightPanel(panel) {
        var rp = document.getElementById('rightPanel');
        if (!rp) return;

        // Hide all views, show target
        rp.querySelectorAll('.right-panel-view').forEach(function(v) {
            v.classList.remove('active');
        });
        var target = document.getElementById('rightView-' + panel);
        if (target) target.classList.add('active');

        rp.classList.add('open');
        setTimeout(resizeActiveMap, 350);
    }

    function closeRightPanel() {
        var rp = document.getElementById('rightPanel');
        if (!rp) return;
        rp.classList.remove('open');
        rp.querySelectorAll('.right-panel-view').forEach(function(v) {
            v.classList.remove('active');
        });
        setTimeout(resizeActiveMap, 350);
    }

    // ── Dedicated Screen ──
    function showDedicatedScreen(panel) {
        var ds = document.getElementById('dedicatedScreen');
        if (!ds) return;

        ds.querySelectorAll('.dedicated-view').forEach(function(v) {
            v.classList.remove('active');
        });

        // Elements to hide during dedicated screen mode
        var mapTopBar = document.getElementById('mapTopBar');
        var mapNav = document.getElementById('mapNavControls');
        var leafletZoom = document.getElementById('leafletZoomControls');

        if (panel) {
            var target = document.getElementById('dedicated-' + panel);
            if (target) target.classList.add('active');
            ds.style.display = '';
            ds.classList.add('active');
            // Hide map-only UI elements
            var bb = document.getElementById('bottomBar');
            if (bb) bb.style.display = 'none';
            if (mapTopBar) mapTopBar.style.display = 'none';
            if (mapNav) mapNav.style.display = 'none';
            if (leafletZoom) leafletZoom.style.display = 'none';
        } else {
            ds.classList.remove('active');
            setTimeout(function() {
                if (!ds.classList.contains('active')) {
                    ds.style.display = 'none';
                }
            }, 300);
            // Restore map-only UI elements
            var bb = document.getElementById('bottomBar');
            if (bb) bb.style.display = '';
            if (mapTopBar) mapTopBar.style.display = '';
            if (mapNav) mapNav.style.display = '';
            if (leafletZoom) leafletZoom.style.display = '';
        }
    }

    // ── Layer Toggle (placeholder for model layers) ──
    function toggleModelLayer(panel, on) {
        // Placeholder: will be implemented when model layers are added
        // For now, just toggle icon active state
        var icon = document.querySelector('.rail-icon[data-panel="' + panel + '"]');
        if (icon) {
            if (on) {
                icon.classList.add('layer-active');
            } else {
                icon.classList.remove('layer-active');
            }
        }
    }

    // ── Public: open ship info in right panel ──
    function showShipInfo() {
        // Remember current panel so back button can return to it
        prevPanel = (activePanel && activePanel !== 'ship') ? activePanel : prevPanel || null;
        deactivateAllIcons();
        activePanel = 'ship';
        activeAction = 'right-panel';
        openRightPanel('ship');
    }

    function getActivePanel() {
        return activePanel;
    }

    /** Explicitly close the active dedicated-screen (used by back buttons). */
    function closeDedicatedPanel() {
        if (activePanel && activeAction === 'dedicated-screen') {
            deactivate(activePanel, activeAction);
            activePanel = null;
            activeAction = null;
        }
    }

    return {
        init: init,
        handleIconClick: handleIconClick,
        openRightPanel: openRightPanel,
        closeRightPanel: closeRightPanel,
        closeDedicatedPanel: closeDedicatedPanel,
        showShipInfo: showShipInfo,
        showDedicatedScreen: showDedicatedScreen,
        getActivePanel: getActivePanel
    };
})();

window.LayoutManager = LayoutManager;
