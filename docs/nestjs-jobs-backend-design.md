# NestJS Jobs Backend 설계

## 1. 문서 목적

이 문서는 하나의 저장소에서 다음 두 애플리케이션을 독립적으로 실행하는 Jobs 백엔드의 설계를 정의한다.

- **Queue API**: REST API를 통해 작업을 생성·조회·검색·수정한다.
- **Worker**: 작업을 주기적으로 조회하고, 여러 프로세스 사이에서 중복 처리되지 않도록 선점한 뒤 완료한다.

두 애플리케이션은 각각 여러 프로세스로 실행될 수 있으며, 모든 프로세스는 동일한 `jobs.json`과 잠금 파일 디렉터리를 공유한다.

이 설계에서 실제 비즈니스 작업은 별도로 정의하지 않는다. Worker가 작업을 선점하고 약 1분 동안 처리한 뒤 상태를 완료로 변경하는 과정을 작업 처리로 간주한다.

---

## 2. 핵심 설계 원칙

1. `jobs.json`이 작업, Worker heartbeat, Reaper 정보를 보관하는 단일 데이터 저장소다.
2. `jobs-global-lock.json`이 `jobs.json`의 읽기-수정-쓰기 경쟁과 lost update를 방지한다.
3. `{jobId}-lock.json`이 동일 작업을 여러 Worker가 동시에 처리하지 못하게 한다.
4. 잠금 파일은 반드시 `fs.open(path, 'wx')`로 원자적으로 생성한다.
5. Worker는 `create` 작업을 `createdAt`, `id` 오름차순으로 순회하며 첫 번째로 잠금 획득에 성공한 작업 하나만 처리한다.
6. 한 후보의 잠금 획득에 실패했다고 즉시 대기하지 않는다. 남은 후보를 계속 확인하고, 모든 후보가 실패하거나 후보가 없을 때만 다음 scheduler tick을 기다린다.
7. 모든 `jobs.json` 변경은 global lock 획득 후 디스크에서 최신 데이터를 다시 읽고, 저장을 완료한 뒤 잠금을 해제한다.
8. Worker 장애로 남은 stale registry와 orphan lock은 선출된 Reaper 한 대가 복구한다.

---

## 3. 기술 스택

| 구분 | 기술 |
|---|---|
| 언어 | TypeScript |
| 프레임워크 | NestJS |
| 데이터 저장 | `node-json-db` |
| 스케줄러 | `@nestjs/schedule` |
| 프로세스 간 잠금 | Node.js `fs.open(..., 'wx')` 기반 파일 잠금 |
| 식별자 | Job: UUID v4, Process/Worker: 64자리 hex 문자열 |

Worker ID는 다음과 같이 생성한다.

```ts
randomBytes(32).toString('hex'); // 64 hex characters
```

---

## 4. 전체 아키텍처

```text
                         shared storage directory
                    ┌───────────────────────────────┐
HTTP ──▶ Queue API ─┤ jobs.json                     │
          API #2 ───┤ jobs-global-lock.json         │
                    │ {jobId}-lock.json             │
Worker #1 ──────────┤ {jobId}-lock.json             │
Worker #2 ──────────┤ ...                           │
Worker #3 ──────────┤                               │
                    └───────────────────────────────┘
                              ▲
                              │
                 Worker 중 하나가 Reaper 역할 수행
```

- Queue API는 HTTP 서버로 실행한다.
- Worker는 HTTP 서버가 없는 Nest standalone application context로 실행한다.
- Queue API와 Worker는 같은 repository/storage 모듈을 사용한다.
- 여러 프로세스에서 메모리 mutex는 공유되지 않으므로 파일 기반 잠금을 사용한다.

---

## 5. 상태 정의

| 상태 | 의미 | 허용되는 다음 상태 |
|---|---|---|
| `create` | 생성되었으며 Worker가 아직 선점하지 않은 처리 대기 작업 | `pending` |
| `pending` | Worker가 per-job lock을 획득하여 처리 중인 작업 | `done`, 장애 복구 시 `create` |
| `done` | 처리가 완료된 작업 | 없음 |

```text
create ── Worker claim ──▶ pending ── 처리 완료 ──▶ done
   ▲                          │
   └──── Reaper recovery ─────┘
```

