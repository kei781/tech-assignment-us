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
  "version": 42,
  "jobs": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "title": "lorem ipsum",
      "description": "lorem ipsum",
      "status": "create",
      "owner": null,
      "attemptId": null,
      "leaseUntil": null,
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

최상위 키는 `version`, `jobs`, `workers`, `reaper`, `config` 다섯 개다.

- `version`: 단조 증가하는 상태 버전. 모든 커밋은 이 값을 근거로 CAS를 수행한다([LOCK-012]).
- `config.fingerprint`: 프로세스 간 합의가 필요한 타이밍 설정의 해시([CFG-002]). 부트스트랩에서 비교해 불일치를 차단한다.

> **[DATA-002]** Job 필드 규칙:

| 필드 | 형식 | 규칙 |
|---|---|---|
| `id` | UUID v4 | PK. 생성 후 불변 |
| `title` | string | 필수. trim(앞뒤 공백 제거) 후 1자 이상, **최대 1,000자** |
| `description` | string | 필수. trim 후 1자 이상, **최대 2,000자** |
| `status` | enum | `create` \| `pending` \| `done` |
| `owner` | 64-hex \| `null` | 현재 선점한 Worker ID. `pending`일 때만 non-null |
| `attemptId` | 32-hex \| `null` | **이 선점 시도**의 고유 토큰. 같은 Worker의 재시도끼리도 서로 다르다 |
| `leaseUntil` | ISO 8601 UTC \| `null` | 선점 만료 시각. 경과하면 다른 주체가 회수할 수 있다 |
| `createdAt` | ISO 8601 UTC | 생성 시각. 불변 |
| `updatedAt` | ISO 8601 UTC | 마지막 변경 시각 |

- `title`·`description`은 **trim된 값을 저장**하며, 길이 제한도 trim 후 값 기준으로 판정한다.
- `owner`·`attemptId`·`leaseUntil`은 **소유권을 레코드 자체에 담아 CAS로 검증**하기 위한 필드다([LOCK-013]). lock **파일**은 값싼 1차 배타 장치일 뿐이며, 소유권의 근거가 아니다.

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
> | `*.tmp` | CAS 재시도로 버려진 임시 파일 | lock 아님. [RPR-015]가 청소 |
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

> **[LOCK-004]** 정상 해제: canonical 경로의 lock 파일을 읽어 `preemption`이 자신의 Process ID와 **일치할 때만** `unlink`한다. 파일이 없거나 `preemption`이 다르면 아무것도 하지 않고 WARN을 로깅한다.
>
> 읽기와 `unlink` 사이에는 TOCTOU 창이 남는다 — 그 사이 lock이 회수되고 다른 프로세스가 재획득했다면 살아있는 lock을 지울 수 있다. **이 창은 rename·복원 절차로 닫을 수 없다**: 읽어서 판정한 *파일 identity*와 나중에 조작하는 *pathname*을 원자적으로 결속하는 POSIX 연산이 없기 때문이다(자세한 근거는 [LOCK-012] 아래 설명). 따라서 본 명세는 이 창을 **닫으려 하지 않고, 무해하게 만든다**: lock을 빼앗긴 프로세스는 [LOCK-012]의 CAS에서 커밋이 거부되고 재시도하므로, 피해는 지연으로 한정되고 데이터 손상은 발생하지 않는다.

> **[LOCK-005]** 모든 `jobs.json` 변경은 다음 순서를 지킨다: `global lock 획득 → jobs.json을 디스크에서 reload → 조건 재검증 → 변경 → [LOCK-012]의 CAS 커밋 → global lock 해제`. `node-json-db` 인메모리 캐시로 덮어쓰는 것을 금지한다(획득 후 reload 필수).
>
> `node-json-db`는 데이터 파싱·조작·reload에 사용하되, 디스크 게시는 [LOCK-012]로 수행한다(자체 save 경로는 비원자적이며 CAS를 제공하지 않는다 — README에 사유 기재).

> **[LOCK-012]** (버전 CAS 커밋 — **안전성의 근거**) `jobs.json`의 모든 커밋은 읽어들인 `version`을 조건으로 하는 compare-and-swap이다.
>
> 1. 트랜잭션 시작 시 읽은 상태의 `version`을 `N`으로 기억한다.
> 2. 변경된 상태에 `version = N + 1`을 기록하고 유일한 임시 파일(`jobs.json.<processId>.<random>.tmp`)에 완전히 쓴 뒤 `fsync`한다.
> 3. **CAS**: `fs.link(tmpPath, {STORAGE_DIR}/versions/v{N+1}.json)`을 시도한다.
>    - `EEXIST` → 다른 프로세스가 이미 `N+1`을 커밋했다. **자신의 커밋을 버리고** 임시 파일을 삭제한 뒤 트랜잭션 전체를 재시도한다(reload → 조건 재검증 → 재적용).
>    - 성공 → 이 프로세스가 `N → N+1` 전이의 **유일한 승자**다.
> 4. 승자는 `rename(tmpPath, jobsJsonPath)`로 현재 상태를 게시한다. `rename`은 원자적이므로 독자는 항상 완전한 JSON을 읽는다.
> 5. 재시도는 `CAS_MAX_RETRIES`(기본 10)까지 수행하고, 초과하면 API는 `503`, Worker는 해당 tick을 포기하고 오류를 로깅한다.
>
> `fs.link`는 목적지가 존재하면 `EEXIST`로 **실패**하는 원자적 연산이므로, 각 버전 전이마다 승자가 정확히 한 명임이 파일시스템 수준에서 보장된다. 따라서 **global lock이 동시에 두 프로세스에게 보유되는 상황이 발생해도 lost update는 불가능하다** — 패자는 CAS에서 거부되고 최신 상태로 재시도한다.
>
> **왜 잠금만으로는 부족한가**: 이전 판은 "stale lock을 rename으로 배타 이동하므로 회수 경쟁이 직렬화된다"고 규정했으나 이는 성립하지 않는다. 회수자 A가 stale lock을 rename한 직후 canonical 경로는 **비어 있고**, 그 틈에 정상 프로세스 N이 `wx`로 새 lock을 획득하면, 뒤늦게 도착한 회수자 B의 rename은 `ENOENT`가 아니라 **N의 살아있는 lock을 이동시킨다**. 다시 빈 경로에 M이 획득해 N과 M이 동시에 임계 구역을 실행한다. B의 사후 재판정과 복원은 이미 늦으며 복원도 `EEXIST`로 실패한다. 같은 구조가 [LOCK-004]의 해제에도 존재한다. 즉 pathname 기반 `read → 조작` 프로토콜로는 lock 탈취를 배제할 수 없다. 본 명세는 그 사실을 인정하고, **정확성을 잠금의 배타성에서 버전 CAS로 이전**한다.
>
> `versions/` 디렉터리는 [RPR-015]가 정리한다.

