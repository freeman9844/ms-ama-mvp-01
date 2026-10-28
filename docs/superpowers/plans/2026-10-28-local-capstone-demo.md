# Capstone 로컬 데모 구현 계획

> **실행 에이전트 필독:** 이 계획은 `superpowers:subagent-driven-development` 또는 `superpowers:executing-plans` 스킬로 작업 단위별 실행한다. 단계는 `- [ ]` 체크박스로 추적한다. 구현 전에 사용자가 이 계획을 검토하고 실행 방식을 선택해야 한다.

**목표:** 사업자 신청부터 심사·경보·상환 지원·동의 삭제까지 원문의 5개 역할을 실제 Copilot SDK 추론과 함께 로컬에서 시연한다.

**아키텍처:** React와 업무 API는 같은 출처에서 서비스하고 별도 mock HTTP 서버가 은행·PG·세금 합성 자료를 제공한다. 코드 오케스트레이터와 SQLite 작업 상태가 흐름을 통제하며 3개 역할만 서버 측 Copilot SDK를 사용한다. 업무 DB와 원천 DB를 분리한다.

**기술 구성:** Node.js 24, TypeScript, React, Vite, Express, `node:sqlite`, `@github/copilot-sdk`, Zod, Vitest, Playwright, ESLint, Prettier.

**설계서:** `docs\superpowers\specs\2026-10-28-local-capstone-demo-design.md`

## 공통 제약

- TypeScript, React, SQLite를 사용하며 업무 DB와 mock 원천 DB를 분리한다.
- Data Assembly와 Consent Lifecycle은 코드로 구현한다.
- Underwriting, Early-Warning, Collections는 GitHub Copilot SDK로 실제 추론한다.
- 합성 데이터만 사용한다. 실제 대출·송금·고객 메시지 발송은 하지 않는다.
- 앱·데이터는 로컬이지만 Copilot 추론은 원격이며 사용량이 발생한다.
- Node.js 24에서 실행한다.
- 기본 앱 주소는 `http://127.0.0.1:3000`, mock API는 `http://127.0.0.1:3001`이다.
- 세션당 기본 제한은 120초, 도구 호출은 최대 8회다.
- 원천 HTTP 조회는 제한시간 10초, 일시적 네트워크·5xx 오류에 총 3회 이내로 재시도한다.
- 실제 API 오류가 일시적인 경우에만 작업당 총 2회 이내로 자동 시도하고, 인증·정책 오류는 자동 재시도하지 않는다.
- 기본 시연용 유효기간은 심사 D+30, 모니터링 D+60이며 화면에 명시한다.
- 초기 테스트 시각 D0는 `2026-10-28T00:00:00+09:00`이다.
- 화면·README·계획·설계 본문은 한국어로 작성한다. 코드 식별자와 API 경로는 영어를 사용한다.
- Windows 명령과 파일 경로를 사용한다. 기존 루트 분석 문서는 구현 중 변경하지 않는다.
- 전역 Copilot 설정·현재 CLI 세션을 재사용하거나 삭제하지 않는다. 앱 소유 런타임만 관리한다.
- 셸·파일·웹·MCP 도구, 자동 확장 설치, 무제한 권한 승인을 허용하지 않는다.
- 실제 모델을 선택하기 전에는 AI 작업을 실패 상태로 표시하며 자동 모델 선택이나 모의 성공으로 대체하지 않는다.

## 집중 검토할 조건

아래 다섯 조건을 해당 작업의 테스트로 고정한다.

1. 같은 날 여러 입출금이 있을 때 일중 순서를 모르면 임의로 안전하다고 판단하지 않는다. 일별 종가와 순서 미확인 표시를 구분한다. 작업 3.
2. 처음 조회한 뒤 원천이 변경되거나 같은 커서가 반복되면 부분 자료로 심사하지 않는다. 작업 2·3.
3. 철회 직전에 시작한 모델이 나중에 완료되어도 삭제한 평가를 되살리지 않는다. 작업 4·8.
4. 다른 탭의 오래된 심사 화면에서 승인하면 새 자료·철회 상태를 덮어쓰지 않는다. 작업 6.
5. Windows에서 포트가 이미 사용 중이거나 자식 서버가 비정상 종료하면 준비 완료를 표시하지 않고 자신이 시작한 프로세스만 종료한다. 작업 10.

---

## 1. 실행 순서와 범위

이 데모는 신청·동의·자료·평가·후속 관리를 공유하는 하나의 업무 흐름이므로 하나의 계획으로 유지한다. 인프라 배포나 별도 분석 플랫폼 계획은 추가하지 않는다.

| 작업 | 검토 가능한 산출물 | 선행 작업 |
|---|---|---|
| 1 | 실행 가능한 로컬 API, DB, 역할 세션과 테스트 기반 | 없음 |
| 2 | 동의 검사와 실제 HTTP mock 원천 | 1 |
| 3 | 완전성 검증과 재현 가능한 현금흐름 계산 | 2 |
| 4 | 영속 작업 실행기, 신청 제출, 재시작 복구 | 3 |
| 5 | 제한된 실제 SDK 어댑터와 모델 선택 | 3 |
| 6 | AI 심사와 사람의 버전 안전 승인 | 4, 5 |
| 7 | 자동 경보·상환 지원·합성 사건 처리 | 6 |
| 8 | 철회·만료·삭제와 늦은 결과 방지 | 7 |
| 9 | 사업자·담당자·운영자 React 화면 | 8 |
| 10 | 단일 실행 명령, 문서, 실제 SDK·전체 여정 확인 | 9 |

작업 5는 독립적인 연동 검증이 가능하지만 기본 실행 순서는 표의 번호를 따른다. 인증·모델·도구 격리가 불가능하면 그 지점에서 실제 추론 완료를 보류하고 원인을 보고한다.

### 파일 배치

| 파일 또는 디렉터리 | 소유 책임 |
|---|---|
| `demo\package.json`, `demo\package-lock.json` | 스크립트와 고정 의존성 |
| `demo\tsconfig.json`, `demo\vite.config.ts`, `demo\vitest.config.ts` | 타입·UI 빌드·테스트 |
| `demo\eslint.config.js`, `demo\.prettierrc.json` | lint·포맷 |
| `demo\src\domain\contracts.ts` | 런타임 Zod 스키마와 공통 타입 |
| `demo\src\domain\clock.ts`, `money.ts`, `forecast.ts` | 업무 시계와 순수 계산 |
| `demo\src\server\db.ts`, `schema.sql` | 업무 SQLite·마이그레이션 |
| `demo\src\server\app.ts`, `auth.ts`, `errors.ts` | 서버 구성·세션·오류 |
| `demo\src\server\routes\*.ts` | 인증된 업무 API |
| `demo\src\agents\consent.ts`, `assembly.ts`, `underwriting.ts`, `warning.ts`, `collections.ts` | 5개 역할 |
| `demo\src\workflow\queue.ts`, `runner.ts`, `handlers.ts` | 선점·복구·작업 연결 |
| `demo\src\copilot\port.ts`, `client.ts`, `tools.ts`, `schemas.ts` | SDK 경계·권한·검증 |
| `demo\src\mock\server.ts`, `schema.sql`, `seed.ts`, `events.ts` | 원천 HTTP·자료·사건 |
| `demo\src\web\App.tsx`, `api.ts`, `pages\*.tsx`, `styles.css` | 역할별 화면 |
| `demo\scripts\*.ts` | 실행·중단·실제 SDK 확인 |
| `demo\tests\helpers\*.ts`, `demo\tests\*.test.ts`, `demo\tests\e2e\*.spec.ts` | 테스트와 테스트 전용 대역 |
| `demo\README.md`, `demo\.env.example` | 실행 안내·비밀 없는 설정 예 |

`*.ts`는 배치 설명이다. 실제 작업별 파일명은 아래에 고정한다. 예시 코드는 해당 파일의 핵심 계약·분기이며 전체 파일을 한 블록에 모으라는 뜻이 아니다.

