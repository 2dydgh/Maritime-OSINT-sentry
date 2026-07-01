# UI Polish Design Spec — Maritime OSINT Sentry
**Date:** 2026-07-01  
**Branch:** feat/aircraft-tracking  
**Approach:** Admiralty Navy 유지 + 폴리시 (A안)  
**Scope:** 전체 화면 (메인 대시보드, Roll 뷰어, 항로 뷰어, 우측 패널, 채팅)

---

## 배경 및 목표

기존 Admiralty Navy 아이덴티티를 유지하면서 세 가지 핵심 페인포인트를 해결한다:
1. 폰트 혼잡 — 7개 패밀리가 역할 없이 혼재
2. 색상 충돌 — 하드코딩·보라 이중사용·토큰 우회
3. 완성도 부족 — 글로스 없음, 인터랙션 피드백 약함, 무한 애니메이션 남발

새 아이덴티티(Radar Glass 등)로의 전환은 이번 범위 밖. 색·레이아웃 전환 없이 토큰 정비 + 디테일 강화.

---

## 섹션 1: 타이포그래피

### 4개 역할 시스템 (확정)

| 토큰 | 폰트 | 역할 | 사용처 |
|------|------|------|--------|
| `--font-brand` | Orbitron 900 | 헤더 브랜드명 전용 | `.brand-name` 딱 1곳 |
| `--font-display` | Rajdhani 700/600 | 영문 UI 레이블 | 패널 타이틀, 버튼, 탭, 섹션 레이블 |
| `--font-body` | Pretendard Variable | 한국어 + 일반 설명 | 본문, 목록, 설명, 상태 텍스트 |
| `--font-data` | IBM Plex Mono 700/600 | 모든 수치·좌표·계기 | 속도, 방위, 좌표, 카운터, 하단바 |

### 제거 대상
- **Orbitron** → `--font-brand`로 역할 부여 (이전: 역할 미정의로 누수)
- **JetBrains Mono** → 제거 (`--font-data`에서 IBM Plex Mono로 단일화)
- **B612 Mono** → IBM Plex Mono로 교체
- **S-CoreDream-6Bold** → 제거 (Pretendard Variable로 한국어 커버)

### `index.html` 폰트 로드 변경
```html
<!-- 제거 -->
<link href="...Orbitron:wght@700..." />  <!-- 역할 재정의로 유지, weight만 900으로 -->
<link href="...JetBrains+Mono..." />     <!-- 제거 -->
<!-- S-CoreDream @font-face 블록 제거 -->

<!-- 추가/변경 -->
<link href="...IBM+Plex+Mono:wght@400;600;700..." />
```

### CSS `:root` 토큰 변경
```css
--font-brand:   'Orbitron', sans-serif;                          /* 신규 */
--font-display: 'Rajdhani', 'Pretendard Variable', sans-serif;   /* 유지 */
--font-body:    'Inter', 'Pretendard Variable', sans-serif;       /* 유지 */
--font-data:    'IBM Plex Mono', 'Pretendard Variable', monospace; /* B612 Mono → IBM Plex Mono */
```

### 크기 스케일 (참고용 — 토큰 미강제)
- `brand-title`: 0.68rem / Orbitron 900 / letter-spacing 3px
- `panel-header`: 0.72–0.82rem / Rajdhani 700 / letter-spacing 1.5px
- `body-sm`: 0.78rem / Pretendard
- `caption`: 0.62rem / Pretendard / color: `--text-sub`
- `data-hero`: 1.4–2.6rem / IBM Plex Mono 700
- `data-sm`: 0.70–0.72rem / IBM Plex Mono

---

## 섹션 2: 색상 시스템

### 수정 1 — 보라 #a78bfa 의미 충돌 분리
```css
/* AI 시나리오 배지: primary 계열로 */
.rv-scenario-badge { background: rgba(47,111,237,0.15); color: #5b8ef5; border-color: rgba(47,111,237,0.35); }

/* 바람 레전드: cyan-teal로 분리 */
.color-wind { background: #22d3ee; }
```

### 수정 2 — severity ramp 하드코딩 토큰화
```css
/* 전체 CSS에서 일괄 교체 */
#fbbf24  →  var(--sev-caution)   /* 4곳 */
#f43f5e  →  var(--sev-danger)    /* 1곳 */
#eab308  →  var(--primary)       /* 항로선·선박 마커 */
```

### 수정 3 — amber 토큰 중복 통합
```css
:root {
  --caution: #f5a623;               /* 유지 */
  --accent-amber: var(--caution);   /* #f59e0b → 별칭으로 */
}
```

### 수정 4 — 미정의 CSS 토큰
```css
/* 정의 추가 (또는 사용처에서 교체) */
--text-secondary: var(--text-sub);    /* #94a3b8 */
--text-primary:   var(--text-main);   /* #f4f4f5 */

/* #e2e8f0 하드코딩 → var(--text-main) 일괄 교체 */
```

### 수정 5 — 항로선 색 (안전 계기)
```js
// route-viewer.js
// 선: #eab308 → '#2f6fed'  (경고색 → 항법색)
// 선박 마커: #eab308 → '#5b8ef5'
```