`pending`은 일반적인 명칭과 달리 이 설계에서는 **처리 중**을 의미한다.

---

## 6. 데이터 구조

### 6.1 `jobs.json`

정렬 기준을 안정적으로 적용하기 위해 기존 구조에 `createdAt`을 포함한다.

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
    "0123456789abcdef...64-hex-characters": {
      "heartbeatAt": "2026-09-03T20:01:00.000Z"
    }
  },
  "reaper": {
    "workerId": "0123456789abcdef...64-hex-characters"
  }
}
```

#### Job 필드

| 필드 | 형식 | 규칙 |
|---|---|---|
| `id` | UUID v4 | Primary key, 생성 후 변경하지 않음 |
| `title` | string | 필수, 최대 1,000자 |
| `description` | string | 필수, 최대 2,000자 |
| `status` | enum | `create`, `pending`, `done` |
| `createdAt` | ISO 8601 UTC | 생성 시각, Worker 후보 정렬의 1차 기준 |
| `updatedAt` | ISO 8601 UTC | 마지막 변경 시각 |

#### Worker 및 Reaper 필드

| 필드 | 의미 |
|---|---|
| `workers[workerId].heartbeatAt` | 해당 Worker가 마지막으로 생존을 알린 시각 |
| `reaper.workerId` | 현재 Reaper로 간주되는 Worker ID. 없으면 `null` 또는 빈 값 |

### 6.2 `{jobId}-lock.json`

```json
{
  "preemption": "0123456789abcdef...64-hex-characters",
  "preemptedAt": "2026-09-03T20:00:00.000Z"
}
```

- 파일명: `{jobId}-lock.json`
- `preemption`: 해당 작업을 선점한 Worker ID
- `preemptedAt`: 잠금 획득 시각
- 파일이 존재하는 동안 다른 Worker는 같은 작업을 처리할 수 없다.
- 파일 존재 여부를 먼저 확인한 뒤 일반 쓰기를 하는 방식은 금지한다. 반드시 exclusive create를 사용한다.

### 6.3 `jobs-global-lock.json`

```json
{
  "preemption": "0123456789abcdef...64-hex-characters",
  "ownerType": "worker",
  "preemptedAt": "2026-09-03T20:00:00.000Z"
}
```

- `jobs.json`을 안전하게 읽고 변경하기 위한 짧은 임계 구역 잠금이다.
- `ownerType`은 `api` 또는 `worker`다.
- 모든 Queue API와 Worker 프로세스는 시작할 때 process ID용 64자리 hex 값을 생성한다. Worker는 이 값을 Worker ID로도 사용한다.
- API 프로세스는 `workers` registry에 등록되지 않으므로, global lock 정리 시 `ownerType`을 구분해야 한다.
- lock 경합 시 Worker는 1초 간격으로 재시도한다. API 요청에는 별도의 최대 대기 시간을 두고 초과 시 `503 Service Unavailable`을 반환할 수 있다.

> `ownerType`을 두지 않으면 Reaper가 정상 동작 중인 API 프로세스의 global lock을 "worker 목록에 없는 잠금"으로 오인할 수 있다.

---

## 7. 잠금 규칙

### 7.1 원자적 잠금 생성

두 종류의 잠금 모두 다음 방식으로 생성한다.

```ts
const handle = await fs.open(lockPath, 'wx');
```

- 성공: 현재 프로세스가 잠금 소유권을 얻는다.
- `EEXIST`: 다른 프로세스가 이미 소유하고 있으므로 획득 실패로 처리한다.
- 잠금 파일은 획득한 file handle을 통해 내용을 기록한 뒤 닫는다.
- 정상 해제는 작업 저장이 완료된 다음 lock 파일을 삭제하는 방식으로 수행한다.

### 7.2 Global lock 임계 구역

`jobs.json`에 대한 변경은 반드시 다음 순서를 따른다.

```text
global lock 획득
→ jobs.json을 디스크에서 다시 로드
→ 현재 조건 재검증
→ 데이터 변경
→ jobs.json 저장 완료
→ global lock 해제
```

`node-json-db` 인스턴스가 보유한 오래된 메모리 값으로 덮어쓰지 않도록 **잠금 획득 뒤 reload**가 필수다.

일관된 snapshot이 필요한 읽기도 동일한 repository transaction을 사용한다. 이를 통해 writer가 저장 중인 파일을 읽는 문제를 피한다.

### 7.3 잠금 역할 분리

| 잠금 | 역할 | 일반적인 보유 시간 |
|---|---|---|
| `jobs-global-lock.json` | `jobs.json` 정합성 보호 | 수 ms~수십 ms |
| `{jobId}-lock.json` | 단일 Job 처리 소유권 보호 | 약 1분 |

Global lock을 작업 처리 시간 전체에 걸쳐 보유하지 않는다.

---

## 8. REST API

### 8.1 공통 응답 형식

```json
{
  "status": 200,
  "result": "success"
}
```

목록 응답은 `list`를 추가한다.

```json
{
  "status": 200,
  "result": "success",
  "list": []
}
```

### 8.2 Endpoint 목록

| Method | Path | 설명 | 성공 상태 |
|---|---|---|---|
| `POST` | `/jobs` | 새 작업 생성 | `201 Created` |
| `GET` | `/jobs` | 전체 작업 목록 조회 | `200 OK` |
| `GET` | `/jobs/search` | 제목 또는 설명으로 검색 | `200 OK` |
| `GET` | `/jobs/:id` | 단일 작업 조회 | `200 OK` |
| `PATCH` | `/jobs/:id` | 작업 제목·설명 수정 | `200 OK` |

### 8.3 `POST /jobs`

요청:

```json
{
  "title": "lorem ipsum",
  "description": "lorem ipsum"
}
```

처리 규칙:

1. DTO validation을 수행한다.
2. global lock을 획득한다.
3. `jobs.json`을 reload한다.
4. UUID, `status: "create"`, `createdAt`, `updatedAt`을 채워 저장한다.
5. global lock을 해제한다.

실패 응답:

- 유효하지 않은 입력: `400 Bad Request`
- 저장소 잠금 또는 저장 실패: `500 Internal Server Error` 또는 정책에 따라 `503 Service Unavailable`

### 8.4 `GET /jobs`

- 전체 작업을 반환한다.
- 빈 목록은 오류가 아니며 `200 OK`, `list: []`을 반환한다.

### 8.5 `GET /jobs/search?title=&description=`

- `title`, `description` 중 하나 이상을 반드시 입력한다.
- 두 조건이 모두 있으면 두 조건을 모두 만족하는 방식 또는 하나라도 만족하는 방식 중 하나를 구현 정책으로 고정해야 한다. 이 설계의 기본값은 **AND**다.
- 문자열 검색은 대소문자를 구분하지 않는 부분 일치를 기본값으로 한다.

| 상황 | HTTP 상태 | `result` |
|---|---:|---|
| 검색 성공 | 200 | `success` |
| 검색 결과 없음 | 200 | `데이터가 존재하지 않습니다.` |
| 조건 없음 | 400 | `title 혹은 description은 반드시 입력하여 주세요.` |

검색 결과가 없으면 반드시 `list: []`을 함께 반환한다.

### 8.6 `GET /jobs/:id`

- 존재하는 작업: `200 OK`
- 존재하지 않는 작업: `404 Not Found`, `result: "존재하지 않는 데이터입니다."`

응답 일관성을 위해 단일 작업도 기존 계약을 유지하여 `list: [job]`으로 반환할 수 있다. 신규 계약을 정의할 수 있다면 `job` 필드를 사용하는 편이 더 자연스럽다.

### 8.7 `PATCH /jobs/:id`

요청:

```json
{
  "title": "updated title",
  "description": "updated description"
}
```

수정 가능 조건:

```text
status === create
AND
해당 Job의 per-job lock 파일이 없음
```

처리 중 상태와 잠금 파일을 함께 확인하는 이유는 per-job lock 생성과 `pending` 저장 사이에 짧은 시간차가 있기 때문이다.

| 상황 | HTTP 상태 | `result` |
|---|---:|---|
| 수정 성공 | 200 | `success` |
| Job 없음 | 404 | `존재하지 않는 데이터입니다.` |
| `pending` 또는 job lock 존재 | 409 | `처리중인 프로세스입니다.` |
| `done` | 409 | `이미 완료된 프로세스입니다.` |
| DTO validation 실패 | 400 | 유효성 검사 사유 |

상태와 lock 존재 여부 검사는 global lock 임계 구역에서 최신 데이터를 reload한 뒤 수행한다.

---

## 9. Worker lifecycle

### 9.1 시작

```text
Worker 프로세스 시작
→ 64자리 hex workerId 생성 및 메모리에 보관
→ global lock 획득
→ workers[workerId].heartbeatAt = now 등록
→ global lock 해제
→ heartbeat, consume, reaper scheduler 시작
```

workerId는 프로세스 종료 전까지 변경하지 않는다.

### 9.2 실행 중 scheduler

| 작업 | 주기 | 역할 |
|---|---:|---|
| Heartbeat | 1분 | 자신의 `heartbeatAt` 갱신 |
| Consume | 1분 | 처리 가능한 Job 하나 선점 및 처리 |
| Reaper check | 1분 | Reaper 생존 확인 및 필요 시 선출 시도 |
| Reaper cleanup | 1분 | Reaper인 경우 stale 데이터 복구 |

한 Worker는 한 번에 Job 하나만 처리한다. 이전 consume 실행이 끝나지 않았다면 같은 프로세스의 다음 consume tick은 건너뛴다.

### 9.3 정상 종료

`SIGINT`, `SIGTERM` 또는 Nest shutdown hook에서 다음 순서를 수행한다.

1. 새 scheduler 실행을 중지한다.
2. 보유 중인 Job이 있으면 안전하게 완료하거나 `pending → create`로 롤백한다.
3. 보유한 per-job lock을 해제한다.
4. global lock을 획득해 `workers[workerId]`를 삭제한다.
5. 자신이 Reaper라면 `reaper.workerId`를 비운다.

프로세스 강제 종료로 이 절차를 수행하지 못한 경우 Reaper가 복구한다.

---

## 10. Heartbeat

Worker는 1분마다 다음 transaction을 실행한다.

```text
global lock 획득
→ jobs.json reload
→ workers[workerId].heartbeatAt = now
→ 저장
→ global lock 해제
```

기준 시간은 모든 프로세스에서 ISO 8601 UTC로 기록하고 비교한다.

- Heartbeat 갱신 주기: 1분
- Reaper 사망 판단: 마지막 heartbeat가 5분 초과
- stale worker registry 삭제: 마지막 heartbeat가 6분 이상

5분과 6분 사이의 1분은 clock drift와 scheduler 지연을 위한 safety margin이다.

---

## 11. Reaper 선출

각 Worker는 시작 후 60초부터 1분마다 현재 Reaper를 확인한다.

### 11.1 현재 Reaper가 유효한 경우

다음 두 조건을 모두 만족하면 현재 Reaper를 유지하고 후보 등록을 포기한다.

- `reaper.workerId`가 `workers`에 존재한다.
- 해당 Worker의 heartbeat가 5분 이내다.

### 11.2 Reaper가 없거나 stale인 경우

```text
현재 Reaper 없음 또는 heartbeat 5분 초과
→ global lock 획득
→ 최신 상태 재확인
→ reaper.workerId = 내 workerId 저장
→ global lock 해제
→ 1분의 grace period 대기
→ 다시 조회
→ 여전히 내 ID이면 Reaper 역할 시작
```

여러 Worker가 동시에 후보가 될 수 있으나 마지막으로 저장된 후보만 grace period 후 자신의 ID를 확인할 수 있다. 이는 `node-json-db`에 compare-and-set이 없다는 제약을 반영한 **eventual leader election**이다.

Reaper는 cleanup을 실행하기 직전에도 `reaper.workerId === workerId`를 재검증한다. 더 이상 자신이 Reaper가 아니면 cleanup을 즉시 중단한다.

---

## 12. Reaper cleanup

Reaper는 1분마다 다음 작업을 수행한다.

### 12.1 Stale worker 정리

- `heartbeatAt`이 6분 이상 갱신되지 않은 Worker를 `workers`에서 삭제한다.
- 현재 Reaper 자신의 heartbeat가 stale인 상황에서는 cleanup을 진행하지 않는다.

### 12.2 Orphan per-job lock 복구

각 `{jobId}-lock.json`을 확인하고 `preemption` Worker가 `workers`에 존재하지 않으면 orphan lock으로 판단한다.

```text
orphan job lock 발견
→ global lock 획득
→ jobs.json reload
→ lock owner가 여전히 workers에 없는지 재확인
→ Job이 pending이면 status = create, updatedAt = now
→ jobs.json 저장
→ global lock 해제
→ 해당 per-job lock 삭제
```

- Job이 이미 `done`이면 상태를 롤백하지 않고 남은 lock 파일만 삭제한다.
- Job 자체가 존재하지 않아도 orphan lock 파일을 삭제한다.
- 살아 있는 Worker의 lock은 Reaper가 제거하지 않는다.

### 12.3 Stale global lock 복구

`jobs-global-lock.json`이 존재하면 다음 중 하나에 해당할 때 stale 후보로 본다.

- `ownerType === "worker"`이고 `preemption`이 `workers`에 없다.
- `preemptedAt`이 5분을 초과했다.

Reaper는 metadata를 다시 읽어 동일한 lock인지 확인한 뒤 삭제한다. API 소유 global lock은 worker registry에 없다는 이유만으로 삭제하지 않으며, 5분 timeout만 적용한다.

> Global lock은 정상적으로 수 ms 안에 해제되어야 한다. 5분 timeout은 프로세스 비정상 종료에 대한 최후의 복구 기준이다.

---

## 13. Worker consume flow

### 13.1 전체 흐름

```text
1분 scheduler tick
→ 현재 Worker가 이미 처리 중이면 이번 tick 종료
→ create Job 목록 조회
→ createdAt ASC, id ASC 정렬
→ 첫 후보부터 per-job lock 획득 시도
   ├─ 실패: 다음 후보로 즉시 이동
   └─ 성공: 최신 상태 재검증 후 해당 Job 처리