### 작업별 공통 실행 규칙

각 명령은 저장소 루트에서 새 PowerShell 프로세스로 실행한다고 가정한다. 먼저 `Set-Location .\demo`를 실행한다. 제품 의존성 설치·파일 생성은 이 계획 승인 후에만 한다.

실패 테스트 → 최소 구현 → 해당 테스트와 타입·lint·포맷 확인 → 작업 커밋 순서를 지킨다. 최초 기반 구성은 테스트 실행기가 실행될 정도까지만 만든 뒤 업무 코드 없이 실패를 확인한다.

각 커밋은 작업에 적힌 파일만 명시적으로 stage한다. `git add .`나 기존 untracked 문서 전체 추가를 하지 않는다. 커밋 메시지에는 다음 두 trailer를 붙인다.

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 8d1142a0-1765-47ea-ae88-b21cf81d5dd8
```

## 작업 1: 로컬 API·SQLite·역할 세션

**파일:** 위 구성 파일 7개, `demo\src\server\{db.ts,schema.sql,app.ts,auth.ts,errors.ts}`, `demo\src\domain\{contracts.ts,clock.ts}`, `demo\tests\helpers\system.ts`, `demo\tests\auth.test.ts` 생성. 루트 `.gitignore` 수정.

**입출력 계약:**

```ts
import type { DatabaseSync } from "node:sqlite";
import type { Express } from "express";

export type Role = "BORROWER" | "OFFICER" | "OPERATOR";
export type Account = "shop-a" | "shop-b" | "officer" | "operator";
export type Actor = { id: Account; role: Role; businessId: string | null };
export interface Clock { now(): Date }
export type ServerOptions = { db: DatabaseSync; clock: Clock; origin: string };
export function openDb(file: string): DatabaseSync;
export function createApp(options: ServerOptions): Express;
```

테스트 helper의 `startTestSystem()`은 임시 디렉터리·DB·루프백 임의 포트 서버를 생성한다. 반환값은 `db`, `url`, `request(account, method, path, body?, headers?)`, `close()`다. `request`는 `Promise<{ status: number; body: unknown }>`를 반환하며 데모 로그인·쿠키·CSRF를 처리한다. `close()`는 소유 서버·DB·해당 임시 디렉터리만 정리한다.

- [ ] **1. 테스트 실행에 필요한 구성만 만든다.** 런타임 의존성은 `express`, `react`, `react-dom`, `zod`; 개발 의존성은 TypeScript, tsx, Vite, Vitest, Playwright, ESLint, typescript-eslint, Prettier와 해당 `@types`다. 버전은 현재 Node 24 지원 여부를 확인하고 `--save-exact`와 lockfile을 사용한다.

```json
{
  "type": "module",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src scripts tests",
    "format:check": "prettier --check src scripts tests",
    "build": "tsc --noEmit && vite build"
  }
}
```

`tsconfig`는 `strict: true`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `jsx: "react-jsx"`를 사용한다. 내부 TS import는 출력 기준 `.js` 확장자로 통일한다. Vitest의 기본 대상은 `tests/**/*.test.ts`이고 유료·브라우저 테스트는 제외한다. `.gitignore`에는 `demo/node_modules/`, `demo/.local/`, `demo/dist/`, `demo/.env`, `demo/test-results/`, `demo/playwright-report/`를 추가한다.

- [ ] **2. 다른 사업자·역할 접근과 CSRF 실패를 테스트한다.**

```ts
it("요청 본문의 역할을 신뢰하지 않는다", async () => {
  const h = await startTestSystem();
  try {
    const response = await h.request("shop-a", "POST", "/api/demo/events", {
      role: "OPERATOR", type: "ADVANCE_TIME", days: 1,
    });
    expect(response.status).toBe(403);
  } finally {
    await h.close();
  }
});
```

서버 테스트에는 로그인 없이 접근 401, 다른 origin의 로그인 403, 변조된 CSRF 403, `/api/me`에서 shop-a의 사업자 범위 반환을 포함한다. 운영자 경로는 이 단계에 권한 검사와 명시적 501 응답만 두고 사건 구현은 작업 7에서 한다.

- [ ] **3. `npm test -- tests/auth.test.ts`로 실패를 확인한다.** 성공인 것처럼 고정 JSON을 반환해 통과시키지 않는다.
- [ ] **4. DB·세션을 구현한다.** `PRAGMA foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=5000`을 설정한다. 업무 DB에 `businesses`, `sessions`, `audit_events`, `settings`를 만든다. session ID와 CSRF는 암호학적으로 생성하고 role은 서버 측 고정 account 매핑으로 결정한다.

```ts
export function requireRole(actor: Actor, allowed: readonly Role[]): void {
  if (!allowed.includes(actor.role)) {
    throw new DomainError("FORBIDDEN", 403);
  }
}
export class DomainError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}
```

쿠키는 HttpOnly·SameSite=Strict·Path=/다. 로컬 HTTP에서 Secure 설정 때문에 로그인이 실패하지 않도록 하되 운영 인증으로 포장하지 않는다. 요청 본문 크기는 32KB로 제한한다. 알 수 없는 서버 예외는 원문 payload 없이 상관 ID와 오류 유형을 기록하고 500을 반환한다.

- [ ] **5. 대상 테스트·타입·lint·포맷을 실행하고 `feat: add local API and demo sessions`로 커밋한다.** 이 단계의 검증 가능한 산출물은 `/health`, `/api/me`, 역할·CSRF 차단이다.

## 작업 2: 동의 계약·분리된 mock HTTP 원천

**파일:** `demo\src\agents\consent.ts`, `demo\src\server\routes\consents.ts`, `demo\src\mock\{server.ts,schema.sql,seed.ts}`, `demo\tests\{consent.test.ts,mock.test.ts}` 생성. `schema.sql`, `contracts.ts`, `app.ts`, 테스트 helper 수정.

**입출력 계약:**

```ts
export type Purpose = "ASSESSMENT" | "MONITORING";
export type Source = "BANK" | "PG" | "TAX";
export type ConsentQuery = {
  consentId: string; businessId: string; purpose: Purpose; source: Source;
  resourceIds: string[]; from: string; to: string;
};
export type ConsentProof = { id: string; version: number; validUntil: string };
export function authorize(
  db: DatabaseSync, query: ConsentQuery, now: Date,
): ConsentProof;
export type SourcePage = {
  snapshotId: string; asOf: string; totalCount: number;
  nextCursor: string | null; items: SourceRecord[];
  balances: { openingKrw: number; closingKrw: number } | null;
};
```

`SourceRecord`는 Zod 판별 union으로 정의한다. 공통 필드는 `kind`, `id`, `businessId`, `resourceId`, `occurredAt`다. BANK는 `amountKrw`, `category`, `settlementId: string | null`; PG는 `netKrw`, `dueAt`, `status: "UNPAID" | "PAID" | "UNKNOWN"`; TAX는 `periodStart`, `periodEnd`, `reportedRevenueKrw`를 갖는다. 조회·응답은 `unknown`에서 스키마 검증 후 사용한다.

- [ ] **1. 기간 초과, 미동의, HTTP 서버 자체의 동의 차단을 실패 테스트로 작성한다.**

```ts
it("요청 기간이 동의 범위를 넘으면 전체 요청을 거부한다", () => {
  const h = createConsentFixture({ from: "2026-07-28T00:00:00+09:00" });
  try {
    expect(() => authorize(h.db, {
      ...h.query, from: "2026-04-28T00:00:00+09:00",
    }, new Date("2026-10-28T00:00:00+09:00"))).toThrow("CONSENT_SCOPE");
  } finally {
    h.close();
  }
});
```

이 작업의 `createConsentFixture(overrides)`를 `tests\helpers\consent.ts`에 생성한다. 반환값은 임시 DB·기본 `ConsentQuery`·종료 함수다. 시험 동의도 실제 등록 함수로 생성한다.

- [ ] **2. `npm test -- tests/consent.test.ts tests/mock.test.ts`를 실행해 미구현 실패를 확인한다.**
- [ ] **3. 동의·데이터 계약을 구현한다.** `consents`에 사업자·목적·원천·자원·조회기간·만료·상태·버전을 저장한다. 동의 등록 body에 명시적 `accepted: true`가 없으면 400이다. 만료 비교는 `now >= validUntil`이면 거부한다.

```ts
if (consent.status !== "ACTIVE" || now >= new Date(consent.validUntil)) {
  throw new DomainError("CONSENT_INACTIVE", 403);
}
if (query.businessId !== consent.businessId ||
    query.purpose !== consent.purpose ||
    query.source !== consent.source ||
    query.resourceIds.some(id => !consent.resourceIds.includes(id)) ||
    Date.parse(query.from) < Date.parse(consent.from) ||
    Date.parse(query.to) > Date.parse(consent.to)) {
  throw new DomainError("CONSENT_SCOPE", 403);
}
```

`consent`는 DB row를 스키마로 검증한 값이다. 잘못된 날짜·`from >= to`는 비교 전에 400으로 거부한다. 신규 동의는 기존 만료 동의를 덮어쓰지 않는다.

동의의 조회 허용기간과 유효기한은 별개다. 심사 은행 조회는 D-6개월~D0, 모니터링 은행 조회 허용 범위는 D-6개월~D+60으로 표시하고 실제 조회 종료는 현재 업무 시각까지만 허용한다. PG의 미래 정산 예정일은 snapshot 수집 시점과 구분하며 미래 예정일이라는 이유로 동의된 snapshot에서 누락하지 않는다. TAX는 표시한 신고기간만 동의받는다. `balances`는 은행 페이지에만 있으며 모든 페이지에서 같은 기초·기말 값을 반환한다.

- [ ] **4. mock 서버와 seed를 구현한다.** 부트스트랩에서 공유하는 임시 서비스 토큰을 서버 메모리로 전달하고 브라우저에 공개하지 않는다. mock API는 bearer 인증 후 `/internal/consents/authorize`를 호출한다. 검사 실패·앱 서버 불통 시 닫힌 상태로 거부한다. 페이지 생성 직전과 응답 직전 검사를 수행한다.

은행 seed는 기초 100만 원, 6개월 동안 합계 +200만 원으로 D0 300만 원을 맞춘다. 예를 들어 월별 영업 유입 +200만 원·비용 -170만 원을 6회, 별도 +20만 원 조정을 기록한다. 자기 계좌 이체 +50만 원/-50만 원, 대출 입금 +100만 원/기존 원금 상환 -100만 원을 추가해 잔액은 유지하되 영업현금흐름 분류를 검증한다.

```ts
expect(openingBalanceKrw +
  transactions.reduce((sum, row) => sum + row.amountKrw, 0))
  .toBe(3_000_000);