> **[LOCK-013]** (선점 토큰) Job의 선점 소유권은 lock 파일이 아니라 **레코드의 `owner`·`attemptId`·`leaseUntil`** 로 표현하며, 모든 전이는 [LOCK-012]의 CAS 안에서 이 세 값을 조건으로 검증한다.
>
> - `attemptId`는 **선점 시도마다 새로 생성**한다. 같은 Worker가 timeout 후 재시도해도 값이 달라진다.
> - 따라서 timeout·정지 후 되살아난 옛 시도는 CAS 조건(`attemptId` 일치)에서 걸러지며, **같은 `workerId`를 쓰는 자신의 다음 시도가 만든 선점을 자기 것으로 오인할 수 없다**.
> - `leaseUntil`이 경과한 선점은 소유자의 생존 여부와 무관하게 회수 대상이다([RPR-011]).

> **[LOCK-006]** 일관된 snapshot이 필요한 읽기(목록/검색/단건 조회, Worker 후보 조회)는 `jobs.json`을 한 번 읽는 것으로 충분하다 — [LOCK-012] 4단계의 원자적 게시 덕분에 항상 완전한 상태를 얻는다. 쓰기를 수반하지 않는 조회는 global lock을 획득하지 않아도 된다.
>
> global lock은 **경합을 줄이기 위한 효율 장치**이며, 정확성은 [LOCK-012]가 담당한다. stale 판정을 위한 lock 파일·`jobs.json` 읽기도 global lock 없이 수행한다.

> **[LOCK-007]** 잠금 획득 순서는 **per-job lock → global lock**이다. global lock을 보유한 채 per-job lock을 획득하지 않는다. global lock을 보유한 채 장시간 처리·sleep을 하지 않는다.

> **[LOCK-008]** global lock 경합 시: 모든 프로세스는 `GLOBAL_LOCK_RETRY_MS`(기본 1,000ms) 간격으로 재시도한다. Worker는 무기한 재시도하고, API는 누적 대기가 `GLOBAL_LOCK_API_WAIT_MS`(기본 5,000ms)를 초과하면 `503 Service Unavailable`을 반환한다.
>
> 파일 잠금 재시도에는 큐도 공정성도 없으므로, 특정 Worker가 오랫동안 `wx` 경쟁에 밀리는 **경합 기아**가 가능하다. 이때 heartbeat 갱신([WRK-010])도 같은 global lock을 필요로 하므로 살아있는 Worker가 자기 생존을 알리지 못하고 Reaper에게 stale로 오판될 수 있다. 이 오판이 데이터 손상으로 이어지지 않게 하는 것은 Reaper 쪽 유예 heuristic이 아니라 **Worker 쪽 self-fencing([WRK-012])** 이다. 기아 자체를 완화하기 위해 재시도 간격에는 `GLOBAL_LOCK_RETRY_MS`의 ±50% 지터를 적용한다.

> **[LOCK-009]** (stale lock 회수 — 모든 프로세스) lock 파일이 아래 조건 중 하나를 만족하면 **API·Worker 어떤 프로세스든** [LOCK-010] 절차로 회수할 수 있다. Reaper가 없는 배포(API 단독 실행)에서도 영구 정지가 발생하지 않기 위한 규칙이다.
>
> | 대상 | 회수 조건 |
> |---|---|
> | global lock | [RPR-012] ①·② |
> | per-job lock | 대응 Job의 `leaseUntil`이 경과했거나 Job이 존재하지 않거나 `status !== "pending"`이면서 lock의 `preemptedAt`이 `JOB_LEASE_MS`를 경과 |
> | 모든 lock | [LOCK-003-a]의 빈·파싱 불가 조건 |
>
> per-job lock의 회수 조건을 `leaseUntil` 기준으로 두는 이유는 [LOCK-013]에 따라 **소유권의 근거가 레코드이기 때문**이다. lock 파일 회수는 재선점을 가능하게 하는 청소 작업이며, 상태 전이 자체는 [RPR-011]이 CAS로 수행한다.

