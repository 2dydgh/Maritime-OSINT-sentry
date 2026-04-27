# Search UI Redesign + Place Info Panel

**Date:** 2026-04-27
**Status:** Approved

## Overview

검색바 스타일 통일, 자동완성 속도 개선, Google Earth 스타일 장소 정보 모달 추가, 검색 마커 표시.

## 1. 검색바 스타일 통일

**현재 문제:** `rgba(0, 0, 0, 0.55)` — 투명도가 높아 밝은 위성사진 배경에서 안 보이고, 다른 UI 요소(`--panel-bg-solid`, `--panel-border`)와 스타일이 다름.

**변경:**
- `#mapSearchWrap` 배경을 `var(--panel-bg-solid)` (`rgba(24, 24, 27, 0.95)`)로 변경
- 보더를 `var(--panel-border)` (`rgba(63, 63, 70, 0.3)`)로 변경
- 포커스 시 기존 `--primary` 기반 glow 유지
- `#mapSearchResults` 드롭다운도 동일한 토큰으로 통일

## 2. 자동완성 속도 개선

**현재:** Nominatim API에 350ms 디바운스 후 요청. 체감 느림.

**변경:**
- 디바운스 350ms → 200ms
- 주요 항구/해역 로컬 캐시 추가 — 하드코딩된 30~50개 항구/해협/해역 데이터로 입력 즉시 매칭 표시. Nominatim 결과는 백그라운드로 보완.
- 로컬 캐시 항목에는 `⚓` 아이콘으로 구분 표시
- 로딩 중 검색 아이콘을 스피너로 교체하여 피드백 제공

**로컬 캐시 데이터 구조:**
```javascript
{ name: '인천항', nameEn: 'Incheon Port', lat: 37.45, lon: 126.63, type: 'harbour' }
```

## 3. 장소 정보 모달

**위치:** 지도 오른쪽 상단, 플로팅 모달 (지도 위에 떠 있는 형태)

**트리거:** 검색 결과 항목 클릭 시

**데이터 소스:** Wikipedia API (한국어 우선, fallback 영어)
- `https://ko.wikipedia.org/api/rest_v1/page/summary/{title}`
- Nominatim 결과의 `display_name`에서 Wikipedia 검색어 추출

**모달 구성:**
1. **사진 영역** (상단) — Wikipedia thumbnail 이미지. 없으면 장소 유형에 맞는 기본 아이콘 표시
2. **장소명** — 한글명 (볼드, 14px)
3. **부제** — 영문명 · 유형 (9px, dim)
4. **설명** — Wikipedia extract, 최대 3줄 (line-clamp)
5. **메타 정보** — 위치 좌표, 유형, 지역 (구분선 후 key-value 리스트)
6. **Wikipedia 링크 버튼** — 새 탭으로 열기
7. **닫기 버튼** (✕) — 오른쪽 상단, 모달 닫기 + 마커 제거

**스타일:**
- 배경: `var(--panel-bg-solid)` + `backdrop-filter: blur(12px)`
- 보더: `var(--panel-border)`
- 그림자: `var(--shadow-panel)`
- 너비: 260px 고정
- 진입 애니메이션: 오른쪽에서 슬라이드 + fade in (200ms)
- 퇴장 애니메이션: fade out (150ms)

**Wikipedia API 실패 시:** 모달은 여전히 표시하되 사진/설명 영역을 기본 아이콘 + "정보를 불러올 수 없습니다" 텍스트로 대체. 좌표와 유형 정보는 Nominatim에서 이미 가지고 있으므로 항상 표시.

## 4. 검색 마커

**트리거:** 검색 결과 클릭 시 (flyToPlace와 동시)

**마커 구성:**
- Cesium: `BillboardCollection` + `LabelCollection`에 추가 (기존 선박 표시 패턴과 동일)
- Leaflet (2D): `L.marker`로 추가
- 파란색 원형 마커 (`#4a8af5`) + 흰색 테두리 + glow 효과
- 마커 아래 장소명 라벨

**생명주기:**
- 새 검색 시 이전 마커 제거 후 새 마커 추가
- 모달 ✕ 닫기 시 마커도 함께 제거
- 최대 1개만 표시 (동시에 여러 마커 없음)

## 파일 변경 범위

| 파일 | 변경 내용 |
|------|-----------|
| `static/css/main.css` | `#mapSearchWrap` 스타일 토큰 통일, 정보 모달 CSS 추가, 마커 애니메이션 |
| `static/js/ui-controls.js` | 검색 로직 개선 (디바운스, 로컬 캐시, 정보 모달 표시/숨기기, Wikipedia API 호출, 마커 관리) |
| `static/index.html` | 정보 모달 HTML 컨테이너 추가 |

## 의존성

- Wikipedia REST API (무료, 인증 불필요, rate limit 넉넉)
- 기존 Nominatim API (변경 없음)
- 기존 Cesium BillboardCollection/LabelCollection 패턴