```

PG·TAX는 별도 원천 계약을 사용한다. PG D+3 미지급 500만 원과 TAX 신고기간 증빙을 제공한다. 두 번째 사업자 자료는 별도 ID를 사용한다. cursor는 서버가 발급한 snapshot·offset·query hash에 연결하며 다른 사업자·조회로 재사용하면 400이다.

- [ ] **5. snapshot 변경·커서 범위·빈 결과·서비스 토큰 없는 접근도 검증하고 `feat: add scoped consent and mock sources`로 커밋한다.**

## 작업 3: Data Assembly와 코드 기반 현금흐름

**파일:** `demo\src\agents\assembly.ts`, `demo\src\domain\{money.ts,forecast.ts}`, `demo\tests\{assembly.test.ts,forecast.test.ts}` 생성. 공통 계약·업무 schema 수정.

**입출력 계약:**

```ts
export type ScheduledFlow = {
  id: string; day: number; amountKrw: number;
  certainty: "CONFIRMED" | "UNKNOWN";
};
export type Forecast = {
  closingKrw: number; minimumKrw: number; shortageDays: number[];
  daily: { day: number; closingKrw: number }[];
  uncertainties: string[];
};
export function forecast(
  openingKrw: number, flows: readonly ScheduledFlow[], horizonDays: 7 | 30,
): Forecast;
export type DatasetRef = { id: string; version: number; consentIds: string[] };
export type AssemblyInput = {
  applicationId: string; businessId: string; purpose: Purpose;
  queries: ConsentQuery[];
};
export type SourceClient = { page(query: ConsentQuery, cursor: string | null):
  Promise<SourcePage> };