> **[LOCK-010]** (stale lock 회수 절차) 1단계에서 [LOCK-009]의 조건 성립을 확인하고, 2단계에서 `unlink`한다.
>
> 이 절차는 **살아있는 lock을 빼앗을 수 있다** — 판정과 `unlink` 사이에 원 소유자가 해제하고 다른 프로세스가 재획득할 수 있으며, 이 창을 pathname 조작으로 닫을 방법은 없다([LOCK-012] 참조). 이전 판의 rename-to-sideline과 그 이전의 reap-mutex는 모두 이 창을 닫으려는 시도였고, 둘 다 실패했다(각각 "빈 canonical 경로에 새 lock이 생성된 뒤 뒤늦은 rename이 그것을 이동", "mutex 자체의 check-then-delete race").
>
> 본 명세는 이 창을 **무해하게 만드는 쪽**을 택한다: lock을 빼앗긴 프로세스의 커밋은 [LOCK-012]의 CAS 또는 [LOCK-013]의 토큰 검증에서 거부되므로, 결과는 재시도 지연이며 데이터 손상이 아니다. 이 선택 덕분에 rename 왕복·복원 절차·조정용 mutex·잔존 파일 청소 규칙이 모두 불필요해졌다.

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
> per-job lock 생성([WRK-021] 2단계)과 `pending` 커밋(5단계) 사이의 시간차 때문에 상태와 lock 파일을 **모두** 확인한다. 검사와 수정은 [LOCK-005] 임계 구역에서 reload 후 수행하고, [LOCK-012]의 CAS로 커밋한다 — 조건 검사와 커밋 사이에 Worker의 claim이 끼어들면 CAS가 실패하므로 재시도 시 최신 상태로 재검사된다.

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
> 1. 이 시도의 `attemptId`(32-hex 난수)를 생성한다.
> 2. `{jobId}-lock.json`을 [LOCK-003] 절차로 생성 시도하며 내용에 `preemption = workerId`, `attemptId`, `preemptedAt = now`를 기록한다. `EEXIST`면 **즉시 다음 후보로 이동**(대기 금지).
> 3. [LOCK-005] 임계 구역에서 다음 **CAS 조건 전체**를 재검증한다.
>    - Job이 여전히 `status === "create"`이다.
>    - `workers[workerId]`가 존재한다([WRK-012]).
>    - **canonical per-job lock 파일이 여전히 존재하며 그 `attemptId`가 이 시도의 값과 같다.**
> 4. 하나라도 어긋나면 claim을 포기하고, 자신의 lock인 경우에만 [LOCK-004]로 해제한 뒤 다음 후보로 이동한다.
> 5. 모두 만족하면 `status = "pending"`, `owner = workerId`, `attemptId`, `leaseUntil = now + JOB_LEASE_MS`, `updatedAt = now`를 [LOCK-012]의 CAS로 커밋하고, 임계 구역을 빠져나온 뒤 처리를 시작한다.
>
> **3단계의 lock 재검증이 없으면 lock 없이 처리하는 경로가 생긴다**: Worker가 lock을 먼저 잡고 global lock을 기다리는 사이 대기가 `JOB_LEASE_MS`를 넘기면 [RPR-011]이 그 lock을 회수할 수 있다. 이후 Worker가 global lock을 얻었을 때 Job 상태와 registry만 확인하면, 자기 lock이 이미 사라졌다는 사실을 모른 채 `pending`으로 전이시키고 처리를 시작한다. self-fencing 기준(5분)이 lease(2분)보다 길어 정상 구성에서도 재현된다.

> **[WRK-022]** 다음 경우에만 다음 tick까지 대기한다: `create` Job이 없음 / 모든 후보의 lock 획득 실패 / 재검증 결과 모든 후보가 `create`가 아님.

> **[WRK-023]** 처리: 기본 `JOB_PROCESSING_MS`(기본 30,000ms) 동안 수행하는 것으로 간주한다(별도 비즈니스 로직 없음). 기본값은 `CONSUME_INTERVAL_MS`보다 작게 두어 [WRK-003] guard가 매 tick마다 상시 발동하지 않게 한다.

> **[WRK-026]** consume tick 전체에 `CONSUME_TIMEOUT_MS`(기본 `2 × JOB_PROCESSING_MS`) 상한을 둔다. 초과하면 [WRK-025]의 롤백 경로로 보내고, **어떤 경우에도 `isConsuming` guard를 해제**한다.
>
> 상한이 없으면 consume 경로가 예외 없이 hang하는 경우(무기한 global lock 대기, NFS I/O 정지 등) [WRK-025]의 롤백이 발동하지 않고 `isConsuming`도 풀리지 않아, 해당 Worker가 이후 어떤 Job도 처리하지 않고 조용히 풀에서 이탈한다. Worker가 1대인 배포에서는 전체 처리가 멈춘다.
>
> **timeout은 취소가 아니다.** Promise timeout은 진행 중인 retry·I/O·처리 callback을 중단시키지 못하므로, 다음 두 장치를 함께 요구한다.
>
> - **협조적 취소**: consume 시도마다 `AbortSignal`(또는 동등한 취소 플래그)을 만들어 하위 대기 루프(global lock 재시도, `processJob`, lease 갱신)에 전달한다. 각 루프는 매 반복마다 신호를 확인하고 즉시 종료한다.
> - **generation guard**: 되살아난 옛 시도가 어떤 mutation 경로에도 진입하지 못하도록, 모든 커밋은 [LOCK-013]의 `attemptId`를 CAS 조건으로 검증한다([WRK-024]/[WRK-025]/[WRK-027]). 취소가 늦더라도 커밋은 구조적으로 거부된다.

