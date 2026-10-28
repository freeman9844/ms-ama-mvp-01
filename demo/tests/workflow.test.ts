import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { startTestSystem } from "./helpers/system.js";
import { consentInput } from "./helpers/consent.js";
import { claim, complete, enqueue } from "../src/workflow/queue.js";
import { openDb } from "../src/server/db.js";
import { DatabaseSync } from "node:sqlite";
import { startRunner } from "../src/workflow/runner.js";
import { createAssembler } from "../src/workflow/handlers.js";

let h: Awaited<ReturnType<typeof startTestSystem>>;
let consentIds: string[];
beforeEach(async () => {
  h = await startTestSystem();
  consentIds = [];
  for (const source of ["BANK", "PG", "TAX"]) {
    const response = await h.request("shop-a", "POST", "/api/consents", {
      ...consentInput,
      source,
      resourceIds: [`${source.toLowerCase()}-shop-a`],
    });
    consentIds.push(z.object({ id: z.string() }).parse(response.body).id);
  }
});
afterEach(async () => {
  await h.close();
});
function submit(amount = 10_000_000, key = "application-request-a") {
  return h.request(
    "shop-a",
    "POST",
    "/api/applications",
    {
      companyName: "합성 가게 A",
      requestedAmountKrw: amount,
      consentIds,
    },
    { "idempotency-key": key },
  );
}
it("같은 요청은 한 신청이며 다른 내용은 충돌한다", async () => {
  const first = await submit();
  expect(first.status).toBe(202);
  expect((await submit()).body).toEqual(first.body);
  expect((await submit(20_000_000)).status).toBe(409);
});
it("다른 사업자는 신청과 작업을 읽을 수 없다", async () => {
  const response = await submit();
  expect(response.status).toBe(202);
  const value = z.object({ applicationId: z.string(), jobId: z.string() }).parse(response.body);
  expect(
    (await h.request("shop-b", "GET", `/api/applications/${value.applicationId}`)).status,
  ).toBe(403);
  expect((await h.request("shop-b", "GET", `/api/jobs/${value.jobId}`)).status).toBe(403);
});
it("만료된 임대의 결과는 새로운 실행을 덮어쓰지 않는다", async () => {
  await submit();
  const first = claim(h.db, Date.now());
  expect(first).not.toBeNull();
  const second = claim(h.db, Date.now() + 60_001);
  expect(second).not.toBeNull();
  if (!first || !second) throw new Error("Missing claimed jobs");
  expect(second.id).toBe(first.id);
  expect(second.claimToken).not.toBe(first.claimToken);
  expect(complete(h.db, first, "old-result", h.clock.now())).toBe(false);
});
it("임대가 살아 있는 작업은 동시에 선점되지 않는다", async () => {
  await submit();
  expect(claim(h.db, Date.now())).not.toBeNull();
  expect(claim(h.db, Date.now())).toBeNull();
});

it("파일 DB를 다시 열어도 임대 만료 작업의 상태가 복구된다", async () => {
  const file = z
    .object({ file: z.string() })
    .parse(h.db.prepare("PRAGMA database_list").get()).file;
  let reopened: DatabaseSync = openDb(file);
  try {
    const id = enqueue(reopened, {
      kind: "DELETE",
      applicationId: null,
      businessId: "shop-a",
      consentIds: [],
      modelId: "",
      referenceId: null,
    });
    const first = claim(reopened, Date.now());
    reopened.close();
    reopened = openDb(file);
    const recovered = claim(reopened, Date.now() + 60_001);
    expect(recovered?.id).toBe(id);
    expect(recovered?.claimToken).not.toBe(first?.claimToken);
  } finally {
    reopened.close();
  }
});

it("실패 재시도는 별도 작업이며 같은 요청으로 중복 생성하지 않는다", async () => {
  const result = await submit();
  const { jobId } = z.object({ jobId: z.string() }).parse(result.body);
  h.db
    .prepare("UPDATE jobs SET status='FAILED',error_code='SOURCE_UNAVAILABLE' WHERE id=?")
    .run(jobId);
  const retry = () =>
    h.request("shop-a", "POST", `/api/jobs/${jobId}/retry`, {}, { "idempotency-key": "retry-a" });
  const first = await retry();
  expect(first.status).toBe(202);
  expect((await retry()).body).toEqual(first.body);
  expect(first.body).not.toEqual({ jobId });
  expect(
    (
      await h.request(
        "shop-a",
        "POST",
        `/api/jobs/${jobId}/retry`,
        {},
        { "idempotency-key": "retry-again" },
      )
    ).status,
  ).toBe(409);
});
it("3개월 동의는 필요한 6개월 심사 범위를 대체하지 못한다", async () => {
  const narrow = await h.request("shop-a", "POST", "/api/consents", {
    ...consentInput,
    from: "2026-07-28T00:00:00+09:00",
  });
  consentIds[0] = z.object({ id: z.string() }).parse(narrow.body).id;
  expect((await submit()).status).toBe(403);
  expect(h.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toMatchObject({ n: 0 });
});

it("보완 요청을 재제출해도 한 번만 재수집한다", async () => {
  const result = await submit();
  const { applicationId } = z.object({ applicationId: z.string() }).parse(result.body);
  h.db.prepare("UPDATE applications SET status='NEEDS_INFORMATION' WHERE id=?").run(applicationId);
  const correction = () =>
    h.request(
      "shop-a",
      "POST",
      `/api/applications/${applicationId}/corrections`,
      { fixtureId: "synthetic-confirmation" },
      { "idempotency-key": "correction-a" },
    );
  const first = await correction();
  expect(first.status).toBe(202);
  expect((await correction()).body).toEqual(first.body);
});

it("브라우저와 독립적으로 HTTP 자료를 수집하고 다음 작업을 생성한다", async () => {
  const response = await submit();
  const value = z.object({ applicationId: z.string(), jobId: z.string() }).parse(response.body);
  const runner = startRunner(
    h.db,
    h.clock,
    new Map([["ASSEMBLE", createAssembler(h.db, h.clock, h.mockUrl, h.serviceToken)]]),
  );
  try {
    await vi.waitFor(
      () =>
        expect(h.db.prepare("SELECT status FROM jobs WHERE id=?").get(value.jobId)).toMatchObject({
          status: "COMPLETED",
        }),
      { timeout: 2_000 },
    );
    expect(
      h.db
        .prepare("SELECT status,dataset_version FROM applications WHERE id=?")
        .get(value.applicationId),
    ).toMatchObject({ status: "ANALYZING", dataset_version: 1 });
    expect(
      h.db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='UNDERWRITE' AND application_id=?")
        .get(value.applicationId),
    ).toMatchObject({ n: 1 });
  } finally {
    await runner.stop();
  }
});
