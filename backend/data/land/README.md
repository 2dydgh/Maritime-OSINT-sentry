# Natural Earth Land Shapefile

이 디렉토리에 Natural Earth 10m Land shapefile을 배치하세요.

## 다운로드

1. https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-land/ 에서 다운로드
2. 압축 해제 후 다음 파일들을 이 디렉토리에 복사:
   - `ne_10m_land.shp`
   - `ne_10m_land.shx`
   - `ne_10m_land.dbf`
   - `ne_10m_land.prj`

## 또는 CLI로 다운로드

```bash
curl -L -o ne_10m_land.zip "https://naciscdn.org/naturalearth/10m/physical/ne_10m_land.zip"
unzip ne_10m_land.zip -d backend/data/land/
```