> **[WRK-024]** 완료 절차: [LOCK-005] 임계 구역에서 다음 **CAS 조건 전체**를 재확인한다.
>
> - `status === "pending"`
> - `owner === workerId`
> - **`attemptId === 이 시도의 attemptId`** ([LOCK-013])
> - `leaseUntil > now`
> - `workers[workerId]` 존재 ([WRK-012])
>
> 모두 만족하면 `status = "done"`, `owner/attemptId/leaseUntil = null`, `updatedAt = now`를 [LOCK-012]의 CAS로 커밋하고, 임계 구역 종료 후 [LOCK-004]로 per-job lock을 해제한다. 하나라도 어긋나면 `done`으로 **덮어쓰지 않고** 오류를 로깅하며, 자신의 것으로 검증되는 lock만 정리한다.
>
> **`workerId`만 검사하면 안 되는 이유**: [WRK-026]의 timeout은 진행 중인 I/O·retry를 자동 취소하지 못하므로, timeout된 옛 시도 A가 나중에 되살아날 수 있다. 그 사이 같은 Worker의 다음 시도 B가 같은 Job을 다시 선점했다면, `workerId`만 보는 A는 **B의 선점을 자기 것으로 오인**해 `done`으로 커밋하고 B의 lock까지 해제한다. `attemptId`가 시도마다 달라 이 경로가 차단된다.

> **[WRK-025]** 처리 중 예외 발생 시(프로세스 생존): [LOCK-005] 임계 구역에서 [WRK-024]와 **동일한 CAS 조건**(`owner` + `attemptId` + `leaseUntil` + registry)을 확인한 뒤, 자신의 시도가 소유한 `pending` Job을 `create`로 롤백(`owner/attemptId/leaseUntil = null`)하고 [LOCK-004]로 per-job lock을 해제한다. 조건이 어긋나면 아무것도 되돌리지 않는다.

> **[WRK-027]** Lease 갱신: 처리 중인 Worker는 `LEASE_RENEW_INTERVAL_MS`(기본 `JOB_LEASE_MS / 3`)마다 [WRK-024]와 동일한 CAS 조건 아래 `leaseUntil = now + JOB_LEASE_MS`로 연장한다. 갱신이 실패하면(조건 불일치 = 선점을 잃음) 처리를 즉시 중단하고 커밋을 시도하지 않는다.
>
> 갱신이 없으면 `JOB_PROCESSING_MS`가 `JOB_LEASE_MS`에 가까운 설정에서 정상 처리 중인 Job이 회수된다. 갱신 실패를 중단 신호로 쓰면, 선점을 잃은 Worker가 헛되게 처리를 이어가지 않는다.

### 5.4 Reaper 선출

> **[RPR-001]** 각 Worker는 시작 `REAPER_INITIAL_DELAY_MS`(기본 60,000ms) 후부터 `REAPER_CHECK_INTERVAL_MS`마다 Reaper 상태를 확인한다. 다음 두 조건을 모두 만족하면 현 Reaper를 유지한다: `reaper.workerId`가 `workers`에 존재 AND 해당 heartbeat가 5분 이내.

> **[RPR-002]** Reaper가 없거나 stale이면: [LOCK-005] 임계 구역에서 최신 상태 재확인 후 `reaper.workerId = 내 workerId` 저장 → **global lock을 해제한 상태로** `REAPER_ELECTION_GRACE_MS`(기본 60,000ms) 대기 → 별도 임계 구역에서 재조회하여 여전히 자신의 ID면 Reaper 역할 시작 (eventual leader election).

> **[RPR-003]** Reaper 자격 재검증은 cleanup run 시작 시점이 아니라 **개별 복구 조치를 수행하는 global lock 임계 구역 내부**(reload 후)에서 수행한다. `reaper.workerId !== workerId`면 해당 조치와 남은 cleanup run을 즉시 중단한다. **예외**: [RPR-012]의 stale global lock 회수는 임계 구역 없이 수행되므로 자격 재검증은 lock-free 읽기로 대체하며, 다중 실행 안전성은 [LOCK-010] 2단계의 원자적 rename이 보장한다(회수는 애초에 Reaper 전용 권한이 아니다 — [LOCK-009]).

> **[RPR-004]** cleanup run은 **프로세스 로컬 `isReaping` guard로 직렬화**한다. 이전 run이 끝나지 않았으면 다음 cleanup tick은 건너뛴다. cleanup은 여러 임계 구역과 파일 회수를 포함해 tick 주기보다 오래 걸릴 수 있으므로, guard가 없으면 같은 프로세스에서 두 run이 겹쳐 동일 대상에 대한 이중 복구가 발생한다.

### 5.5 Reaper cleanup

> **[RPR-010]** Stale worker 정리: `heartbeatAt`이 `WORKER_DELETE_AFTER_MS`(기본 6분) 이상 갱신되지 않은 Worker를 `workers`에서 삭제한다. 자신의 heartbeat가 `REAPER_STALE_AFTER_MS`(기본 5분)를 초과해 stale이면 cleanup을 진행하지 않는다([WRK-012] ⓒ에 따라 Reaper 역할도 포기한다).
>
> 이전 판에 있던 "stale global lock 회수 직후 1주기 유예" 규칙은 **삭제**했다. 그 규칙은 회수 사실을 `jobs.json`에 영속화해야 동작했는데, 회수와 기록 사이가 원자적이지 않아 ⓐ 기록 전 crash 시 공백, ⓑ 같은 프로세스의 중첩 cleanup이 자기 소유 mutex 예외로 가드를 우회, ⓒ Reaper 교체 시 유예 인지 실패 등 새 실패 모드를 만들었다. 유예가 보호하려던 대상(경합 기아 상태의 생존 Worker)은 이제 [WRK-012] self-fencing이 **오판 자체와 무관하게** 보호한다.

