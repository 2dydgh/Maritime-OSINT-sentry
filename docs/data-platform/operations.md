# AIS 원본 저널 백업

현재 구현은 한 서버에서 SQLite에 저장하는 로컬 서비스입니다. 클라우드 계정이나 유료 자원을 만들지 않습니다.

## 저장과 백업

```bash
.venv/bin/python -m backend.data_platform.operations status
.venv/bin/python -m backend.data_platform.operations backup var/backups/journal-checkpoint
```

`status`는 저널 DB·WAL 크기와 테이블 행 수를 조회합니다. `backup`은 기존 경로를 덮어쓰지 않고 SQLite 온라인 백업 API를 사용합니다. WAL에 남은 커밋 데이터도 포함하고 `integrity_check`와 SHA-256 manifest를 남깁니다. 검증에 실패하면 성공 manifest를 만들지 않으므로 실패한 디렉터리를 완성 백업으로 취급하지 않습니다.

원본 자동 삭제는 없습니다. 장기 보관 주기·삭제 승인이 정해지기 전에는 용량을 점검하고 별도 저장소에 백업 사본을 보관해야 합니다.

복원은 서버를 중지한 상태에서 현재 DB를 먼저 별도 보관한 뒤 진행합니다. manifest의 SHA-256을 검증하고, 이전 DB의 WAL/SHM 파일을 새 DB와 섞지 않도록 새 데이터 디렉터리에 복사한 뒤 `DATA_PLATFORM_DB` 경로를 그 디렉터리로 지정해 기동합니다. 운영 DB를 덮어쓰는 자동 복원 명령은 제공하지 않습니다.
