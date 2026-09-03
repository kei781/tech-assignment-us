# Jobs Backend 명세서 (SDD Specification)

- 기준 문서: `docs/nestjs-jobs-backend-design.md` (이하 "설계 문서")
- 본 문서는 설계 문서를 **테스트 가능한 요구사항 단위**로 재구성한 명세서다. 각 요구사항에는 고유 ID를 부여하며, 테스트 코드는 이 ID를 참조한다.
- 설계 문서와 본 문서가 충돌하면 **본 문서가 우선**한다. 충돌 사항은 [부록 A](#부록-a-설계-문서-대비-변경-사항)에 기록한다.

---

## 1. 범위와 용어

### 1.1 시스템 구성

하나의 저장소에서 두 종류의 애플리케이션을 독립 실행한다.

| 애플리케이션 | 실행 형태 | 역할 |
|---|---|---|
| **Queue API** | NestJS HTTP 서버 | REST API로 작업 생성·조회·검색·수정 |
| **Worker** | NestJS standalone application context | 작업을 주기적으로 선점·처리·완료 |

두 애플리케이션 모두 **여러 프로세스로 중복 실행될 수 있으며**, 모든 프로세스는 동일한 storage 디렉터리(`jobs.json` + lock 디렉터리)를 공유한다.

### 1.2 용어

| 용어 | 정의 |
|---|---|
| Job | 처리 대상 작업 단위. `jobs.json`의 `jobs` 배열 원소 |
| Global lock | `jobs.json` 읽기-수정-쓰기를 직렬화하는 파일 잠금 (`jobs-global-lock.json`) |
| Per-job lock | 단일 Job의 처리 소유권을 보장하는 파일 잠금 (`{jobId}-lock.json`) |
| Worker ID | Worker 프로세스가 시작 시 생성하는 64자리 hex 문자열 |
| Reaper | Worker 중 선출된 1대. stale 데이터(고아 lock, 죽은 worker 레코드)를 복구 |
| Claim(선점) | Worker가 per-job lock을 획득하고 Job을 `pending`으로 전이시키는 행위 |

### 1.3 기술 스택 (고정)

- NestJS (TypeScript), `node-json-db`, `@nestjs/schedule`
- 프로세스 간 잠금: `fs.open(path, 'wx')` 기반 파일 잠금
- Job ID: UUID v4 / Worker(프로세스) ID: `randomBytes(32).toString('hex')` (64 hex)

---

## 2. 데이터 모델

### 2.1 `jobs.json` 스키마

> **[DATA-001]** `jobs.json`은 아래 구조를 따른다. 최상위 키는 `jobs`(배열), `workers`(객체), `reaper`(객체)다.

```json
{
  "jobs": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "title": "lorem ipsum",
      "description": "lorem ipsum",
      "status": "create",
      "createdAt": "2026-09-03T20:00:00.000Z",
      "updatedAt": "2026-09-03T20:00:00.000Z"
    }
  ],
  "workers": {
    "<64-hex worker id>": { "heartbeatAt": "2026-09-03T20:01:00.000Z" }
  },
  "reaper": { "workerId": null }
}
```

> **[DATA-002]** Job 필드 규칙:

| 필드 | 형식 | 규칙 |
|---|---|---|
| `id` | UUID v4 | PK. 생성 후 불변 |
| `title` | string | 필수. 공백 제거 후 1자 이상, **최대 1,000자** |
| `description` | string | 필수. 공백 제거 후 1자 이상, **최대 2,000자** |
| `status` | enum | `create` \| `pending` \| `done` |
| `createdAt` | ISO 8601 UTC | 생성 시각. 불변 |
| `updatedAt` | ISO 8601 UTC | 마지막 변경 시각 |

> **[DATA-003]** 모든 시각은 ISO 8601 UTC(`...Z`) 문자열로 기록·비교한다.

> **[DATA-004]** 저장소에는 조회 동작 확인용 **샘플 데이터가 포함된 `data/jobs.json`을 커밋**한다. 샘플에는 `create`, `pending`, `done` 상태의 Job이 최소 1건씩 포함된다.

### 2.2 상태 머신

> **[STATE-001]** 상태와 허용 전이:

```text
create ── Worker claim ──▶ pending ── 처리 완료 ──▶ done
   ▲                          │
   └── 복구(rollback) ────────┘
```

| 상태 | 의미 | 허용되는 다음 상태 | 전이 주체 |
|---|---|---|---|
| `create` | 생성됨, 아직 선점되지 않음 | `pending` | Worker(claim) |
| `pending` | Worker가 선점하여 **처리 중** | `done`, `create`(복구) | Worker / Reaper |
| `done` | 처리 완료 | 없음 | — |

> **[STATE-002]** 위 표에 없는 전이는 금지한다. 특히 `done`은 종결 상태이며 어떤 주체도 되돌리지 않는다.

### 2.3 Lock 파일

> **[LOCK-001]** `{jobId}-lock.json` (per-job lock):

```json
{ "preemption": "<64-hex worker id>", "preemptedAt": "2026-09-03T20:00:00.000Z" }
```

- 파일이 존재하는 동안 다른 Worker는 해당 Job을 처리할 수 없다.

> **[LOCK-002]** `jobs-global-lock.json` (global lock):

```json
{ "preemption": "<64-hex process id>", "ownerType": "api", "preemptedAt": "2026-09-03T20:00:00.000Z" }
```

- `ownerType`은 `"api"` 또는 `"worker"`. API 프로세스는 `workers` 레지스트리에 등록되지 않으므로, Reaper의 stale 판정 시 구분에 사용한다.

> **[LOCK-003]** 두 lock 모두 **반드시 `fs.open(path, 'wx')`** 로 원자적으로 생성한다. 성공 시 소유권 획득, `EEXIST` 시 획득 실패로 처리한다. "존재 확인 후 쓰기" 방식은 금지한다.

> **[LOCK-004]** lock 해제는 lock 파일 삭제로 수행한다.

> **[LOCK-005]** 모든 `jobs.json` 변경은 다음 순서를 지킨다: `global lock 획득 → jobs.json을 디스크에서 reload → 조건 재검증 → 변경 → 저장 → global lock 해제`. `node-json-db` 인메모리 캐시로 덮어쓰는 것을 금지한다(획득 후 reload 필수).

> **[LOCK-006]** 일관된 snapshot이 필요한 읽기(목록/검색/단건 조회, Worker 후보 조회)도 동일한 global lock 임계 구역에서 수행한다.

> **[LOCK-007]** 잠금 획득 순서는 **per-job lock → global lock**이다. global lock을 보유한 채 per-job lock을 획득하지 않는다. global lock을 보유한 채 장시간 처리·sleep을 하지 않는다.

> **[LOCK-008]** global lock 경합 시: Worker는 1초 간격으로 무기한 재시도한다. API는 최대 대기 시간(`GLOBAL_LOCK_API_WAIT_MS`, 기본 5,000ms) 안에 획득하지 못하면 `503 Service Unavailable`을 반환한다.

---

## 3. REST API

### 3.1 공통 규칙

> **[API-001]** 응답 본문 공통 형식:

```json
{ "status": 200, "result": "success" }
```

- `status`: HTTP 상태 코드와 동일한 숫자
- `result`: 성공 시 `"success"`, 그 외에는 한국어 사유 메시지
- 목록 응답은 `list`(배열), 단건 응답은 `job`(객체)을 추가한다.

> **[API-002]** 본문의 `status`는 실제 HTTP 응답 상태 코드와 항상 일치해야 한다.

> **[API-003]** DTO validation 실패는 `400 Bad Request`와 사유 메시지를 반환한다. 정의되지 않은 필드는 거부한다(whitelist + forbidNonWhitelisted).

> **[API-004]** 처리 중 내부 오류는 `500 Internal Server Error`, global lock 대기 초과는 `503 Service Unavailable`을 반환한다. 어떤 경우에도 [API-001] 형식을 유지한다.

### 3.2 Endpoint 요약

| Method | Path | 설명 | 성공 상태 |
|---|---|---|---|
| `POST` | `/jobs` | 새 작업 생성 | `201 Created` |
| `GET` | `/jobs` | 전체 작업 목록 조회 | `200 OK` |
| `GET` | `/jobs/search` | 제목·설명·상태로 검색 | `200 OK` |
| `GET` | `/jobs/:id` | 단일 작업 조회 | `200 OK` |
| `PATCH` | `/jobs/:id` | 작업 제목·설명 수정 | `200 OK` |

> **[API-005]** `/jobs/search` 라우트는 `/jobs/:id`보다 먼저 매칭되어야 한다(`search`가 `:id`로 해석되면 안 된다).

### 3.3 `POST /jobs`

> **[API-010]** 요청 본문: `{ "title": string, "description": string }` — 둘 다 필수이며 [DATA-002] 규칙을 따른다.

> **[API-011]** 성공 시 `201`을 반환하고, 서버가 채운 `id`(UUID v4), `status: "create"`, `createdAt`, `updatedAt`을 포함한 생성된 Job을 `job` 필드로 반환한다.

```json
{ "status": 201, "result": "success", "job": { "id": "...", "title": "...", "description": "...", "status": "create", "createdAt": "...", "updatedAt": "..." } }
```

> **[API-012]** 저장은 [LOCK-005] 임계 구역에서 수행한다.

| 상황 | HTTP 상태 |
|---|---:|
| 성공 | 201 |
| validation 실패(누락·타입·길이 초과) | 400 |
| global lock 대기 초과 | 503 |
| 저장 실패 | 500 |

### 3.4 `GET /jobs`

> **[API-020]** 전체 Job을 `list`로 반환한다. 빈 목록도 `200 OK` + `list: []`이다.

### 3.5 `GET /jobs/search`

> **[API-030]** Query parameter: `title`, `description`, `status` — **셋 중 하나 이상 필수**.
>
> 과제 원문은 "제목/상태로 검색"을 요구한다. 설계 문서의 `title`/`description`에 **`status`를 추가**하여 과제 요구를 충족한다.

> **[API-031]** 매칭 규칙:
> - `title`, `description`: **대소문자 구분 없는 부분 일치**
> - `status`: enum 정확 일치 (`create` | `pending` | `done`). 그 외 값은 `400`
> - 복수 조건은 **AND** 결합

> **[API-032]** 응답:

| 상황 | HTTP 상태 | `result` | `list` |
|---|---:|---|---|
| 검색 성공(1건 이상) | 200 | `success` | 매칭된 Job 배열 |
| 검색 결과 없음 | 200 | `데이터가 존재하지 않습니다.` | `[]` |
| 조건 없음 | 400 | `title, description, status 중 하나 이상을 입력하여 주세요.` | 없음 |
| `status`에 잘못된 값 | 400 | 유효성 검사 사유 | 없음 |

### 3.6 `GET /jobs/:id`

> **[API-040]** `:id`는 UUID 형식이어야 하며, 형식이 아니면 `400`.

| 상황 | HTTP 상태 | `result` | 본문 |
|---|---:|---|---|
| 존재 | 200 | `success` | `job: {...}` |
| 없음 | 404 | `존재하지 않는 데이터입니다.` | — |

### 3.7 `PATCH /jobs/:id`

> **[API-050]** 요청 본문: `{ "title"?: string, "description"?: string }` — **하나 이상 필수**, 각 필드는 [DATA-002] 규칙을 따른다. `status` 등 다른 필드의 수정은 거부한다(400).

> **[API-051]** 수정 가능 조건 (둘 다 만족):
>
> ```text
> status === "create"  AND  해당 Job의 per-job lock 파일이 없음
> ```
>
> per-job lock 생성과 `pending` 저장 사이의 시간차 때문에 상태와 lock 파일을 **모두** 확인한다. 검사와 수정은 [LOCK-005] 임계 구역에서 최신 데이터를 reload한 뒤 수행한다.

> **[API-052]** 성공 시 `updatedAt`을 갱신하고 수정된 Job을 `job` 필드로 반환한다.

| 상황 | HTTP 상태 | `result` |
|---|---:|---|
| 수정 성공 | 200 | `success` |
| Job 없음 | 404 | `존재하지 않는 데이터입니다.` |
| `pending` 또는 per-job lock 존재 | 409 | `처리중인 프로세스입니다.` |
| `done` | 409 | `이미 완료된 프로세스입니다.` |
| validation 실패 | 400 | 유효성 검사 사유 |

---

## 4. 로깅 (`logs.txt`)

> 과제 필수 요구사항이나 설계 문서에 누락되어 있던 항목이다.

> **[LOG-001]** 모든 프로세스(API, Worker)는 프로젝트 루트의 `logs.txt`(경로는 `LOG_FILE_PATH`로 재정의 가능)에 로그를 **append 모드**로 기록한다. 여러 프로세스가 동시에 기록할 수 있으므로 한 로그 항목은 한 번의 append 호출로 기록한다(줄 단위 원자성).

> **[LOG-002]** 로그 라인 형식:

```text
[ISO8601 UTC] [LEVEL] [scope] message
```

예: `[2026-09-03T20:00:00.000Z] [INFO] [http] POST /jobs 201 12ms`

> **[LOG-003]** **모든 HTTP 요청**을 로깅한다: method, path(query 포함), 응답 상태 코드, 처리 시간(ms). 에러 응답도 포함한다.

> **[LOG-004]** Worker는 **처리 결과**를 로깅한다. 최소 대상: Job claim(선점), 처리 완료(done), 처리 실패·롤백, Reaper 선출, Reaper의 복구 조치(orphan lock 정리, stale worker 삭제, stale global lock 삭제).

> **[LOG-005]** 로그 기록 실패가 API 응답이나 Worker 처리를 실패시키면 안 된다(best-effort).

---

## 5. Worker

### 5.1 Lifecycle

> **[WRK-001]** 시작 시: 64-hex `workerId` 생성(프로세스 종료까지 불변) → [LOCK-005] 임계 구역에서 `workers[workerId].heartbeatAt = now` 등록 → 스케줄러 시작.

> **[WRK-002]** 스케줄러 구성(모든 주기는 §7 설정값으로 주입 가능):

| 작업 | 기본 주기 | 역할 |
|---|---:|---|
| Heartbeat | 1분 | 자신의 `heartbeatAt` 갱신 |
| Consume | 1분 | 처리 가능한 Job 하나 선점·처리 |
| Reaper check | 1분 | Reaper 생존 확인, 필요 시 선출 시도 |
| Reaper cleanup | 1분 | 자신이 Reaper인 경우 stale 데이터 복구 |

> **[WRK-003]** 같은 프로세스에서 이전 consume이 끝나지 않았으면 다음 consume tick은 건너뛴다(`isConsuming` guard). Worker 1대는 동시에 Job 1개만 처리한다.

> **[WRK-004]** 정상 종료(`SIGINT`/`SIGTERM`/shutdown hook) 시: ① 새 스케줄 실행 중지 → ② 보유 중인 `pending` Job을 `create`로 롤백(또는 안전 완료) → ③ 보유한 per-job lock 삭제 → ④ `workers[workerId]` 삭제 → ⑤ 자신이 Reaper면 `reaper.workerId` 초기화.

### 5.2 Heartbeat

> **[WRK-010]** 1분마다 [LOCK-005] 임계 구역에서 `workers[workerId].heartbeatAt = now`로 갱신한다.

> **[WRK-011]** 시간 기준(§7과 연동): Reaper 사망 판단 5분 초과, stale worker 삭제 6분 이상. 1분의 차이는 clock drift·스케줄 지연에 대한 safety margin이다.

### 5.3 Consume flow

> **[WRK-020]** 후보 조회: [LOCK-006] snapshot에서 `status === "create"`인 Job을 `createdAt` ASC, 동률 시 `id` ASC로 정렬한다.

> **[WRK-021]** Claim 절차 (후보별):
> 1. `{jobId}-lock.json`을 `wx`로 생성 시도. `EEXIST`면 **즉시 다음 후보로 이동**(대기 금지).
> 2. 성공 시 lock 파일에 `preemption = workerId`, `preemptedAt = now` 기록.
> 3. [LOCK-005] 임계 구역에서 해당 Job이 여전히 `create`인지 재검증.
> 4. `create`가 아니면 per-job lock 삭제 후 다음 후보로 이동.
> 5. `create`면 `status = "pending"`, `updatedAt = now`로 저장하고 임계 구역을 빠져나온 뒤 처리를 시작한다.

> **[WRK-022]** 다음 경우에만 다음 tick까지 대기한다: `create` Job이 없음 / 모든 후보의 lock 획득 실패 / 재검증 결과 모든 후보가 `create`가 아님.

> **[WRK-023]** 처리: 기본 `JOB_PROCESSING_MS`(기본 60,000ms) 동안 수행하는 것으로 간주한다(별도 비즈니스 로직 없음).

> **[WRK-024]** 완료 절차: [LOCK-005] 임계 구역에서 ① `status === "pending"` 재확인, ② per-job lock의 `preemption === workerId` 재확인 → 모두 만족 시 `status = "done"`, `updatedAt = now` 저장 → 임계 구역 종료 후 per-job lock 삭제. 소유권 검증 실패 시 `done`으로 **덮어쓰지 않고** 오류를 로깅하며 자신이 소유한 lock만 정리한다.

> **[WRK-025]** 처리 중 예외 발생 시(프로세스 생존): [LOCK-005] 임계 구역에서 소유권 확인 후 자신이 소유한 `pending` Job을 `create`로 롤백하고 per-job lock을 삭제한다.

### 5.4 Reaper 선출

> **[RPR-001]** 각 Worker는 시작 60초 후부터 1분마다 Reaper 상태를 확인한다. 다음 두 조건을 모두 만족하면 현 Reaper를 유지한다: `reaper.workerId`가 `workers`에 존재 AND 해당 heartbeat가 5분 이내.

> **[RPR-002]** Reaper가 없거나 stale이면: [LOCK-005] 임계 구역에서 최신 상태 재확인 후 `reaper.workerId = 내 workerId` 저장 → **1분 grace period 대기** → 재조회하여 여전히 자신의 ID면 Reaper 역할 시작 (eventual leader election).

> **[RPR-003]** Reaper는 cleanup 실행 직전마다 `reaper.workerId === workerId`를 재검증하고, 아니면 즉시 중단한다.

### 5.5 Reaper cleanup

> **[RPR-010]** Stale worker 정리: `heartbeatAt`이 6분 이상 갱신되지 않은 Worker를 `workers`에서 삭제한다. 자신의 heartbeat가 stale이면 cleanup을 진행하지 않는다.

> **[RPR-011]** Orphan per-job lock 복구: lock의 `preemption`이 `workers`에 없으면 orphan으로 판단하고, [LOCK-005] 임계 구역에서 재검증 후 — Job이 `pending`이면 `create`로 롤백(`updatedAt = now`), Job이 `done`이거나 존재하지 않으면 상태 변경 없이 — 임계 구역 종료 후 lock 파일을 삭제한다. 살아 있는 Worker의 lock은 삭제하지 않는다.

> **[RPR-012]** Stale global lock 복구: `jobs-global-lock.json`이 다음 중 하나면 stale 후보다 — ① `ownerType === "worker"`이고 `preemption`이 `workers`에 없음, ② `preemptedAt`이 5분 초과. metadata를 다시 읽어 동일 lock인지 확인한 뒤 삭제한다. API 소유 lock은 ②(5분 timeout)만 적용한다.

---

## 6. 동시성 규칙 요약

| ID | 상황 | 규칙 |
|---|---|---|
| **[CON-001]** | 여러 Worker가 같은 Job 조회 | per-job lock exclusive create 성공자만 처리 |
| **[CON-002]** | 특정 Job lock 실패 | 다음 `create` 후보 즉시 시도 |
| **[CON-003]** | `jobs.json` 동시 변경 | global lock 직렬화 + 획득 후 reload |
| **[CON-004]** | claim 전 상태 변경됨 | per-job lock 해제 후 다음 후보 |
| **[CON-005]** | 완료 전 소유권 변경됨 | `done` 덮어쓰기 금지 |
| **[CON-006]** | 처리 예외(프로세스 생존) | `pending → create` 롤백 |
| **[CON-007]** | Worker 비정상 종료 | Reaper가 orphan lock 삭제 + 롤백 |
| **[CON-008]** | API·Worker 동시 접근 | 모든 쓰기·일관 읽기는 global lock 경유 |

---

## 7. 설정값

> **[CFG-001]** 모든 시간 관련 값은 환경 변수(또는 주입 가능한 설정)로 재정의할 수 있어야 하며, 테스트에서는 clock·scheduler를 주입해 실제 대기 없이 검증한다.

| 설정 | 기본값 |
|---|---:|
| `STORAGE_DIR` | `./data` |
| `LOG_FILE_PATH` | `./logs.txt` |
| `HEARTBEAT_INTERVAL_MS` | 60,000 |
| `CONSUME_INTERVAL_MS` | 60,000 |
| `REAPER_CHECK_INTERVAL_MS` | 60,000 |
| `REAPER_ELECTION_GRACE_MS` | 60,000 |
| `REAPER_STALE_AFTER_MS` | 300,000 |
| `WORKER_DELETE_AFTER_MS` | 360,000 |
| `GLOBAL_LOCK_RETRY_MS` | 1,000 |
| `GLOBAL_LOCK_API_WAIT_MS` | 5,000 |
| `GLOBAL_LOCK_STALE_AFTER_MS` | 300,000 |
| `JOB_PROCESSING_MS` | 60,000 |

---

## 8. 프로젝트 구조와 실행

> **[RUN-001]** 디렉터리 구조:

```text
src/
├─ apps/
│  ├─ api/        # NestFactory.create(ApiModule) — HTTP 서버
│  └─ worker/     # NestFactory.createApplicationContext(WorkerModule)
├─ jobs/          # controller / service / repository
├─ worker/        # consume / heartbeat / reaper services
├─ storage/       # json-db / global-lock / job-lock services
└─ common/        # dto, errors, logging, time
data/
├─ jobs.json      # 샘플 데이터 포함, 커밋 대상
└─ locks/         # lock 파일 디렉터리, 커밋 제외
```

> **[RUN-002]** 실행 명령: `npm run start:api`, `npm run start:worker`. 각 명령은 중복 실행이 가능해야 하며, 모든 인스턴스는 동일한 storage 디렉터리를 공유한다.

> **[RUN-003]** 기본 Node 환경에서 `npm install` 후 별도 설정 없이 실행 가능해야 한다.

---

## 9. 테스트 요구사항 (Stage 2 기준)

> **[TST-001]** 테스트는 본 명세의 요구사항 ID를 참조한다(예: `describe('[API-030] ...')`).

최소 검증 범위:

| 영역 | 대상 |
|---|---|
| API e2e | §3의 모든 엔드포인트 × 성공/실패 케이스 (상태 코드 + 응답 본문 형식) |
| 로깅 | HTTP 요청 로깅[LOG-003], Worker 처리 로깅[LOG-004] |
| Storage/Lock | [LOCK-003] 원자적 생성, [LOCK-005] reload-후-저장, [LOCK-008] 대기·503 |
| Worker consume | [WRK-020]~[WRK-025] claim·완료·롤백·소유권 검증 |
| Reaper | [RPR-001]~[RPR-012] 선출·grace period·각 복구 시나리오 |
| 동시성 | [CON-001] 두 Worker가 같은 Job을 동시에 claim 시도 → 정확히 1개만 성공 |

> **[TST-002]** 테스트는 실제 시간 대기 없이 실행 가능해야 한다(fake timer 또는 주입된 clock/interval 사용).

---

## 부록 A. 설계 문서 대비 변경 사항

| # | 항목 | 설계 문서 | 본 명세 | 사유 |
|---|---|---|---|---|
| 1 | 검색 파라미터 | `title`, `description` | `title`, `description`, `status` | 과제 원문이 "제목/**상태**로 검색"을 명시 — 과제 위배 보정 |
| 2 | 검색 조건 누락 메시지 | `title 혹은 description은 반드시 입력하여 주세요.` | `title, description, status 중 하나 이상을 입력하여 주세요.` | status 추가에 따른 문구 정합화 |
| 3 | `logs.txt` 로깅 | 없음 | §4 전체 신설 | 과제 필수 요구사항 누락 보정 |
| 4 | 단건 응답 형식 | `list: [job]` 허용 또는 `job` 필드 | `job` 필드로 고정 | 설계 문서 §8.6이 권장한 방향으로 확정 |
| 5 | 샘플 데이터 | 없음 | [DATA-004] 신설 | 과제 제출 요건 |

## 부록 B. 초기설계 대비 확정 사항

`docs/초기설계..md`와 설계 문서가 다른 부분은 설계 문서(및 본 명세)를 따른다.

| 항목 | 초기설계 | 확정 |
|---|---|---|
| `pending` 의미 | 처리 대기중 | **처리 중(선점됨)** — README에 해석 명시 |
| POST 성공 상태 | 200 | **201 Created** (HTTP 시맨틱) |
| job lock 획득 실패 시 | 1분 대기 후 재시도 | **다음 후보 즉시 시도** |
| global lock 경합(API) | 삭제 대기만 정의 | Worker 1초 재시도 / API 5초 timeout 후 503 |

## 부록 C. 과제 해석 사항 (README 반영 대상)

1. 과제 예시의 초기 상태는 `pending`이지만, 본 설계는 `create`(대기) → `pending`(처리 중) → `done`(완료) 3단계 상태 머신을 사용한다. 스키마 자유 설계 허용 범위 내의 결정이다.
2. "제목/상태로 검색"은 `title`·`status` 쿼리 파라미터로 구현하고, 설계 확장으로 `description`도 지원한다.
3. 처리 주기(1분)와 한 번에 처리할 단위(Worker당 1건)는 과제가 허용한 자유 가정이다.
4. 응답 본문에 `status`(HTTP 코드 미러링)와 `result`(성공/사유)를 두는 형식은 자유 설계 항목이다.