> **[RPR-011]** 만료 선점 복구 (lease 기반 — 이전 판의 orphan lock 복구와 별도 처리 lease 규칙을 통합):
>
> - **판정**: `status === "pending"`이면서 `leaseUntil <= now`인 Job. 소유자의 `workers` 등록 여부는 판정에 쓰지 않는다 — 소유권의 근거는 레코드이고([LOCK-013]) lease 만료는 그 자체로 충분한 조건이다.
> - **복구**: [LOCK-005] 임계 구역에서 `status === "pending" AND attemptId === 판정 당시의 attemptId AND leaseUntil <= now`를 CAS 조건으로 확인한 뒤 `create`로 롤백하고 `owner/attemptId/leaseUntil = null`, `updatedAt = now`로 커밋한다. 조건이 어긋나면(소유자가 그 사이 lease를 갱신했거나 완료했다면) 아무것도 하지 않는다.
> - **lock 파일 청소**: 롤백 후 대응 per-job lock 파일을 [LOCK-010]으로 회수한다. 회수가 실패하거나 살아있는 lock을 빼앗아도 정확성에는 영향이 없다([LOCK-010] 참조).
> - lock 스캔 대상은 [LOCK-000]의 per-job lock 패턴을 만족하는 파일만이다. 예약 파일명(`jobs-global-lock.json`)은 lock으로 취급하지 않는다.
>
> registry 부재를 판정 조건에서 뺀 것은 의도적이다. registry는 경합 기아·신규 등록 지연으로 살아있는 Worker에게도 일시적으로 비어 있을 수 있어 오판원이 되지만, `leaseUntil`은 소유자가 [WRK-027]로 직접 갱신하는 값이므로 생존의 직접적 증거다.

> **[RPR-015]** 잔존 파일 청소:
>
> - mtime이 `REAPER_STALE_AFTER_MS`를 경과한 `*.tmp` 파일을 `{STORAGE_DIR}`와 `{STORAGE_DIR}/locks/`에서 삭제한다(CAS 재시도로 버려진 임시 파일).
> - `{STORAGE_DIR}/versions/`에서 현재 `version`보다 `VERSION_KEEP_COUNT`(기본 5)개 이상 오래된 버전 파일을 삭제한다. 최신 몇 개를 남기는 이유는 진행 중인 CAS 시도가 참조할 수 있기 때문이다.
> - 청소는 파괴적 복구가 아니므로 [RPR-003]의 자격 재검증과 무관하게 수행할 수 있다.

> **[RPR-012]** Stale global lock 복구: `jobs-global-lock.json`이 다음 중 하나면 stale 후보다.
>
> - ① `ownerType === "worker"`이고 `preemption`이 `workers`에 없으며, **`preemptedAt`이 `GLOBAL_LOCK_ORPHAN_MIN_MS`(기본 180,000ms)를 경과**했다. (최소 경과 조건이 없으면 신규 Worker가 자기 등록을 위해 잡은 첫 lock — 아직 `workers`에 미등록 상태 — 을 오판한다.)
> - ② `preemptedAt`이 `GLOBAL_LOCK_STALE_AFTER_MS`(기본 5분)를 초과했다. (API 소유 lock은 ②만 적용)
> - ③ [LOCK-003-a]의 빈·파싱 불가 조건을 만족한다.
>
> 판정을 위한 읽기는 lock-free로 수행하고, 회수는 [LOCK-010] 절차를 따른다. [LOCK-009]에 따라 ②·③의 복구는 Reaper가 아닌 프로세스도 수행할 수 있다.

> **[RPR-013]** Lease 없는 `pending` 복구: `status === "pending"`인데 `leaseUntil`이 `null`인 Job(수동 편집·샘플 데이터([DATA-004])로 도달)은, `updatedAt`이 `REAPER_STALE_AFTER_MS`를 초과했다면 [RPR-011]과 동일한 CAS 절차로 `create`로 롤백한다.

---

## 6. 동시성 규칙 요약

| ID | 상황 | 규칙 |
|---|---|---|
| **[CON-001]** | 여러 Worker가 같은 Job 조회 | per-job lock exclusive create 성공자만 처리 |
| **[CON-002]** | 특정 Job lock 실패 | 다음 `create` 후보 즉시 시도 |
| **[CON-003]** | `jobs.json` 동시 변경 | 획득 후 reload + **버전 CAS 커밋**([LOCK-012]). global lock은 경합 완화용 |
| **[CON-004]** | claim 전 상태 변경됨 | per-job lock 해제 후 다음 후보 |
| **[CON-005]** | 완료 전 소유권 변경됨 | `owner`+`attemptId`+`leaseUntil` CAS 조건 불일치 → `done` 커밋 거부 |
| **[CON-006]** | 처리 예외(프로세스 생존) | `pending → create` 롤백 |
| **[CON-007]** | Worker 비정상 종료 | Reaper가 orphan lock 삭제 + 롤백 |
| **[CON-008]** | API·Worker 동시 접근 | 모든 쓰기·일관 읽기는 global lock 경유 |
| **[CON-009]** | lock 탈취 발생 | 정확성에 영향 없음 — 빼앗긴 쪽의 커밋은 [LOCK-012] CAS / [LOCK-013] 토큰 검증에서 거부되고 재시도 |
| **[CON-010]** | Reaper가 생존 Worker를 오판 | [WRK-012] self-fencing + CAS로 커밋 차단 — 중복 실행은 허용, 이중 커밋은 불가 |
| **[CON-011]** | 소유자 생존 + 처리 hang | [WRK-026] tick 상한·협조적 취소 + [RPR-011] lease 만료 복구 |
| **[CON-012]** | timeout된 옛 시도가 되살아남 | [LOCK-013] `attemptId` CAS 조건에서 거부 |

