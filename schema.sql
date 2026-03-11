-- PostGIS Extension 활성화
CREATE EXTENSION IF NOT EXISTS postgis;

-- 1. 사건/이벤트 테이블 (점 데이터 - Point)
CREATE TABLE IF NOT EXISTS military_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id VARCHAR(255),               -- 원본 소스 식별자 (트윗 ID 등)
    event_type VARCHAR(50) NOT NULL,      -- 사건 유형 (explosion, troop_movement 등)
    event_time TIMESTAMPTZ NOT NULL,      -- 사건 발생 시간 (Timezone 포함 필수)
    geom GEOMETRY(Point, 4326) NOT NULL,  -- 위경도 공간 데이터 (WGS84 좌표계)
    confidence INTEGER CHECK (confidence >= 0 AND confidence <= 100),
    description TEXT,                     -- 사건 상세 내용
    created_at TIMESTAMPTZ DEFAULT NOW()  -- DB 적재 시간
);

-- 공간 검색 및 시간 기반 검색을 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_military_events_geom ON military_events USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_military_events_time ON military_events (event_time);

-- 2. 비행체/선박 궤적 테이블 (시계열 점 데이터 - Time-Series)
CREATE TABLE IF NOT EXISTS trajectories (
    id BIGSERIAL,
    object_id VARCHAR(100) NOT NULL,      -- 항공기 Callsign 또는 선박 MMSI
    object_type VARCHAR(20) NOT NULL,     -- 'aircraft', 'ship', 'satellite'
    record_time TIMESTAMPTZ NOT NULL,     -- 위치 기록 시간
    geom GEOMETRY(PointZ, 4326) NOT NULL, -- 위경도 + 고도(Z축) 포함 3D 공간 데이터
    altitude NUMERIC(10, 2),              -- 고도 (미터 또는 피트)
    velocity NUMERIC(8, 2),               -- 속도
    heading NUMERIC(5, 2),                -- 진행 방향 (0~360도)
    PRIMARY KEY (object_id, record_time)
);

CREATE INDEX IF NOT EXISTS idx_trajectories_geom ON trajectories USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_trajectories_time ON trajectories (record_time);

-- 3. 통제 구역 테이블 (다각형 데이터 - Polygon)
CREATE TABLE IF NOT EXISTS restricted_areas (
    id SERIAL PRIMARY KEY,
    area_type VARCHAR(50) NOT NULL,       -- 'no_fly_zone', 'gps_jamming' 등
    start_time TIMESTAMPTZ NOT NULL,      -- 통제 시작 시간
    end_time TIMESTAMPTZ,                 -- 통제 종료 시간 (NULL이면 무기한)
    geom GEOMETRY(Polygon, 4326) NOT NULL,-- 다각형 공간 데이터
    source_agency VARCHAR(100),           -- 발령 기관 (FAA, ICAO 등)
    is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_restricted_areas_geom ON restricted_areas USING GIST (geom);
