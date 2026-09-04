# Jobs Backend

NestJS로 작업(Job)을 관리하는 백엔드입니다. REST API로 작업을 생성·조회·검색·수정하고, 스케줄러가 주기적으로 작업을 처리합니다. 데이터는 단일 JSON 파일(`data/jobs.json`)에 영속화합니다.

- 상세 명세: [`docs/SPEC.md`](docs/SPEC.md) — 요구사항마다 ID를 부여했고, 테스트 코드가 그 ID를 참조합니다.
- 설계 경위: [`docs/nestjs-jobs-backend-design.md`](docs/nestjs-jobs-backend-design.md) (초기 다중 프로세스 설계, **철회됨**)

---

## 1. 실행 방법

### 설치

```bash
npm install
```

Node 20 이상을 권장합니다(개발·검증은 Node 24에서 진행). 추가 설정 없이 바로 실행됩니다.

### 실행

```bash
npm run start
```

`http://localhost:3000`에서 HTTP 서버가, 같은 프로세스에서 스케줄러가 함께 동작합니다. 기동 즉시 tick이 1회 돌기 때문에 첫 주기(1분)를 기다릴 필요가 없습니다.

프로덕션 빌드:

```bash
npm run build && npm run start:prod
```

### 빠른 확인용 실행

기본값은 처리 주기 1분·처리 시간 5초입니다. 동작을 바로 보고 싶다면 주기를 줄여서 실행하세요.

```bash
JOB_PROCESSING_MS=500 CONSUME_INTERVAL_MS=2000 npm run start
```

Windows PowerShell:

```powershell
$env:JOB_PROCESSING_MS=500; $env:CONSUME_INTERVAL_MS=2000; npm run start
```

### 테스트

```bash
npm test
```

105개 테스트 / 5개 스위트입니다. 실제 스케줄러 주기나 처리 시간을 기다리지 않습니다([TST-002]) — 시계와 처리 로직을 주입하고 tick을 직접 호출합니다.

| 스위트 | 검증 대상 |
|---|---|
| `test/api.e2e-spec.ts` | 전체 엔드포인트 × 성공/실패, 요청 로깅, 부트스트랩 |
| `test/jobs-store.spec.ts` | 직렬화·원자적 저장·기동 복구·손상 파일 처리 |
| `test/scheduler.spec.ts` | 선점·완료·롤백·재진입 guard·종료 drain |
| `test/concurrency.spec.ts` | **동시성 시나리오 8종** ([TST-003]) |
| `test/logging.spec.ts` | 로그 형식·append·best-effort |

### 설정값

| 환경 변수 | 기본값 | 설명 |
|---|---:|---|
| `PORT` | `3000` | HTTP 포트 |
| `JOBS_FILE_PATH` | `./data/jobs.json` | 데이터 파일 (상대 경로는 cwd 기준) |
| `LOG_FILE_PATH` | `./logs.txt` | 로그 파일 |
| `CONSUME_INTERVAL_MS` | `60000` | 스케줄러 tick 주기 |
| `JOB_PROCESSING_MS` | `5000` | 한 Job의 처리 시간(모사) |
| `SHUTDOWN_DRAIN_MS` | `10000` | 종료 시 진행 중인 tick 대기 한도 |
| `SCHEDULER_ENABLED` | `true` | `false`면 스케줄러를 띄우지 않고 API만 실행 |

`JOB_PROCESSING_MS`가 `CONSUME_INTERVAL_MS`보다 크거나 같으면 매 tick 재진입 guard가 발동해 실효 처리량이 떨어집니다. 기동은 막지 않고 경고를 남깁니다.

### 샘플 데이터

`data/jobs.json`에 4건이 들어 있습니다 — `done` 1건, `pending` 1건, `create` 2건.

