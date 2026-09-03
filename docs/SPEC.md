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
| Process ID | 모든 프로세스(API·Worker)가 시작 시 생성하는 64자리 hex 문자열 |
| Worker ID | Worker 프로세스의 Process ID. `workers` 레지스트리의 키 |
| Reaper | Worker 중 선출된 1대. stale 데이터(고아 lock, 죽은 worker 레코드)를 복구 |
| Claim(선점) | Worker가 per-job lock을 획득하고 Job을 `pending`으로 전이시키는 행위 |

### 1.3 기술 스택 (고정)

- NestJS (TypeScript), `node-json-db`, `@nestjs/schedule`
- 프로세스 간 잠금: exclusive create(`wx` flag) 기반 파일 잠금
- Job ID: UUID v4
- Process ID: `randomBytes(32).toString('hex')` (64 hex). **API 프로세스를 포함한 모든 프로세스**가 시작 시 1회 생성하여 종료까지 사용하며, Worker는 이 값을 Worker ID로도 사용한다.

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
  "reaper": { "workerId": null },
  "config": { "fingerprint": "<hash>", "recordedAt": "2026-09-03T20:00:00.000Z" }
}
```

- `config.fingerprint`: 프로세스 간 합의가 필요한 타이밍 설정의 해시([CFG-002]). 부트스트랩에서 비교해 불일치를 차단한다.

> **[DATA-002]** Job 필드 규칙:

| 필드 | 형식 | 규칙 |
|---|---|---|
| `id` | UUID v4 | PK. 생성 후 불변 |
| `title` | string | 필수. trim(앞뒤 공백 제거) 후 1자 이상, **최대 1,000자** |
| `description` | string | 필수. trim 후 1자 이상, **최대 2,000자** |
| `status` | enum | `create` \| `pending` \| `done` |
| `createdAt` | ISO 8601 UTC | 생성 시각. 불변 |
| `updatedAt` | ISO 8601 UTC | 마지막 변경 시각 |

- `title`·`description`은 **trim된 값을 저장**하며, 길이 제한도 trim 후 값 기준으로 판정한다.

> **[DATA-003]** 모든 시각은 ISO 8601 UTC(`...Z`) 문자열로 기록·비교한다.

> **[DATA-004]** 저장소에는 조회 동작 확인용 **샘플 데이터가 포함된 `data/jobs.json`을 커밋**한다. 샘플에는 `create`, `pending`, `done` 상태의 Job이 최소 1건씩 포함된다. 샘플의 `pending` Job은 per-job lock 없이 커밋되므로, Worker 기동 후 Reaper가 선출되고 [RPR-013]의 조건(`updatedAt` 5분 초과)이 충족되면 `create`로 복구된 뒤 정상 처리된다.

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

> **[LOCK-000]** 모든 lock 파일은 `{STORAGE_DIR}/locks/` 디렉터리에 위치한다. 이 디렉터리의 파일명 규칙은 다음과 같으며, 이외의 이름은 lock으로 취급하지 않는다.
>
> | 파일명 | 종류 | 비고 |
> |---|---|---|
> | `{uuid}-lock.json` | per-job lock | `{uuid}`는 **UUID 형식이어야 한다** |
> | `jobs-global-lock.json` | global lock | **예약 파일명** |
> | `*.stale-*`, `*.release-*`, `*.tmp` | 절차상 임시 파일 | lock 아님. [RPR-011]이 청소 |
>
> per-job lock 스캔은 `{uuid}-lock.json` 패턴 **AND** `{uuid}`가 UUID 형식인 파일만 대상으로 하며, 예약 파일명은 명시적으로 제외한다. `jobs-global-lock.json`이 `{jobId}-lock.json` 패턴(`jobId = "jobs-global"`)에 매칭되어 per-job lock으로 오인되면 살아있는 global lock이 orphan으로 삭제되므로, 이 구분은 안전성 요구사항이다.

> **[LOCK-001]** `{STORAGE_DIR}/locks/{jobId}-lock.json` (per-job lock):

```json
{ "preemption": "<64-hex worker id>", "preemptedAt": "2026-09-03T20:00:00.000Z" }
```

- 파일이 존재하는 동안 다른 Worker는 해당 Job을 처리할 수 없다.

> **[LOCK-002]** `{STORAGE_DIR}/locks/jobs-global-lock.json` (global lock):

```json
{ "preemption": "<64-hex process id>", "ownerType": "api", "preemptedAt": "2026-09-03T20:00:00.000Z" }
```

- `ownerType`은 `"api"` 또는 `"worker"`. API 프로세스는 `workers` 레지스트리에 등록되지 않으므로, stale 판정 시 구분에 사용한다.

> **[LOCK-003]** lock 획득은 exclusive create로 수행한다: `fs.open(lockPath, 'wx')` → metadata write → `fsync` → close. 성공 시 소유권 획득, `EEXIST` 시 획득 실패로 처리한다. "존재 확인 후 쓰기" 방식은 금지한다.
>
> `wx`가 보장하는 것은 **경로의 배타적 생성**뿐이며 내용 기록까지 원자적이지는 않다. 따라서 생성 직후·기록 완료 전에 프로세스가 죽으면 빈(또는 부분) lock 파일이 남을 수 있다. 이 상태는 **모든 lock 종류에 공통으로 적용되는** 다음 규칙으로 회수한다:
>
> > **[LOCK-003-a]** (빈·파싱 불가 lock 회수) lock 파일의 내용이 비었거나 JSON 파싱에 실패하거나 `preemption`·`preemptedAt`이 없으면, 파일 mtime이 `PARTIAL_LOCK_STALE_MS`(기본 60,000ms)를 경과한 뒤 stale로 판정하고 [LOCK-010] 절차로 회수한다. 경과 전에는 건드리지 않는다. per-job lock과 global lock 모두 이 규칙의 대상이다.
>
> 이 규칙이 없으면 빈 `jobs-global-lock.json`은 `preemptedAt`을 평가할 수 없어 어떤 stale 판정도 통과하지 못하고, Worker는 무기한 대기·API는 영구 503이 된다.

> **[LOCK-004]** 정상 해제는 소유자만 수행한다.
>
> 1. canonical 경로의 lock 파일을 **먼저 읽는다**. 파일이 없거나 `preemption`이 자신의 Process ID와 다르면 **아무것도 건드리지 않고 중단**하고 오류를 로깅한다.
> 2. 자신의 lock임을 확인했으면 `rename(lockPath, lockPath + '.release-' + myProcessId + '-' + nonce)`를 시도한다. `ENOENT`면 그 사이 회수된 것이므로 중단한다.
> 3. rename된 파일을 다시 읽어 `preemption`이 여전히 자신의 것인지 확인한다. 일치하면 삭제한다. 일치하지 않으면 [LOCK-011]의 복원 절차로 되돌린다.
>
> **1단계(선행 읽기)가 없으면 비소유자 경로가 파괴적이 된다**: 소유권 확인 전에 rename하면 타 프로세스가 정당하게 보유·재획득한 lock이 canonical 경로에서 사라지고, 그 창에서 제3자가 `wx`로 생성에 성공하면 [LOCK-011] 복원이 `EEXIST`로 실패해 원 소유자의 lock이 영구 소실된다. 1단계로 이 경로 자체를 제거하며, 2~3단계의 재확인이 TOCTOU를 계속 막는다.

> **[LOCK-005]** 모든 `jobs.json` 변경은 다음 순서를 지킨다: `global lock 획득 → jobs.json을 디스크에서 reload → 조건 재검증 → 변경 → 저장 → global lock 해제`. `node-json-db` 인메모리 캐시로 덮어쓰는 것을 금지한다(획득 후 reload 필수).
>
> **저장은 임시 파일에 기록한 뒤 원자적 rename으로 `jobs.json`을 교체**한다. 저장 도중 crash가 나도 기존 파일이 손상되지 않아야 한다. 임시 파일명에는 **Process ID와 난수를 포함**하여 프로세스 간 충돌을 방지한다(예: `jobs.json.<processId>.<random>.tmp`).
>
> `node-json-db`는 데이터 파싱·조작·reload에 사용하되, 디스크 저장은 위 원자적 persist로 수행한다(자체 save 경로의 비원자성 우회 — README에 사유 기재).

> **[LOCK-006]** 일관된 snapshot이 필요한 읽기(목록/검색/단건 조회, Worker 후보 조회)도 동일한 global lock 임계 구역에서 수행한다. **예외**: [LOCK-009]/[RPR-012]의 stale 판정을 위한 lock 파일·`jobs.json` 읽기는 global lock 없이 수행한다(판정 대상이 global lock 자신이므로).

> **[LOCK-007]** 잠금 획득 순서는 **per-job lock → global lock**이다. global lock을 보유한 채 per-job lock을 획득하지 않는다. global lock을 보유한 채 장시간 처리·sleep을 하지 않는다.

> **[LOCK-008]** global lock 경합 시: 모든 프로세스는 `GLOBAL_LOCK_RETRY_MS`(기본 1,000ms) 간격으로 재시도한다. Worker는 무기한 재시도하고, API는 누적 대기가 `GLOBAL_LOCK_API_WAIT_MS`(기본 5,000ms)를 초과하면 `503 Service Unavailable`을 반환한다.
>
> 파일 잠금 재시도에는 큐도 공정성도 없으므로, 특정 Worker가 오랫동안 `wx` 경쟁에 밀리는 **경합 기아**가 가능하다. 이때 heartbeat 갱신([WRK-010])도 같은 global lock을 필요로 하므로 살아있는 Worker가 자기 생존을 알리지 못하고 Reaper에게 stale로 오판될 수 있다. 이 오판이 데이터 손상으로 이어지지 않게 하는 것은 Reaper 쪽 유예 heuristic이 아니라 **Worker 쪽 self-fencing([WRK-012])** 이다. 기아 자체를 완화하기 위해 재시도 간격에는 `GLOBAL_LOCK_RETRY_MS`의 ±50% 지터를 적용한다.

> **[LOCK-009]** (stale global lock 복구 — 모든 프로세스) global lock 획득 시도 중 기존 lock 파일이 [RPR-012]의 stale 조건 또는 [LOCK-003-a]의 빈·파싱 불가 조건에 해당하면, **API·Worker 어떤 프로세스든** [LOCK-010] 절차로 해당 lock을 회수한 뒤 획득을 재시도할 수 있다. Reaper가 없는 배포(API 단독 실행)에서도 영구 정지가 발생하지 않기 위한 규칙이다.

> **[LOCK-010]** (stale lock 회수 절차) stale로 판정한 lock의 회수는 **plain unlink를 절대 사용하지 않고** 다음 순서로 수행한다. 별도의 조정용 mutex는 두지 않는다 — 2단계의 rename 자체가 회수 경쟁을 직렬화한다.
>
> 1. **판정**: 대상 lock 파일을 읽어 stale 조건([RPR-012] 또는 [LOCK-003-a])이 성립하는지 확인한다. 성립하지 않으면 중단한다. 판정 근거(`preemption`, `preemptedAt`, 빈 파일이면 mtime)를 기록한다.
> 2. **배타적 이동**: `rename(lockPath, lockPath + '.stale-' + myProcessId + '-' + nonce)`를 시도한다. 같은 원본에 대한 rename은 **정확히 하나만 성공**하며 나머지는 `ENOENT`로 실패한다. 실패하면 다른 프로세스가 이미 회수를 진행한 것이므로 중단하고 획득 루프로 돌아간다.
> 3. **이동 후 재판정**: 이제 대상 파일을 **배타적으로 점유**한 상태다. 파일을 다시 읽어 1의 판정 근거와 동일한지 확인한다.
> 4. 동일하면 삭제한다(회수 완료). 다르면(판정 이후 원 소유자가 해제하고 다른 프로세스가 새 lock을 게시한 경우) [LOCK-011]의 복원 절차로 되돌린다.
>
> **왜 mutex가 아니라 rename인가**: 이전 판이 사용한 "reap-mutex를 `wx`로 잡고 그 안에서 회수" 방식은 ⓐ mutex 자체의 `read → unlink → wx` 경로에 동일한 check-then-delete race가 생기고(두 프로세스가 모두 획득 성공), ⓑ mutex가 누출되면 회수 기능이 영구 정지하고, ⓒ 절차 중단 경로마다 해제 누락이 생겨, 막으려던 문제보다 더 많은 실패 모드를 만들었다. rename 기반 회수는 배타성을 파일시스템 원자성에서 직접 얻으므로 이 세 문제가 모두 사라진다. 회수 도중 프로세스가 죽어도 남는 것은 `*.stale-*` 잔존 파일뿐이며 [RPR-011]이 mtime 기준으로 청소한다.

> **[LOCK-011]** (no-replace 복원 절차) rename으로 옮겨둔 lock 파일을 원래 경로로 되돌릴 때는 `rename`을 사용하지 않는다 — Node.js `fs.rename`은 목적지가 존재해도 조용히 덮어쓰므로, 그 사이 다른 프로세스가 `wx`로 생성한 살아있는 lock을 파괴할 수 있다. 대신 `fs.link(movedPath, lockPath)`(목적지 존재 시 `EEXIST` 보장)를 시도하고, 성공하면 `movedPath`를 삭제한다. `EEXIST`면(새 lock이 이미 생성됨) 복원을 포기하고 `movedPath`를 삭제한 뒤 경고를 로깅한다.

---

## 3. REST API

### 3.1 공통 규칙

> **[API-001]** 응답 본문 공통 형식:

```json
{ "status": 200, "result": "success" }
```

- `status`: HTTP 상태 코드와 동일한 숫자
- `result`: 성공 시 `"success"`, 그 외에는 한국어 사유 메시지. **단 하나의 예외**로, 검색 결과 없음([API-032])은 `200`이면서 `result`에 사유 메시지를 담는다.
- 목록 응답은 `list`(배열), 단건 응답은 `job`(객체)을 추가한다.

> **[API-002]** 본문의 `status`는 실제 HTTP 응답 상태 코드와 항상 일치해야 한다.

> **[API-003]** DTO validation 실패는 `400 Bad Request`와 사유 메시지를 반환한다. 정의되지 않은 필드는 거부한다(whitelist + forbidNonWhitelisted).

> **[API-004]** 처리 중 내부 오류는 `500 Internal Server Error`를 반환한다. **모든 엔드포인트**는 [LOCK-006]에 따라 global lock을 경유하므로, 대기 초과 시 `503 Service Unavailable`([LOCK-008])을 반환할 수 있다(각 엔드포인트 표에 별도 기재하지 않는다). 어떤 경우에도 [API-001] 형식을 유지한다.

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
| 저장 실패 | 500 |

### 3.4 `GET /jobs`

> **[API-020]** 전체 Job을 `createdAt` ASC, 동률 시 `id` ASC로 정렬해 `list`로 반환한다. 빈 목록도 `200 OK` + `list: []`이다.

### 3.5 `GET /jobs/search`

> **[API-030]** Query parameter: `title`, `description`, `status` — **셋 중 하나 이상 필수**.
>
> **처리 순서를 다음으로 고정한다** (이 순서가 없으면 `?status=`의 기대 결과를 정할 수 없다):
>
> 1. **정규화**: 세 파라미터를 trim하고, 결과가 빈 문자열인 파라미터는 **아예 전달되지 않은 것으로 간주해 제거**한다. 이 단계는 **DTO validation보다 선행**한다([API-053] ⓪과 같은 수준의 규정).
> 2. **조건 존재 검사**: 정규화 후 남은 파라미터가 하나도 없으면 `400`(조건 누락 메시지).
> 3. **validation**: 남은 파라미터에 대해서만 [API-031]의 규칙을 적용한다. 따라서 `?status=`는 status enum validation을 타지 않는다(제거되었으므로).
>
> 예: `?title=`은 title 미입력, `?title=&status=done`은 status 단독 검색, `?status=`(단독)는 전부 미입력과 동일해 `400`.
>
> 과제 원문은 "제목/상태로 검색"을 요구한다. 설계 문서의 `title`/`description`에 **`status`를 추가**하여 과제 요구를 충족한다.

> **[API-031]** 매칭 규칙 (모든 파라미터는 **trim된 값**으로 매칭한다):
> - `title`, `description`: **대소문자 구분 없는 부분 일치**
> - `status`: trim 후 enum 정확 일치 (`create` | `pending` | `done`). 그 외 값은 `400`
> - 복수 조건은 **AND** 결합
> - 결과 목록 정렬은 [API-020]과 동일

> **[API-032]** 응답:

| 상황 | HTTP 상태 | `result` | `list` |
|---|---:|---|---|
| 검색 성공(1건 이상) | 200 | `success` | 매칭된 Job 배열 |
| 검색 결과 없음 | 200 | `데이터가 존재하지 않습니다.` | `[]` |
| 유효 조건 없음(전부 미입력, `?status=` 단독 포함) | 400 | `title, description, status 중 하나 이상을 입력하여 주세요.` | 없음 |
| `status`에 enum 아닌 값(`?status=unknown`) | 400 | 유효성 검사 사유 | 없음 |
| `?title=x&status=` (빈 status 제거 후 title 단독) | 200 | 검색 결과에 따름 | 결과에 따름 |

### 3.6 `GET /jobs/:id`

> **[API-040]** `:id` 경로 파라미터를 받는 **모든 라우트**(GET, PATCH)에서 `:id`는 UUID 형식(버전 무관)이어야 하며, 형식이 아니면 `400`. 형식은 유효하나 존재하지 않으면 `404`.

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

> **[API-053]** 거부 사유 판정 우선순위: ⓪ DTO/파라미터 validation(400, 상태 검사보다 선행) → ① Job 존재 여부(404) → ② `done`(409, 완료 메시지) → ③ `pending` 또는 per-job lock 존재(409, 처리중 메시지). `done`이면서 lock 파일이 아직 남아 있는 경우([WRK-024]의 lock 삭제 전 시간창) 완료 메시지가 우선한다.

| 상황 | HTTP 상태 | `result` |
|---|---:|---|
| 수정 성공 | 200 | `success` |
| Job 없음 | 404 | `존재하지 않는 데이터입니다.` |
| `done` | 409 | `이미 완료된 프로세스입니다.` |
| `pending` 또는 per-job lock 존재 | 409 | `처리중인 프로세스입니다.` |
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

- `LEVEL`: `INFO` | `WARN` | `ERROR` | `FATAL`
- `scope`: `http`(요청 로깅) | `worker`(claim·완료·롤백) | `reaper`(Reaper cleanup의 선출·복구 조치) | `storage`(lock·저장·초기화 관련. [LOCK-009] 경로의 stale lock 제거는 수행 주체와 무관하게 `storage`로 기록)

> **[LOG-003]** **모든 HTTP 요청**을 로깅한다: method, path(query 포함), 응답 상태 코드, 처리 시간(ms). 에러 응답도 포함한다.

> **[LOG-004]** Worker는 **처리 결과**를 로깅한다. 최소 대상: Job claim(선점), 처리 완료(done), 처리 실패·롤백, Reaper 선출, Reaper의 복구 조치(orphan lock 정리, stale worker 삭제, stale global lock 삭제, pending-무lock 롤백).

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

> **[WRK-004]** 정상 종료(`SIGINT`/`SIGTERM`/shutdown hook) 시 다음 순서를 지킨다.
>
> 1. `isShuttingDown = true`로 설정하고 **새 스케줄 실행을 차단**한다.
> 2. **이미 시작된 in-flight callback(heartbeat / consume / reaper check / reaper cleanup)이 모두 settle될 때까지 대기**한다(`SHUTDOWN_DRAIN_MS`(기본 10,000ms) 초과 시 WARN 로깅 후 진행).
> 3. 보유 중인 `pending` Job을 [LOCK-005] 임계 구역에서 **항상 `create`로 롤백**한다.
> 4. 보유한 per-job lock을 [LOCK-004]에 따라 해제한다.
> 5. `workers[workerId]`를 삭제한다.
> 6. 자신이 Reaper면 `reaper.workerId`를 초기화한다.
>
> 추가로 **모든 스케줄 callback은 global lock 임계 구역 내부의 mutation 직전에 `isShuttingDown`을 재확인**하고, 참이면 mutation을 포기한다. 2단계의 drain만으로는 부족하다 — global lock을 대기 중이던 heartbeat가 3~6단계 이후에 lock을 얻어 `workers[workerId]`를 다시 upsert하거나, reaper check가 `reaper.workerId`를 다시 기록하거나, claim 직전이던 consume이 새 `pending`을 만들 수 있고, 그 결과 "정상 종료"인데도 zombie worker/reaper 레코드나 새 orphan Job이 남아 failover가 5~6분 지연된다.

### 5.2 Heartbeat와 self-fencing

> **[WRK-010]** `HEARTBEAT_INTERVAL_MS`마다 [LOCK-005] 임계 구역에서 `workers[workerId].heartbeatAt = now`로 갱신한다. 갱신에 성공하면 메모리의 `lastHeartbeatOkAt`을 함께 갱신한다.

> **[WRK-011]** 시간 기준(§7과 연동): Reaper 사망 판단 5분 초과, stale worker 삭제 6분 이상. 1분의 차이는 clock drift·스케줄 지연에 대한 safety margin이다.

> **[WRK-012]** (Self-fencing — 안전성의 근거) Worker는 자신의 생존이 **다른 프로세스에게 증명된 상태**에서만 상태를 변경한다.
>
> - `now - lastHeartbeatOkAt > REAPER_STALE_AFTER_MS`이면 자신이 stale로 오판될 수 있는 구간이다. 이때 Worker는 ⓐ 처리 중인 Job을 중단하고 가능해지는 즉시 `pending → create` 롤백 및 per-job lock 해제를 수행하며, ⓑ heartbeat가 다시 성공하기 전까지 **새 Job을 claim하지 않으며**, ⓒ 자신이 Reaper라면 역할을 즉시 포기한다.
> - **모든 Job 상태 변경 트랜잭션은 임계 구역 안에서 `workers[workerId]`의 존재를 재확인**하고, 없으면(Reaper가 자신을 삭제한 것) 변경을 포기하고 WARN을 로깅한다.
>
> 이로써 Reaper가 경합 기아([LOCK-008]) 상태의 살아있는 Worker를 stale로 오판해도 **이중 커밋은 발생하지 않는다**. 중복 실행은 발생할 수 있으나 [WRK-023]의 처리에는 외부 부작용이 없으므로 무해하며, 완료 시 [WRK-024]의 소유권 재검증이 두 번째 커밋을 차단한다. 안전성을 Reaper 쪽 heuristic(유예 규칙)이 아니라 Worker 쪽 불변식에 두는 것이 이 설계의 핵심이다.

### 5.3 Consume flow

> **[WRK-020]** 후보 조회: [LOCK-006] snapshot에서 `status === "create"`인 Job을 `createdAt` ASC, 동률 시 `id` ASC로 정렬한다.

> **[WRK-021]** Claim 절차 (후보별):
> 1. `{jobId}-lock.json`을 [LOCK-003]에 따라 내용(`preemption = workerId`, `preemptedAt = now`)과 함께 단일 호출로 생성 시도. `EEXIST`면 **즉시 다음 후보로 이동**(대기 금지).
> 2. [LOCK-005] 임계 구역에서 해당 Job이 여전히 `create`인지 재검증.
> 3. `create`가 아니면 per-job lock을 [LOCK-004]에 따라 삭제 후 다음 후보로 이동.
> 4. `create`면 `status = "pending"`, `updatedAt = now`로 저장하고 임계 구역을 빠져나온 뒤 처리를 시작한다.

> **[WRK-022]** 다음 경우에만 다음 tick까지 대기한다: `create` Job이 없음 / 모든 후보의 lock 획득 실패 / 재검증 결과 모든 후보가 `create`가 아님.

> **[WRK-023]** 처리: 기본 `JOB_PROCESSING_MS`(기본 30,000ms) 동안 수행하는 것으로 간주한다(별도 비즈니스 로직 없음). 기본값은 `CONSUME_INTERVAL_MS`보다 작게 두어 [WRK-003] guard가 매 tick마다 상시 발동하지 않게 한다.

> **[WRK-026]** consume tick 전체에 `CONSUME_TIMEOUT_MS`(기본 `2 × JOB_PROCESSING_MS`) 상한을 둔다. 초과하면 [WRK-025]의 롤백 경로로 보내고, **어떤 경우에도 `isConsuming` guard를 해제**한다.
>
> 상한이 없으면 consume 경로가 예외 없이 hang하는 경우(무기한 global lock 대기, NFS I/O 정지 등) [WRK-025]의 롤백이 발동하지 않고 `isConsuming`도 풀리지 않아, 해당 Worker가 이후 어떤 Job도 처리하지 않고 조용히 풀에서 이탈한다. Worker가 1대인 배포에서는 전체 처리가 멈춘다. Job 쪽 고착은 [RPR-014]가 함께 처리한다.

> **[WRK-024]** 완료 절차: [LOCK-005] 임계 구역에서 ① `status === "pending"` 재확인, ② per-job lock의 `preemption === workerId` 재확인 → 모두 만족 시 `status = "done"`, `updatedAt = now` 저장 → 임계 구역 종료 후 per-job lock을 [LOCK-004]에 따라 삭제. 소유권 검증 실패 시 `done`으로 **덮어쓰지 않고** 오류를 로깅하며, [LOCK-004] 검증을 통과하는 lock만 정리한다.

> **[WRK-025]** 처리 중 예외 발생 시(프로세스 생존): [LOCK-005] 임계 구역에서 소유권 확인 후 자신이 소유한 `pending` Job을 `create`로 롤백하고 per-job lock을 [LOCK-004]에 따라 삭제한다.

### 5.4 Reaper 선출

> **[RPR-001]** 각 Worker는 시작 `REAPER_INITIAL_DELAY_MS`(기본 60,000ms) 후부터 `REAPER_CHECK_INTERVAL_MS`마다 Reaper 상태를 확인한다. 다음 두 조건을 모두 만족하면 현 Reaper를 유지한다: `reaper.workerId`가 `workers`에 존재 AND 해당 heartbeat가 5분 이내.

> **[RPR-002]** Reaper가 없거나 stale이면: [LOCK-005] 임계 구역에서 최신 상태 재확인 후 `reaper.workerId = 내 workerId` 저장 → **global lock을 해제한 상태로** `REAPER_ELECTION_GRACE_MS`(기본 60,000ms) 대기 → 별도 임계 구역에서 재조회하여 여전히 자신의 ID면 Reaper 역할 시작 (eventual leader election).

> **[RPR-003]** Reaper 자격 재검증은 cleanup run 시작 시점이 아니라 **개별 복구 조치를 수행하는 global lock 임계 구역 내부**(reload 후)에서 수행한다. `reaper.workerId !== workerId`면 해당 조치와 남은 cleanup run을 즉시 중단한다. **예외**: [RPR-012]의 stale global lock 회수는 임계 구역 없이 수행되므로 자격 재검증은 lock-free 읽기로 대체하며, 다중 실행 안전성은 [LOCK-010] 2단계의 원자적 rename이 보장한다(회수는 애초에 Reaper 전용 권한이 아니다 — [LOCK-009]).

> **[RPR-004]** cleanup run은 **프로세스 로컬 `isReaping` guard로 직렬화**한다. 이전 run이 끝나지 않았으면 다음 cleanup tick은 건너뛴다. cleanup은 여러 임계 구역과 파일 회수를 포함해 tick 주기보다 오래 걸릴 수 있으므로, guard가 없으면 같은 프로세스에서 두 run이 겹쳐 동일 대상에 대한 이중 복구가 발생한다.

### 5.5 Reaper cleanup

> **[RPR-010]** Stale worker 정리: `heartbeatAt`이 `WORKER_DELETE_AFTER_MS`(기본 6분) 이상 갱신되지 않은 Worker를 `workers`에서 삭제한다. 자신의 heartbeat가 `REAPER_STALE_AFTER_MS`(기본 5분)를 초과해 stale이면 cleanup을 진행하지 않는다([WRK-012] ⓒ에 따라 Reaper 역할도 포기한다).
>
> 이전 판에 있던 "stale global lock 회수 직후 1주기 유예" 규칙은 **삭제**했다. 그 규칙은 회수 사실을 `jobs.json`에 영속화해야 동작했는데, 회수와 기록 사이가 원자적이지 않아 ⓐ 기록 전 crash 시 공백, ⓑ 같은 프로세스의 중첩 cleanup이 자기 소유 mutex 예외로 가드를 우회, ⓒ Reaper 교체 시 유예 인지 실패 등 새 실패 모드를 만들었다. 유예가 보호하려던 대상(경합 기아 상태의 생존 Worker)은 이제 [WRK-012] self-fencing이 **오판 자체와 무관하게** 보호한다.

> **[RPR-011]** Orphan per-job lock 복구: 다음 **두 조건을 모두** 만족하면 orphan으로 판단한다.
>
> - lock의 `preemption`이 `workers`에 없다.
> - **`preemptedAt` 경과가 `WORKER_DELETE_AFTER_MS`를 초과**했다(빈·파싱 불가 lock은 [LOCK-003-a]에 따라 mtime 기준).
>
> 최소 경과 조건은 [RPR-012]①과 동일한 이유로 필요하다. registry 부재만으로 판정하면, 경합 기아나 신규 등록 지연으로 일시적으로 `workers`에 없는 **살아있는** Worker의 lock을 즉시 orphan으로 판정해 처리 중인 Job을 롤백하고 중복 실행을 유발한다.
>
> - 복구 절차: [LOCK-005] 임계 구역에서 orphan 여부 재검증 → Job이 `pending`이면 `create`로 롤백(`updatedAt = now`), Job이 `done`이거나 존재하지 않으면 상태 변경 없음 → 임계 구역 종료 후 [LOCK-010] 절차로 lock 파일을 회수한다.
> - 살아 있는 Worker의 lock은 회수하지 않는다(단, [RPR-014]의 lease 만료는 예외).
> - lock 스캔 대상은 [LOCK-000]의 per-job lock 패턴을 만족하는 파일만이다. 예약 파일명(`jobs-global-lock.json`)과 절차상 임시 파일(`*.stale-*`, `*.release-*`, `*.tmp`)은 lock으로 취급하지 않는다.
> - **잔존 파일 청소**: mtime이 `REAPER_STALE_AFTER_MS`를 경과한 `*.stale-*`, `*.release-*`, `*.tmp` 파일을 `{STORAGE_DIR}/locks/`와 `{STORAGE_DIR}`(저장용 `jobs.json.*.tmp` 포함) 양쪽에서 삭제한다.

> **[RPR-012]** Stale global lock 복구: `jobs-global-lock.json`이 다음 중 하나면 stale 후보다.
>
> - ① `ownerType === "worker"`이고 `preemption`이 `workers`에 없으며, **`preemptedAt`이 `GLOBAL_LOCK_ORPHAN_MIN_MS`(기본 180,000ms)를 경과**했다. (최소 경과 조건이 없으면 신규 Worker가 자기 등록을 위해 잡은 첫 lock — 아직 `workers`에 미등록 상태 — 을 오판한다.)
> - ② `preemptedAt`이 `GLOBAL_LOCK_STALE_AFTER_MS`(기본 5분)를 초과했다. (API 소유 lock은 ②만 적용)
> - ③ [LOCK-003-a]의 빈·파싱 불가 조건을 만족한다.
>
> 판정을 위한 읽기는 [LOCK-006]의 예외에 따라 lock-free로 수행하고, 회수는 [LOCK-010] 절차를 따른다. [LOCK-009]에 따라 ②·③의 복구는 Reaper가 아닌 프로세스도 수행할 수 있다.

> **[RPR-013]** Pending-무lock 복구: `status === "pending"`인데 per-job lock 파일이 존재하지 않는 Job은, `updatedAt`이 `REAPER_STALE_AFTER_MS`(기본 5분)를 초과했다면 [LOCK-005] 임계 구역에서 `create`로 롤백한다(`updatedAt = now`). 이 상태는 정상 흐름에서는 발생하지 않지만, 장애 조합·샘플 데이터([DATA-004])로 도달할 수 있다.

> **[RPR-014]** 처리 lease 만료 복구: per-job lock의 `preemptedAt` 경과가 `JOB_LEASE_MS`(기본 `4 × JOB_PROCESSING_MS`)를 초과하면, **소유자가 `workers`에 등록되어 있어도** lease 만료로 간주해 [RPR-011]과 동일한 복구를 수행한다.
>
> [LOCK-001]의 `preemptedAt`을 소비하는 유일한 규칙이다. 이것이 없으면 heartbeat는 정상이지만 consume만 hang한 Worker가 보유한 Job이 `pending` + 유효 lock 상태로 **영구 고착**된다([RPR-011]은 소유자가 registry에 있으면 판정 불가, [RPR-013]은 lock이 있으면 대상 아님). Worker 쪽에서는 [WRK-026]의 tick 상한이 같은 상황을 해소하며, 두 규칙이 만나는 지점에서 이중 커밋은 [WRK-024]의 소유권 재검증과 [WRK-012]의 self-fencing이 막는다.

---

## 6. 동시성 규칙 요약

| ID | 상황 | 규칙 |
|---|---|---|
| **[CON-001]** | 여러 Worker가 같은 Job 조회 | per-job lock exclusive create 성공자만 처리 |
| **[CON-002]** | 특정 Job lock 실패 | 다음 `create` 후보 즉시 시도 |
| **[CON-003]** | `jobs.json` 동시 변경 | global lock 직렬화 + 획득 후 reload + 원자적 rename 저장 |
| **[CON-004]** | claim 전 상태 변경됨 | per-job lock 해제 후 다음 후보 |
| **[CON-005]** | 완료 전 소유권 변경됨 | `done` 덮어쓰기 금지 |
| **[CON-006]** | 처리 예외(프로세스 생존) | `pending → create` 롤백 |
| **[CON-007]** | Worker 비정상 종료 | Reaper가 orphan lock 삭제 + 롤백 |
| **[CON-008]** | API·Worker 동시 접근 | 모든 쓰기·일관 읽기는 global lock 경유 |
| **[CON-009]** | lock 해제·회수 | 소유 검증 후 해제([LOCK-004]) 또는 rename 기반 회수([LOCK-010]) 필수. **plain unlink 금지** |
| **[CON-010]** | Reaper가 생존 Worker를 오판 | Worker self-fencing([WRK-012])으로 커밋 차단 — 중복 실행은 허용, 이중 커밋은 불가 |
| **[CON-011]** | 소유자 생존 + 처리 hang | [WRK-026] tick 상한 + [RPR-014] lease 만료 복구 |

### 안전성의 근거

이 설계의 안전성은 **두 층**으로 구성된다.

1. **배타성은 파일시스템 원자성에서만 얻는다.** 획득은 `wx` exclusive create([LOCK-003]), 회수는 rename([LOCK-010] 2단계), 저장은 tmp + rename([LOCK-005]), 복원은 `fs.link`([LOCK-011]). "읽고 판단한 뒤 지운다"는 경로는 어디에도 없다 — 그 경로는 필연적으로 check-then-delete race를 만든다.
2. **소유권은 커밋 시점에 재검증한다.** [WRK-024]의 상태·소유권 재확인, [WRK-012]의 self-fencing과 registry 재확인, [RPR-003]의 Reaper 자격 재확인. 따라서 회수 판정이 틀렸더라도 잘못된 커밋으로 이어지지 않는다.

### 알려진 한계 (README 기재 대상)

파일 기반 잠금에는 fencing token이 없으므로, 다음 잔여 창이 남는다.

- **정지 후 부활**: lock 소유자가 stale timeout(global lock 5분, 등록용 lock 3분, per-job lock `WORKER_DELETE_AFTER_MS` 6분, 빈 lock 60초)을 넘겨 정지했다가 살아나는 GC pause·컨테이너 throttling. 이 경우 회수는 정당하지만 원 소유자가 자신이 소유자라고 오인할 수 있다. [WRK-012]/[WRK-024]의 재검증이 커밋을 막으므로 데이터 손상으로는 이어지지 않는다.
- **[LOCK-010] 1~2단계 사이의 교체**: 판정 직후 rename 전에 원 소유자가 정상 해제하고 제3자가 새 lock을 게시하면, 3단계 재판정에서 불일치를 감지해 [LOCK-011]로 복원한다. 복원이 `EEXIST`로 실패하는 경우(그 짧은 사이에 또 다른 lock이 게시됨)에만 lock이 소실되며, 이때도 Job은 [RPR-013]으로 회수된다.
- **중복 실행**: Reaper 오판이나 lease 만료 시 같은 Job이 두 번 실행될 수 있다. [WRK-023]의 처리는 외부 부작용이 없어 무해하지만, 실제 비즈니스 로직을 넣는다면 idempotency가 필요하다.

강한 보장이 필요하면 PostgreSQL row lock(`SELECT ... FOR UPDATE SKIP LOCKED`)이나 Redis/RabbitMQ 기반 queue로 이전하는 것이 적절하다. 파일 잠금으로 fencing을 얻으려는 시도는 복잡도만 늘린다 — 이 명세의 reap-mutex 도입·철회가 그 사례다.

---

## 7. 설정값

> **[CFG-001]** 모든 시간 관련 값은 환경 변수(또는 주입 가능한 설정)로 재정의할 수 있어야 하며, 테스트에서는 clock·scheduler를 주입해 실제 대기 없이 검증한다.

| 설정 | 기본값 |
|---|---:|
| `STORAGE_DIR` | `./data` (상대 경로는 **프로젝트 루트 기준**으로 해석) |
| `LOG_FILE_PATH` | `./logs.txt` |
| `HEARTBEAT_INTERVAL_MS` | 60,000 |
| `CONSUME_INTERVAL_MS` | 60,000 |
| `REAPER_INITIAL_DELAY_MS` | 60,000 |
| `REAPER_CHECK_INTERVAL_MS` | 60,000 |
| `REAPER_ELECTION_GRACE_MS` | 60,000 |
| `REAPER_STALE_AFTER_MS` | 300,000 |
| `WORKER_DELETE_AFTER_MS` | 360,000 |
| `GLOBAL_LOCK_RETRY_MS` | 1,000 |
| `GLOBAL_LOCK_API_WAIT_MS` | 5,000 |
| `GLOBAL_LOCK_STALE_AFTER_MS` | 300,000 |
| `GLOBAL_LOCK_ORPHAN_MIN_MS` | 180,000 |
| `PARTIAL_LOCK_STALE_MS` | 60,000 |
| `JOB_PROCESSING_MS` | 30,000 |
| `CONSUME_TIMEOUT_MS` | 60,000 (`2 × JOB_PROCESSING_MS`) |
| `JOB_LEASE_MS` | 120,000 (`4 × JOB_PROCESSING_MS`) |
| `SHUTDOWN_DRAIN_MS` | 10,000 |

- 제약: `WORKER_DELETE_AFTER_MS > REAPER_STALE_AFTER_MS`, `JOB_LEASE_MS > CONSUME_TIMEOUT_MS > JOB_PROCESSING_MS`, `JOB_PROCESSING_MS < CONSUME_INTERVAL_MS`.
- global lock 장기 장애 시 생존 Worker 보호는 Reaper 쪽 유예가 아니라 [WRK-012] self-fencing이 담당한다.

> **[CFG-002]** (프로세스 간 합의가 필요한 설정) 아래 값들은 **한 프로세스가 다른 프로세스의 생존·소유권을 판정하는 기준**이므로, 같은 `STORAGE_DIR`을 공유하는 모든 프로세스에서 **동일해야 한다**.
>
> `HEARTBEAT_INTERVAL_MS`, `REAPER_STALE_AFTER_MS`, `WORKER_DELETE_AFTER_MS`, `GLOBAL_LOCK_STALE_AFTER_MS`, `GLOBAL_LOCK_ORPHAN_MIN_MS`, `PARTIAL_LOCK_STALE_MS`, `JOB_LEASE_MS`
>
> [RUN-004]의 부트스트랩에서 이 값들의 fingerprint를 `jobs.json`의 `config.fingerprint`와 비교하고, 불일치하면 FATAL 로깅 후 비-0 종료 코드로 중단한다. 그렇지 않으면 예를 들어 `HEARTBEAT_INTERVAL_MS=300000`으로 기동한 Worker를 기본값(60,000ms)의 Reaper가 6분 기준으로 판정해 **살아있는 Worker를 삭제**하며, 각 프로세스는 이 불일치를 감지할 방법이 없다.
>
> 나머지 값(`CONSUME_INTERVAL_MS`, `JOB_PROCESSING_MS`, `GLOBAL_LOCK_RETRY_MS`, `GLOBAL_LOCK_API_WAIT_MS`, `REAPER_*_DELAY/GRACE/CHECK`, `CONSUME_TIMEOUT_MS`, `SHUTDOWN_DRAIN_MS`)은 프로세스별로 달라도 안전하다.

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

> **[RUN-004]** 부트스트랩 초기화: 프로세스 기동 시 순서대로 —
>
> 1. `STORAGE_DIR`·locks 디렉터리가 없으면 생성한다(멱등).
> 2. `jobs.json`이 없으면 기본 스키마 `{ "jobs": [], "workers": {}, "reaper": { "workerId": null }, "config": null }`로 생성한다. 배타성과 내용 원자성을 함께 보장하기 위해, **임시 파일([LOCK-005] 명명 규칙)에 완전히 기록한 뒤 `fs.link(tmpPath, jobsJsonPath)`로 연결**하고 임시 파일을 삭제한다. `EEXIST`면 다른 프로세스가 이미 생성한 것이므로 임시 파일만 삭제하고 건너뛴다(동시 기동 race 방지 — 일반 write로 기존 데이터를 덮어쓰는 것과, `wx` 직접 쓰기 중 crash로 인한 부분 파일 잔존을 모두 방지).
> 3. 최상위 키 누락 보정은 **global lock 임계 구역에서 reload 후** 수행한다([LOCK-005] 준수).
> 4. **[CFG-002] fingerprint 검증**을 global lock 임계 구역에서 수행한다: `config.fingerprint`가 없으면(최초 기동) 자신의 값으로 기록하고, 있으면 자신의 값과 비교해 **불일치 시 FATAL 로깅 후 비-0 종료 코드로 중단**한다.
> 5. `jobs.json`이 파싱 불가(손상)하면 **자동으로 초기화하지 않는다**(데이터 보호 우선). 기동 시 감지하면 FATAL 로깅 후 비-0 종료 코드로 중단하고, 런타임 reload 중 감지하면 해당 API 요청은 `500`, 해당 Worker tick은 중단 처리하며 오류를 로깅한다.

> **[DOC-001]** `README.md`는 다음을 포함한다: ① 설치·실행·테스트 방법(API/Worker 별도 실행법, 다중 인스턴스 실행 예시 포함), ② 모든 엔드포인트의 요청/응답 예시, ③ 설계 코멘트(API 설계, 동시성 처리, 성능, 의도적 결정), ④ [부록 C](#부록-c-과제-해석-사항-readme-반영-대상)의 과제 해석 사항 전부, ⑤ §6의 안전성 근거와 알려진 한계, ⑥ 아래 **관측 타임라인과 빠른 확인 방법**.

> **[DOC-002]** 기본 설정값으로는 처리 결과 관측까지 수 분이 걸리므로 README에 다음을 명시한다.
>
> | 단계 | 기본 설정 소요 |
> |---|---|
> | Reaper 가동 (`REAPER_INITIAL_DELAY_MS` + `REAPER_ELECTION_GRACE_MS`) | 최대 2분 |
> | 샘플 `pending` Job 복구 ([RPR-013], cleanup tick 대기) | 최대 3분 |
> | `create` Job 처리 완료 (consume tick + `JOB_PROCESSING_MS`) | 최대 4.5분 |
>
> 빠른 확인용 환경 변수 조합을 README에 함께 제공한다:
>
> ```bash
> JOB_PROCESSING_MS=3000 CONSUME_INTERVAL_MS=5000 \
> HEARTBEAT_INTERVAL_MS=5000 REAPER_INITIAL_DELAY_MS=2000 \
> REAPER_ELECTION_GRACE_MS=2000 REAPER_CHECK_INTERVAL_MS=5000 \
> REAPER_STALE_AFTER_MS=15000 WORKER_DELETE_AFTER_MS=20000 \
> JOB_LEASE_MS=12000 npm run start:worker
> ```
>
> [CFG-002]에 해당하는 값을 바꿀 때는 **모든 프로세스에 동일하게** 적용해야 한다(그렇지 않으면 부트스트랩이 FATAL로 중단시킨다). 기존 `data/jobs.json`의 `config.fingerprint`도 함께 갱신되어야 하므로, 설정을 바꿔 실행할 때는 `data/`를 초기화하거나 모든 프로세스를 동일 설정으로 재기동한다.

---

## 9. 테스트 요구사항 (Stage 2 기준)

> **[TST-001]** 테스트는 본 명세의 요구사항 ID를 참조한다(예: `describe('[API-030] ...')`).

최소 검증 범위:

| 영역 | 대상 |
|---|---|
| API e2e | §3의 모든 엔드포인트 × 성공/실패 케이스 (상태 코드 + 응답 본문 형식). `?status=` 계열 정규화 순서([API-030]), 런타임 손상 시 `500` 본문 형식([API-004]) 포함 |
| 로깅 | HTTP 요청 로깅[LOG-003], Worker·Reaper 처리 로깅[LOG-004] (scope별) |
| Storage/Lock | [LOCK-003] 획득, [LOCK-003-a] 빈·부분 lock 회수(**생성 직후 crash fault injection**), [LOCK-004] 비소유자 해제가 타 lock을 건드리지 않음, [LOCK-005] reload-후-저장·원자적 저장, [LOCK-008]~[LOCK-011] 대기·503·회수·복원 |
| 초기화 | [RUN-004] 파일/디렉터리 부재·키 누락·손상·동시 기동, [CFG-002] fingerprint 불일치 시 FATAL |
| Worker consume | [WRK-020]~[WRK-026] claim·완료·롤백·소유권 검증·tick 상한 |
| Reaper | [RPR-001]~[RPR-014] 선출·grace period·각 복구 시나리오·lease 만료 |
| Shutdown | [WRK-004] in-flight drain: heartbeat / reaper check / claim-직전 consume이 각각 shutdown 이후 상태를 재생성하지 않음(3가지 interleaving) |

> **[TST-003]** 다음 동시성·복구 시나리오는 fake clock과 제어 가능한 lock으로 재현 가능하므로 **명시적 테스트 케이스로 고정**한다.

| # | 시나리오 | 기대 |
|---|---|---|
| 1 | 두 Worker가 같은 Job을 동시에 claim ([CON-001]) | 정확히 1개만 성공 |
| 2 | 두 프로세스가 같은 stale lock을 동시에 회수 ([LOCK-010] 2단계) | rename 승자 1개, 패자는 `ENOENT`로 중단 후 획득 재시도 |
| 3 | [LOCK-010] 1~2단계 사이에 lock이 교체됨 | 3단계 재판정 실패 → [LOCK-011] 복원, 살아있는 lock 보존 |
| 4 | 비소유자가 [LOCK-004] 해제를 시도 | canonical 경로의 lock이 **전혀 변경되지 않음** |
| 5 | 경합 기아로 heartbeat 실패 → Reaper가 생존 Worker 삭제 | [WRK-012]에 의해 해당 Worker의 커밋이 거부됨 (`done` 미기록) |
| 6 | `jobs-global-lock.json`이 존재하는 상태에서 Reaper cleanup 실행 | per-job lock으로 오인·회수되지 않음 ([LOCK-000]) |
| 7 | 소유자 생존 + consume hang, `JOB_LEASE_MS` 초과 | [RPR-014]가 Job 회수, hang한 Worker는 커밋 실패 |
| 8 | lock 생성 직후 metadata 기록 전 crash (빈 lock 잔존) | `PARTIAL_LOCK_STALE_MS` 경과 후 회수되어 global lock 교착이 풀림 |

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
| 6 | lock 생성 방식 | `fs.open(path, 'wx')` 후 내용 기록 | `fs.writeFile(path, content, { flag: 'wx' })` 단일 호출 | 빈 lock 파일 관측 창 제거(2단계 비원자성 결함) |
| 7 | lock 해제 | 파일 삭제 | 삭제 전 소유 검증([LOCK-004]) | 타 주체가 복구·재획득한 lock 오삭제 방지 |
| 8 | stale global lock 복구 주체 | Reaper 전유 | 모든 프로세스([LOCK-009]) | Reaper 선출 자체가 global lock을 요구하므로 Reaper 전유 시 데드락. API 단독 배포에서도 복구 불가 문제 해소 |
| 9 | stale lock 삭제 방식 | 재확인 후 삭제 | 원자적 rename 경유([LOCK-010]) | check-then-delete race로 인한 살아있는 lock 오삭제 방지 |
| 10 | `jobs.json` 저장 | `node-json-db` save | 임시 파일 + 원자적 rename | 저장 중 crash 시 단일 공유 파일 손상 방지 |
| 11 | Reaper 오판 방지 | worker registry 부재만으로 판정 | `GLOBAL_LOCK_ORPHAN_MIN_MS` 최소 경과 조건 추가([RPR-012] ①) | 신규 Worker의 등록용 첫 lock(아직 registry 미등록)을 오판·삭제하는 결함 보정 |
| 12 | Reaper 자격 재검증 시점 | cleanup 실행 직전 | 개별 조치의 임계 구역 내부([RPR-003]) | 긴 cleanup run 중 Reaper 교체 시 이중 Reaper 동작 방지 |
| 13 | 정상 종료 시 보유 Job | "안전하게 완료하거나 롤백" | 항상 `create` 롤백([WRK-004]) | 비결정적 규칙은 테스트 불가 |
| 14 | 빈/파싱불가 lock 처리 | §17에 보조 정보로만 언급 | [RPR-011]에 mtime 기준 규칙로 명세화 | 판정 불능으로 인한 영구 잔존/오삭제 방지 |
| 15 | pending-무lock Job | 규칙 없음 | [RPR-013] 신설 | 복구 경로 부재 시 영구 pending 고착(샘플 데이터 포함) |
| 16 | storage 경로 | 절대 경로 전달 필수 | 상대 경로는 프로젝트 루트 기준 해석 | `npm install` 후 무설정 실행([RUN-003])과의 정합 |
| 17 | 생존 Worker 오판 방어 | 규칙 없음 | Worker self-fencing([WRK-012]) | lock 장애·경합 기아로 heartbeat를 기록하지 못한 생존 Worker의 커밋을 차단. (2라운드의 Reaper 쪽 유예 규칙은 부록 A-1에서 철회) |
| 18 | stale lock 회수 직렬화 | 없음 | rename 기반 배타 이동([LOCK-010] 2단계) | 다중 프로세스 동시 회수를 파일시스템 원자성으로 직렬화. (2라운드의 reap-mutex는 부록 A-1에서 철회) |
| 19 | lock 정상 해제 | 파일 삭제 | rename 경유 원자 해제([LOCK-004]) | 검증(read)과 삭제(unlink) 사이 TOCTOU 제거 |
| 20 | 부트스트랩 초기화 | 없음 | `wx` 생성 + 임계 구역 키 보정([RUN-004]) | 동시 기동 시 라이브 데이터 덮어쓰기 방지 |
| 21 | 저장 임시 파일 | 미규정 | Process ID+난수 포함 파일명([LOCK-005]) | 프로세스 간 임시 파일 충돌로 인한 부분 쓰기 rename 방지 |
| 22 | `node-json-db` 저장 경로 | 자체 save | 파싱·조작에만 사용, persist는 원자적 rename으로 자체 수행 | 기술 스택 요건과 crash-safety 양립 |
| 23 | `:id` 검증 범위 | GET만 언급 | `:id` 라우트 전체([API-040]) | PATCH의 형식 오류 응답 결정성 |
| 24 | lock 복원 방식 | 없음 | no-replace 복원(`fs.link`, [LOCK-011]) | `fs.rename`은 목적지 존재 시 조용히 덮어쓰므로 살아있는 lock 파괴 가능 — 도달 불가능한 `EEXIST` 가드 대체 |

### 부록 A-1. 외부 적대적 검증(5·6차) 반영 — reap-mutex 철회와 self-fencing 전환

PR #1의 외부 검증에서 critical 3 / high 6 / medium 5 / low 1 = 15건이 보고되었다. 이 중 5건(F4·F5·F12·F13·F14)이 **2라운드에서 도입한 reap-mutex 자체의 결함**이었다. 개별 패치 대신 해당 장치를 철회하고, 안전성의 근거를 Reaper 쪽 heuristic에서 Worker 쪽 불변식으로 옮겼다.

| 발견 | 심각도 | 조치 |
|---|---|---|
| F1 lock 스캔 패턴이 `jobs-global-lock.json`과 매칭 | critical | [LOCK-000] 신설 — 경로·파일명 규칙 확정, per-job 스캔을 UUID 패턴으로 제한, 예약 파일명 제외 |
| F2 [RPR-011]에 최소 경과 가드 없음 | critical | [RPR-011]에 `preemptedAt > WORKER_DELETE_AFTER_MS` 조건 추가 ([RPR-012]①과 대칭) |
| F11 `writeFile(wx)`는 create+content 원자성 없음 | critical | [LOCK-003] 문구 정정(`open(wx)`+write+fsync), [LOCK-003-a] 신설 — 빈·부분 lock 회수를 **모든 lock 종류**에 공통 적용 |
| F3 경합 기아로 생존 Worker 오판 | high | [WRK-012] self-fencing 신설, [LOCK-008]에 지터 추가 |
| F4 reap-mutex 7단계 소유 검증 없음 + 경계값 충돌 | high | **reap-mutex 제거** ([LOCK-010] 재작성) |
| F5 누출된 reap-mutex로 Reaper 영구 정지 | high | **reap-mutex 제거** — 잔존물은 `*.stale-*` 파일뿐이며 [RPR-011]이 청소 |
| F6 [LOCK-004]가 소유 검증 전에 rename | high | [LOCK-004] 1단계에 canonical 선행 읽기 추가 — 비소유자 파괴 경로 제거 |
| F12 stale reap-mutex의 `read → unlink → wx` race | high | **reap-mutex 제거** + [LOCK-010]에서 plain unlink 금지, rename만 사용 |
| F13 self-owned mutex 예외로 중첩 cleanup 우회 | high | 유예 규칙 삭제 + [RPR-004] 프로세스 로컬 `isReaping` guard 신설 |
| F7 소유자 생존 + hang 시 `pending` 무제한 | medium | [WRK-026] tick 상한, [RPR-014] 처리 lease 신설 |
| F8 cross-process 설정 불변식 미검증 | medium | [CFG-002] 신설 + [RUN-004] 4단계 fingerprint 검증 |
| F9 `?status=` 정규화·validation 순서 미규정 | medium | [API-030] 처리 순서 3단계 고정, [API-032] 표에 해당 행 추가 |
| F14 early-exit에서 mutex 누출 | medium | **reap-mutex 제거**로 소멸 |
| F15 shutdown이 in-flight callback을 drain하지 않음 | medium | [WRK-004] 재작성 — drain + 임계 구역 내 `isShuttingDown` 재확인 |
| F10 `JOB_PROCESSING_MS == CONSUME_INTERVAL_MS` | low | 기본값 30,000ms로 하향, [DOC-002] 신설(타임라인 + 빠른 확인 env) |

`REAP_MUTEX_STALE_MS`와 `reaper.lastGlobalLockReapAt`은 제거되었고, `PARTIAL_LOCK_STALE_MS`·`CONSUME_TIMEOUT_MS`·`JOB_LEASE_MS`·`SHUTDOWN_DRAIN_MS`·`config.fingerprint`가 추가되었다.

## 부록 B. 초기설계 대비 확정 사항

`docs/초기설계..md`와 설계 문서가 다른 부분은 설계 문서(및 본 명세)를 따른다.

| 항목 | 초기설계 | 확정 |
|---|---|---|
| `pending` 의미 | 처리 대기중 | **처리 중(선점됨)** — README에 해석 명시 |
| POST 성공 상태 | 200 | **201 Created** (HTTP 시맨틱) |
| job lock 획득 실패 시 | 1분 대기 후 재시도 | **다음 후보 즉시 시도** |
| global lock 경합(API) | 삭제 대기만 정의 | 1초 간격 재시도, 누적 5초 초과 시 503 |

## 부록 C. 과제 해석 사항 (README 반영 대상)

1. 과제 예시의 초기 상태는 `pending`이지만, 본 설계는 `create`(대기) → `pending`(처리 중) → `done`(완료) 3단계 상태 머신을 사용한다. 스키마 자유 설계 허용 범위 내의 결정이다.
2. "제목/상태로 검색"은 `title`·`status` 쿼리 파라미터로 구현하고, 설계 확장으로 `description`도 지원한다.
3. 처리 주기(1분)와 한 번에 처리할 단위(Worker당 1건)는 과제가 허용한 자유 가정이다.
4. 응답 본문에 `status`(HTTP 코드 미러링)와 `result`(성공/사유)를 두는 형식은 자유 설계 항목이다.
5. **스케줄러는 별도 Worker 프로세스로 분리 실행**한다(`start:api` / `start:worker`). API만 실행하면 작업 처리가 일어나지 않으며, 처리 확인에는 두 프로세스의 동시 기동이 필요하다. API·Worker 모두 다중 인스턴스 실행을 지원하기 위한 결정이다.