→ 모든 후보가 실패하거나 목록이 비어 있으면 tick 종료
→ 다음 scheduler tick 대기
```

### 13.2 후보 조회 및 정렬

1. global lock을 통해 일관된 `jobs.json` snapshot을 읽는다.
2. `status === "create"`인 작업만 고른다.
3. `createdAt` 오름차순으로 정렬한다.
4. `createdAt`이 같으면 `id` 오름차순으로 정렬한다.

`id`를 2차 기준으로 사용하면 여러 Worker가 같은 후보 순서를 보더라도 결과가 결정적이다. 실제 중복 처리는 원자적인 per-job lock이 방지한다.

### 13.3 Job claim

각 후보에 대해 다음 순서를 수행한다.

1. `{jobId}-lock.json`을 `fs.open(lockPath, 'wx')`로 생성한다.
2. `EEXIST`이면 다음 후보로 즉시 이동한다.
3. 성공하면 lock에 `preemption = workerId`, `preemptedAt = now`를 기록한다.
4. global lock을 획득하고 `jobs.json`을 reload한다.
5. 해당 Job이 여전히 `create`인지 재검증한다.
6. `create`가 아니면 global lock과 per-job lock을 해제하고 다음 후보로 이동한다.
7. `create`이면 `status = "pending"`, `updatedAt = now`로 변경하고 저장한다.
8. global lock을 해제한 뒤 실제 작업을 수행한다.

per-job lock 획득 뒤 상태를 다시 확인해야 목록 조회와 잠금 획득 사이의 상태 변경을 안전하게 처리할 수 있다.

### 13.4 Job 처리 및 완료

과제의 기본 처리 시간은 1분이다.

```text
Job claim 성공
→ 약 1분 동안 작업 수행
→ global lock 획득
→ jobs.json reload
→ status === pending 재확인
→ per-job lock.preemption === workerId 재확인
→ 조건을 만족하면 status = done, updatedAt = now
→ 저장
→ global lock 해제
→ per-job lock 삭제
```

완료 직전 소유권 검증에 실패하면 다른 주체가 상태를 변경한 것이므로 `done`으로 덮어쓰지 않는다. 오류를 기록하고 자신이 소유한 lock만 안전하게 정리한다.

### 13.5 모든 후보의 잠금 획득 실패

후보가 `job1`, `job2`, `job3`일 때 `job1` 잠금에 실패해도 1분간 대기하지 않는다.

```text
job1 lock 실패 → job2 즉시 시도
job2 lock 실패 → job3 즉시 시도
job3 lock 성공 → job3 처리 후 이번 tick 종료
```

다음 경우에만 다음 scheduler tick까지 기다린다.

- `create` Job이 없다.
- 목록에 있던 모든 Job의 잠금 획득에 실패했다.
- 잠금 획득 뒤 재검증한 모든 Job이 더 이상 `create`가 아니었다.

### 13.6 처리 오류

처리 중 예외가 발생했지만 Worker 프로세스가 살아 있다면 다음과 같이 복구한다.

```text
global lock 획득
→ 최신 Job과 per-job lock 소유권 확인
→ 내가 소유한 pending Job이면 status = create
→ 저장 및 global lock 해제
→ per-job lock 삭제
```

Worker 프로세스 자체가 종료되어 복구 코드를 실행하지 못하면 Reaper가 orphan lock과 `pending` 상태를 복구한다.

### 13.7 의사 코드

```ts
async function consumeOnce(): Promise<void> {
  if (isConsuming) return;
  isConsuming = true;

  try {
    const candidates = await repository.findCreateJobs({
      orderBy: ['createdAt', 'id'],
    });

    for (const job of candidates) {
      const lock = await jobLock.tryAcquire(job.id, workerId);
      if (!lock) continue;

      const claimed = await repository.withGlobalLock(async (db) => {
        const latest = db.jobs.find(({ id }) => id === job.id);
        if (!latest || latest.status !== 'create') return false;

        latest.status = 'pending';
        latest.updatedAt = new Date().toISOString();
        await db.save();
        return true;
      });

      if (!claimed) {
        await lock.release();
        continue;
      }

      await processJob(job.id);
      await completeOnlyIfStillOwned(job.id, workerId);
      await lock.release();
      break;
    }
  } finally {
    isConsuming = false;
  }
}
```

---

## 14. 동시성 및 복구 규칙

| 상황 | 처리 규칙 |
|---|---|
| 여러 Worker가 같은 Job을 조회 | per-job lock의 exclusive create 성공자만 처리 |
| 특정 Job lock 획득 실패 | 다음 `create` Job을 즉시 시도 |
| 모든 Job lock 획득 실패 | 다음 scheduler tick까지 대기 |
| `jobs.json` 동시 변경 | global lock으로 직렬화하고 잠금 후 reload |
| global lock 경합 | Worker는 1초 간격 재시도 |
| claim 전 상태가 변경됨 | per-job lock 해제 후 다음 후보 시도 |
| 완료 전 소유권이 변경됨 | `done`으로 덮어쓰지 않음 |
| 처리 로직 예외 | 소유권이 유지되면 `pending → create` 롤백 |
| Worker 비정상 종료 | Reaper가 orphan lock 삭제 및 `pending → create` 롤백 |
| stale Worker | heartbeat 6분 이상이면 registry에서 삭제 |
| Reaper 비정상 종료 | 다른 Worker가 5분 stale 판단 후 후보 등록, 1분 뒤 재검증 |
| stale global lock | Reaper가 owner 및 5분 timeout을 재검증한 뒤 삭제 |
| 같은 Worker의 scheduler 중첩 | `isConsuming` guard로 후속 tick 건너뜀 |

### 잠금 순서

- Job 처리 경로: **per-job lock → global lock**
- 일반 CRUD/heartbeat/reaper election: **global lock만 사용**
- Reaper는 per-job lock을 별도로 획득한 채 global lock을 기다리지 않는다. orphan 여부를 확인하고 global transaction에서 다시 검증한 뒤 정리한다.
- global lock을 가진 상태에서 장시간 처리하거나 sleep하지 않는다.

---

## 15. 실행 구조

권장 monorepo 구조:

```text
src/
├─ apps/
│  ├─ api/
│  │  ├─ api.module.ts
│  │  └─ main.ts
│  └─ worker/
│     ├─ worker.module.ts
│     └─ main.ts
├─ jobs/
│  ├─ jobs.controller.ts
│  ├─ jobs.service.ts
│  └─ jobs.repository.ts
├─ worker/
│  ├─ consume.service.ts
│  ├─ heartbeat.service.ts
│  └─ reaper.service.ts
├─ storage/
│  ├─ json-db.service.ts
│  ├─ global-lock.service.ts
│  └─ job-lock.service.ts
└─ common/
   ├─ dto/
   ├─ errors/
   └─ time/