### 안전성의 근거

**정확성은 잠금이 아니라 CAS에 있다.** 이것이 7차 검증(F16/F17)을 반영한 이 설계의 핵심 전환이다.

1. **모든 커밋은 버전 CAS다** ([LOCK-012]). `fs.link`는 목적지가 존재하면 원자적으로 `EEXIST` 실패하므로, 각 `version` 전이의 승자가 파일시스템 수준에서 정확히 한 명임이 보장된다. **global lock이 두 프로세스에게 동시 보유되더라도 lost update는 불가능하다.**
2. **소유권은 레코드에 있고 커밋 시점에 검증된다** ([LOCK-013]). `owner` + `attemptId` + `leaseUntil`이 CAS 조건에 포함되므로, 정지 후 부활한 시도·lock을 빼앗긴 시도·timeout된 옛 시도의 커밋은 모두 구조적으로 거부된다.
3. **잠금은 효율 장치로 격하되었다.** global lock과 per-job lock은 경합과 중복 실행을 줄이지만, 정확성의 근거가 아니다. 따라서 lock 탈취를 막기 위한 rename 왕복·복원 절차·조정용 mutex가 모두 불필요하다.

> **pathname 잠금으로 정확성을 얻으려던 세 번의 시도와 그 실패**
>
> | 시도 | 실패 원인 |
> |---|---|
> | reap-mutex로 회수 직렬화 (2라운드) | mutex 자체의 `read → unlink → wx`에 동일한 race. 누출 시 복구 기능 영구 정지 |
> | rename-to-sideline으로 배타 회수 (6차 반영) | A가 rename한 직후 **빈** canonical 경로에 새 lock이 생성되면, 뒤늦은 B의 rename이 그 **살아있는** lock을 이동 |
> | 해제 시 선행 읽기로 TOCTOU 제거 (6차 반영) | 읽기와 rename 사이에 회수·재획득이 끼어들면 타인의 live lock을 이동 |
>
> 공통 원인: **읽어서 판정한 파일 identity와 나중에 조작하는 pathname을 원자적으로 결속하는 POSIX 연산이 없다.** 이 사실을 인정하고 정확성을 CAS로 옮긴 것이 현재 판이다.

### 알려진 한계 (README 기재 대상)

- **중복 실행**: lock 탈취, Reaper 오판, lease 만료 시 같은 Job이 두 번 **실행**될 수 있다. 커밋은 한 번만 성공하므로 상태는 정확하지만, 실제 비즈니스 로직을 넣는다면 idempotency가 필요하다. [WRK-023]의 처리는 외부 부작용이 없어 무해하다.
- **CAS 재시도 소진**: 극심한 경합에서 `CAS_MAX_RETRIES`를 초과하면 API는 `503`, Worker는 tick을 포기한다. 데이터는 안전하지만 처리량이 떨어진다.
- **버전 디렉터리 증가**: `versions/`는 [RPR-015]가 정리하며, Reaper가 없는 배포(API 단독)에서는 누적된다.
- **단일 파일시스템 전제**: 모든 프로세스가 같은 물리 파일시스템을 봐야 하고, `link`·`rename`의 원자성이 보장되어야 한다. 일부 네트워크 파일시스템에서는 성립하지 않는다.

강한 보장과 처리량이 필요하면 PostgreSQL(`SELECT ... FOR UPDATE SKIP LOCKED`)이나 Redis/RabbitMQ 기반 queue로 이전하는 것이 적절하다.

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
| `LEASE_RENEW_INTERVAL_MS` | 40,000 (`JOB_LEASE_MS / 3`) |
| `CAS_MAX_RETRIES` | 10 |
| `VERSION_KEEP_COUNT` | 5 |
| `SHUTDOWN_DRAIN_MS` | 10,000 |
| `BOOTSTRAP_LOCK_STALE_MS` | 600,000 (**고정 상수 — env로 재정의 불가**, [RUN-004] 3단계) |