export function collect(
  db: DatabaseSync, clock: Clock, source: SourceClient, input: AssemblyInput,
  signal: AbortSignal,
): Promise<DatasetRef>;
```

- [ ] **1. 수치와 double counting을 테스트한다.**

```ts
const flows: ScheduledFlow[] = [
  { id: "pg-1", day: 3, amountKrw: 5_000_000, certainty: "CONFIRMED" },
  { id: "payroll", day: 5, amountKrw: -6_000_000, certainty: "CONFIRMED" },
  { id: "loan-1", day: 10, amountKrw: -1_000_000, certainty: "CONFIRMED" },
];
it("7일과 30일 최저 잔액을 구분한다", () => {
  expect(forecast(3_000_000, flows, 7).minimumKrw).toBe(2_000_000);
  expect(forecast(3_000_000, flows, 30).minimumKrw).toBe(1_000_000);
});
it("D+8 정산이면 D+5에 부족하다", () => {
  const delayed = flows.map(x => x.id === "pg-1" ? { ...x, day: 8 } : x);
  const result = forecast(3_000_000, delayed, 30);
  expect(result.minimumKrw).toBe(-3_000_000);
  expect(result.shortageDays).toContain(5);
});
```

동일 일자의 상쇄 입출금은 일별 종가로 계산하되 `INTRADAY_ORDER_UNKNOWN`을 남기는 테스트, UNKNOWN 정산 제외, NaN·소수 원·안전 정수 초과 거부를 추가한다.

- [ ] **2. `npm test -- tests/forecast.test.ts tests/assembly.test.ts`로 실패를 확인한다.**
- [ ] **3. 순수 계산과 완전성 검증을 구현한다.**

```ts
export function addKrw(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) ||
      !Number.isSafeInteger(a + b)) {
    throw new DomainError("INVALID_MONEY", 400);
  }
  return a + b;
}
```

전망은 D0 잔액을 포함해 매일 순유입을 누적한다. 기간 밖 흐름은 해당 기간 전망에 포함하지 않는다. 과거 예정일인데 지급 상태 미확인인 정산은 앞으로 받을 확정 현금으로 임의 이월하지 않는다. 30일 전체 미래 지출을 안다는 뜻이 아님을 `FUTURE_FLOWS_INCOMPLETE`로 표시한다.

은행의 실제 입금은 현재 잔액에 이미 반영하고 `PAID` PG를 다시 더하지 않는다. 영업현금흐름에서 자기 이체·대출 원금을 분리한다. 제안 상환 일정은 승인 후 동일 schedule key로 대체한다.

- [ ] **4. 수집을 원천별 고정 snapshot 기준으로 수행한다.** 동일 ID·동일 내용은 dedupe하되 상충 내용, cursor 반복, totalCount 불일치, 잔액 불일치이면 명시적 오류를 남긴다. HTTP는 10초 제한과 1초·2초 지수 대기를 사용해 총 3회까지만 시도한다.

앱 DB에는 `datasets`, `dataset_consents`, `source_records`, `forecasts`를 추가한다. 은행 row 고유 키는 `(dataset_id, source, resource_id, source_record_id)`다. 각 동의·목적의 자료를 같은 전역 row로 합쳐 삭제 계보를 잃지 않는다.

페이지마다 현재 동의를 재검사한다. 모든 자료를 검증한 뒤 짧은 트랜잭션에서 동의 버전을 다시 확인하고 검증된 dataset을 저장한다. 실행기 연결 전 단위 테스트는 이 반환값을 검증하고, 작업 4 연결 이후 제품에서는 dataset을 STAGED로 저장한 뒤 작업 완료 트랜잭션에서만 공개한다. STAGED 자료는 모델·API에서 읽을 수 없다.

- [ ] **5. 중간 페이지 실패·snapshot 교체·철회 중 수집·같은 ID의 상충 자료를 테스트하고 `feat: assemble consented cash-flow datasets`로 커밋한다.** 원천 오류는 `FAILED`, 고객 보완이 필요한 자료 불일치는 `NEEDS_INFORMATION`으로 분류한다.

## 작업 4: 신청과 영속 작업 실행기

**파일:** `demo\src\workflow\{queue.ts,runner.ts,handlers.ts}`, `demo\src\server\routes\{applications.ts,jobs.ts}`, `demo\tests\workflow.test.ts` 생성. 업무 schema·app·테스트 helper 수정.

**입출력 계약:**

```ts
export type JobKind = "ASSEMBLE" | "UNDERWRITE" | "MONITOR" | "SUPPORT" | "DELETE";
export type Job = {
  id: string; kind: JobKind; applicationId: string | null;
  businessId: string; consentIds: string[]; generation: number;
  attempt: number; claimToken: string;
};
export function claim(db: DatabaseSync, realNowMs: number): Job | null;
export function complete(
  db: DatabaseSync, job: Job, resultId: string, businessNow: Date,
): boolean;
export type JobHandler = (job: Job, signal: AbortSignal) => Promise<string>;
export function startRunner(
  db: DatabaseSync, clock: Clock, handlers: ReadonlyMap<JobKind, JobHandler>,
): { stop(): Promise<void> };
```

`generation`은 초기화 전후 작업 구분, `claimToken`은 임대 재선점 뒤 오래된 작업 결과 차단용이다. 삭제 작업의 consentIds는 삭제 대상 참조이며 ACTIVE 동의를 요구하는 자료 이용 작업과 구분한다.

- [ ] **1. 재선점 뒤 이전 실행의 완료 거부를 테스트한다.**

```ts
it("만료된 임대의 실행은 새 실행을 덮어쓰지 못한다", () => {
  const h = createQueueFixture();
  try {
    const first = claim(h.db, 0);
    const second = claim(h.db, 60_001);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) throw new Error("fixture did not enqueue a job");
    expect(first.claimToken).not.toBe(second.claimToken);
    expect(complete(h.db, first, "old-result", h.clock.now())).toBe(false);
  } finally {
    h.close();
  }
});
```

`tests\helpers\queue.ts`에 `createQueueFixture()`를 구현해 하나의 실행 가능한 작업을 저장한다. 검증에 필요한 결과 row도 fixture에서 실제 FK를 만족하게 생성한다.

- [ ] **2. `npm test -- tests/workflow.test.ts`에서 실패를 확인한다.**
- [ ] **3. SQLite 작업·멱등성 테이블을 구현한다.** `applications`, `jobs`, `idempotency_keys`에 신청 상태·입력 fingerprint·임대·retryAt·attempt·claimToken·generation을 기록한다.

```sql
UPDATE jobs
SET status = 'RUNNING', claim_token = ?, lease_until_ms = ?, attempt = attempt + 1
WHERE id = ? AND (status = 'QUEUED' OR
  (status = 'RUNNING' AND lease_until_ms <= ?));
