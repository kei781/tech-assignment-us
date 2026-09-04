# Jobs Backend 명세서 (SDD Specification)

- 기준 문서: `docs/nestjs-jobs-backend-design.md` (이하 "설계 문서")
- 본 문서는 설계 문서를 **테스트 가능한 요구사항 단위**로 재구성한 명세서다. 각 요구사항에 고유 ID를 부여하며, 테스트 코드는 이 ID를 참조한다.
- 설계 문서와 본 문서가 충돌하면 **본 문서가 우선**한다. 충돌 사항은 [부록 A](#부록-a-설계-문서-대비-변경-사항)에 기록한다.

---

## 1. 범위와 아키텍처

### 1.1 구성

**하나의 NestJS 애플리케이션**이 HTTP 서버와 스케줄러를 함께 실행한다.

```text
                  ┌──────────────── NestJS 프로세스 ────────────────┐
                  │                                                │
HTTP ──▶ Controller ──▶ JobsService ──┐                            │
                  │                   ├──▶ JobsStore ──▶ jobs.json │
      @nestjs/schedule ──▶ Processor ──┘    (직렬화 + 원자적 저장)   │
                  │                                                │
                  └────────────────────────────────────────────────┘
```

- HTTP 핸들러와 스케줄러 콜백이 **같은 이벤트 루프**에서 실행되며, 둘 다 같은 `jobs.json`을 읽고 쓴다.
- `jobs.json`에 쓰는 주체는 이 프로세스 하나다([CON-001]).

### 1.2 이 설계가 다루는 동시성 문제

과제가 요구한 것은 "API 요청과 스케줄러가 동시에 같은 데이터에 접근하는 환경에서 데이터가 손실되거나 깨지지 않게 하라"다. 단일 프로세스에서도 이 문제는 실재한다.

- Node.js는 단일 스레드지만 **`await` 지점에서 실행이 교차한다.** 핸들러가 상태를 읽고 `await`로 양보하는 사이 스케줄러가 상태를 변경하면, 핸들러는 낡은 값으로 덮어쓴다(lost update).
- 파일 쓰기 도중 프로세스가 죽으면 `jobs.json`이 절단된 채 남는다.
- 스케줄러가 처리 중인 Job을 API가 수정하면 처리 결과와 수정이 서로를 덮어쓸 수 있다.

세 가지를 각각 [CON-002] 직렬화, [CON-003] 원자적 저장, [CON-005] 상태 기반 수정 차단으로 해결한다.

### 1.3 다중 프로세스를 지원하지 않는 이유

`jobs.json`을 여러 프로세스가 동시에 쓰는 구성은 **의도적으로 지원하지 않는다.** 파일시스템에는 세션에 묶인 잠금이 없어 프로세스가 죽었는지 알 방법이 없고, 그래서 잠금 파일·stale timeout·소유권 회수·리더 선출이 연쇄적으로 필요해진다. 그 경로는 `node-json-db` 같은 수동 저장소로는 안전하게 닫히지 않는다([부록 D](#부록-d-다중-프로세스-설계를-철회한-경위)).

수평 확장이 필요해지면 파일 잠금을 정교하게 만드는 것이 아니라 PostgreSQL(`SELECT ... FOR UPDATE SKIP LOCKED`)이나 전용 queue로 이전하는 것이 옳다. 이 판단을 README에 기재한다([DOC-001]).

### 1.4 기술 스택 (고정)

NestJS (TypeScript), `node-json-db`, `@nestjs/schedule`. 잠금·직렬화는 Node 내장 기능만 사용하며 추가 의존성을 두지 않는다. Job ID는 UUID v4(`node:crypto`의 `randomUUID`).

---

## 2. 데이터 모델

### 2.1 `jobs.json` 스키마

> **[DATA-001]** `jobs.json`의 최상위 키는 `jobs`(배열) 하나다.

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
  ]
}
```

> **[DATA-002]** Job 필드 규칙:

| 필드 | 형식 | 규칙 |
|---|---|---|
| `id` | UUID v4 | PK. 생성 후 불변 |
| `title` | string | 필수. trim 후 1자 이상, **최대 1,000자** |
| `description` | string | 필수. trim 후 1자 이상, **최대 2,000자** |
| `status` | enum | `create` \| `pending` \| `done` |
| `createdAt` | ISO 8601 UTC | 생성 시각. 불변 |
| `updatedAt` | ISO 8601 UTC | 마지막 변경 시각 |

- `title`·`description`은 **trim된 값을 저장**하며, 길이 제한도 trim 후 값 기준으로 판정한다.

> **[DATA-003]** 모든 시각은 ISO 8601 UTC(`...Z`) 문자열로 기록·비교한다.

> **[DATA-004]** 조회 동작 확인용 **샘플 데이터를 포함한 `data/jobs.json`을 커밋**한다. `create`, `pending`, `done` 상태를 각각 최소 1건 포함한다. 샘플의 `pending` Job은 기동 시 [CON-006]에 의해 `create`로 복구된 뒤 처리되므로, 복구 규칙의 동작을 함께 보여준다.

### 2.2 상태 머신

> **[STATE-001]** 상태와 허용 전이:

```text
create ── 스케줄러 선점 ──▶ pending ── 처리 완료 ──▶ done
   ▲                          │
   └── 처리 실패 / 기동 복구 ──┘
```

| 상태 | 의미 | 허용되는 다음 상태 | 전이 주체 |
|---|---|---|---|
| `create` | 생성됨, 아직 선점되지 않음 | `pending` | 스케줄러 |
| `pending` | 스케줄러가 선점하여 **처리 중** | `done`, `create`(복구) | 스케줄러 |
| `done` | 처리 완료 | 없음 | — |

- `pending`은 일반적인 명칭과 달리 이 설계에서 **처리 중**을 의미한다. README에 명시한다([부록 C](#부록-c-과제-해석-사항-readme-반영-대상)).

> **[STATE-002]** 위 표에 없는 전이는 금지한다. `done`은 종결 상태이며 어떤 주체도 되돌리지 않는다. API는 `status`를 직접 변경할 수 없다([API-050]).

---

## 3. 동시성 설계

> **[CON-001]** (단일 writer) `jobs.json`에 쓰는 주체는 애플리케이션 프로세스 하나다. 같은 `jobs.json`을 여러 프로세스로 동시에 여는 구성은 지원하지 않으며, 그 경우의 동작은 정의하지 않는다.

> **[CON-002]** (직렬화) `jobs.json`을 변경하는 모든 작업은 프로세스 내 **단일 mutex**를 통과하며, 다음 순서를 지킨다.
>
> 1. 현재 인메모리 상태의 **복사본**을 만든다.
> 2. 복사본에 변경을 적용한다(검증·조건 검사도 이 안에서 수행한다).
> 3. 복사본을 [CON-003]으로 저장한다.
> 4. **저장이 성공한 뒤에만** 인메모리 참조를 복사본으로 교체한다.
>
> mutex는 promise chain으로 구현한다 — 새 작업은 직전 작업의 완료(성공·실패 무관) 뒤에 실행된다. 별도 라이브러리를 쓰지 않는다.
>
> ```ts
> private tail: Promise<unknown> = Promise.resolve();
>
> runExclusive<T>(fn: () => Promise<T>): Promise<T> {
>   const result = this.tail.then(fn, fn);
>   this.tail = result.then(
>     () => undefined,
>     () => undefined,
>   );
>   return result;
> }
> ```
>
> 4단계 순서가 중요하다: 저장이 실패하면 인메모리 상태가 변경 전으로 남아 디스크와 어긋나지 않는다.
>
> **왜 단일 스레드인데도 필요한가**: `await` 지점에서 실행이 교차하므로, mutex가 없으면 `읽기 → await → (다른 쪽이 변경) → 낡은 값으로 쓰기` 순서가 성립해 변경이 소실된다.

> **[CON-003]** (원자적 저장) 저장은 임시 파일에 전체 내용을 기록하고 `fsync`한 뒤 `fs.rename`으로 `jobs.json`을 교체한다. `rename`은 원자적이므로 저장 도중 프로세스가 죽어도 `jobs.json`은 항상 이전 또는 이후의 완전한 상태이며, 절단된 파일이 남지 않는다.
>
> 임시 파일명은 `jobs.json.<random>.tmp` 형식으로 만들고 저장 후 남기지 않는다. `node-json-db`는 데이터 파싱·조작에 사용하되 디스크 게시는 이 절차로 수행한다(자체 save 경로는 원자성을 보장하지 않는다 — README에 사유 기재).
>
> **임시 파일 정리는 `open` 이후의 모든 실패 지점에 적용한다** — write·fsync·close·rename 어디서 실패해도 임시 파일을 지운 뒤 오류를 전파한다. `rename` 실패만 정리하면 반복되는 디스크 오류가 숨겨진 `.tmp`를 계속 누적시켜 "임시 파일 잔존 없음"이 깨진다.

> **[CON-004]** (읽기) 읽기는 인메모리 상태에서 동기적으로 수행하며, 반환 전에 복사(스냅샷)한다. [CON-002]의 변경이 동기 구간에서 적용되므로 읽기가 부분 적용 상태를 관측할 수 없고, 따라서 읽기는 mutex를 필요로 하지 않는다.
>
> 인메모리 상태는 기동 시 1회 로드하며([CON-006]), 이후 디스크가 단일 진실 소스가 아니라 인메모리 상태가 단일 진실 소스다(writer가 하나이므로 외부에서 파일이 바뀔 일이 없다).

> **[CON-005]** (처리 중 수정 차단 — **과제의 핵심 질문에 대한 답**) `PATCH /jobs/:id`는 `status === "create"`인 Job만 수정할 수 있다. `pending`이면 `409`(처리중), `done`이면 `409`(완료)를 반환한다.
>
> 상태 검사와 수정은 **같은 mutex 구간**에서 이루어지므로, "검사를 통과한 직후 스케줄러가 선점" 같은 창이 존재하지 않는다. 반대 방향도 같다 — 스케줄러의 선점(`create → pending`)도 같은 mutex를 통과하므로, 수정이 진행되는 동안 선점이 끼어들지 못한다.
>
> 결과적으로 처리 중인 Job은 API가 덮어쓸 수 없고, 처리 결과(`done`)가 수정에 의해 소실되지도 않는다.

> **[CON-006]** (기동 복구) 애플리케이션 기동 시 `jobs.json`을 로드한 직후, `status === "pending"`인 Job을 모두 `create`로 되돌리고(`updatedAt = now`) 한 번 저장한다.
>
> writer가 하나이므로 **기동 시점에 진행 중인 처리는 존재할 수 없다.** 따라서 `pending`으로 남아 있는 Job은 이전 실행이 처리 중 비정상 종료된 잔여물이며, 되돌리는 것이 항상 옳다. 이 한 규칙이 다중 프로세스 설계에서 필요했던 lease·heartbeat·리더 선출 전체를 대체한다.

> **[CON-007]** (정상 종료) `SIGINT`/`SIGTERM` 또는 Nest shutdown hook에서: ① 새 스케줄러 tick을 차단하고 ② 진행 중인 tick이 끝날 때까지 `SHUTDOWN_DRAIN_MS`(기본 10,000ms)까지 대기한다.
>
> tick은 항상 `done` 커밋 또는 `create` 롤백으로 끝나므로([SCH-004], [SCH-005]) drain이 완료되면 이 프로세스가 남긴 `pending`은 없다. drain이 시간 내 끝나지 않거나 프로세스가 강제 종료되면 [CON-006]이 다음 기동에서 복구한다.
>
> ③ 마지막으로 **대기 중인 로그 append를 flush한다**([LOG-001]). Nest의 signal handler는 shutdown hook 직후 프로세스를 재종료하므로, flush하지 않으면 종료 로그뿐 아니라 직전에 예약된 요청·처리 로그까지 유실된다.

### 동시성 규칙 요약

| ID | 상황 | 규칙 |
|---|---|---|
| [CON-002] | 핸들러와 스케줄러의 동시 변경 | mutex로 직렬화 + 저장 성공 후 상태 교체 |
| [CON-003] | 저장 중 프로세스 종료 | 임시 파일 + 원자적 `rename` → 파일 손상 없음 |
| [CON-005] | 처리 중 Job에 대한 `PATCH` | `409` 거부. 검사와 수정이 같은 mutex 구간 |
| [CON-005] | 수정 중 스케줄러 선점 시도 | 같은 mutex를 대기 → 끼어들지 못함 |
| [CON-006] | 처리 중 비정상 종료 | 다음 기동에서 `pending → create` 복구 |
| [SCH-002] | 이전 tick이 끝나지 않음 | `isProcessing` guard로 이번 tick 건너뜀 |
| [SCH-005] | 처리 중 예외 | `pending → create` 롤백 |

---

## 4. REST API

### 4.1 공통 규칙

> **[API-001]** 응답 본문 공통 형식:

```json
{ "status": 200, "result": "success" }
```

- `status`: HTTP 상태 코드와 동일한 숫자
- `result`: 성공 시 `"success"`, 그 외에는 한국어 사유 메시지. **단 하나의 예외**로 검색 결과 없음([API-032])은 `200`이면서 `result`에 사유 메시지를 담는다.
- 목록 응답은 `list`(배열), 단건 응답은 `job`(객체)을 추가한다.

> **[API-002]** 본문의 `status`는 실제 HTTP 응답 상태 코드와 항상 일치해야 한다.

> **[API-003]** DTO validation 실패는 `400`과 사유 메시지를 반환한다. 정의되지 않은 필드는 거부한다(whitelist + forbidNonWhitelisted).

> **[API-004]** 처리 중 내부 오류(저장 실패 등)는 `500`을 반환한다. 어떤 경우에도 [API-001] 형식을 유지한다.

### 4.2 Endpoint 요약

| Method | Path | 설명 | 성공 상태 |
|---|---|---|---|
| `POST` | `/jobs` | 새 작업 생성 | `201 Created` |
| `GET` | `/jobs` | 전체 작업 목록 조회 | `200 OK` |
| `GET` | `/jobs/search` | 제목·설명·상태로 검색 | `200 OK` |
| `GET` | `/jobs/:id` | 단일 작업 조회 | `200 OK` |
| `PATCH` | `/jobs/:id` | 작업 제목·설명 수정 | `200 OK` |

> **[API-005]** `/jobs/search` 라우트는 `/jobs/:id`보다 먼저 매칭되어야 한다(`search`가 `:id`로 해석되면 안 된다).

### 4.3 `POST /jobs`

> **[API-010]** 요청 본문: `{ "title": string, "description": string }` — 둘 다 필수이며 [DATA-002] 규칙을 따른다.

> **[API-011]** 성공 시 `201`과 함께 서버가 채운 `id`(UUID v4), `status: "create"`, `createdAt`, `updatedAt`을 포함한 Job을 `job` 필드로 반환한다.

```json
{ "status": 201, "result": "success", "job": { "id": "...", "title": "...", "description": "...", "status": "create", "createdAt": "...", "updatedAt": "..." } }
```

> **[API-012]** 저장은 [CON-002] mutex 구간에서 수행한다.

| 상황 | HTTP 상태 |
|---|---:|
| 성공 | 201 |
| validation 실패(누락·타입·길이 초과) | 400 |
| 저장 실패 | 500 |

### 4.4 `GET /jobs`

> **[API-020]** 전체 Job을 `createdAt` ASC, 동률 시 `id` ASC로 정렬해 `list`로 반환한다. 빈 목록도 `200` + `list: []`이다.

### 4.5 `GET /jobs/search`

> **[API-030]** Query parameter: `title`, `description`, `status` — **셋 중 하나 이상 필수**. 처리 순서를 다음으로 고정한다.
>
> 1. **정규화**: 세 파라미터를 trim하고, 결과가 빈 문자열인 파라미터는 **전달되지 않은 것으로 간주해 제거**한다. 이 단계는 validation보다 **선행**한다.
> 2. **조건 존재 검사**: 남은 파라미터가 하나도 없으면 `400`.
> 3. **validation**: 남은 파라미터에만 [API-031]을 적용한다. 따라서 `?status=`는 enum validation을 타지 않는다.
>
> 예: `?title=`은 title 미입력, `?title=&status=done`은 status 단독 검색, `?status=` 단독은 전부 미입력과 동일해 `400`.
>
> 과제 원문은 "제목/상태로 검색"을 요구한다. 설계 문서의 `title`/`description`에 **`status`를 추가**해 과제 요구를 충족한다.

> **[API-031]** 매칭 규칙 (모든 파라미터는 trim된 값으로 매칭):
> - `title`, `description`: **대소문자 구분 없는 부분 일치**
> - `status`: enum 정확 일치 (`create` | `pending` | `done`). 그 외 값은 `400`
> - 복수 조건은 **AND** 결합
> - 결과 정렬은 [API-020]과 동일

> **[API-032]** 응답:

| 상황 | HTTP 상태 | `result` | `list` |
|---|---:|---|---|
| 검색 성공(1건 이상) | 200 | `success` | 매칭된 Job 배열 |
| 검색 결과 없음 | 200 | `데이터가 존재하지 않습니다.` | `[]` |
| 유효 조건 없음(`?status=` 단독 포함) | 400 | `title, description, status 중 하나 이상을 입력하여 주세요.` | 없음 |
| `status`에 enum 아닌 값 | 400 | 유효성 검사 사유 | 없음 |
| `?title=x&status=` (빈 status 제거 후 title 단독) | 200 | 결과에 따름 | 결과에 따름 |

### 4.6 `GET /jobs/:id`

> **[API-040]** `:id`를 받는 **모든 라우트**(GET, PATCH)에서 `:id`는 UUID 형식(버전 무관)이어야 하며, 형식이 아니면 `400`. 형식은 유효하나 존재하지 않으면 `404`.

| 상황 | HTTP 상태 | `result` | 본문 |
|---|---:|---|---|
| 존재 | 200 | `success` | `job: {...}` |
| 없음 | 404 | `존재하지 않는 데이터입니다.` | — |

### 4.7 `PATCH /jobs/:id`

> **[API-050]** 요청 본문: `{ "title"?: string, "description"?: string }` — **하나 이상 필수**, 각 필드는 [DATA-002] 규칙을 따른다. `status` 등 다른 필드의 수정은 거부한다(`400`).

> **[API-051]** 수정 가능 조건은 `status === "create"` 하나다. 검사와 수정은 [CON-002] mutex 구간에서 함께 수행한다([CON-005]).

> **[API-052]** 성공 시 `updatedAt`을 갱신하고 수정된 Job을 `job` 필드로 반환한다.

> **[API-053]** 거부 사유 판정 우선순위: ⓪ DTO/파라미터 validation(`400`, 상태 검사보다 선행) → ① Job 존재 여부(`404`) → ② `done`(`409`) → ③ `pending`(`409`).

| 상황 | HTTP 상태 | `result` |
|---|---:|---|
| 수정 성공 | 200 | `success` |
| Job 없음 | 404 | `존재하지 않는 데이터입니다.` |
| `done` | 409 | `이미 완료된 프로세스입니다.` |
| `pending` | 409 | `처리중인 프로세스입니다.` |
| validation 실패 | 400 | 유효성 검사 사유 |

---

## 5. 스케줄러

> **[SCH-001]** `@nestjs/schedule`로 `CONSUME_INTERVAL_MS`(기본 60,000ms)마다 tick을 실행한다. 애플리케이션 기동 직후에도 **1회 즉시 실행**해, 확인을 위해 첫 주기를 기다리지 않게 한다.

> **[SCH-002]** 이전 tick이 끝나지 않았으면 이번 tick은 건너뛴다(`isProcessing` guard). 한 tick은 Job **1개**를 처리한다(과제가 허용한 자유 가정 — [부록 C](#부록-c-과제-해석-사항-readme-반영-대상)).

> **[SCH-003]** 선점: [CON-002] mutex 구간에서 `status === "create"`인 Job을 `createdAt` ASC, 동률 시 `id` ASC로 정렬해 첫 번째를 `status = "pending"`, `updatedAt = now`로 커밋한다. 대상이 없으면 tick을 종료한다.
>
> 선점을 mutex 안에서 커밋한 뒤 mutex를 **벗어나서** 처리하는 이유는, 처리 시간(`JOB_PROCESSING_MS`) 동안 mutex를 잡고 있으면 그 사이 모든 API 요청이 대기하게 되기 때문이다.

> **[SCH-004]** 처리와 완료: 선점한 Job을 `JOB_PROCESSING_MS`(기본 5,000ms) 동안 처리한 것으로 간주한 뒤, [CON-002] mutex 구간에서 해당 Job이 여전히 `status === "pending"`인지 확인하고 `status = "done"`, `updatedAt = now`로 커밋한다.
>
> 실제 비즈니스 작업은 이 과제에서 정의하지 않는다. 처리 로직은 주입 가능한 형태로 두어 테스트가 실제 대기 없이 검증할 수 있게 한다([TST-002]).

> **[SCH-005]** 처리 중 예외가 발생하면 [CON-002] mutex 구간에서 해당 Job이 `pending`인지 확인하고 `create`로 롤백한다(`updatedAt = now`). 예외는 로깅하되 프로세스를 중단시키지 않으며, `isProcessing` guard는 성공·실패·예외 어느 경로에서도 반드시 해제한다.
>
> **오류 경계는 선점([SCH-003])과 완료([SCH-004])까지 포함하며, tick은 어떤 이유로도 호출자에게 reject를 전파하지 않는다.** 자동 호출부(interval callback, [SCH-001] 기동 즉시 tick)는 catch handler를 둘 수 없는 fire-and-forget 경로이므로, reject가 새어나가면 처리되지 않은 rejection이 되어 Node 기본 동작에서 프로세스가 죽는다 — 일시적 저장 실패 하나가 스케줄러 전체를 멈추고 오류 로그도 남기지 않는다. 선점 커밋도 디스크 쓰기이므로 실패할 수 있다.

---

## 6. 로깅 (`logs.txt`)

> 과제 필수 요구사항이나 설계 문서에 누락되어 있던 항목이다.

> **[LOG-001]** 프로젝트 루트의 `logs.txt`(경로는 `LOG_FILE_PATH`로 재정의 가능)에 **append 모드**로 기록한다. 한 로그 항목은 한 번의 append 호출로 기록한다.
>
> 기록은 비동기로 예약하고 즉시 반환한다([LOG-005] best-effort). 대신 로거는 `flush()`를 제공하고 **종료 시 flush를 보장**해야 한다([CON-007] ③) — 그러지 않으면 예약된 항목이 프로세스 종료와 함께 사라져 "모든 요청을 로깅"([LOG-003])이 정상 종료 경로에서 깨진다.

> **[LOG-002]** 로그 라인 형식:

```text
[ISO8601 UTC] [LEVEL] [scope] message
```

예: `[2026-09-03T20:00:00.000Z] [INFO] [http] POST /jobs 201 12ms`

- `LEVEL`: `INFO` | `WARN` | `ERROR`
- `scope`: `http`(요청) | `scheduler`(선점·완료·롤백) | `storage`(로드·저장·기동 복구)

> **[LOG-003]** **모든 HTTP 요청**을 로깅한다: method, path(query 포함), 응답 상태 코드, 처리 시간(ms). 에러 응답도 포함한다.

> **[LOG-004]** 스케줄러의 **처리 결과**를 로깅한다: 선점, 완료(`done`), 실패·롤백, 대상 없음. 각 항목에 Job ID를 포함한다. 기동 복구([CON-006])는 복구 건수와 함께 `storage` scope로 로깅한다.

> **[LOG-005]** 로그 기록 실패가 API 응답이나 스케줄러 처리를 실패시키면 안 된다(best-effort).

---

## 7. 설정값

> **[CFG-001]** 아래 값은 환경 변수로 재정의할 수 있고, 테스트에서는 주입해 실제 대기 없이 검증한다([TST-002]).

| 설정 | 기본값 |
|---|---:|
| `JOBS_FILE_PATH` | `./data/jobs.json` (상대 경로는 프로세스 cwd 기준) |
| `LOG_FILE_PATH` | `./logs.txt` |
| `CONSUME_INTERVAL_MS` | 60,000 |
| `JOB_PROCESSING_MS` | 5,000 |
| `SHUTDOWN_DRAIN_MS` | 10,000 |
| `SCHEDULER_ENABLED` | `true` |

- 제약: `JOB_PROCESSING_MS < CONSUME_INTERVAL_MS` — 그렇지 않으면 [SCH-002] guard가 매 tick 발동해 실효 처리량이 절반 이하로 떨어진다. 위반 시 기동을 막지는 않고 `WARN`을 남긴다.
- **범위 검증**: 모든 ms 설정은 정수여야 하며 `2,147,483,647`(Node timer의 32-bit signed 한계)을 넘을 수 없다. `CONSUME_INTERVAL_MS`는 **1 이상**이어야 한다 — `setInterval(fn, 0)`이나 범위를 넘는 delay는 libuv가 1ms로 보정하므로, 빈 큐에서도 매 tick 로그를 append해 오설정 하나가 CPU/I-O 폭주와 `logs.txt` 폭증으로 바뀐다. `JOB_PROCESSING_MS`·`SHUTDOWN_DRAIN_MS`는 "대기 없음"이라는 의미가 있으므로 `0`을 허용한다. 위반은 기동 시점에 오류로 거부한다.
- `Node 20+`가 필요하다([RUN-003]) — `package.json`의 `engines`에 선언한다.
- `SCHEDULER_ENABLED=false`면 interval 등록과 기동 즉시 tick([SCH-001])을 모두 건너뛴다. 테스트가 tick 시점을 직접 통제하기 위한 seam이며([TST-002]), API만 띄우는 운영 구성에도 쓸 수 있다.

---

## 8. 프로젝트 구조와 실행

> **[RUN-001]** 디렉터리 구조:

```text
src/
├─ main.ts              # NestFactory.create(AppModule)
├─ app.module.ts        # ScheduleModule.forRoot() 포함
├─ jobs/
│  ├─ jobs.controller.ts
│  ├─ jobs.service.ts
│  ├─ jobs.processor.ts # @Interval 스케줄러
│  ├─ jobs.store.ts     # mutex + 원자적 저장 + 기동 복구
│  └─ dto/
└─ common/
   ├─ logging/          # logs.txt 로거 + 요청 로깅 미들웨어 (부록 A #13)
   ├─ filters/          # 공통 에러 응답 형식
   └─ config.ts
data/
└─ jobs.json            # 샘플 데이터 포함, 커밋 대상
```

> **[RUN-002]** 실행 명령: `npm run start`(개발), `npm run build && npm run start:prod`. HTTP 서버와 스케줄러가 함께 뜬다.

> **[RUN-003]** 기본 Node 환경에서 `npm install` 후 별도 설정 없이 실행 가능해야 한다.

> **[RUN-004]** 부트스트랩: ① `jobs.json`의 상위 디렉터리가 없으면 생성 → ② 파일이 없으면 `{ "jobs": [] }`로 생성 → ③ 로드 → ④ [CON-006] 기동 복구.
>
> `jobs.json`이 파싱 불가(손상)하면 **자동으로 초기화하지 않는다**(데이터 보호 우선). 오류를 로깅하고 비-0 종료 코드로 기동을 중단한다.

> **[DOC-001]** `README.md`는 다음을 포함한다.
>
> 1. 설치·실행·테스트 방법
> 2. 모든 엔드포인트의 요청/응답 예시
> 3. 설계 코멘트 — 특히 **왜 단일 프로세스인가**([1.3](#13-다중-프로세스를-지원하지-않는-이유)), 단일 스레드에서도 mutex가 필요한 이유([1.2](#12-이-설계가-다루는-동시성-문제)), `node-json-db` 자체 save 대신 원자적 rename을 쓴 이유([CON-003])
> 4. [부록 C](#부록-c-과제-해석-사항-readme-반영-대상)의 과제 해석 사항 전부
> 5. 고민했던 지점과 되돌린 결정 — [부록 D](#부록-d-다중-프로세스-설계를-철회한-경위)의 요약
> 6. 확인 타임라인: 기동 즉시 1회 tick이 돌므로([SCH-001]) 샘플 `pending` Job은 기동 직후 `create`로 복구되고 첫 tick에 처리된다. 빠른 확인이 필요하면 `JOB_PROCESSING_MS=500 CONSUME_INTERVAL_MS=2000`으로 실행한다.

---

## 9. 테스트 요구사항

> **[TST-001]** 테스트는 본 명세의 요구사항 ID를 참조한다(예: `describe('[API-030] ...')`).

| 영역 | 대상 |
|---|---|
| API e2e | §4의 모든 엔드포인트 × 성공/실패 케이스(상태 코드 + 응답 본문 형식). `?status=` 계열 정규화 순서([API-030]), 손상 파일 로드 시 기동 중단([RUN-004]) |
| 저장소 | [CON-002] 직렬화·저장 실패 시 인메모리 롤백, [CON-003] 원자적 저장·임시 파일 잔존 없음, [CON-006] 기동 복구, [RUN-004] 파일/디렉터리 부재·손상 |
| 스케줄러 | [SCH-002] guard, [SCH-003] 선점 순서, [SCH-004] 완료, [SCH-005] 예외 롤백, [CON-007] 종료 drain |
| 로깅 | [LOG-003] 요청 로깅, [LOG-004] 스케줄러·복구 로깅, [LOG-002] 형식, [LOG-005] best-effort |
| 설정 | [CFG-001] 환경 변수 로드·범위 검증, [RUN-003] 실행 전제(`engines`) |
| 샘플 데이터 | [DATA-004] 커밋된 `data/jobs.json`의 3상태 유지와 [DATA-002] 필드 규칙 |

> **[TST-004]** `data/jobs.json`은 제출 요건이면서 앱이 실행 중에 덮어쓰는 파일이다. 기본 설정으로 한 번 띄우면 모든 Job이 `done`이 되므로, **커밋된 샘플이 [DATA-004]의 3상태를 유지하는지 테스트로 고정**한다. 그러지 않으면 시연 후 상태가 커밋되어 "조회 동작 확인용 샘플"이라는 목적이 조용히 사라진다.

> **[TST-005]** 다음 요구사항은 자동 테스트 대상이 아니라 **검토로 확인**한다 — 문서·구조 요구사항이라 테스트로 고정하면 리팩터링을 방해하고 실질 검증력은 없다.
>
> | ID | 확인 방법 |
> |---|---|
> | [DOC-001] | `README.md`가 6개 항목을 포함하는지 검토 |
> | [RUN-001] | 디렉터리 구조가 §8과 일치하는지 검토 |
> | [TST-001] | 각 테스트의 `describe`/`it`가 요구사항 ID를 참조하는지 검토 |

> **[TST-002]** 테스트는 실제 스케줄러 주기나 처리 시간을 기다리지 않는다. 처리 로직과 tick 트리거를 주입 가능하게 두고 직접 호출한다.

> **[TST-003]** 동시성 시나리오는 **명시적 테스트 케이스로 고정**한다.

| # | 시나리오 | 기대 |
|---|---|---|
| 1 | 처리 중(`pending`)인 Job에 `PATCH` | `409` `처리중인 프로세스입니다.`, Job의 `title`·`description` 불변 |
| 2 | `done` Job에 `PATCH` | `409` `이미 완료된 프로세스입니다.` |
| 3 | `PATCH`와 스케줄러 선점을 동시에 시작 | 순서와 무관하게 두 결과 중 하나만 성립: (수정 성공 후 선점) 또는 (선점 후 수정 `409`). **수정이 소실된 채 `pending`이 되는 결과는 없다** |
| 4 | 여러 `POST`를 동시에 발행 | 모든 Job이 `jobs.json`에 남는다(lost update 없음) |
| 5 | 스케줄러 처리 중 `POST`·`GET` 요청 | mutex가 처리 시간 동안 잡히지 않으므로 정상 응답([SCH-003]) |
| 6 | 저장이 실패하도록 만든 뒤 `POST` | `500`, **인메모리 상태와 디스크 상태 모두 변경 전** |
| 7 | `pending` Job이 남은 파일로 기동 | [CON-006]으로 `create` 복구 + `storage` 로그 기록 |
| 8 | 처리 중 예외 발생 | `create` 롤백, `isProcessing` 해제되어 다음 tick 정상 동작 |

---

## 부록 A. 설계 문서 대비 변경 사항

| # | 항목 | 설계 문서 | 본 명세 | 사유 |
|---|---|---|---|---|
| 1 | 프로세스 구성 | Queue API·Worker를 각각 다중 프로세스로 실행 | **단일 NestJS 프로세스**(HTTP + 스케줄러) | 과제는 프로세스 분리를 요구하지 않는다. 다중 writer가 파일 잠금·Reaper·소유권 회수 전체의 원인이며, 파일시스템으로는 안전하게 닫히지 않는다([부록 D](#부록-d-다중-프로세스-설계를-철회한-경위)) |
| 2 | 동시성 제어 | `jobs-global-lock.json`·`{jobId}-lock.json` 파일 잠금 | 프로세스 내 mutex([CON-002]) + 원자적 저장([CON-003]) | 단일 writer에서는 파일 잠금이 불필요하다. Node 내장 기능만 사용 |
| 3 | Worker registry·heartbeat·Reaper 선출 | `workers`·`reaper` 키와 선출·복구 절차 | **전부 삭제** | 존재 이유가 "죽은 프로세스의 잠금 회수"였고, 단일 프로세스에서는 [CON-006] 기동 복구 한 규칙으로 대체된다 |
| 4 | 검색 파라미터 | `title`, `description` | `title`, `description`, `status` | 과제 원문이 "제목/**상태**로 검색"을 명시 — 과제 위배 보정 |
| 5 | 검색 조건 누락 메시지 | `title 혹은 description은 반드시 입력하여 주세요.` | `title, description, status 중 하나 이상을 입력하여 주세요.` | status 추가에 따른 문구 정합화 |
| 6 | `logs.txt` 로깅 | 없음 | §6 신설 | 과제 필수 요구사항 누락 보정 |
| 7 | 단건 응답 형식 | `list: [job]` 허용 또는 `job` 필드 | `job` 필드로 고정 | 설계 문서 §8.6이 권장한 방향으로 확정 |
| 8 | 샘플 데이터 | 없음 | [DATA-004] 신설 | 과제 제출 요건 |
| 9 | `PATCH` 수정 조건 | `status === create` **AND** per-job lock 파일 부재 | `status === create` 단독 | lock 파일이 없어졌고, 검사와 수정이 같은 mutex 구간이라 상태 검사만으로 충분하다 |
| 10 | `jobs.json` 저장 | `node-json-db` save | 임시 파일 + `fsync` + 원자적 `rename` | 저장 중 종료로 인한 파일 손상 방지 |
| 11 | 처리 시간 | 1분 | 5초 (`JOB_PROCESSING_MS`) | 과제가 허용한 자유 가정. `CONSUME_INTERVAL_MS`보다 작게 두어 [SCH-002] guard가 상시 발동하지 않게 한다 |
| 12 | 기동 시 즉시 tick | 없음 | [SCH-001] | 확인을 위해 첫 주기를 기다리지 않게 한다 |
| 13 | 요청 로깅 방식 | 인터셉터 | **미들웨어** (`res.on('finish')`) | 인터셉터는 exception filter가 상태 코드를 확정하기 전에 종료되므로 에러 응답의 실제 코드를 알 수 없다. 미들웨어는 라우트 미매칭·validation 실패·filter가 만든 응답까지 최종 코드로 기록해 [LOG-003]의 "모든 요청"을 만족한다 |
| 14 | `SCHEDULER_ENABLED` | 없음 | §7에 추가 | tick 시점을 테스트가 통제하기 위한 seam([TST-002]). API만 띄우는 운영 구성에도 쓸 수 있다 |

## 부록 B. 초기설계 대비 확정 사항

`docs/초기설계..md`와 다른 부분은 본 명세를 따른다.

| 항목 | 초기설계 | 확정 |
|---|---|---|
| 프로세스 구성 | API·Worker 각각 중복 실행 | **단일 프로세스** (부록 A #1) |
| 잠금 | `fs.open(lockPath, 'wx')` 파일 잠금 필수 | 프로세스 내 mutex (부록 A #2) |
| `workers`·`reaper` 키 | `jobs.json`에 포함 | 삭제 (부록 A #3) |
| `pending` 의미 | 처리 대기중 | **처리 중(선점됨)** |
| `POST` 성공 상태 | 200 | **201 Created** (HTTP 시맨틱) |
| job lock 획득 실패 시 | 1분 대기 후 재시도 | 해당 없음 (잠금 없음) |

## 부록 C. 과제 해석 사항 (README 반영 대상)

1. 과제 예시의 초기 상태는 `pending`이지만, 본 설계는 `create`(대기) → `pending`(처리 중) → `done`(완료) 3단계 상태 머신을 사용한다. 스키마 자유 설계 범위 내의 결정이다.
2. "제목/상태로 검색"은 `title`·`status` 쿼리 파라미터로 구현하고, 설계 확장으로 `description`도 지원한다.
3. 처리 주기(기본 1분)와 한 번에 처리할 단위(tick당 1건)는 과제가 허용한 자유 가정이다.
4. 응답 본문에 `status`(HTTP 코드 미러링)와 `result`(성공/사유)를 두는 형식은 자유 설계 항목이다.
5. **HTTP 서버와 스케줄러를 한 프로세스에서 실행한다.** 과제의 "API 요청과 스케줄러가 동시에 같은 데이터에 접근하는 환경"을 `@nestjs/schedule`의 기본 사용 형태로 해석한 결과다. 같은 `jobs.json`을 여러 프로세스로 여는 구성은 지원하지 않는다.

## 부록 D. 다중 프로세스 설계를 철회한 경위

초기 설계는 API·Worker를 각각 여러 프로세스로 실행하고 `jobs.json`을 파일 잠금으로 보호하는 구조였다. 이 방향은 7차에 걸친 적대적 검증에서 총 22건의 결함이 나온 뒤 철회했다. 결함들은 개별 실수가 아니라 하나의 원인에서 파생됐다.

**파일시스템에는 DB가 공짜로 주는 두 가지가 없다.** ① 여러 단계를 묶는 트랜잭션 — 원자적인 것은 `rename`·`link`·`O_EXCL` 생성 같은 **단일 syscall 하나**뿐이어서 "읽고 판단하고 쓴다"를 묶을 수단이 없다. ② 세션에 묶인 잠금 — DB는 연결이 끊기면 락을 자동 해제하지만, 파일 잠금은 소유자가 죽었는지 알 방법이 없다.

②를 흉내내려고 heartbeat·registry·stale timeout·리더 선출(Reaper)이 필요해졌고, ①이 없어서 그 회수 절차를 안전하게 만들 수 없었다. 잠금 회수의 배타성을 확보하려는 시도는 세 번 모두 실패했다.

| 시도 | 실패 원인 |
|---|---|
| 조정용 mutex 파일(reap-mutex)로 회수 직렬화 | mutex 자체의 `read → unlink → wx`에 같은 race. 누출 시 복구 기능 영구 정지 |
| stale lock을 rename으로 배타 이동 | A가 rename한 직후 **빈** 경로에 새 lock이 생성되면, 뒤늦은 B의 rename이 그 **살아있는** lock을 이동 |
| 해제 시 소유권 선행 읽기 | 읽기와 rename 사이에 회수·재획득이 끼어들면 타인의 살아있는 lock을 이동 |

공통 원인은 **읽어서 판정한 파일 identity와 나중에 조작하는 pathname을 원자적으로 결속하는 POSIX 연산이 없다**는 것이다. 마지막 판에서는 정확성을 잠금에서 버전 CAS(`fs.link`로 `versions/v{N+1}.json` 생성)로 옮겨 lost update를 막았지만, 그 시점에 명세는 700줄·요구사항 60여 개가 되어 있었다. 과제가 요구한 것은 "동시 요청 상황에서도 데이터가 손실되거나 깨지지 않도록 고려해 주세요"이지 분산 합의가 아니다.

그래서 잠금을 더 정교하게 만드는 대신 **빠져 있던 중재자를 되돌려놓았다.** writer를 프로세스 하나로 되돌리면 트랜잭션은 인메모리 mutex로, 생존 감지는 기동 복구 한 규칙으로 끝난다. 잠금 파일·Reaper·lease·CAS·설정 fingerprint가 전부 사라지고, 남는 것은 [CON-002]·[CON-003]·[CON-005]·[CON-006] 네 규칙이다.

수평 확장이 필요해지는 시점에는 이 네 규칙을 파일 위에서 확장하는 것이 아니라 PostgreSQL이나 전용 queue로 이전하는 것이 옳다. `SELECT ... FOR UPDATE SKIP LOCKED` 한 줄이 이 과제의 선점 문제 전체에 해당한다.