`pending` 샘플은 의도적인 것입니다. 기동하면 [기동 복구](#기동-복구가-복잡한-생존-감지를-대체한다)가 이 Job을 `create`로 되돌리고, 이어서 스케줄러가 처리합니다. 조회뿐 아니라 복구 규칙의 동작까지 한 번에 확인할 수 있습니다.

---

## 2. API 사용법

모든 응답 본문은 같은 형식입니다. `status`는 HTTP 상태 코드를 그대로 미러링합니다.

```json
{ "status": 200, "result": "success" }
```

- 목록 응답은 `list`(배열), 단건 응답은 `job`(객체)이 추가됩니다.
- `result`는 성공 시 `"success"`, 그 외에는 한국어 사유 메시지입니다.

### `POST /jobs` — 생성

```bash
curl -X POST http://localhost:3000/jobs \
  -H 'Content-Type: application/json' \
  -d '{"title":"가입 환영 메일 발송","description":"신규 가입자에게 환영 메일을 보낸다"}'
```

```json
{
  "status": 201,
  "result": "success",
  "job": {
    "id": "49176ec1-7f12-4d06-88b8-8c456d75f996",
    "title": "가입 환영 메일 발송",
    "description": "신규 가입자에게 환영 메일을 보낸다",
    "status": "create",
    "createdAt": "2026-09-04T09:29:04.136Z",
    "updatedAt": "2026-09-04T09:29:04.136Z"
  }
}
```

| 상황 | 상태 코드 |
|---|---:|
| 성공 | 201 |
| `title`/`description` 누락·타입 오류·길이 초과·공백만 | 400 |
| 정의되지 않은 필드 포함 (`status` 등) | 400 |
| 저장 실패 | 500 |

`title`은 최대 1,000자, `description`은 최대 2,000자입니다. 둘 다 **trim된 값으로 저장**하며 길이 제한도 trim 후 기준입니다.

### `GET /jobs` — 전체 조회

```bash
curl http://localhost:3000/jobs
```

```json
{
  "status": 200,
  "result": "success",
  "list": [
    { "id": "3f1c9a6e-...", "title": "월간 정산 리포트 생성", "status": "done", "...": "..." }
  ]
}
```

`createdAt` 오름차순, 동률이면 `id` 오름차순으로 정렬합니다. 빈 목록도 `200` + `list: []`입니다(오류가 아닙니다).

### `GET /jobs/search` — 검색

`title`, `description`, `status` 중 **하나 이상**이 필요합니다.

```bash
curl "http://localhost:3000/jobs/search?title=메일"
curl "http://localhost:3000/jobs/search?status=done"
curl "http://localhost:3000/jobs/search?title=리포트&status=create"
```

- `title`, `description`: 대소문자 구분 없는 **부분 일치**
- `status`: `create` | `pending` | `done` **정확 일치**
- 복수 조건은 **AND** 결합
- 정렬은 `GET /jobs`와 동일

| 상황 | 상태 코드 | `result` |
|---|---:|---|
| 1건 이상 | 200 | `success` |
| 결과 없음 | 200 | `데이터가 존재하지 않습니다.` (+ `list: []`) |
| 유효 조건 없음 | 400 | `title, description, status 중 하나 이상을 입력하여 주세요.` |
| `status`가 enum이 아님 | 400 | 유효성 검사 사유 |

**빈 문자열 파라미터의 처리 순서**를 명시적으로 고정했습니다. ① 각 파라미터를 trim하고 결과가 빈 문자열이면 **전달되지 않은 것으로 간주해 제거**한다 → ② 남은 파라미터가 없으면 400 → ③ 남은 파라미터에만 validation을 적용한다.

그래서 `?status=`는 enum validation을 타지 않고 "미입력"이 되어 400이 되고, `?title=&status=done`은 `status` 단독 검색이 됩니다. 정규화가 validation보다 **먼저** 오지 않으면 `?status=`가 "빈 문자열은 유효한 enum이 아니다"라는 엉뚱한 사유로 400이 됩니다.

### `GET /jobs/:id` — 단건 조회

```bash
curl http://localhost:3000/jobs/3f1c9a6e-5b47-4d2a-9c8e-1a2b3c4d5e6f
```

```json
{ "status": 200, "result": "success", "job": { "id": "3f1c9a6e-...", "...": "..." } }
```

| 상황 | 상태 코드 | `result` |
|---|---:|---|
| 존재 | 200 | `success` |
| UUID 형식 아님 | 400 | `id는 UUID 형식이어야 합니다.` |
| 존재하지 않음 | 404 | `존재하지 않는 데이터입니다.` |

### `PATCH /jobs/:id` — 수정

```bash
curl -X PATCH http://localhost:3000/jobs/9c3e5f2a-7d18-4a62-b93c-3c4d5e6f7081 \
  -H 'Content-Type: application/json' \
  -d '{"title":"수정된 제목"}'
```

`title`, `description` 중 하나 이상이 필요합니다. **`status`는 API로 변경할 수 없습니다** — 상태 전이는 스케줄러만 수행합니다.

| 상황 | 상태 코드 | `result` |
|---|---:|---|
| 성공 | 200 | `success` |
| validation 실패 | 400 | 유효성 검사 사유 |
| 존재하지 않음 | 404 | `존재하지 않는 데이터입니다.` |
| `done` | 409 | `이미 완료된 프로세스입니다.` |
| `pending` (처리 중) | 409 | `처리중인 프로세스입니다.` |

판정 우선순위는 **validation → 존재 → `done` → `pending`** 순으로 고정했습니다.

### 로깅

모든 HTTP 요청과 스케줄러 처리 결과를 `logs.txt`에 append합니다.

```text
[2026-09-04T09:28:53.157Z] [INFO] [storage] 기동 복구 완료: pending → create 1건, 전체 4건 로드 (...)
[2026-09-04T09:28:53.159Z] [INFO] [scheduler] 스케줄러 시작: 주기 1500ms, 처리 시간 300ms
[2026-09-04T09:28:53.162Z] [INFO] [http] 서버 기동 완료: http://localhost:3999
[2026-09-04T09:28:53.164Z] [INFO] [scheduler] 선점: job=7a2d4b18-... create → pending
[2026-09-04T09:28:53.541Z] [INFO] [scheduler] 완료: job=7a2d4b18-... pending → done
[2026-09-04T09:29:04.200Z] [INFO] [http] POST /jobs 201 64ms
[2026-09-04T09:29:04.375Z] [WARN] [http] GET /jobs/not-a-uuid 400 1ms
```

형식은 `[ISO8601 UTC] [LEVEL] [scope] message`이고, scope는 `http` | `scheduler` | `storage`입니다. 로그 기록 실패가 API 응답이나 스케줄러 처리를 실패시키지 않습니다(best-effort).

---

## 3. 구현에 대한 코멘트

### 과제의 핵심 질문에 대한 답

과제가 요구한 것은 **"API 요청과 스케줄러가 동시에 같은 데이터에 접근하는 환경에서 데이터가 손실되거나 깨지지 않게 하라"** 입니다. 이 문제를 네 개 규칙으로 나눠 풀었습니다.

| 문제 | 규칙 |
|---|---|
| 핸들러와 스케줄러가 서로의 변경을 덮어쓴다 (lost update) | **단일 mutex로 직렬화**하고, **저장이 성공한 뒤에만** 인메모리 상태를 교체 |
| 저장 도중 프로세스가 죽어 파일이 절단된다 | **임시 파일 + `fsync` + 원자적 `rename`** |
| 처리 중인 Job을 API가 수정해 결과가 소실된다 | `PATCH`는 `create` 상태만 허용. 상태 검사와 수정을 **같은 mutex 구간**에서 수행 |
| 처리 중 비정상 종료로 `pending`이 영구히 남는다 | **기동 시 `pending → create` 복구** |

#### 단일 스레드인데 왜 mutex가 필요한가

가장 자주 오해받는 지점이라 명시합니다. Node.js는 단일 스레드지만 **`await` 지점에서 실행이 교차합니다.**

```text
핸들러: 상태 읽기 ──▶ await(파일 I/O) ────────────▶ 낡은 값으로 쓰기
스케줄러:                    └─▶ 상태 변경 + 저장 ─┘   (← 스케줄러의 변경이 소실)
```

`jobs.json`을 쓰는 모든 경로가 하나의 promise chain을 통과하게 만들면 이 순서가 성립하지 않습니다. 별도 라이브러리 없이 20줄이면 됩니다.

```ts
private tail: Promise<unknown> = Promise.resolve();

private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = this.tail.then(fn, fn);   // 성공·실패 모두 연결 → 체인이 끊기지 않는다
  this.tail = result.then(() => undefined, () => undefined);
  return result;
}
```

`.then(fn, fn)`으로 성공·실패 양쪽에 같은 콜백을 연결한 것이 포인트입니다. 한쪽만 연결하면 앞선 작업이 실패했을 때 체인이 끊겨 이후 모든 변경이 영구히 멈춥니다. `test/jobs-store.spec.ts`에 이 케이스를 테스트로 고정해 두었습니다.

#### 저장 성공 → 상태 교체 순서

mutex 안에서 다음 순서를 지킵니다.

1. 현재 인메모리 상태의 **복사본**을 만든다
2. 복사본에 변경을 적용한다 (검증·조건 검사도 이 안에서)
3. 복사본을 디스크에 원자적으로 저장한다
4. **저장이 성공한 뒤에만** 인메모리 참조를 복사본으로 교체한다

4번의 순서가 중요합니다. 먼저 교체하면 저장이 실패했을 때 메모리와 디스크가 어긋나고, 그 뒤의 모든 응답이 실제로 저장되지 않은 데이터를 사실처럼 반환합니다. `test/concurrency.spec.ts`의 6번 시나리오가 이걸 검증합니다 — 저장을 강제로 실패시키면 `500`이 나가고 **인메모리와 디스크가 모두 변경 전 상태**로 남습니다.

부수 효과로 3번 전에 직렬화 결과를 비교하므로, 변경이 없으면 디스크 쓰기를 건너뜁니다.

#### `node-json-db`의 save를 쓰지 않은 이유

과제가 지정한 저장소이므로 **파싱·로드에는 `node-json-db`를 사용**하되, **디스크 게시는 직접 합니다.**

`node-json-db`의 저장 경로는 대상 파일에 직접 쓰기 때문에 쓰는 도중 프로세스가 죽으면 절단된 JSON이 남습니다. 그 파일은 다시 로드할 수 없고, 그러면 데이터 전체를 잃습니다. `rename`은 POSIX와 NTFS 모두에서 원자적이라, 임시 파일에 다 쓰고 `fsync`한 뒤 교체하면 `jobs.json`은 **항상 이전 또는 이후의 완전한 상태**입니다.

```ts
const handle = await fs.open(tmpPath, 'wx');
await handle.writeFile(serialized, 'utf8');
await handle.sync();          // 내용이 디스크에 도달한 뒤에
await handle.close();
await fs.rename(tmpPath, filePath);   // 원자적으로 교체
```

`rename`이 실패하면 임시 파일을 정리해 잔여물을 남기지 않습니다.

#### 기동 복구가 복잡한 생존 감지를 대체한다

writer가 하나이므로 **기동 시점에 진행 중인 처리는 존재할 수 없습니다.** 따라서 `pending`으로 남아 있는 Job은 예외 없이 "이전 실행이 처리 중 죽은 잔여물"이고, `create`로 되돌리는 것이 항상 옳습니다.

이 한 줄짜리 규칙이 초기 설계에서 필요했던 heartbeat·worker registry·lease·리더 선출 전체를 대체합니다. 실제로 확인했습니다 — 처리 중인 프로세스를 강제 종료(`TerminateProcess`)하면 Job이 `pending`으로 남고, 재기동하면 로그에 `기동 복구 완료: pending → create 1건`이 찍힌 뒤 정상 처리됩니다.

정상 종료 경로에서는 새 tick을 차단하고 진행 중인 tick이 끝날 때까지 최대 `SHUTDOWN_DRAIN_MS`를 기다립니다. tick은 항상 `done` 커밋 또는 `create` 롤백으로 끝나므로 drain이 완료되면 남는 `pending`이 없습니다.

> **알려진 환경 제약**: Windows에서 Git Bash의 `kill -TERM`은 네이티브 프로세스에 `TerminateProcess`를 호출하므로 Node가 신호를 받지 못하고, shutdown hook이 실행되지 않습니다. 이때는 위의 기동 복구가 안전망으로 동작합니다. Linux/macOS와 Windows 콘솔의 Ctrl+C에서는 hook이 정상 실행되며, 같은 경로(`app.close()`)를 `test/scheduler.spec.ts`에서 검증합니다.

### API 설계 결정

**응답 형식.** 본문에 `status`(HTTP 코드 미러링)와 `result`(성공/사유)를 두는 형식은 초기 설계에서 정한 계약을 유지했습니다. HTTP 상태 코드와 중복이지만, 클라이언트가 본문만 보고도 분기할 수 있어 실무에서 자주 쓰이는 형태입니다. 대신 **본문 `status`와 실제 HTTP 코드가 어긋나지 않도록** 예외 필터 한 곳에서 응답을 만들고, 테스트로 일치를 검증합니다.

**단건 응답은 `list: [job]`이 아니라 `job`.** 초기 설계는 모든 응답을 `list`로 통일하는 안도 허용했지만, 단건 조회가 배열을 반환하면 클라이언트가 매번 `[0]`을 꺼내야 하고 "0건일 수도 있다"는 잘못된 신호를 줍니다.

**`POST`는 201.** 초기 설계의 200에서 바꿨습니다. 새 리소스를 만드는 요청의 HTTP 시맨틱은 `201 Created`입니다.

**처리 중 수정은 409.** `403`(권한)이나 `422`(표현 오류)가 아니라 `409 Conflict`입니다 — 요청 자체는 유효하지만 리소스의 **현재 상태**와 충돌하기 때문입니다.

**검색에 `status`를 추가.** 초기 설계는 `title`·`description`만 받았지만 과제 원문은 "제목/**상태**로 검색"을 요구합니다. `status`를 추가하고 `description`은 확장으로 유지했습니다.

**`/jobs/search`를 `/jobs/:id`보다 먼저 선언.** 순서가 뒤바뀌면 `search`가 `:id`로 해석되어 UUID validation에 걸립니다. 라우트 선언 순서에 의존하는 부분이라 테스트로 고정했습니다.

**요청 로깅은 인터셉터가 아니라 미들웨어.** 인터셉터는 예외를 만나면 exception filter가 상태 코드를 확정하기 **전에** 종료되므로 에러 응답의 실제 코드를 알 수 없습니다. 미들웨어에서 `res.on('finish')`를 걸면 라우트 미매칭(404)·validation 실패(400)·필터가 만든 응답(500)까지 전부 최종 상태 코드로 기록됩니다. "모든 요청을 로깅"이 요구사항이라 정확성을 택했습니다.

### 성능과 한계

`jobs.json` 전체를 매번 직렬화·저장하므로 **데이터 크기에 비례해 쓰기 비용이 커집니다.** 과제 규모에서는 문제가 없지만, 수만 건 규모에서는 mutex 대기가 눈에 보이기 시작합니다.

의도적으로 감수한 트레이드오프입니다.

- **읽기는 인메모리에서 동기적으로** 처리하고 mutex를 거치지 않습니다. writer가 하나여서 부분 적용 상태를 관측할 수 없기 때문입니다. 조회 요청은 스케줄러 처리 중에도 대기 없이 응답합니다.
- **mutex는 처리 시간 동안 잡지 않습니다.** 선점(`create → pending`)만 mutex 안에서 커밋하고, 실제 처리는 mutex 밖에서 수행한 뒤 완료를 다시 mutex 안에서 커밋합니다. 그러지 않으면 `JOB_PROCESSING_MS` 내내 모든 API 요청이 멈춥니다. `test/concurrency.spec.ts`의 5번 시나리오가 이걸 검증합니다.
- 완료 직전에 **여전히 `pending`인지 다시 확인**합니다. 아니면 `done`으로 덮어쓰지 않습니다.

한 tick은 Job 1개만 처리합니다(과제가 허용한 자유 가정). 재진입 guard가 있어 이전 tick이 끝나지 않으면 이번 tick은 건너뜁니다.

---

## 4. 과제 해석 사항

명세에서 모호했던 부분에 대한 제 해석입니다.

1. **상태값을 3단계로 확장했습니다.** 과제 예시의 초기 상태는 `pending`이지만, 이 설계는 `create`(대기) → `pending`(**처리 중**) → `done`(완료)을 사용합니다. 스키마 자유 설계 범위 내의 결정입니다. `pending`이 일반적 어감과 달리 "처리 대기"가 아니라 **"선점되어 처리 중"** 을 의미한다는 점을 유의해 주세요 — 이 이름 때문에 `PATCH`가 409를 반환합니다.
2. **"제목/상태로 검색"** 은 `title`·`status` 쿼리 파라미터로 구현하고, 확장으로 `description`도 지원합니다.
3. **처리 주기(1분)와 처리 단위(tick당 1건)** 는 과제가 허용한 자유 가정입니다. 처리 시간은 5초로 두었습니다 — 주기보다 작아야 재진입 guard가 상시 발동하지 않습니다.
4. **응답 본문에 `status`·`result`를 두는 형식** 은 자유 설계 항목입니다.
5. **HTTP 서버와 스케줄러를 한 프로세스에서 실행합니다.** 과제의 "API 요청과 스케줄러가 동시에 같은 데이터에 접근하는 환경"을 `@nestjs/schedule`의 기본 사용 형태로 해석한 결과입니다. 같은 `jobs.json`을 여러 프로세스로 여는 구성은 지원하지 않습니다 — 아래에 이유를 적었습니다.
6. **실제 비즈니스 작업은 정의하지 않았습니다.** 스케줄러가 Job을 선점하고 일정 시간 처리한 뒤 완료로 바꾸는 과정을 처리로 간주합니다. 처리 로직은 주입 가능한 형태로 분리해 두었습니다.

---

## 5. 고민했던 지점과 되돌린 결정

### 다중 프로세스 + 파일 잠금 설계를 전면 철회했습니다

처음 설계는 API와 Worker를 각각 여러 프로세스로 띄우고 `jobs.json`을 파일 잠금으로 보호하는 구조였습니다([`docs/nestjs-jobs-backend-design.md`](docs/nestjs-jobs-backend-design.md)). `{jobId}-lock.json`, `jobs-global-lock.json`, worker heartbeat registry, 그리고 죽은 워커의 잠금을 회수하는 Reaper 선출까지 있었습니다.

7차에 걸쳐 적대적으로 검증하며 **총 22건의 결함**이 나온 뒤 철회했습니다. 결함들은 개별 실수가 아니라 한 가지 원인에서 파생됐습니다.

**파일시스템에는 DB가 공짜로 주는 두 가지가 없습니다.**

1. **여러 단계를 묶는 트랜잭션** — 원자적인 것은 `rename`·`link`·`O_EXCL` 생성 같은 **단일 syscall 하나**뿐이어서, "읽고 판단하고 쓴다"를 묶을 수단이 없습니다.
2. **세션에 묶인 잠금** — DB는 연결이 끊기면 락을 자동 해제하지만, 파일 잠금은 소유자가 죽었는지 알 방법이 없습니다.

2번을 흉내내려고 heartbeat·registry·stale timeout·리더 선출이 필요해졌고, 1번이 없어서 그 회수 절차를 안전하게 만들 수 없었습니다. 잠금 회수의 배타성을 확보하려는 시도는 **세 번 모두 실패**했습니다.

| 시도 | 실패 원인 |
|---|---|
| 조정용 mutex 파일로 회수를 직렬화 | mutex 자체의 `read → unlink → wx`에 같은 race. 누출되면 복구 기능이 영구 정지 |
| stale lock을 `rename`으로 배타적으로 이동 | A가 rename한 직후 **빈** 경로에 새 lock이 생기면, 뒤늦은 B의 rename이 그 **살아있는** lock을 이동 |
| 해제할 때 소유권을 먼저 읽어 확인 | 읽기와 rename 사이에 회수·재획득이 끼어들면 타인의 살아있는 lock을 이동 |

공통 원인은 **읽어서 판정한 파일 identity와 나중에 조작하는 pathname을 원자적으로 결속하는 POSIX 연산이 없다**는 것입니다. 마지막 판에서는 정확성을 잠금에서 버전 CAS(`fs.link`로 `versions/v{N+1}.json` 생성)로 옮겨 lost update를 막는 데까지 갔지만, 그 시점에 명세는 700줄·요구사항 60여 개가 되어 있었습니다.

과제가 요구한 것은 "동시 요청 상황에서도 데이터가 손실되거나 깨지지 않도록 고려해 주세요"이지 분산 합의가 아닙니다.

**그래서 잠금을 더 정교하게 만드는 대신, 빠져 있던 중재자를 되돌려놓았습니다.** writer를 프로세스 하나로 되돌리면 트랜잭션은 인메모리 mutex로, 생존 감지는 기동 복구 한 규칙으로 끝납니다. 잠금 파일·Reaper·lease·CAS·설정 fingerprint가 전부 사라지고 규칙 네 개가 남았습니다. 명세는 700줄에서 475줄로, 요구사항은 60여 개에서 49개로 줄었습니다.

이 판단이 **기능 축소가 아니라는 점**이 중요합니다. 철회한 설계도 결국 "한 번에 Job 하나를 처리"했고, 파일 하나를 공유 저장소로 쓰는 한 병목은 그 파일이었습니다. 프로세스를 늘려도 실효 처리량은 늘지 않으면서 정확성만 잃는 구조였습니다.

### 시간이 더 있다면

1. **수평 확장이 필요해지면 PostgreSQL이나 전용 queue로 옮기는 것이 옳습니다.** 파일 잠금을 정교하게 만드는 방향이 아닙니다. `SELECT ... FOR UPDATE SKIP LOCKED` 한 줄이 이 과제의 선점 문제 전체에 해당하고, 트랜잭션과 세션 기반 락이 위에서 실패한 세 시도를 전부 불필요하게 만듭니다.
2. **처리 재시도와 실패 상태.** 지금은 처리 실패 시 `create`로 롤백하므로 계속 실패하는 Job이 무한히 재시도됩니다. `attempts` 카운터와 `failed` 종결 상태, 지수 백오프가 필요합니다.
3. **목록 조회 페이지네이션.** `GET /jobs`가 전체를 반환합니다. 데이터가 커지면 cursor 기반 페이지네이션이 필요합니다.
4. **로그 로테이션.** `logs.txt`가 무한히 커집니다. 크기 기반 로테이션이나 외부 로그 수집기로 넘기는 편이 낫습니다.
5. **관측성.** 처리 지연·큐 길이·실패율을 메트릭으로 노출하면 `JOB_PROCESSING_MS`와 `CONSUME_INTERVAL_MS`를 근거 있게 조정할 수 있습니다.

---

## 6. 프로젝트 구조

```text
src/
├─ main.ts                          # 부트스트랩, 기동 실패 시 비-0 종료
├─ app.module.ts                    # ScheduleModule + 요청 로깅 미들웨어
├─ jobs/
│  ├─ jobs.controller.ts            # REST 엔드포인트
│  ├─ jobs.service.ts               # 도메인 로직 + 상태 전이
│  ├─ jobs.processor.ts             # 스케줄러 tick, 재진입 guard, 종료 drain
│  ├─ jobs.store.ts                 # ★ mutex + 원자적 저장 + 기동 복구
│  ├─ jobs.types.ts
│  ├─ job-task.ts                   # 주입 가능한 처리 로직
│  └─ dto/
└─ common/
   ├─ config.ts                     # 환경 변수 로드
   ├─ clock.ts                      # 주입 가능한 시계
   ├─ logging/                      # logs.txt 로거 + 요청 로깅 미들웨어
   └─ filters/                      # 공통 에러 응답 형식
data/
└─ jobs.json                        # 샘플 데이터 (커밋 대상)
docs/
├─ SPEC.md                          # 요구사항 명세 (테스트가 ID를 참조)
└─ nestjs-jobs-backend-design.md    # 초기 다중 프로세스 설계 (철회)
```

동시성 설계는 전부 `src/jobs/jobs.store.ts` 한 파일에 있습니다. 이 파일만 읽으면 데이터 무결성 보장의 전부를 확인할 수 있습니다.