```

선점은 BEGIN IMMEDIATE 안에서 후보 선택과 UPDATE를 실행한다. 임대 60초, 10초 하트비트, 기본 폴링 500ms를 사용한다. 하트비트·완료 모두 claimToken과 generation을 비교한다. 동의 무효화·현재 임대 불일치는 결과 저장 전에 거부한다. 필요한 결과 저장과 작업 완료는 같은 트랜잭션으로 결합한다.

작업 3의 STAGED dataset 및 이후 역할의 STAGED 결과를 `resultId`로 참조하고 `complete`에서 공개한다. 중간 저장에도 현재 동의·job generation·claimToken을 확인한다. 이를 위해 작업 4에서 `AssemblyInput`에 `job: Job`을 추가하고 해당 테스트 helper도 실제 job을 생성하도록 갱신한다. SDK 작업의 총 2회 제한에는 재시작으로 재실행한 호출도 포함한다. 제한을 넘으면 FAILED이며 운영자 재시도는 새 작업으로 이력을 남긴다.

- [ ] **4. 제출·조회·재시도 API를 연결한다.** `POST /api/applications`는 소유자·심사 동의 검증 후 신청과 ASSEMBLE을 같은 트랜잭션에서 생성하고 202를 반환한다. `POST /api/jobs/:id/retry`는 소유자 또는 담당자에게 실패 사유별 재시도 가능 여부를 검사한다. 동의가 없으면 재시도하지 않는다.

멱등 키는 `(actor_id, route, key)`로 범위를 정하고 정규화 body의 SHA-256 fingerprint와 비교한다. 같은 키 다른 body는 409다. 성공 중복은 기존 ID를 반환한다. 작업 payload에는 금융 원문이 아니라 참조 ID만 저장한다.

`GET /api/applications`, `GET /api/applications/:id`, `GET /api/jobs/:id`는 사업자 소유권과 역할별 응답 필터를 적용한다. 보완자료는 `POST /api/applications/:id/corrections`로 준비된 fixture ID만 받고 새 수집·평가 버전을 시작한다.

- [ ] **5. 실제 DB 파일 재오픈, 중복 제출·보완, 중단·재시도, 두 선점 경쟁을 검증하고 `feat: persist application workflow and recovery`로 커밋한다.**

## 작업 5: 실제 Copilot SDK와 제한된 도구

**파일:** `demo\src\copilot\{port.ts,client.ts,tools.ts,schemas.ts}`, `demo\src\server\routes\ai.ts`, `demo\scripts\ai-smoke.ts`, `demo\tests\{copilot.test.ts,helpers\fake-ai.ts}` 생성. manifest·lockfile·app 수정.

**입출력 계약:**

```ts
export type AiRole = "UNDERWRITING" | "WARNING" | "COLLECTIONS";
export type AiRequest = {
  role: AiRole; businessId: string; jobId: string;
  dataset: DatasetRef | null; modelId: string; prompt: string;
};
export type AiResult = {
  text: string; sessionId: string; modelId: string;
  usage: { inputTokens: number; outputTokens: number } | null;
};
export interface AiPort {
  listModels(): Promise<{ id: string; name: string }[]>;
  run(request: AiRequest, signal: AbortSignal): Promise<AiResult>;
  deleteSession(id: string): Promise<void>;
  stop(): Promise<void>;
}
```

`AiPort`는 모델 호출을 감싸는 작은 인터페이스다. fake는 tests 안에만 두며 제품 환경변수로 가짜 성공을 선택할 수 없게 한다.

- [ ] **1. SDK 패키지를 exact version으로 추가하고 설치된 README·타입을 확인한다.** 공식 문서의 `mode`, `baseDirectory`, `availableTools`, 권한 처리기, session 삭제의 실제 지원을 확인한다. 미지원 설정은 `as any`로 우회하지 않는다.
- [ ] **2. 모델 미선택과 임의 도구 거부 테스트를 작성한다.**

```ts
it("미선택 모델은 기본 모델로 대체하지 않는다", async () => {
  const h = createAiFixture();
  await expect(h.ai.run({
    role: "UNDERWRITING", businessId: "shop-a", jobId: "job-1",
    dataset: null, modelId: "", prompt: "합성 자료 확인",
  }, new AbortController().signal)).rejects.toThrow("MODEL_NOT_SELECTED");
  expect(h.createSession).not.toHaveBeenCalled();
});
```

`tests\helpers\fake-ai.ts`의 `createAiFixture()`는 SDK client transport를 mock하는 계약 테스트 helper다. `createSession` 호출 여부·설정·도구 실행·abort를 관찰한다. production은 실제 `CopilotClient`를 사용한다.

- [ ] **3. `npm test -- tests/copilot.test.ts`로 실패를 확인하고 어댑터를 구현한다.**

```ts
const client = new CopilotClient({
  mode: "empty",
  workingDirectory: runtimeDirectory,
  baseDirectory: copilotDataDirectory,
  logLevel: "error",
});
await client.start();
const models = await client.listModels();
if (!models.some(model => model.id === requestedModelId)) {
  throw new DomainError("MODEL_UNAVAILABLE", 409);
}
```

`runtimeDirectory`와 `copilotDataDirectory`는 앱이 생성한 `demo\.local` 하위 전용 경로다. `mode: "empty"`만으로 안전하다고 간주하지 않는다. 등록한 앱 도구명만 허용 목록으로 지정하고 cross-session store·무한 세션·불필요한 자동 기능을 비활성화한다. 인증이 분리된 홈 때문에 실패하면 사용자에게 승인된 로그인·인증 설정 절차를 안내하며 전역 설정이나 자격증명 파일을 복사하지 않는다.

도구는 `get_evidence`, `get_policy`, `run_cashflow_scenario` 세 개로 제한한다. `get_evidence`는 evidence ID 목록만, `get_policy`는 역할에 맞는 정책 key만, 시나리오는 승인된 `settlement_delay_days` 정수 0~30만 입력받는다. businessId와 dataset은 handler closure로 결합한다. 인가를 통과하지 못한 SDK 권한 요청은 설치 버전의 명시적 거부 타입으로 반환한다.

- [ ] **4. 제한·출력·정리를 구현하고 테스트한다.** 도구 호출 직전에 작업·동의 유효성을 검사하고 9번째 호출을 거부한다. `sendAndWait`는 120초로 제한한다. timeout·AbortSignal 발생 시 해당 session을 abort하고 타이머·리스너를 정리한다. Promise.race만 하고 실제 작업을 방치하지 않는다.

```ts
const message = await session.sendAndWait({ prompt: request.prompt }, 120_000);
if (!message) throw new DomainError("AI_EMPTY_RESPONSE", 502);
const output: unknown = JSON.parse(message.data.content);
const assessment = assessmentSchema.parse(output);
```

`assessmentSchema`는 다음 작업의 심사 출력 계약으로 정의한다. 경보·지원도 각 schema로 검증한다. JSON 오류는 명시적 `AI_INVALID_OUTPUT`으로 변환해 원문 없이 기록한다. session ID는 생성 즉시 DB의 앱 소유 목록에 기록한다. `disconnect`는 삭제가 아니므로 완료 후 명시적 `deleteSession`과 정리 상태 기록을 수행한다.

```ts
export const assessmentSchema = z.object({
  recommendation: z.enum(["REVIEW", "REQUEST_INFORMATION", "DECLINE_RECOMMENDED"]),
  factors: z.array(z.object({
    label: z.string().min(1), evidenceIds: z.array(z.string()),
  })),
  uncertainties: z.array(z.string()),
  explanation: z.string().min(1),
});
export const warningSchema = z.object({
  explanation: z.string().min(1),
  evidenceIds: z.array(z.string()),
  uncertainties: z.array(z.string()),
});
export const supportSchema = z.object({
  route: z.enum(["GENERAL_INQUIRY", "PAYMENT_DIFFICULTY",
    "DISPUTE_OR_CORRECTION", "HUMAN_REVIEW"]),
  explanation: z.string().min(1),
  evidenceIds: z.array(z.string()),
});
```

근거 조회가 필요 없는 일반 지원은 `dataset: null`을 허용하되 `get_evidence`·현금흐름 도구를 노출하지 않는다. SDK 세션 registry·도구 로그·설정 테이블을 이 작업에서 생성한다. 출력을 역할별 schema로 검사한 뒤 `AiResult.text`에 검증된 JSON을 반환한다. usage 누락은 null이며 0으로 바꾸지 않는다.

모델 선택은 운영자 `GET /api/ai/models`, `PUT /api/ai/settings`로 설정한다. 새 작업에 선택한 ID를 고정하고 실행 중 설정 변경으로 모델을 바꾸지 않는다.

- [ ] **5. 실제 연동 확인용 명령을 구현한다.**

```powershell
Set-Location .\demo
npm run ai:smoke -- --list-models
npm run ai:smoke -- --model $env:DEMO_MODEL_ID
```

`ai:smoke`는 `tsx scripts/ai-smoke.ts`다. 목록 명령은 인증과 모델 목록만 확인한다. 운영자가 선택한 모델을 두 번째 명령에 전달하며 알려지지 않은 ID를 미리 쓰지 않는다. 실제 추론은 합성 300만 원과 확인된 500만 원으로 제한하고, 지정 도구 실행·차단 정책·세션 삭제를 확인한다. 실패하면 비영(非零) 종료 코드를 반환한다.

- [ ] **6. 인증정보·금융 원문이 로그와 Git에 없는지 확인하고 `feat: integrate constrained Copilot inference`로 커밋한다.** 실제 호출 미완료는 대역 테스트 통과와 별개로 기록한다.

## 작업 6: Underwriting과 담당자 승인

**파일:** `demo\src\agents\underwriting.ts`, `demo\src\server\routes\review.ts`, `demo\tests\underwriting.test.ts` 생성. schema·SDK schemas·workflow handlers 수정.

**입출력 계약:**

```ts
export type Assessment = {
  recommendation: "REVIEW" | "REQUEST_INFORMATION" | "DECLINE_RECOMMENDED";
  factors: { label: string; evidenceIds: string[] }[];
  uncertainties: string[]; explanation: string;
};
export type ReviewInput = {
  applicationId: string; datasetVersion: number; assessmentVersion: number;
  decision: "APPROVE" | "REJECT" | "REQUEST_INFORMATION"; reason: string;
};
export function review(
  db: DatabaseSync, clock: Clock, actor: Actor, input: ReviewInput,
): { decisionId: string; applicationStatus: string };
```

`createUnderwriter(db: DatabaseSync, clock: Clock, ai: AiPort): JobHandler`를 이 역할 모듈에 구현해 UNDERWRITE handler로 등록한다. 반환된 handler는 해당 job·dataset·model 설정을 조회하고 검증한 Assessment ID를 반환한다.

- [ ] **1. 오래된 평가 승인과 LLM 실패 후 승인 차단을 테스트한다.**

```ts
it("다른 탭에서 만든 오래된 평가로 승인할 수 없다", () => {
  const h = createReviewFixture({ datasetVersion: 2, assessmentVersion: 2 });
  try {
    expect(() => review(h.db, h.clock, h.officer, {
      applicationId: h.applicationId, datasetVersion: 1, assessmentVersion: 1,
      decision: "APPROVE", reason: "합성 현금흐름 확인",
    })).toThrow("STALE_REVIEW");
  } finally {
    h.close();
  }
});
```

`tests\helpers\review.ts`에 `createReviewFixture`를 추가한다. 승인 가능한 신청·동의·데이터·평가를 실제 schema로 저장한다.

- [ ] **2. `npm test -- tests/underwriting.test.ts`로 실패를 확인한다.**
- [ ] **3. 심사 agent와 근거 검증을 구현한다.** ASSEMBLE 성공 후 한 번만 UNDERWRITE를 enqueue한다. 모델은 코드가 계산한 7일·30일 전망과 영업흐름 요인을 읽고 필요하면 허용된 시나리오 도구를 선택한다.

```ts
for (const factor of assessment.factors) {
  if (factor.evidenceIds.some(id => !allowedEvidenceIds.has(id))) {
    throw new DomainError("AI_UNKNOWN_EVIDENCE", 502);
  }
}
```

정책은 데모용으로 명시한다. 불완전 자료는 분석 불가, 음수 전망은 담당자 추가 검토, 동의 차단은 작업 중지다. 임의의 신용점수·정확도·승인 확률을 만들지 않는다. 모델 지시와 버전을 저장하되 민감한 응답 원문을 audit에 복사하지 않는다.

- [ ] **4. 사람의 결정 트랜잭션을 구현한다.** `assessments`, `decisions`, `loans`, `repayment_schedules`를 추가한다. BEGIN IMMEDIATE 안에서 role·현재 상태·동의 만료·dataset version·assessment version을 확인한다. 모두 일치할 때만 결정과 대출을 원자적으로 생성한다.

신청당 하나의 최초 대출을 고유 제약으로 보장한다. 같은 멱등 키는 같은 결정 ID를 반환한다. 다른 키로 재승인하면 409다. D+10 가정 상환은 승인 시 같은 schedule key의 확정 모의 일정으로 전환한다.

- [ ] **5. 근거 위조·borrower 승인·미동의 승인·동시 승인·LLM 오류를 검증하고 `feat: add AI assessment and human approval`로 커밋한다.**

## 작업 7: Early-Warning·Collections·합성 사건

**파일:** `demo\src\agents\{warning.ts,collections.ts}`, `demo\src\mock\events.ts`, `demo\src\server\routes\{events.ts,support.ts}`, `demo\src\domain\support-policy.ts`, `demo\tests\{warning.test.ts,collections.test.ts,events.test.ts}` 생성. schema·handlers·contracts 수정.

**입출력 계약:**

```ts
export type DemoEvent =
  | { id: string; type: "SETTLEMENT_DELAY"; settlementId: string; dueAt: string }
  | { id: string; type: "SETTLEMENT_PAID"; settlementId: string }
  | { id: string; type: "MISSED_PAYMENT"; scheduleId: string }
  | { id: string; type: "PAYMENT_RECEIVED"; scheduleId: string }
  | { id: string; type: "SOURCE_FAILURE"; source: Source; requests: number }
  | { id: string; type: "ADVANCE_TIME"; days: number };
