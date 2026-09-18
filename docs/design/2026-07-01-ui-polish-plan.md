# UI 폴리시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admiralty Navy 시스템을 유지하면서 폰트 4역할 정리, 색 토큰 수정, 폴리시 디테일 5가지를 적용한다.

**Architecture:** CSS `:root` 토큰 수정이 중심이며, index.html 폰트 로드와 route-viewer.js 색 수정이 동반된다. 레이아웃/구조 변경 없음. 각 태스크는 `DEV_NO_CACHE=1` 개발 서버 + 브라우저 새로고침으로 검증한다.

**Tech Stack:** vanilla CSS custom properties, vanilla JS, FastAPI dev server (`uv run`)

## Global Constraints

- 개발 서버 실행: `DEV_NO_CACHE=1 uv run uvicorn backend.main:app --host 0.0.0.0 --port 12081`
- 정적 파일 캐시: `DEV_NO_CACHE=1` 없이 서버를 띄운 경우 `index.html`의 `?v=` 숫자를 올려야 새로고침에 반영됨
- `DEV_NO_CACHE=1`으로 띄우면 `?v=` 변경 불필요
- `.env` 커밋 금지
- 색·폰트는 모두 CSS 토큰(`--변수명`)으로, JS에서 직접 참조할 때는 해당 토큰의 hex 값을 상수로 표시

## 사전 확인 (이미 완료된 항목 — 건드리지 말 것)

코드 분석 결과 아래 항목은 **이미 수정돼 있음**:
- `--accent-amber: var(--caution)` — main.css:74 ✓
- `.color-wind { background-color: #22d3ee; }` — main.css:3484 ✓  
- `.map-nav-btn:hover` blue border + glow — main.css:4035 ✓ (토큰 사용 중)
- CSS 내 `#fbbf24`/`#f43f5e` 하드코딩 — 주석에만 존재, 실제 적용 없음 ✓

---

## File Map

| 파일 | 변경 내용 |
|------|-----------|
| `static/index.html` | Google Fonts URL 수정, S-CoreDream import 제거, chat send 아이콘 교체, `?v=` 범프 |
| `static/css/main.css` | `:root` 토큰 수정(폰트·색), `@font-face` S-CoreDream 블록 제거, AI badge 색, rail glow, panel highlight, map-mode-btn hover, `:focus-visible`, animation iteration-count |
| `static/js/route-viewer.js` | `#eab308`/`#fbbf24` → primary/caution hex |

---

## Task 1: 폰트 시스템

**Files:**
- Modify: `static/index.html` (head의 Google Fonts `<link>`)
- Modify: `static/css/main.css:1-25` (`@font-face` + `:root` 토큰)

**Goal:** B612 Mono/JetBrains Mono 제거 → IBM Plex Mono 추가, `--font-brand` 신규, `--font-display`에서 S-CoreDream 제거, `--font-data` → IBM Plex Mono

- [ ] **Step 1: index.html Google Fonts URL 교체**

`static/index.html` 23-24번째 줄의 Google Fonts `<link>`를 찾아 교체한다.

```html
<!-- 변경 전 -->
<link
    href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=JetBrains+Mono:wght@400;700&family=Orbitron:wght@700;900&family=Rajdhani:wght@600;700&family=B612+Mono:wght@400;700&display=swap"
    rel="stylesheet">

<!-- 변경 후 -->
<link
    href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&family=Inter:wght@300;400;600;700&family=Orbitron:wght@900&family=Rajdhani:wght@600;700&display=swap"
    rel="stylesheet">
```

변경 사항:
- 제거: `JetBrains+Mono`, `B612+Mono`, `Orbitron:wght@700` (900만 유지)
- 추가: `IBM+Plex+Mono:wght@400;600;700`

- [ ] **Step 2: main.css `@font-face` S-CoreDream 블록 제거**

`static/css/main.css` 1-6줄의 `@font-face` 블록 전체를 삭제한다.

```css
/* 이 블록 전체 삭제 */
@font-face {
    font-family: 'S-CoreDream-6Bold';
    src: url('https://fastly.jsdelivr.net/gh/projectnoonnu/noonfonts_six@1.2/S-CoreDream-6Bold.woff') format('woff');
    font-weight: 700;
    font-style: normal;
}
```

- [ ] **Step 3: main.css `:root` 폰트 토큰 업데이트**

`static/css/main.css` `:root` 블록 내 아래 세 줄을 찾아 교체한다:

