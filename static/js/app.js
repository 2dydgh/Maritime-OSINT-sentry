// ── Maritime OSINT Sentry — App Entry Point ──
// Shared global state declarations. All variables use `var` or `window.x`
// so they are accessible across all script files loaded via <script> tags.

var currentMapMode = '3d';
var leafletMap = null;
var viewer = null; // set in map-cesium.js
var shipDataMap = {};
var shipDataSources = {};
// Primitive Collection 참조 (신규)
var shipBillboards = {};      // { type: BillboardCollection }
var shipLabels = {};           // { type: LabelCollection }
var shipBillboardMap = {};     // { mmsi: Billboard }
var shipLabelMap = {};         // { mmsi: Label }
var SHIP_TYPES = ['cargo', 'tanker', 'passenger', 'fishing', 'military', 'tug', 'other'];
var SHIP_COLORS = {
    cargo: '#10b981',
    tanker: '#f97316',
    passenger: '#0ea5e9',
    fishing: '#eab308',
    military: '#6366f1',
    tug: '#a855f7',
    other: '#6b7280'
};

var satDataSource = null; // set in map-cesium.js
var _satRecCache = {};
var SAT_COLORS = {
    military_recon: '#fde047',
    military_sar: '#f97316',
    sar: '#f97316',
    sigint: '#eab308',
    navigation: '#10b981',
    early_warning: '#a855f7',
    space_station: '#3b82f6',
    commercial_imaging: '#94a3b8',
};

var proximityDataSource = null; // set in map-cesium.js
// Proximity Primitive Collections (신규)
var proximityLines = null;     // PolylineCollection
var proximityLabels = null;    // LabelCollection
var proximityCogLines = null;  // PolylineCollection
var proximityCpaPoints = null; // PointPrimitiveCollection
var proximityCpaLabels = null; // LabelCollection
var proximityMap = {};         // { targetMmsi: { line, label, cogSel, cogTgt, cpaPoint, cpaLabel } }
var selectedProximityMmsi = null;
var collisionTargetMmsi = null;
var latestWsShipsMmsis = new Set();
var collisionData = { distance: { risks: [] }, ml: { risks: [] } };
var collisionActiveTab = 'distance';
var mlRiskFilter = null;
var timeMode = 'live';

// Leaflet shared state
var leafletInitialized = false;
var leafletShipMarkers = {};
var leafletShipLayerGroups = {};
var leafletCollisionLines = {};
var leafletSatMarkers = {};
var leafletSatTracks = {};
var leafletSatFootprints = {};

// Proximity shared state
var lastProximityUpdate = 0;
var proximityMissCount = 0;
var PROXIMITY_RADIUS_NM = 10;
var PROXIMITY_MAX_COUNT = 10;
var PROXIMITY_THROTTLE_MS = 2000;

// ML risk colors and labels (shared between collision and proximity)
var ML_RISK_COLORS = {
    3: '#f43f5e',
    2: '#f97316',
    1: '#eab308',
    0: '#10b981',
};
var ML_RISK_LABELS = { 3: '위험', 2: '경고', 1: '주의' };