export type SupportRoute =
  "GENERAL_INQUIRY" | "PAYMENT_DIFFICULTY" |
  "DISPUTE_OR_CORRECTION" | "HUMAN_REVIEW";
export function createMonitor(db: DatabaseSync, clock: Clock, ai: AiPort): JobHandler;
export function createSupportAgent(db: DatabaseSync, clock: Clock, ai: AiPort): JobHandler;
```

- [ ] **1. 모델 실패해도 규칙 경보가 남는 테스트를 작성한다.**

```ts
it("AI 설명 실패는 유동성 부족 경보를 취소하지 않는다", async () => {
  const h = await createMonitoringFixture({ failAi: true, settlementDay: 8 });
  try {
    await h.runMonitor();
    expect(h.alerts()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LIQUIDITY_SHORTFALL", explanationStatus: "FAILED" }),
    ]));
    expect(h.collectionCount()).toBe(0);
  } finally {
    await h.close();
  }
});
```

`tests\helpers\monitoring.ts`에 해당 fixture를 구현한다. 승인된 모의 대출·별도 모니터링 동의·지연 PG를 실제 수집한 dataset으로 준비한다.

- [ ] **2. `npm test -- tests/warning.test.ts tests/collections.test.ts tests/events.test.ts`로 실패를 확인한다.**
- [ ] **3. 모니터링과 사건을 연결한다.** 원천 사건은 인증된 내부 HTTP 명령으로 전달한다. 원천 사건 ID 고유 제약과 원자적 BANK/PG 갱신으로 지급 재처리를 막는다. 앱 `demo_events`에 PENDING/APPLIED를 기록하고 HTTP 후 앱 반영 전에 죽어도 같은 ID로 재호출한다.

유효한 별도 모니터링 동의가 있는 승인 대출만 MONITOR 수집을 수행한다. 테스트 시계의 날짜 변경과 원천 사건 뒤 enqueue하며 변경 없는 날은 dataset fingerprint로 중복 경보를 막는다.

```ts
if (forecast30.minimumKrw < 0) {
  saveRuleAlert("LIQUIDITY_SHORTFALL", forecast30.minimumKrw);
}
```

`saveRuleAlert`는 `warning.ts`의 내부 DB 함수다. 경보를 먼저 영속화하고 그 다음 모델 설명을 요청한다. 날짜 이동만으로 실제 미납을 만들지 않는다. MISSED_PAYMENT는 승인 대출의 기한 도래 일정만 허용하고 미래 일정은 409다.

SDK 설명 실패와 규칙 경보 생성을 다른 결과로 기록한다. 앱 내부 경보 생성은 유효한 동의·작업 claim을 확인한 트랜잭션에서 수행하며, 모델 실패 후에도 이 경보는 ACTIVE로 유지한다. 설명 재시도는 기존 경보에 연결하고 경보를 새로 중복 생성하지 않는다.

- [ ] **4. 상환 지원과 mock 안내를 구현한다.** `support_requests`, `support_reviews`, `alerts`, `mock_messages`를 추가한다. 고객 요청 유형은 문의·곤란·이의/정정·고충으로 기록하며 모델은 허용 경로와 근거만 반환한다.

```ts
export const templates: Record<SupportRoute, string> = {
  GENERAL_INQUIRY: "문의를 접수했습니다. 담당자가 확인합니다.",
  PAYMENT_DIFFICULTY: "상환 지원 요청을 접수했습니다. 변경 조건은 담당자 승인 후 안내됩니다.",
  DISPUTE_OR_CORRECTION: "정정 또는 이의 요청을 접수했습니다. 담당자가 자료를 확인합니다.",
  HUMAN_REVIEW: "담당자 검토가 필요한 요청으로 접수했습니다.",
};
```

자유 생성 메시지를 자동 발송하지 않는다. 동일 사건·템플릿 고유 키와 신청·업무 날짜별 발송 트랜잭션으로 1일 1건을 보장한다. 억제한 안내는 SUPPRESSED 사유를 기록한다. 모델 실패는 담당자 검토 대기로 남긴다.

`POST /api/support-requests/:id/review`에서 담당자가 검토 완료 또는 새 납부일 제안을 승인한다. 금액 감면·금리 변경은 이번 모의 조건에 추가하지 않는다. 날짜 변경은 기존 schedule version과 합법 날짜 범위를 검사한 다음 기록한다.

날짜 변경 범위는 기존 납부일 이후 최대 30일이며 현재 업무 날짜보다 과거일 수 없다. 이는 법률상 한도를 주장하는 것이 아닌 시연용 정책이다. 담당자의 버전 일치 승인 없이 변경하지 않는다.

- [ ] **5. 날짜 이동·정산 지급 중복·미납과 경보 분리·발송 빈도·모델의 임의 조건 거부를 검증하고 `feat: add warning and fair support workflows`로 커밋한다.**

## 작업 8: 철회·만료·삭제와 작업 경쟁

**파일:** `demo\src\agents\consent.ts`, `demo\src\workflow\{runner.ts,handlers.ts}`, `demo\src\copilot\client.ts`, 업무 schema 수정. `demo\src\server\deletion.ts`, `demo\tests\deletion.test.ts` 생성.

**입출력 계약:**

```ts
export function revokeConsent(
  db: DatabaseSync, clock: Clock, actor: Actor, consentId: string,
): { access: "BLOCKED"; deletionJobId: string };
export function expireConsents(db: DatabaseSync, clock: Clock): number;
export function createDeletionHandler(
  db: DatabaseSync, ai: AiPort,
): JobHandler;
```

- [ ] **1. 철회 도중 모델 결과 경쟁을 테스트한다.**

```ts
it("철회 뒤 도착한 모델 결과를 저장하지 않는다", async () => {
  const h = await createRevocationFixture();
  try {
    const running = h.startAssessment();
    await h.waitUntilModelStarted();
    revokeConsent(h.db, h.clock, h.borrower, h.consentId);
    h.finishModel();
    await expect(running).rejects.toThrow("CONSENT_INACTIVE");
    expect(h.assessmentCount()).toBe(0);
  } finally {
    await h.close();
  }
});
```

`tests\helpers\revocation.ts`의 fixture는 deferred promise로 정확한 경쟁 시점을 제어한다. 고정 sleep으로 우연한 순서에 의존하지 않는다.

- [ ] **2. `npm test -- tests/deletion.test.ts`로 실패를 확인한다.**
- [ ] **3. 차단과 삭제를 분리한다.** 철회 트랜잭션에서 상태·동의 version을 갱신하고 관련 jobs·datasets를 무효화한 뒤 DELETE를 생성한다. API는 차단 완료·삭제 대기를 반환한다. 만료 처리기는 1초마다 및 재시작 시 실행하고 시간 이동 직후에도 실행한다. 인가 함수는 처리기 실행 여부와 무관하게 만료를 검사한다.

삭제는 `dataset_consents`의 계보를 따라 원자료·전망·평가·경보 설명·관련 캐시를 정리한다. 두 동의에 근거한 파생 결과는 한 동의가 무효화되어도 전체 결과를 무효화하고 다시 계산해야 한다. 다른 목적의 별도 dataset은 보존한다.

```sql
UPDATE consents SET status = 'REVOKED', version = version + 1 WHERE id = ?;
UPDATE datasets SET validation_status = 'INVALIDATED'
WHERE id IN (SELECT dataset_id FROM dataset_consents WHERE consent_id = ?);
```

위 SQL은 철회 트랜잭션의 일부다. 작업 차단과 삭제 enqueue도 같은 트랜잭션에서 실행한다.

- [ ] **4. SDK 세션·앱 파생 내용의 삭제를 연결한다.** SDK session ID registry에서 해당 동의의 소유 세션만 abort·delete한다. 실패 시 CLEANUP_FAILED로 남겨 명시적으로 재시도한다. 로컬 row 삭제 성공만으로 전체 삭제 COMPLETE를 표시하지 않는다.

사람의 결정 이유·지원·mock 메시지에 삭제 대상 금융 값이 복사되지 않도록 ID·고정 템플릿 중심으로 저장한다. 삭제된 근거를 가리키는 남은 업무 기록에는 `근거 자료 삭제됨`을 표시한다. app·mock DB 외부로 백업을 만들지 않는다.

- [ ] **5. 만료 경계·page 응답 직전 철회·삭제 중 재시작·SDK 정리 실패·다른 목적 보존·원천 보존을 검증하고 `feat: enforce consent deletion lifecycle`로 커밋한다.**

## 작업 9: 한국어 사업자 포털·담당자·데모 화면

**파일:** `demo\index.html`, `demo\src\web\{main.tsx,App.tsx,api.ts,styles.css}`, `demo\src\web\pages\{Home.tsx,Application.tsx,ApplicationStatus.tsx,Consents.tsx,Repayments.tsx,Support.tsx,Officer.tsx,DemoControls.tsx}`, `demo\tests\e2e\portal.spec.ts`, `demo\playwright.config.ts` 생성. app·routes 수정.

**입출력 계약:**

```ts
export async function apiRequest<T>(
  path: string, schema: z.ZodType<T>, init?: RequestInit,
): Promise<T>;
```

`apiRequest`는 same-origin fetch와 CSRF를 사용하고 성공 응답도 schema로 검증한다. HTTP 오류는 한국어 안내와 correlation ID를 표시한다. 폴링 응답에 오류가 있으면 마지막 성공 상태를 완료 상태로 오인하지 않는다.

- [ ] **1. 기본 동의와 신청 화면 흐름을 브라우저 실패 테스트로 작성한다.**

```ts
test("동의는 사전 선택되지 않고 수집 결과 승인 단계가 없다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "합성 사업자 A로 시작" }).click();
  await page.getByRole("link", { name: "대출 신청" }).click();
  await expect(page.getByRole("checkbox", { name: "신청 심사 데이터 제공 동의" }))
    .not.toBeChecked();
  await expect(page.getByRole("button", { name: "최종 제출" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "신청 심사 데이터 제공 동의" }).check();
  await page.getByRole("button", { name: "최종 제출" }).click();
  await expect(page.getByText("자료 수집 중")).toBeVisible();
  await expect(page.getByRole("button", { name: "수집 결과 승인" })).toHaveCount(0);
});
```

- [ ] **2. `npm run test:e2e -- tests\e2e\portal.spec.ts`로 실패를 확인한다.** 이 작업에서 `test:e2e` 스크립트와 `tests\helpers\browser-server.ts`를 추가한다. 테스트 서버는 fake AiPort를 주입하는 tests 전용 bootstrap을 사용한다. 제품 launcher에는 이 선택지를 제공하지 않는다.
- [ ] **3. 승인된 화면을 구현한다.**

```tsx
<label>
  <input type="checkbox" checked={assessmentConsent}
    onChange={event => setAssessmentConsent(event.target.checked)} />
  신청 심사 데이터 제공 동의