```css
/* 변경 전 */
--font-display: 'Rajdhani', 'S-CoreDream-6Bold', 'Pretendard Variable', sans-serif;
--font-body: 'Inter', 'Pretendard Variable', sans-serif;
--font-data: 'B612 Mono', 'JetBrains Mono', 'Pretendard Variable', monospace;

/* 변경 후 */
--font-brand:   'Orbitron', sans-serif;
--font-display: 'Rajdhani', 'Pretendard Variable', sans-serif;
--font-body:    'Inter', 'Pretendard Variable', sans-serif;
--font-data:    'IBM Plex Mono', 'Pretendard Variable', monospace;
```

- [ ] **Step 4: brand-name에 --font-brand 적용**

`static/css/main.css`에서 `.brand-name` 셀렉터를 찾아 폰트를 적용한다. 현재 `font-family`가 없거나 `--font-display`를 쓰고 있다면 교체:

```css
.brand-name {
    font-family: var(--font-brand);
    /* 나머지 기존 속성 유지 */
}
```

- [ ] **Step 5: 서버 띄우고 시각 검증**

```bash
DEV_NO_CACHE=1 uv run uvicorn backend.main:app --host 0.0.0.0 --port 12081 &
```

브라우저에서 `http://localhost:12081` 접속 후:
- 헤더 "MARITIME OSINT SENTRY" → Orbitron 폰트로 렌더링되는지 확인 (각진 기하학적 글자체)
- 패널 제목 "COLLISION RISK" → Rajdhani (넓은 자폭, 두꺼운 자체)
- 하단바 숫자 "14kt / 2.1m" → IBM Plex Mono (날렵한 모노스페이스)
- DevTools > Network > Fonts 탭에서 `IBM Plex Mono` 로드 확인, `B612 Mono`/`JetBrains Mono` 없는지 확인

- [ ] **Step 6: 커밋**

```bash
git add static/index.html static/css/main.css
git commit -m "style: 폰트 4역할 시스템 — Orbitron/Rajdhani/Pretendard/IBM Plex Mono"
```

---

## Task 2: 색상 수정

**Files:**
- Modify: `static/css/main.css:1370-1386` (AI scenario badge)
- Modify: `static/js/route-viewer.js:123,259,965,992`

**Goal:** AI 배지의 보라 `#a78bfa` → primary 계열, 항로선 `#eab308` → `#2f6fed`, 웨이포인트 `#fbbf24` → `#d9a441`

- [ ] **Step 1: AI scenario badge 색 수정 (main.css)**

`static/css/main.css:1370`의 `.rv-scenario-badge` 블록을 찾아 color를 수정한다.

```css
/* 변경 전 */
.rv-scenario-badge {
    ...
    color: #a78bfa;
    ...
}

/* 변경 후 */
.rv-scenario-badge {
    ...
    color: var(--accent-glow);   /* #4d9bff — primary 계열 밝은 파랑 */
    ...
}
```

같은 블록 내 `border-color`나 `background`에 `#a78bfa`가 있다면 함께 교체:
- `background` → `var(--primary-muted)` (`rgba(47,111,237,0.12)`)
- `border-color` → `rgba(47, 111, 237, 0.35)`

- [ ] **Step 2: route-viewer.js 항로선 색 수정**

`static/js/route-viewer.js:965`에서 항로 라인 색을 변경한다:

```js
// 변경 전 (line 965)
color: '#eab308',

// 변경 후
color: '#2f6fed',
```

- [ ] **Step 3: route-viewer.js 선박 SVG 마커 색 수정**

`static/js/route-viewer.js:259`와 `992`의 선박 SVG 폴리곤 fill 색을 변경한다:

```js
// 변경 전 (line 259 및 992)
'<polygon points="16,2 28,28 16,22 4,28" fill="#eab308" stroke="#a16207" stroke-width="1.5"/>'

// 변경 후
'<polygon points="16,2 28,28 16,22 4,28" fill="#5b8ef5" stroke="#2f6fed" stroke-width="1.5"/>'
```

- [ ] **Step 4: route-viewer.js 웨이포인트 마커 색 수정**

`static/js/route-viewer.js:123`의 waypoint 색 변경:

```js
// 변경 전
var c = slot === 'from' ? '#10b981' : slot === 'to' ? '#ef4444' : '#fbbf24';

// 변경 후
var c = slot === 'from' ? '#10b981' : slot === 'to' ? '#ef4444' : '#d9a441';
// '#fbbf24'(밝은 노랑) → '#d9a441'(--sev-caution hex: 차분한 muted gold)
```

- [ ] **Step 5: 항로 화면에서 시각 검증**

