// ── OVERWATCH 4D — Layout Manager ──
// Handles sidebar toggle, right panel, dedicated screen transitions

var LayoutManager = (function() {
    var activePanel = null;     // currently active sidebar icon panel name
    var activeAction = null;    // 'right-panel' | 'layer-toggle' | 'dedicated-screen'

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
    }

    function handleIconClick(panel, action) {
        // Toggle: same icon clicked again → deactivate
        if (panel === activePanel) {
            deactivate(panel, action);
            activePanel = null;
            activeAction = null;
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
        } else if (action === 'dedicated-screen') {
            closeRightPanel();
            showDedicatedScreen(panel);
        }
    }

    function deactivate(panel, action) {
        deactivateAllIcons();

        if (action === 'right-panel') {
            closeRightPanel();
        } else if (action === 'layer-toggle') {
            toggleModelLayer(panel, false);
        } else if (action === 'dedicated-screen') {
            showDedicatedScreen(null);
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

        if (panel) {
            var target = document.getElementById('dedicated-' + panel);
            if (target) target.classList.add('active');
            ds.style.display = '';
            ds.classList.add('active');
            // Hide bottom bar in dedicated screen mode
            var bb = document.getElementById('bottomBar');
            if (bb) bb.style.display = 'none';
        } else {
            ds.classList.remove('active');
            setTimeout(function() {
                if (!ds.classList.contains('active')) {
                    ds.style.display = 'none';
                }
            }, 300);
            var bb = document.getElementById('bottomBar');
            if (bb) bb.style.display = '';
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
        // Deactivate sidebar selection (ship info is not a sidebar item)
        deactivateAllIcons();
        activePanel = 'ship';
        activeAction = 'right-panel';
        openRightPanel('ship');
    }

    function getActivePanel() {
        return activePanel;
    }

    return {
        init: init,
        handleIconClick: handleIconClick,
        openRightPanel: openRightPanel,
        closeRightPanel: closeRightPanel,
        showShipInfo: showShipInfo,
        showDedicatedScreen: showDedicatedScreen,
        getActivePanel: getActivePanel
    };
})();

document.addEventListener('DOMContentLoaded', function() {
    LayoutManager.init();
});

window.LayoutManager = LayoutManager;
