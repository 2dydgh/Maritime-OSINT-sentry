const WebSocket = require('ws');

const args = process.argv.slice(2);
const API_KEY = args[0] || process.env.AIS_API_KEY;

if (!API_KEY) {
    console.error("FATAL: AIS_API_KEY is not set. WebSocket proxy cannot start.");
    process.exit(1);
}

// "minLat,minLng,maxLat,maxLng" — 저사양 서버가 전세계 물량을 못 버텨서 기본은
// 한국/동아시아 근해로 좁힘 (backend/config.py:AIS_BOUNDING_BOX 기본값 참고).
const bboxArg = args[1] || process.env.AIS_BOUNDING_BOX || "-90,-180,90,180";
const [minLat, minLng, maxLat, maxLng] = bboxArg.split(",").map(Number);
const BOUNDING_BOXES = [[[minLat, minLng], [maxLat, maxLng]]];

// ── Reconnect 정책 ──────────────────────────────────────────────
// 고정 5초 재접속은 서버가 429(Too Many Requests)로 거부하기 시작하면
// 디도스성 트래픽이 되어 IP 가 영구 차단(blacklist)될 위험이 있다.
// → 지수 backoff + jitter, 429 시엔 훨씬 긴 쿨다운으로 물러난다.
const BASE_DELAY_MS = 5000;        // 정상 끊김 시작 지연
const MAX_DELAY_MS = 300000;       // 상한 5분
const RATE_LIMIT_DELAY_MS = 60000; // 429 최초 쿨다운 1분
const RESET_AFTER_MS = 30000;      // 이 시간 이상 안정 수신하면 backoff 리셋

let reconnectDelay = BASE_DELAY_MS;
let reconnectTimer = null;         // 중복 재접속 타이머 방지

function scheduleReconnect(delay) {
    // error + close 가 함께 터질 때 타이머가 두 번 잡히는 것을 막는다.
    if (reconnectTimer) return;
    const jitter = Math.floor(Math.random() * 1000); // 동시 재접속 분산
    const wait = delay + jitter;
    console.error(`WebSocket Proxy: reconnecting in ${Math.round(wait / 1000)}s...`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, wait);
    // 다음 끊김은 더 길게 (상한까지). 안정 수신 시 connect() 에서 리셋.
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY_MS);
}

function connect() {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    let resetTimer = null;

    ws.on('open', () => {
        const subMsg = {
            APIKey: API_KEY,
            BoundingBoxes: BOUNDING_BOXES,
            FilterMessageTypes: [
                "PositionReport",
                "ShipStaticData",
                "StandardClassBPositionReport"
            ]
        };
        ws.send(JSON.stringify(subMsg));
        // 일정 시간 끊기지 않고 버티면 정상 연결로 보고 backoff 리셋.
        resetTimer = setTimeout(() => { reconnectDelay = BASE_DELAY_MS; }, RESET_AFTER_MS);
    });

    ws.on('message', (data) => {
        // Output raw AIS message JSON to stdout so Python can consume it
        // We ensure exactly one JSON object per line.
        try {
            const parsed = JSON.parse(data);
            console.log(JSON.stringify(parsed));
        } catch (e) {
            // ignore non-json
        }
    });

    // 핸드셰이크가 비-101 로 거부될 때 (429 등) status code 를 받는다.
    ws.on('unexpected-response', (req, res) => {
        if (res.statusCode === 429) {
            // rate limit: backoff 를 최소 1분 이상으로 끌어올려 물러난다.
            reconnectDelay = Math.max(reconnectDelay, RATE_LIMIT_DELAY_MS);
            console.error("WebSocket Proxy: 429 Too Many Requests — backing off hard.");
        } else {
            console.error(`WebSocket Proxy: unexpected response ${res.statusCode}`);
        }
        res.destroy();
    });

    ws.on('error', (err) => {
        console.error("WebSocket Proxy Error:", err.message);
        // 'error' 뒤엔 보통 'close' 가 따라오므로 재접속은 close 에서 처리.
    });

    ws.on('close', () => {
        if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
        console.error("WebSocket Proxy Closed.");
        scheduleReconnect(reconnectDelay);
    });
}

connect();