브라우저에서 항로 뷰어로 진입 후:
- 항로 라인이 경고색(노랑)이 아닌 파란색(`#2f6fed`)으로 표시되는지 확인
- 선박 마커(▲)가 노랑 대신 파란색(`#5b8ef5`)으로 표시되는지 확인
- 중간 웨이포인트 dot이 muted gold(`#d9a441`)로 표시되는지 확인

- [ ] **Step 6: 커밋**

```bash
git add static/css/main.css static/js/route-viewer.js
git commit -m "style: 색 수정 — AI 배지 보라 제거, 항로선 경고색→항법색"
```

---

## Task 3: 폴리시 CSS

**Files:**
- Modify: `static/css/main.css` (여러 셀렉터에 추가)

**Goal:** 패널 top highlight, rail active glow, map-mode-btn hover 개선, `:focus-visible` 전역 규칙

- [ ] **Step 1: :focus-visible 전역 규칙 추가**

`static/css/main.css`에서 `@font-face` 블록이 있던 자리(파일 최상단) 또는 `* { ... }` 블록 바로 뒤에 추가:

```css
/* 키보드 포커스 링 — 전역 */
:focus-visible {
    outline: 2px solid rgba(47, 111, 237, 0.7);
    outline-offset: 2px;
    border-radius: 4px;
}
```

- [ ] **Step 2: 우측 패널 헤더 top highlight 추가**

`static/css/main.css`에서 `.right-panel-header` 블록을 찾아 `position: relative` 추가 및 `::before` 규칙 추가:

```css
/* 기존 .right-panel-header에 position: relative 추가 */
.right-panel-header {
    /* 기존 속성들 유지 */
    position: relative;  /* ::before 위치 기준 */
}

/* 아래에 ::before 추가 */
.right-panel-header::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg,
        rgba(47, 111, 237, 0.6) 0%,
        rgba(91, 142, 245, 0.3) 40%,
        transparent 100%
    );
    pointer-events: none;
}
```

- [ ] **Step 3: rail-icon active 엣지바 glow 추가**

`static/css/main.css:210-220`의 `.rail-icon.active::before` 블록을 찾아 `box-shadow`와 `background` 그라데이션 추가:

```css
/* 변경 전 */
.rail-icon.active::before {
    content: '';
    position: absolute;
    left: -3px;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 24px;
    background: var(--primary);
    border-radius: 0 3px 3px 0;
}

/* 변경 후 */
.rail-icon.active::before {
    content: '';
    position: absolute;
    left: -3px;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 24px;
    background: linear-gradient(180deg, var(--accent-glow), var(--primary));
    border-radius: 0 3px 3px 0;
    box-shadow: 0 0 6px rgba(47, 111, 237, 0.5);
}
```

`.rail-icon.active` 에도 미세 배경 틴트 추가:

```css
.rail-icon.active {
    background: rgba(47, 111, 237, 0.07);  /* transparent → 미세 틴트 */
    color: var(--text-main);
}
```

- [ ] **Step 4: map-mode-btn hover blue border + glow 추가**

`static/css/main.css:5060`의 `.map-mode-btn:hover:not(.active)` 블록을 찾아 border/glow 추가:

```css
/* 변경 전 */
.map-mode-btn:hover:not(.active) {
    color: var(--text-main);
}

/* 변경 후 */
.map-mode-btn:hover:not(.active) {
    color: var(--text-main);
    border-color: var(--btn-overlay-border-hover);  /* rgba(47,111,237,0.85) */
    box-shadow: var(--btn-overlay-glow-hover);      /* 0 0 16px rgba(47,111,237,0.35)... */
}
```

- [ ] **Step 5: 시각 검증**

브라우저에서:
1. **Tab 키**를 눌러 포커스 링이 파란 아웃라인으로 보이는지 확인
2. **COLLISION RISK** 패널 열기 → 헤더 상단에 파란 그라데이션 1px 라인 확인
3. **라이브 버튼** active 상태 → 왼쪽 엣지바에 glow 생겼는지 확인
4. **2D/3D 토글 버튼** hover → 파란 테두리와 glow 확인

- [ ] **Step 6: 커밋**

```bash
git add static/css/main.css
git commit -m "style: 폴리시 — panel highlight, rail glow, btn hover, focus-visible"
```

---

## Task 4: 채팅 아이콘 + 애니메이션

**Files:**
- Modify: `static/index.html:544`
- Modify: `static/css/main.css` (animation iteration-count)