data/
├─ jobs.json
└─ locks/
   ├─ jobs-global-lock.json
   └─ {jobId}-lock.json
```

API bootstrap:

```ts
await NestFactory.create(ApiModule);
```

Worker bootstrap:

```ts
await NestFactory.createApplicationContext(WorkerModule);
```

권장 실행 명령:

```bash
npm run start:api
npm run start:worker
```

여러 인스턴스 실행 예시:

```bash
# 별도 터미널 또는 프로세스 관리자에서 실행
npm run start:api
npm run start:api
npm run start:worker
npm run start:worker
npm run start:worker
```

모든 인스턴스는 환경 변수로 동일한 절대 경로의 storage directory를 전달받아야 한다.

---

## 16. 권장 설정값

| 설정 | 기본값 |
|---|---:|
| `HEARTBEAT_INTERVAL_MS` | 60,000 |
| `CONSUME_INTERVAL_MS` | 60,000 |
| `REAPER_CHECK_INTERVAL_MS` | 60,000 |
| `REAPER_ELECTION_GRACE_MS` | 60,000 |
| `REAPER_STALE_AFTER_MS` | 300,000 |
| `WORKER_DELETE_AFTER_MS` | 360,000 |
| `GLOBAL_LOCK_RETRY_MS` | 1,000 |
| `GLOBAL_LOCK_STALE_AFTER_MS` | 300,000 |
| `JOB_PROCESSING_MS` | 60,000 |

테스트에서는 시간을 직접 기다리지 않도록 clock과 scheduler를 주입 가능한 구조로 만든다.

---

## 17. 운영상 제약과 주의사항

`node-json-db`와 파일 잠금은 소규모 과제 및 단일 공유 파일시스템 환경에는 적합하지만, 일반적인 분산 시스템용 저장소를 대체하지는 않는다.

- 모든 프로세스가 **동일한 물리적 파일시스템과 lock directory**를 바라봐야 한다.
- 파일시스템이 exclusive create의 원자성을 보장해야 한다.
- 일부 네트워크 파일시스템에서는 `wx`의 잠금 의미가 기대와 다를 수 있다.
- 프로세스가 lock 생성 직후 metadata 기록 전에 종료되면 빈 lock이 남을 수 있으므로 Reaper는 파일 수정 시각도 보조 정보로 사용할 수 있다.
- `jobs.json`이 커질수록 전체 파일 reload/save 비용과 global lock 경합이 증가한다.
- 높은 처리량, 여러 서버, 강한 트랜잭션 보장이 필요해지면 PostgreSQL의 row lock, Redis 기반 queue, RabbitMQ 등의 저장·큐 시스템으로 이전하는 것이 적절하다.

---

## 18. 최종 처리 흐름 요약

```text
[Queue API]
요청 수신
→ global lock
→ jobs.json reload
→ 검증 및 CRUD
→ save
→ unlock

[Worker heartbeat]
1분마다
→ global lock
→ workers[workerId].heartbeatAt 갱신
→ save
→ unlock

[Worker consume]
1분마다
→ create Job 목록 조회
→ createdAt/id 오름차순 순회
→ 각 Job의 atomic lock 획득 시도
→ 실패하면 다음 Job 즉시 시도
→ 첫 성공 Job의 create 상태 재검증
→ global lock으로 pending 변경
→ 1분 처리
→ 상태와 소유권 재검증
→ global lock으로 done 변경
→ Job lock 삭제
→ 모든 후보가 실패했을 때만 다음 tick 대기

[Reaper]
1분마다 현재 Reaper 생존 확인
→ 없거나 5분 stale이면 후보 등록
→ 1분 뒤에도 자신의 ID이면 Reaper
→ 6분 stale Worker 삭제
→ orphan Job lock 복구 및 pending → create 롤백
→ stale global lock 정리
```
