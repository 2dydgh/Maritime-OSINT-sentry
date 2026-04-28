// ── Maritime OSINT Sentry — ECharts Data Visualization ──

var CHART_THEME = {
    bg: 'transparent',
    text: '#cbd5e1',
    textDim: '#94a3b8',
    axisLine: 'rgba(148,163,184,0.18)',
    danger: '#f43f5e',
    warning: '#f97316',
    caution: '#eab308',
    safe: '#10b981',
    accent: '#3b82f6'
};

function initCharts() {
    // Ship type chart moved to bottom bar (CSS mini bars via BottomBar.updateVesselTypes)
}
window.initCharts = initCharts;

// updateCollisionCharts removed — charts moved out of collision drawer
function updateCollisionCharts() {}
window.updateCollisionCharts = updateCollisionCharts;

// Ship type chart now rendered by BottomBar.updateVesselTypes (sparkline.js)
function updateShipTypeChart() {}
window.updateShipTypeChart = updateShipTypeChart;
