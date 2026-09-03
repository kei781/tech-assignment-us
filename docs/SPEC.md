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
  "reaper": { "workerId": null, "lastGlobalLockReapAt": null }
}
```

- `reaper.lastGlobalLockReapAt`: stale global lock이 마지막으로 강제 제거된 시각([LOCK-009]). 복구 유예([RPR-010])의 판단 기준.

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

> **[DATA-004]** 저장소에는 조회 동작 확인용 **샘플 데이터가 포함된 `data/jobs.json`을 커밋**한다. 샘플에는 `create`, `pending`, `done` 상태의 Job이 최소 1건씩 포함된다. 샘플의 `pending` Job은 per-job lock 없이 커밋되므로, Worker 기동 시 [RPR-013]에 의해 `create`로 복구된 뒤 정상 처리된다.

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

- `ownerType`은 `"api"` 또는 `"worker"`. API 프로세스는 `workers` 레지스트리에 등록되지 않으므로, stale 판정 시 구분에 사용한다.

> **[LOCK-003]** 두 lock 모두 **생성과 내용 기록을 단일 원자 호출**로 수행한다: `fs.writeFile(path, content, { flag: 'wx' })`. 성공 시 소유권 획득, `EEXIST` 시 획득 실패로 처리한다. "존재 확인 후 쓰기" 방식과 "빈 파일 생성 후 내용 기록" 2단계 방식은 금지한다.

> **[LOCK-004]** 정상 해제는 소유자만 수행하며, 원자성을 위해 rename을 경유한다: ① `rename(lockPath, lockPath + '.release-' + myProcessId)` 시도 — `ENOENT`면 lock이 이미 사라진 것이므로 오류를 로깅하고 중단. ② rename된 파일을 읽어 `preemption`이 자신의 Process ID와 일치하면 삭제. ③ 일치하지 않으면(다른 주체가 복구·재획득한 lock을 잡은 것) 원래 경로로 되돌리고 오류를 로깅한다.

> **[LOCK-005]** 모든 `jobs.json` 변경은 다음 순서를 지킨다: `global lock 획득 → jobs.json을 디스크에서 reload → 조건 재검증 → 변경 → 저장 → global lock 해제`. `node-json-db` 인메모리 캐시로 덮어쓰는 것을 금지한다(획득 후 reload 필수).
>
> **저장은 임시 파일에 기록한 뒤 원자적 rename으로 `jobs.json`을 교체**한다. 저장 도중 crash가 나도 기존 파일이 손상되지 않아야 한다. 임시 파일명에는 **Process ID와 난수를 포함**하여 프로세스 간 충돌을 방지한다(예: `jobs.json.<processId>.<random>.tmp`).
>
> `node-json-db`는 데이터 파싱·조작·reload에 사용하되, 디스크 저장은 위 원자적 persist로 수행한다(자체 save 경로의 비원자성 우회 — README에 사유 기재).

> **[LOCK-006]** 일관된 snapshot이 필요한 읽기(목록/검색/단건 조회, Worker 후보 조회)도 동일한 global lock 임계 구역에서 수행한다. **예외**: [LOCK-009]/[RPR-012]의 stale 판정을 위한 lock 파일·`jobs.json` 읽기는 global lock 없이 수행한다(판정 대상이 global lock 자신이므로).

> **[LOCK-007]** 잠금 획득 순서는 **per-job lock → global lock**이다. global lock을 보유한 채 per-job lock을 획득하지 않는다. global lock을 보유한 채 장시간 처리·sleep을 하지 않는다.

> **[LOCK-008]** global lock 경합 시: 모든 프로세스는 `GLOBAL_LOCK_RETRY_MS`(기본 1,000ms) 간격으로 재시도한다. Worker는 무기한 재시도하고, API는 누적 대기가 `GLOBAL_LOCK_API_WAIT_MS`(기본 5,000ms)를 초과하면 `503 Service Unavailable`을 반환한다.

> **[LOCK-009]** (stale global lock 복구 — 모든 프로세스) global lock 획득 시도 중 기존 lock 파일의 `preemptedAt`이 `GLOBAL_LOCK_STALE_AFTER_MS`(기본 300,000ms)를 초과했다면, **API·Worker 어떤 프로세스든** [LOCK-010] 절차로 해당 lock을 제거한 뒤 획득을 재시도할 수 있다. Reaper가 없는 배포(API 단독 실행)에서도 영구 정지가 발생하지 않기 위한 규칙이다.
>
> stale global lock을 제거한 프로세스는 **직후 자신이 진입하는 첫 global lock 임계 구역에서 `reaper.lastGlobalLockReapAt = now`를 기록**해야 한다. 이는 복구 유예([RPR-010])의 지속적 트리거가 된다.

> **[LOCK-010]** (stale lock 안전 삭제 절차) stale로 판정한 lock의 삭제는 다음 순서로 수행한다:
>
> 1. **reap-mutex 획득**: `locks/reap-mutex.json`을 [LOCK-003] 방식(`wx`, 내용: `preemption`, `preemptedAt`)으로 생성한다. `EEXIST`면 다른 프로세스가 reaping 중이므로 중단한다. 단, 기존 reap-mutex의 `preemptedAt`(파싱 불가 시 파일 mtime)이 `REAP_MUTEX_STALE_MS`(기본 60,000ms)를 초과했으면 직접 삭제 후 재시도할 수 있다(reap-mutex는 ms 단위로만 보유되므로).
> 2. **삭제 직전 재판정**: 대상 lock 파일을 다시 읽어 stale 조건이 여전히 성립하는지 확인한다. 성립하지 않으면(그 사이 새 lock으로 교체됨) 중단한다. 판정 근거(`preemption`, `preemptedAt`)를 기록한다.
> 3. `rename(lockPath, lockPath + '.reaping-' + myProcessId)`를 시도한다. 실패(`ENOENT` 등)하면 중단한다.
> 4. rename된 파일을 다시 읽어 2의 판정 근거와 **`preemption`·`preemptedAt`이 모두 동일**한지 확인한다.
> 5. 동일하면 삭제한다. 다르면 원래 경로로 rename을 되돌린다. 되돌리기가 `EEXIST`로 실패하면 rename된 파일을 삭제하고 경고를 로깅한다(이 경로는 reap-mutex 직렬화 하에서는 프로세스 정지 상황에서만 도달 — §6 알려진 한계).
> 6. reap-mutex를 삭제한다.

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

> **[API-030]** Query parameter: `title`, `description`, `status` — **셋 중 하나 이상 필수**. trim 후 빈 문자열인 파라미터는 **미입력으로 간주**한다(예: `?title=`은 title 미입력, `?title=&status=done`은 status만 입력한 것).
>
> 과제 원문은 "제목/상태로 검색"을 요구한다. 설계 문서의 `title`/`description`에 **`status`를 추가**하여 과제 요구를 충족한다.

> **[API-031]** 매칭 규칙:
> - `title`, `description`: **대소문자 구분 없는 부분 일치**
> - `status`: enum 정확 일치 (`create` | `pending` | `done`). 그 외 값은 `400`
> - 복수 조건은 **AND** 결합
> - 결과 목록 정렬은 [API-020]과 동일

> **[API-032]** 응답:

| 상황 | HTTP 상태 | `result` | `list` |
|---|---:|---|---|
| 검색 성공(1건 이상) | 200 | `success` | 매칭된 Job 배열 |
| 검색 결과 없음 | 200 | `데이터가 존재하지 않습니다.` | `[]` |
| 유효 조건 없음(전부 미입력) | 400 | `title, description, status 중 하나 이상을 입력하여 주세요.` | 없음 |
| `status`에 잘못된 값 | 400 | 유효성 검사 사유 | 없음 |

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

> **[API-053]** 거부 사유 판정 우선순위: ① Job 존재 여부(404) → ② `done`(409, 완료 메시지) → ③ `pending` 또는 per-job lock 존재(409, 처리중 메시지). `done`이면서 lock 파일이 아직 남아 있는 경우([WRK-024]의 lock 삭제 전 시간창) 완료 메시지가 우선한다.

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

> **[WRK-004]** 정상 종료(`SIGINT`/`SIGTERM`/shutdown hook) 시: ① 새 스케줄 실행 중지 → ② 보유 중인 `pending` Job을 **항상 `create`로 롤백** → ③ 보유한 per-job lock을 [LOCK-004]에 따라 삭제 → ④ `workers[workerId]` 삭제 → ⑤ 자신이 Reaper면 `reaper.workerId` 초기화.

### 5.2 Heartbeat

> **[WRK-010]** 1분마다 [LOCK-005] 임계 구역에서 `workers[workerId].heartbeatAt = now`로 갱신한다.

> **[WRK-011]** 시간 기준(§7과 연동): Reaper 사망 판단 5분 초과, stale worker 삭제 6분 이상. 1분의 차이는 clock drift·스케줄 지연에 대한 safety margin이다.

### 5.3 Consume flow

> **[WRK-020]** 후보 조회: [LOCK-006] snapshot에서 `status === "create"`인 Job을 `createdAt` ASC, 동률 시 `id` ASC로 정렬한다.

> **[WRK-021]** Claim 절차 (후보별):
> 1. `{jobId}-lock.json`을 [LOCK-003]에 따라 내용(`preemption = workerId`, `preemptedAt = now`)과 함께 단일 호출로 생성 시도. `EEXIST`면 **즉시 다음 후보로 이동**(대기 금지).
> 2. [LOCK-005] 임계 구역에서 해당 Job이 여전히 `create`인지 재검증.
> 3. `create`가 아니면 per-job lock을 [LOCK-004]에 따라 삭제 후 다음 후보로 이동.
> 4. `create`면 `status = "pending"`, `updatedAt = now`로 저장하고 임계 구역을 빠져나온 뒤 처리를 시작한다.

> **[WRK-022]** 다음 경우에만 다음 tick까지 대기한다: `create` Job이 없음 / 모든 후보의 lock 획득 실패 / 재검증 결과 모든 후보가 `create`가 아님.

> **[WRK-023]** 처리: 기본 `JOB_PROCESSING_MS`(기본 60,000ms) 동안 수행하는 것으로 간주한다(별도 비즈니스 로직 없음).

> **[WRK-024]** 완료 절차: [LOCK-005] 임계 구역에서 ① `status === "pending"` 재확인, ② per-job lock의 `preemption === workerId` 재확인 → 모두 만족 시 `status = "done"`, `updatedAt = now` 저장 → 임계 구역 종료 후 per-job lock을 [LOCK-004]에 따라 삭제. 소유권 검증 실패 시 `done`으로 **덮어쓰지 않고** 오류를 로깅하며, [LOCK-004] 검증을 통과하는 lock만 정리한다.

> **[WRK-025]** 처리 중 예외 발생 시(프로세스 생존): [LOCK-005] 임계 구역에서 소유권 확인 후 자신이 소유한 `pending` Job을 `create`로 롤백하고 per-job lock을 [LOCK-004]에 따라 삭제한다.

### 5.4 Reaper 선출

> **[RPR-001]** 각 Worker는 시작 `REAPER_INITIAL_DELAY_MS`(기본 60,000ms) 후부터 `REAPER_CHECK_INTERVAL_MS`마다 Reaper 상태를 확인한다. 다음 두 조건을 모두 만족하면 현 Reaper를 유지한다: `reaper.workerId`가 `workers`에 존재 AND 해당 heartbeat가 5분 이내.

> **[RPR-002]** Reaper가 없거나 stale이면: [LOCK-005] 임계 구역에서 최신 상태 재확인 후 `reaper.workerId = 내 workerId` 저장 → **global lock을 해제한 상태로** `REAPER_ELECTION_GRACE_MS`(기본 60,000ms) 대기 → 별도 임계 구역에서 재조회하여 여전히 자신의 ID면 Reaper 역할 시작 (eventual leader election).

> **[RPR-003]** Reaper 자격 재검증은 cleanup run 시작 시점이 아니라 **개별 복구 조치를 수행하는 global lock 임계 구역 내부**(reload 후)에서 수행한다. `reaper.workerId !== workerId`면 해당 조치와 남은 cleanup run을 즉시 중단한다. **예외**: [RPR-012]의 stale global lock 삭제는 임계 구역 없이 수행되므로 자격 재검증은 lock-free 읽기로 대체하며, 다중 실행 안전성은 [LOCK-010]의 reap-mutex와 원자적 rename이 보장한다.

### 5.5 Reaper cleanup

> **[RPR-010]** Stale worker 정리: `heartbeatAt`이 `WORKER_DELETE_AFTER_MS`(기본 6분) 이상 갱신되지 않은 Worker를 `workers`에서 삭제한다. 자신의 heartbeat가 `REAPER_STALE_AFTER_MS`(기본 5분)를 초과해 stale이면 cleanup을 진행하지 않는다.
>
> **유예 규칙**: `reaper.lastGlobalLockReapAt`이 존재하고 `now - lastGlobalLockReapAt < 2 × HEARTBEAT_INTERVAL_MS`인 동안은 stale worker 삭제와 orphan lock 복구([RPR-011])를 유예한다. stale global lock은 어떤 프로세스든 제거할 수 있고([LOCK-009]) 제거 사실이 `lastGlobalLockReapAt`으로 영속화되므로, 유예는 삭제 주체·Reaper 교체와 무관하게 동작한다. 장기 global lock 장애 동안 heartbeat를 갱신하지 못한 **생존** Worker가 다시 heartbeat를 기록할 시간을 보장하기 위함이다.

> **[RPR-011]** Orphan per-job lock 복구: lock의 `preemption`이 `workers`에 없으면 orphan으로 판단한다.
>
> - 복구 절차: [LOCK-005] 임계 구역에서 orphan 여부 재검증 → Job이 `pending`이면 `create`로 롤백(`updatedAt = now`), Job이 `done`이거나 존재하지 않으면 상태 변경 없음 → 임계 구역 종료 후 lock 파일 삭제.
> - **lock 파일 삭제는 [LOCK-010]의 안전 삭제 절차(판정 근거 동일성 재확인)를 따른다.** 판정 시점과 내용이 달라졌으면(다른 Worker가 재획득) 삭제하지 않는다.
> - 내용이 비었거나 파싱 불가한 lock 파일은 파일 mtime이 `REAPER_STALE_AFTER_MS`(기본 5분)를 경과하기 전에는 건드리지 않고, 경과 후 orphan으로 간주해 삭제한다.
> - 살아 있는 Worker의 lock은 삭제하지 않는다.
> - lock 스캔은 정확히 `{jobId}-lock.json` 패턴의 파일만 대상으로 한다. `*.reaping-*`, `*.release-*`, `*.tmp` 등 절차상 잔존 가능한 파일은 lock으로 취급하지 않으며, mtime이 `REAPER_STALE_AFTER_MS`를 경과한 잔존 파일은 Reaper가 삭제한다.

> **[RPR-012]** Stale global lock 복구: `jobs-global-lock.json`이 다음 중 하나면 stale 후보다.
>
> - ① `ownerType === "worker"`이고 `preemption`이 `workers`에 없으며, **`preemptedAt`이 `GLOBAL_LOCK_ORPHAN_MIN_MS`(기본 180,000ms)를 경과**했다. (최소 경과 조건이 없으면 신규 Worker가 자기 등록을 위해 잡은 첫 lock — 아직 `workers`에 미등록 상태 — 을 오판한다.)
> - ② `preemptedAt`이 `GLOBAL_LOCK_STALE_AFTER_MS`(기본 5분)를 초과했다. (API 소유 lock은 ②만 적용)
>
> 판정을 위한 읽기는 [LOCK-006]의 예외에 따라 lock-free로 수행하고, 삭제는 [LOCK-010] 절차를 따른다. [LOCK-009]에 따라 ②의 timeout 기반 복구는 Reaper가 아닌 프로세스도 수행할 수 있다.

> **[RPR-013]** Pending-무lock 복구: `status === "pending"`인데 per-job lock 파일이 존재하지 않는 Job은, `updatedAt`이 `REAPER_STALE_AFTER_MS`(기본 5분)를 초과했다면 [LOCK-005] 임계 구역에서 `create`로 롤백한다(`updatedAt = now`). 이 상태는 정상 흐름에서는 발생하지 않지만, 장애 조합·샘플 데이터([DATA-004])로 도달할 수 있다.

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
| **[CON-009]** | lock 해제·복구 삭제 | 소유 검증([LOCK-004]) 또는 안전 삭제 절차([LOCK-010]) 필수 |

### 알려진 한계 (README 기재 대상)

파일 기반 잠금에는 fencing token이 없으므로, 극단적인 상황에서 이중 소유를 **완전히** 배제할 수는 없다. 구체적으로:

- lock 소유자가 stale timeout(`GLOBAL_LOCK_STALE_AFTER_MS` 5분, 등록용 lock은 `GLOBAL_LOCK_ORPHAN_MIN_MS` 3분)을 넘겨 정지했다가 살아나는 GC pause·컨테이너 throttling.
- [LOCK-010] 절차 중간(재판정과 rename 사이 등)에 reaping 프로세스가 장시간 정지하는 경우.
- reap-mutex 자체가 stale(`REAP_MUTEX_STALE_MS` 60초 초과)로 판정되어 직접 삭제되는 경로 — reap-mutex는 ms 단위로만 보유되므로 실질 위험은 극히 작다.

본 명세는 reap 직렬화([LOCK-010] reap-mutex), 삭제 직전 재판정, rename 원자화([LOCK-004]/[LOCK-010]), 최소 경과 시간([RPR-012] ①), 복구 유예 영속화([RPR-010]), 원자적 저장([LOCK-005])으로 위험 창을 ms 수준까지 최소화한다. 강한 보장이 필요하면 DB row lock·전용 queue로 이전한다.

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
| `REAP_MUTEX_STALE_MS` | 60,000 |
| `JOB_PROCESSING_MS` | 60,000 |

- 제약: `WORKER_DELETE_AFTER_MS > GLOBAL_LOCK_STALE_AFTER_MS`를 유지해야 하며, global lock 장기 장애 시 생존 Worker 보호는 [RPR-010]의 유예 규칙(영속화된 `lastGlobalLockReapAt` + `2 × HEARTBEAT_INTERVAL_MS`)이 담당한다.

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
> 2. `jobs.json`이 없으면 기본 스키마 `{ "jobs": [], "workers": {}, "reaper": { "workerId": null, "lastGlobalLockReapAt": null } }`를 **`wx` flag로 생성**한다. `EEXIST`면 다른 프로세스가 이미 생성한 것이므로 건너뛴다(동시 기동 race 방지 — 일반 write로 기존 데이터를 덮어쓰는 것을 금지).
> 3. 최상위 키 누락 보정은 **global lock 임계 구역에서 reload 후** 수행한다([LOCK-005] 준수).
> 4. `jobs.json`이 파싱 불가(손상)하면 **자동으로 초기화하지 않는다**(데이터 보호 우선). 기동 시 감지하면 FATAL 로깅 후 비-0 종료 코드로 중단하고, 런타임 reload 중 감지하면 해당 API 요청은 `500`, 해당 Worker tick은 중단 처리하며 오류를 로깅한다.

> **[DOC-001]** `README.md`는 다음을 포함한다: ① 설치·실행·테스트 방법(API/Worker 별도 실행법, 다중 인스턴스 실행 예시 포함), ② 모든 엔드포인트의 요청/응답 예시, ③ 설계 코멘트(API 설계, 동시성 처리, 성능, 의도적 결정), ④ [부록 C](#부록-c-과제-해석-사항-readme-반영-대상)의 과제 해석 사항 전부, ⑤ §6의 알려진 한계.

---

## 9. 테스트 요구사항 (Stage 2 기준)

> **[TST-001]** 테스트는 본 명세의 요구사항 ID를 참조한다(예: `describe('[API-030] ...')`).

최소 검증 범위:

| 영역 | 대상 |
|---|---|
| API e2e | §3의 모든 엔드포인트 × 성공/실패 케이스 (상태 코드 + 응답 본문 형식) |
| 로깅 | HTTP 요청 로깅[LOG-003], Worker 처리 로깅[LOG-004] |
| Storage/Lock | [LOCK-003] 원자적 생성, [LOCK-004] 소유 검증 해제, [LOCK-005] reload-후-저장·원자적 저장, [LOCK-008]~[LOCK-010] 대기·503·stale 복구 |
| 초기화 | [RUN-004] 파일/디렉터리 부재·키 누락·손상 각 케이스 |
| Worker consume | [WRK-020]~[WRK-025] claim·완료·롤백·소유권 검증 |
| Reaper | [RPR-001]~[RPR-013] 선출·grace period·각 복구 시나리오(유예 규칙 포함) |
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
| 17 | stale global lock 삭제 후 | 규칙 없음 | 영속화된 복구 유예([RPR-010], `lastGlobalLockReapAt`) | lock 장애로 heartbeat 기아 상태였던 생존 Worker 오판 방지. 삭제 주체·Reaper 교체와 무관하게 동작 |
| 18 | stale lock 삭제 직렬화 | 없음 | reap-mutex + 삭제 직전 재판정([LOCK-010]) | 다중 프로세스 동시 reaping이 살아있는 lock을 rename하는 race 방지 |
| 19 | lock 정상 해제 | 파일 삭제 | rename 경유 원자 해제([LOCK-004]) | 검증(read)과 삭제(unlink) 사이 TOCTOU 제거 |
| 20 | 부트스트랩 초기화 | 없음 | `wx` 생성 + 임계 구역 키 보정([RUN-004]) | 동시 기동 시 라이브 데이터 덮어쓰기 방지 |
| 21 | 저장 임시 파일 | 미규정 | Process ID+난수 포함 파일명([LOCK-005]) | 프로세스 간 임시 파일 충돌로 인한 부분 쓰기 rename 방지 |
| 22 | `node-json-db` 저장 경로 | 자체 save | 파싱·조작에만 사용, persist는 원자적 rename으로 자체 수행 | 기술 스택 요건과 crash-safety 양립 |
| 23 | `:id` 검증 범위 | GET만 언급 | `:id` 라우트 전체([API-040]) | PATCH의 형식 오류 응답 결정성 |

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