**Goal:** 채팅 전송 버튼 아이콘 교체, feedTicker 제외 무한 애니메이션 iteration-count 제한

- [ ] **Step 1: 채팅 전송 버튼 아이콘 교체**

`static/index.html:544`에서:

```html
<!-- 변경 전 -->
<button id="chat-send-btn" class="chat-send-btn" title="전송">&#9654;</button>

<!-- 변경 후 -->
<button id="chat-send-btn" class="chat-send-btn" title="전송">
    <i class="fa-solid fa-paper-plane"></i>
</button>
```

- [ ] **Step 2: animation iteration-count 제한**

`static/css/main.css`에서 `infinite`를 쓰는 애니메이션을 검색:

```bash
grep -n "animation.*infinite" static/css/main.css
```

아래 기준으로 수정:
- **feedTicker** (main.css:2821) — 텍스트 스크롤이므로 `infinite` **유지**
- **ledBlink** — `.rail-badge.pulse` (이미 `4` 회 제한) **유지**
- 나머지 `infinite` 항목들 → `animation-iteration-count: 3` 추가 또는 shorthand에서 `infinite` → `3` 교체

예시 (실제 발견된 경우):
```css
/* 변경 전 */
animation: dangerPulse 1.2s ease-in-out infinite;

/* 변경 후 */
animation: dangerPulse 1.2s ease-in-out 3;
```

Step 2 실행 후 grep으로 남은 infinite 목록을 재확인하여 feedTicker + ledBlink 외에 없는지 검증.

- [ ] **Step 3: 시각 검증**

브라우저에서:
1. 채팅 버튼 → 종이비행기 아이콘(✈) 표시 확인
2. 충돌 위험 이벤트 발생 시 배지 펄스가 3-4회 후 정지하는지 확인 (라이브 데이터 필요; 없으면 DevTools에서 클래스 수동 추가 후 확인)

- [ ] **Step 4: ?v= 범프 (DEV_NO_CACHE=1 없이 서버를 띄울 경우)**

`DEV_NO_CACHE=1` 없이 서버를 쓰는 경우에만 수행. `static/index.html`에서:

```html
<!-- css/main.css?v= 숫자를 현재값 +1로 올림 -->
<link rel="stylesheet" href="css/main.css?v=252">
```

- [ ] **Step 5: 최종 커밋**

```bash
git add static/index.html static/css/main.css
git commit -m "style: 채팅 아이콘 교체, 무한 애니메이션 제한"
```

---

## Self-Review

**Spec coverage 체크:**

| 스펙 요구사항 | 구현 태스크 |
|---|---|
| `--font-brand` Orbitron 추가 | Task 1 Step 3 |
| `--font-data` IBM Plex Mono 교체 | Task 1 Step 3 |
| S-CoreDream 제거 | Task 1 Step 1-2 |
| JetBrains Mono 제거 | Task 1 Step 1 |
| AI 배지 `#a78bfa` 제거 | Task 2 Step 1 |
| 항로선 경고색 → 항법색 | Task 2 Step 2-4 |
| `.right-panel-header` top highlight | Task 3 Step 2 |
| rail active glow | Task 3 Step 3 |
| map-mode-btn hover 개선 | Task 3 Step 4 |
| `:focus-visible` 전역 규칙 | Task 3 Step 1 |
| 채팅 전송 버튼 아이콘 | Task 4 Step 1 |
| 애니메이션 iteration-count 제한 | Task 4 Step 2 |
| `--text-secondary`/`--text-primary` 미정의 | 사전 분석 결과 미사용 확인 — 스킵 ✓ |
| `#fbbf24`/`#f43f5e` CSS 하드코딩 | 이미 수정됨 — 스킵 ✓ |
| `--accent-amber` 중복 | 이미 `var(--caution)` — 스킵 ✓ |
| `.color-wind` 보라 충돌 | 이미 `#22d3ee` — 스킵 ✓ |

**플레이스홀더 스캔:** TBD/TODO 없음. 모든 코드 블록에 실제 값 포함. ✓

**타입 일관성:** 색 hex값이 스펙과 코드 블록에서 일치 (`#2f6fed`, `#5b8ef5`, `#d9a441`, `#4d9bff`). ✓

---

## 범위 밖 (다음 스프린트)

- Roll HUD 히어로 승격 (실측 횡요각 표시) — `roll-viewer.js` 안전 계기 수정
- `#route-click-hint` DOM 미생성 — `route-viewer.js` buildUI() 수정
- 챗 feed_status 신선도 — 백엔드 프롬프트 연동