- 제약: `WORKER_DELETE_AFTER_MS > REAPER_STALE_AFTER_MS`, `JOB_LEASE_MS > CONSUME_TIMEOUT_MS > JOB_PROCESSING_MS`, `JOB_PROCESSING_MS < CONSUME_INTERVAL_MS`, `LEASE_RENEW_INTERVAL_MS < JOB_LEASE_MS / 2`.
- global lock 장기 장애 시 생존 Worker 보호는 Reaper 쪽 유예가 아니라 [WRK-012] self-fencing이 담당하며, 정확성은 [LOCK-012] CAS가 담당한다.

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
├─ jobs.json      # 현재 상태(원자적 게시). 샘플 데이터 포함, 커밋 대상
├─ versions/      # v{N}.json — [LOCK-012] CAS 토큰, 커밋 제외
└─ locks/         # lock 파일 디렉터리, 커밋 제외
```

> **[RUN-002]** 실행 명령: `npm run start:api`, `npm run start:worker`. 각 명령은 중복 실행이 가능해야 하며, 모든 인스턴스는 동일한 storage 디렉터리를 공유한다.

> **[RUN-003]** 기본 Node 환경에서 `npm install` 후 별도 설정 없이 실행 가능해야 한다.

> **[RUN-004]** 부트스트랩 초기화: 프로세스 기동 시 순서대로 —
>
> 1. `STORAGE_DIR`·`locks`·`versions` 디렉터리가 없으면 생성한다(멱등).
> 2. **[CFG-002] fingerprint preflight** — 어떤 lock도 획득하기 **전에** `jobs.json`을 lock-free로 한 번 읽는다([LOCK-012] 4단계의 원자적 게시 덕분에 완전한 상태를 얻는다). `config.fingerprint`가 존재하고 자신의 값과 다르면 **즉시 FATAL 로깅 후 비-0 종료**한다. 이 단계는 lock 획득·회수·CAS 커밋보다 앞서야 한다.
>
>    검증을 lock 획득 **뒤로** 두면 순환이 생긴다: 잘못 설정된 프로세스(예: `GLOBAL_LOCK_STALE_AFTER_MS=1`)가 fingerprint 불일치를 발견하기 전에 자신의 잘못된 timeout으로 정상 프로세스의 live global lock을 stale로 판정해 회수해버린다. 즉 [CFG-002]가 막으려던 손상을 [CFG-002] 검증 과정이 유발한다.
> 3. **부트스트랩 lock 획득에는 환경 변수로 재정의할 수 없는 보수적 상수를 사용한다**: stale 판정 임계값을 `BOOTSTRAP_LOCK_STALE_MS`(고정 600,000ms — 모든 기본 timeout보다 크다)로 두고, 부트스트랩 단계에서는 회수 자체를 생략할 수도 있다(다음 tick에 정상 경로가 회수한다).
> 4. `jobs.json`이 없으면 기본 스키마 `{ "version": 0, "jobs": [], "workers": {}, "reaper": { "workerId": null }, "config": null }`로 생성한다. **임시 파일에 완전히 기록한 뒤 `fs.link(tmpPath, jobsJsonPath)`로 연결**하고 임시 파일을 삭제한다. `EEXIST`면 다른 프로세스가 이미 생성한 것이므로 임시 파일만 삭제하고 건너뛴다.
> 5. 최상위 키 누락 보정과 `config.fingerprint` 최초 기록(2단계에서 `null`이었던 경우)은 [LOCK-005] 임계 구역에서 [LOCK-012] CAS로 수행한다. 이때도 `config.fingerprint`가 그사이 다른 값으로 기록되었으면 FATAL 종료한다(최초 기동 경쟁).
> 6. `jobs.json`이 파싱 불가(손상)하면 **자동으로 초기화하지 않는다**(데이터 보호 우선). 기동 시 감지하면 FATAL 로깅 후 비-0 종료 코드로 중단하고, 런타임 reload 중 감지하면 해당 API 요청은 `500`, 해당 Worker tick은 중단 처리하며 오류를 로깅한다.

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
| Storage/Lock | [LOCK-003] 획득, [LOCK-003-a] 빈·부분 lock 회수(**생성 직후 crash fault injection**), [LOCK-004] 비소유자 해제가 타 lock을 건드리지 않음, [LOCK-005]·[LOCK-012] reload-후-CAS 커밋·`EEXIST` 재시도·원자적 게시, [LOCK-013] 토큰 검증, [LOCK-008]~[LOCK-010] 대기·503·회수 |
| 초기화 | [RUN-004] 파일/디렉터리 부재·키 누락·손상·동시 기동, [CFG-002] fingerprint 불일치 시 FATAL |
| Worker consume | [WRK-020]~[WRK-026] claim·완료·롤백·소유권 검증·tick 상한 |
| Reaper | [RPR-001]~[RPR-015] 선출·grace period·lease 만료 복구·잔존 파일·버전 정리 |
| Shutdown | [WRK-004] in-flight drain: heartbeat / reaper check / claim-직전 consume이 각각 shutdown 이후 상태를 재생성하지 않음(3가지 interleaving) |

> **[TST-003]** 다음 동시성·복구 시나리오는 fake clock과 제어 가능한 lock으로 재현 가능하므로 **명시적 테스트 케이스로 고정**한다.

| # | 시나리오 | 기대 |
|---|---|---|
| 1 | 두 Worker가 같은 Job을 동시에 claim ([CON-001]) | 정확히 1개만 성공 |
| 2 | **두 프로세스가 같은 `version`에서 동시에 커밋** ([LOCK-012]) | 한쪽만 `link` 성공, 패자는 `EEXIST` → reload 후 재시도, **최종 상태에 두 변경이 모두 반영** |
| 3 | **global lock이 두 프로세스에게 동시 보유된 상태로 각각 저장** (탈취 재현) | lost update 없음 — CAS 패자가 재시도 |
| 4 | 비소유자가 [LOCK-004] 해제를 시도 | `preemption` 불일치로 `unlink` 하지 않음 |
| 5 | 경합 기아로 heartbeat 실패 → Reaper가 생존 Worker 삭제 | [WRK-012]에 의해 해당 Worker의 커밋이 거부됨 (`done` 미기록) |
| 6 | `jobs-global-lock.json`이 존재하는 상태에서 Reaper cleanup 실행 | per-job lock으로 오인·회수되지 않음 ([LOCK-000]) |
| 7 | 소유자 생존 + consume hang, `JOB_LEASE_MS` 초과 | [RPR-011]이 Job 회수, hang한 Worker는 `attemptId`·`leaseUntil` 조건으로 커밋 실패 |
| 8 | lock 생성 직후 metadata 기록 전 crash (빈 lock 잔존) | `PARTIAL_LOCK_STALE_MS` 경과 후 회수되어 global lock 교착이 풀림 |
| 9 | **timeout된 시도 A가 되살아남 — 같은 Worker의 시도 B가 이미 재선점** ([CON-012]) | A의 완료·롤백·해제가 모두 거부됨. B의 선점과 lock이 온전히 유지 |
| 10 | **claim 중 global lock 대기가 `JOB_LEASE_MS` 초과 → lock이 회수됨** | [WRK-021] 3단계의 lock `attemptId` 재검증에서 claim 포기, lock 없는 `pending` 전이 없음 |
| 11 | **`GLOBAL_LOCK_STALE_AFTER_MS=1`로 잘못 설정된 프로세스 기동** | lock 획득·회수 **이전** preflight에서 fingerprint 불일치로 FATAL 종료. 정상 프로세스의 live lock 무영향 |
| 12 | 처리 시간이 `JOB_LEASE_MS`를 초과 | [WRK-027] lease 갱신으로 회수되지 않음. 갱신 실패 시 처리 즉시 중단 |

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
| 6 | lock 생성 방식 | `fs.open(path, 'wx')` 후 내용 기록 | 동일(`open(wx)` → write → fsync → close) + [LOCK-003-a] 빈·부분 lock 회수 규칙 | `wx`는 경로의 배타적 **생성**만 보장하고 내용 기록까지 원자적이지 않다. 2라운드에서 `fs.writeFile(..., {flag:'wx'})`를 "단일 원자 호출"로 규정했던 것은 **오류이며 철회**했다(부록 A-2 F11) |
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
| 24 | 커밋 방식 | `node-json-db` save | tmp 기록 → `fs.link`로 버전 CAS → 원자적 게시([LOCK-012]) | 저장 중 crash로 인한 손상과 lock 탈취로 인한 lost update를 함께 차단. (6차 반영판의 `fs.link` 복원 절차 [LOCK-011]은 부록 A-2에서 철회) |

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

### 부록 A-2. 외부 적대적 검증(7차) 반영 — 정확성을 잠금에서 CAS로 이전

7차 검증에서 critical 2 / high 4 / low 1 = 7건이 보고되었다. 두 critical(F16·F17)의 공통 원인은 **읽어서 판정한 파일 identity와 나중에 조작하는 pathname을 원자적으로 결속할 수 없다**는 것으로, 6차 반영판의 rename-to-sideline 회수와 선행 읽기 해제가 모두 이 반례에 걸렸다(재현 결과 첨부됨). 개별 보강으로는 닫히지 않는 문제이므로, **정확성의 근거를 잠금의 배타성에서 버전 CAS로 이전**했다.

| 발견 | 심각도 | 조치 |
|---|---|---|
| F16 rename이 새 소유자의 live lock을 탈취 | critical | **[LOCK-012]** 버전 CAS 커밋 신설 — `fs.link`로 `versions/v{N+1}.json` 생성, `EEXIST`면 재시도. lock 이중 보유에도 lost update 불가. [LOCK-010]은 단순 `unlink`로 축소하고 탈취 가능성을 명시적으로 인정 |
| F17 선행 읽기가 해제 TOCTOU를 막지 못함 | critical | [LOCK-004]를 "검증 후 `unlink`"로 단순화하고, 잔여 창이 무해한 이유를 [LOCK-012]로 근거화. **[LOCK-013]** 선점 토큰(`owner`·`attemptId`·`leaseUntil`)을 레코드에 도입 |
| F18 timeout 후 옛 callback이 다음 시도의 lock을 오인 | high | [LOCK-013] `attemptId`를 시도마다 생성하고 [WRK-024]/[WRK-025]/[WRK-027]의 CAS 조건에 포함. [WRK-026]에 협조적 취소(`AbortSignal`) + generation guard 명시 |
| F19 lease 회수 후 lock 없는 claim 경로 | high | [WRK-021] 3단계에 **canonical lock의 `attemptId` 재검증** 추가 |
| F20 [LOCK-010] 판정 조건에 per-job 회수 조건 누락 | high | [LOCK-009]에 대상별 회수 조건 표를 명시(global / per-job / 공통) |
| F21 fingerprint 검증이 lock 획득 뒤라 순환 | high | [RUN-004] 재작성 — **2단계 lock-free preflight**로 검증을 앞당기고, 3단계 부트스트랩 lock에 env로 못 바꾸는 `BOOTSTRAP_LOCK_STALE_MS` 고정 상수 사용. 최초 생성 경쟁 경로도 정의 |
| F22 [LOCK-003] 변경과 잔존 문구 충돌 | low | [WRK-021] 1~2단계 문구, 부록 A #6, [DATA-001] 최상위 키 설명을 함께 갱신 |

구조 변경 요약: `version`·`owner`·`attemptId`·`leaseUntil` 필드와 `versions/` 디렉터리가 추가되었고, [LOCK-011](복원 절차)·[RPR-014](별도 lease 규칙)·`*.stale-*`/`*.release-*` 잔존 파일 규칙은 **불필요해져 삭제**되었다. [RPR-011]은 lease 기반으로 통합되었고 [RPR-015](잔존 파일·버전 정리)가 신설되었다.

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