</label>
<button disabled={!assessmentConsent || submitting} onClick={submitApplication}>
  최종 제출
</button>
```

`assessmentConsent`는 false로 시작한다. 실제 화면은 원천·목적·기간·항목을 각각 펼쳐 확인하게 하고 최종 제출 전 서버 등록 결과를 확인한다. 모니터링 동의는 별도 선택이다.

`submitApplication(): Promise<void>`는 선택한 원천별 동의를 `/api/consents`에 등록한 뒤 반환된 consent ID로 `/api/applications`를 호출한다. 동의 등록·신청 어느 단계든 실패하면 에러를 표시하고 같은 멱등 키로 재시도한다. 성공 응답의 신청 ID로 상태 화면을 연다.

홈과 신청 상태에는 실패·재시도·보완을 구분한다. 2초 폴링은 unmount·로그아웃·종결 상태에서 취소하고 요청 중 중첩 호출하지 않는다. 담당자 상세는 규칙 계산·근거·AI 설명을 분리하며 승인 payload에 표시 중인 두 version을 포함한다.

- [ ] **4. 필요한 읽기 API를 완성한다.** `GET /api/consents`, `GET /api/loans`, `GET /api/support-requests`, `GET /api/alerts`, `GET /api/timeline`을 역할·사업자 범위로 구현한다. 로그의 모델 내부 사고과정이나 도구 원문을 UI로 보내지 않는다.

DemoControls에는 명시적 모델 선택, 사건 입력, 시간 이동, 원천 장애, 초기화를 둔다. 현재 선택 모델·합성 모드·원격 추론 비용·국내 처리 미충족 안내를 표시한다. 자유 입력에는 실제 개인·금융 정보를 넣지 말라는 안내를 둔다.

- [ ] **5. 키보드 조작·모바일 폭·다른 사업자 접근·승인 409·삭제 상태·미동의 모니터링을 확인하고 `feat: build borrower and officer demo screens`로 커밋한다.**

## 작업 10: 실행·초기화·문서·전체 여정

**파일:** `demo\scripts\{start.ts,server-main.ts,mock-main.ts}`, `demo\src\server\reset.ts`, `demo\README.md`, `demo\.env.example`, `demo\tests\launcher.test.ts`, `demo\tests\e2e\journey.spec.ts`, `demo\tests\e2e\real-ai.spec.ts` 생성. manifest·Playwright 설정·events route 수정.

**입출력 계약:**

```ts
export type RunningDemo = { appUrl: string; mockUrl: string; stop(): Promise<void> };
export function startDemo(options: {
  appPort: number; mockPort: number; dataDirectory: string;
}): Promise<RunningDemo>;
export function resetDemo(): Promise<{ generation: number }>;
```

`resetDemo`는 server 생성 시 DB·runner·mock client·AiPort에 결합해 노출하는 서버 내부 함수다. 경로를 HTTP body에서 받아 삭제하지 않는다. operator·CSRF·명시 확인을 거친 `POST /api/demo/reset`만 연결한다.

- [ ] **1. 포트 충돌과 서버 실패를 테스트한다.**

```ts
it("사용 중인 포트를 준비 완료로 표시하지 않는다", async () => {
  const occupied = await occupyLoopbackPort();
  try {
    await expect(startDemo({
      appPort: occupied.port, mockPort: 0, dataDirectory: temporaryDataDirectory,
    })).rejects.toThrow("PORT_IN_USE");
    expect(await occupied.isResponsive()).toBe(true);
  } finally {
    await occupied.close();
  }
});
```

`tests\helpers\launcher.ts`의 `occupyLoopbackPort`는 실제 임시 서버를 만들고 종료 함수를 반환한다. 임시 dataDirectory는 해당 테스트의 명시적 경로로 생성·정리한다. launcher 오류가 다른 서버를 죽이지 않는지 확인한다.

- [ ] **2. `npm test -- tests/launcher.test.ts`로 실패를 확인한다.**
- [ ] **3. launcher·초기화를 구현한다.** `npm run demo`는 `npm run build && tsx scripts/start.ts`다. 두 서버를 자신이 시작한 Node 자식 프로세스로 유지하고 각 `/health` 200을 확인한 뒤 URL을 출력한다. 내부 서비스 토큰은 메모리에서 생성해 자식 프로세스에만 전달한다. Ctrl+C 또는 한 서버 오류 시 소유 자식과 SDK만 종료한다.

초기화 시 새 generation으로 기존 결과 저장을 차단하고 작업 중단·SDK 정리 완료를 기다린다. app 데이터 reset과 mock seed는 단계 상태를 기록해 중간 실패 시 유지보수 상태로 남긴다. 현재 사용자 세션을 폐기하고 재로그인을 안내한다. 성공 전 앱 트래픽을 재개하지 않는다.

```json
{
  "scripts": {
    "demo": "npm run build && tsx scripts/start.ts",
    "ai:smoke": "tsx scripts/ai-smoke.ts",
    "test:e2e": "playwright test --project=deterministic",
    "test:e2e:real": "playwright test --project=real-ai"
  }
}
```

- [ ] **4. README와 설정 예를 작성한다.** Node 24 확인, `npm ci`, Playwright 브라우저 설치, SDK 인증, 모델 목록·선택, 시작·종료, D0 사례와 두 전망의 예상 값, 동의 철회, 원천 보존, SDK 원격 보존 한계, 포트·비용·실패 복구를 설명한다.

```powershell
Set-Location .\demo
npm ci
npx playwright install chromium
npm run ai:smoke -- --list-models
npm run demo
```

`.env.example`에는 비밀이 아닌 `DEMO_APP_PORT=3000`, `DEMO_MOCK_PORT=3001`만 넣는다. 실제 모델 ID는 조회 후 UI에서 선택하게 한다. 토큰·실제 개인 자료·검증되지 않은 기본 모델을 넣지 않는다.

- [ ] **5. 결정적 전체 여정을 검증한다.** 신청·동의·HTTP 수집·모델 대역·사람 승인·모니터링 동의·정산 지연·규칙 경보·D+10 시간 이동·명시 미납·지원·철회·삭제를 브라우저로 확인한다.

```ts
test("정산 지연과 실제 미납 사건을 구분한다", async ({ page }) => {
  await runApprovedLoanJourney(page);
  await triggerDemoEvent(page, "정산일 D+8로 변경");
  await expect(page.getByText("유동성 부족 경보")).toBeVisible();
  await expect(page.getByText("미납 안내 발송")).toHaveCount(0);
  await triggerDemoEvent(page, "D+10으로 이동");
  await triggerDemoEvent(page, "상환 미납 사건 생성");
  await expect(page.getByText("상환 지원 검토")).toBeVisible();
});
```

`tests\e2e\helpers.ts`의 `runApprovedLoanJourney(page)`는 account 전환·동의·신청·완료 대기·담당자 승인·모니터링 동의를 UI로 수행한다. `triggerDemoEvent(page, label)`는 운영자 세션에서 지정 label 버튼을 누르고 event APPLIED 상태를 기다린다. 버튼 결과를 직접 DB 성공으로 바꾸지 않는다.

- [ ] **6. 실제 SDK 전체 여정을 별도 실행한다.** `real-ai.spec.ts`는 실제 제품 launcher와 명시 선택된 모델만 사용한다. UNDERWRITING·WARNING·COLLECTIONS의 SDK 호출 완료와 구조화 결과, 권한 도구 거부, 세션 정리를 확인한다. 자연어 문구 일치가 아니라 출력 schema·근거·업무 상태로 판정한다.

`real-ai` 프로젝트는 환경의 `DEMO_MODEL_ID`를 읽어 모델 목록에서 확인한 뒤 운영자 UI에서 그 ID를 선택한다. 제품 코드에 테스트용 모델 기본값을 넣지 않는다. 실제 모델이 위험 도구를 시도할 확률에 의존하지 않고 권한 거부는 어댑터 계약 테스트도 함께 확인한다.

```powershell
Set-Location .\demo
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run test:e2e
npm run ai:smoke -- --model $env:DEMO_MODEL_ID
npm run test:e2e:real
```

`real-ai`는 선택 모델이 없으면 skip 성공이 아니라 설정 오류로 실패한다. 실연동 테스트에서만 호출 비용이 발생하며 대역 테스트와 결과를 분리한다. 테스트는 테스트 소유 데이터 디렉터리와 임의 포트를 사용해 사용자가 보고 있는 데모를 초기화하지 않는다.

- [ ] **7. 변경 파일만 stage하고 `feat: finish local demo runner and end-to-end journey`로 커밋한다.** 실제 연동이 막혔다면 원인과 미완료 범위를 분명히 남기며 데모 완료로 보고하지 않는다.

## 설계서 대응 및 완료 판단

| 설계 영역 | 구현 작업 |
|---|---|
| 5개 역할·모듈형 로컬 구성 | 1~8 |
| 사업자·담당자·운영자 화면 | 9 |
| 합성 데이터·정확한 전망·원천 분리 | 2, 3, 7 |
| 실제 SDK·세션 격리·모델 선택 | 5 |
| 신청 상태·멱등성·재시작 | 4, 6, 8, 10 |
| 사람 승인·보완·오래된 평가 차단 | 6, 9 |
| 경보·상환 지원·승인된 템플릿 | 7 |
| 철회·만료·삭제·원격 보존 구분 | 2, 4, 8 |
| 로그·근거·사용량·불확실성 | 1, 5, 6, 9 |
| 자동 테스트·실제 SDK·브라우저 여정 | 각 작업, 10 |
| 실행·종료·초기화·README | 10 |

완료는 코드 생성이나 대역 테스트 통과가 아니라, 저장된 코드로 로컬 앱이 실행되고 실제 SDK를 포함한 전체 여정이 동작하는 상태다. 결과 보고에서 실제 연동 확인 여부와 남은 제한을 분리한다.

이 계획에서 원문의 신용위험 성과·공정성 통계·국내 처리·운영 인증의 달성을 주장하지 않는다. 두 합성 사업자 격리 테스트는 공정성 검증을 대신하지 않는다.

## 실행 방식 검토

권장 방식은 **Native**다. 10개 작업이 같은 신청·동의·데이터 버전 계약을 공유하므로 현재 세션에서 순서대로 구현하면 문맥 전달 비용을 줄일 수 있다.

- **Native:** 현재 세션에서 직접 작업별 구현·검증 후 전체 변경에 대한 별도 최종 리뷰를 수행한다.
- **Subagent-driven:** 작업별 새 구현 에이전트와 리뷰 에이전트로 검토한 뒤 다음 작업을 진행한다. 더 많은 문맥·사용량이 필요하다.

계획 검토와 실행 방식 선택 전에는 제품 코드·의존성 설치·SDK 호출을 시작하지 않는다.