### 최종 확정 팔레트 역할표

| 토큰 | 값 | 역할 |
|------|----|------|
| `--primary` | `#2f6fed` | 브랜드·인터랙션·active·AI 배지 |
| `--sev-caution` | `#d9a441` | 주의·fallback 배너 |
| `--sev-warning` | `#ec7a2c` | 경고·중위험 충돌 |
| `--sev-danger` | `#ef4444` | 위험·고위험 (유일한 빨강) |
| `--color-wind` | `#22d3ee` | 바람 레전드 전용 |
| `--text-main` | `#f4f4f5` | 주요 텍스트 |
| `--text-sub` | `#94a3b8` | 보조 텍스트 |
| `--accent-green` | `#22c55e` | 정상·연결·WS LED |

---

## 섹션 3: 애니메이션 절제

### 규칙
- **화면당 무한 애니메이션 1개만** 허용
  - 라이브 뷰: WS LED 펄스 (`ledBlink`) 1개
  - Roll 뷰어: 파도 시뮬레이션 1개
- 나머지 펄스류 → `animation-iteration-count: 3–4` 후 정지, 새 이벤트 시 JS로 재발화
- 대상: `badge-pulse`, `dangerHex`, `dangerDot`, `feedCardEnter` + `feedTicker` 중첩 제거

### 구체 변경
```css
/* 충돌 위험 헥사곤 */
.danger-hex { animation: dangerHex 1.5s ease-in-out 3; }  /* infinite → 3 */

/* 배지 펄스 */
.rail-badge.pulse { animation: ledBlink 1.5s ease-in-out 4; }  /* 이미 4회, 유지 */

/* 피드 카드 진입 + 티커 중첩 제거 */
.feed-card-enter { animation: feedCardEnter 0.3s ease-out 1; }
/* feedTicker와 동시 적용 금지 — JS에서 진입 후 ticker 클래스 추가 */
```

---

## 섹션 4: 폴리시 / 깊이

### 4-1. 패널 헤더 top 1px 하이라이트
```css
.right-panel-header::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 1px;
  background: linear-gradient(90deg, rgba(47,111,237,0.6) 0%, rgba(91,142,245,0.3) 40%, transparent 100%);
}
.right-panel-header { position: relative; }
```

### 4-2. 충돌 카드 severity left border
```css
.collision-item[data-severity="high"] {
  border-left: 2px solid var(--sev-danger);
  background: rgba(239,68,68,0.04);
  padding-left: 12px;
}
.collision-item[data-severity="med"] {
  border-left: 2px solid var(--sev-warning);
  padding-left: 12px;
}
```

### 4-3. 버튼 hover → 파란 테두리 + glow
```css
/* 오버레이 버튼 (지도 위 floating) */
.map-nav-btn:hover,
.map-mode-btn:hover,
.map-area-select-btn:hover {
  border-color: rgba(47,111,237,0.85);
  box-shadow: 0 0 12px rgba(47,111,237,0.25), 0 2px 8px rgba(0,0,0,0.4);
}
```

### 4-4. 레일 active 엣지바 glow
```css
.rail-icon.active::before {
  background: linear-gradient(180deg, #5b8ef5, #2f6fed);
  box-shadow: 0 0 6px rgba(47,111,237,0.5);  /* 추가 */
}
.rail-icon.active { background: rgba(47,111,237,0.07); }  /* 미세 틴트 추가 */
```

### 4-5. :focus-visible 전역 규칙
```css
/* main.css 최상단 global reset 바로 아래 추가 */
:focus-visible {
  outline: 2px solid rgba(47,111,237,0.7);
  outline-offset: 2px;
  border-radius: 4px;
}
```

### 4-6. 채팅 전송 버튼 아이콘
```html
<!-- index.html -->
<!-- 변경 전: -->
<button id="chat-send-btn">&#9654;</button>
<!-- 변경 후: -->
<button id="chat-send-btn"><i class="fa-solid fa-paper-plane"></i></button>
```

---

## 범위 밖 (이번 스펙 제외)

- Roll HUD 히어로 승격 (실측 횡요각 표시) — 별도 안전 픽스 티켓
- `#route-click-hint` DOM 미생성 — 별도 픽스
- 챗 데이터 신선도 (`feed_status` 컨텍스트 누락) — 백엔드 연동 필요
- 레이아웃 재구성 (레일 너비, 하단바 그리드 비율) — 범위 확장 시 별도 스펙

---

## 구현 순서 (권장)

1. **CSS 토큰 정비** (색·폰트 `:root` 변경, 하드코딩 교체, 미정의 토큰) — 시각 거의 불변, 회귀 낮음
2. **폰트 로드 정리** (`index.html` `<head>`) + `?v=` 범프
3. **폴리시 CSS** (top highlight, left border, button hover, rail glow, focus-visible)
4. **채팅 아이콘** + 항로 색 JS 수정
5. **애니메이션 iteration-count** 제한

각 배치 후 `?v=` 범프 필수 (`DEV_NO_CACHE=1` 없이 서버 띄웠을 경우).
