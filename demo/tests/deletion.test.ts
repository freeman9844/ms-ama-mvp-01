import { expect, it } from "vitest";
import { EventEmitter, once } from "node:events";
import { createReviewFixture } from "./helpers/review.js";
import { createDeletionHandler } from "../src/server/deletion.js";
import { claim, complete, fail } from "../src/workflow/queue.js";
import { createTestAi } from "./helpers/fake-ai.js";
import { z } from "zod";
import { startRunner } from "../src/workflow/runner.js";
import { createUnderwriter } from "../src/agents/underwriting.js";
import { consentInput } from "./helpers/consent.js";
import { createMonitor } from "../src/agents/warning.js";
import { readAuthorizedDataset } from "../src/agents/assembly.js";
import { expireConsents, startConsentSweeper } from "../src/agents/consent.js";
import { DomainError } from "../src/server/errors.js";
import { createServer } from "node:http";
import { openDb } from "../src/server/db.js";

it("mock 페이지 응답 직전 철회하면 이미 계산한 페이지도 반환하지 않는다", async () => {
  const h = await createReviewFixture();
  let checks = 0;
  const proxy = createServer(async (req, res) => {
    try {
      if (++checks === 2)
        await h.request("shop-a", "POST", `/api/consents/${h.consentIds[0]}/revoke`, {});
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const authorized = await fetch(`${h.url}/internal/consents/authorize`, {
        method: "POST",
        headers: { authorization: `Bearer ${h.serviceToken}`, "content-type": "application/json" },
        body,
      });
      res.writeHead(authorized.status, { "content-type": "application/json" });
      res.end(await authorized.text());
    } catch (error) {
      res.destroy(error instanceof Error ? error : new Error("Proxy failed"));
    }
  });
  try {
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("No proxy address");
    h.mockOptions.appUrl = `http://127.0.0.1:${address.port}`;
    const response = await h.sourceRequest(
      "BANK",
      { ...consentInput, businessId: "shop-a", consentId: h.consentIds[0] },
      null,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty("items");
    expect(checks).toBe(2);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
    await h.close();
  }
});

it("삭제 후 작업 완료 기록 전에 재시작해도 SQLite 임대 복구로 완료한다", async () => {
  const h = await createReviewFixture();
  try {
    await h.request("shop-a", "POST", `/api/consents/${h.consentIds[0]}/revoke`, {});
    const job = claim(h.db, Date.now(), ["DELETE"]);
    if (!job) throw new Error("Missing deletion");
    await createDeletionHandler(h.db, h.ai)(job, new AbortController().signal);
    const file = z
      .object({ file: z.string() })
      .parse(h.db.prepare("PRAGMA database_list").get()).file;
    const reopened = openDb(file);
    try {
      const recovered = claim(reopened, Date.now() + 61_000, ["DELETE"]);
      if (!recovered) throw new Error("Missing recovered deletion");
      const id = await createDeletionHandler(reopened, h.ai)(
        recovered,
        new AbortController().signal,
      );
      expect(complete(reopened, recovered, id, h.clock.now())).toBe(true);
      expect(reopened.prepare("SELECT COUNT(*) AS n FROM datasets").get()).toMatchObject({ n: 0 });
      expect(reopened.prepare("SELECT state FROM deletion_requests").get()).toMatchObject({
        state: "COMPLETE",
      });
    } finally {
      reopened.close();
    }
  } finally {
    await h.close();
  }
});

it("실행기는 철회된 진행 작업을 중단 신호로 취소한다", async () => {
  const h = await createReviewFixture();
  const events = new EventEmitter();
  const ready = once(events, "ready");
  h.ai.run = async (_request, signal) => {
    events.emit("ready");
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          events.emit("aborted");
          reject(signal.reason);
        },
        { once: true },
      );
    });
    throw new Error("Unexpected completion");
  };
  const runner = startRunner(
    h.db,
    h.clock,
    new Map([["UNDERWRITE", createUnderwriter(h.db, h.clock, h.ai)]]),
  );
  try {
    await ready;
    const aborted = once(events, "aborted", { signal: AbortSignal.timeout(3_000) });
    await h.request("shop-a", "POST", `/api/consents/${h.consentIds[0]}/revoke`, {});
    await aborted;
  } finally {
    await runner.stop();
    await h.close();
  }
});

it("다른 목적의 모니터링 자료와 독립 대출 기록은 보존하고 재시작 시 만료를 처리한다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    await h.review({ reason: "은행 잔액 300만원을 확인했습니다." });
    for (const source of ["BANK", "PG", "TAX"]) {
      const response = await h.request("shop-a", "POST", "/api/consents", {
        ...consentInput,
        source,
        resourceIds: [`${source.toLowerCase()}-shop-a`],
        purpose: "MONITORING",
        to: "2026-12-27T00:00:00+09:00",
        validUntil: "2026-12-27T00:00:00+09:00",
      });
      expect(response.status).toBe(201);
    }
    await h.request("operator", "POST", "/api/demo/events", {
      id: "delay",
      businessId: "shop-a",
      type: "SETTLEMENT_DELAY",
      settlementId: "shop-a-settlement",
      dueAt: "2026-11-05T00:00:00+09:00",
    });
    const monitor = claim(h.db, Date.now(), ["MONITOR"]);
    if (!monitor) throw new Error("Missing monitor");
    await createMonitor(
      h.db,
      h.clock,
      h.ai,
      h.mockUrl,
      h.serviceToken,
    )(monitor, new AbortController().signal);
    const monitored = z
      .object({ dataset_id: z.string() })
      .parse(h.db.prepare("SELECT dataset_id FROM alerts").get());
    await h.request("shop-a", "POST", `/api/consents/${h.consentIds[0]}/revoke`, {});
    const job = claim(h.db, Date.now(), ["DELETE"]);
    if (!job) throw new Error("Missing deletion");
    await createDeletionHandler(h.db, h.ai)(job, new AbortController().signal);
    expect(readAuthorizedDataset(h.db, h.clock, monitored.dataset_id).forecast7.minimumKrw).toBe(
      -3_000_000,
    );
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM loans").get()).toMatchObject({ n: 1 });
    expect(h.db.prepare("SELECT reason FROM decisions").get()).toMatchObject({
      reason: "근거 자료 삭제됨",
    });
    h.clock.set(new Date("2026-12-27T00:00:00+09:00"));
    expect(() => readAuthorizedDataset(h.db, h.clock, monitored.dataset_id)).toThrow(
      "CONSENT_INACTIVE",
    );
    const sweeper = startConsentSweeper(h.db, h.clock);
    sweeper.stop();
    expect(expireConsents(h.db, h.clock)).toBe(0);
    expect(
      h.db.prepare("SELECT validation_status FROM datasets WHERE id=?").get(monitored.dataset_id),
    ).toMatchObject({ validation_status: "INVALIDATED" });
  } finally {
    await h.close();
  }
});

it("철회 뒤 도착한 심사 결과는 저장하지 않으며 삭제 작업은 원천을 보존한다", async () => {
  const h = await createReviewFixture();
  try {
    const events = new EventEmitter();
    const ready = once(events, "ready");
    const finish = once(events, "finish");
    const ai = createTestAi();
    h.ai.run = async (request, signal) => {
      events.emit("ready");
      await finish;
      return ai.run(request, signal);
    };
    const running = h.runAssessment();
    const rejected = expect(running).rejects.toThrow("CONSENT_INACTIVE");
    await ready;
    const response = await h.request(
      "shop-a",
      "POST",
      `/api/consents/${h.consentIds[0]}/revoke`,
      {},
    );
    events.emit("finish");
    await rejected;
    expect(response.status).toBe(202);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM assessments").get()).toMatchObject({ n: 0 });
    const job = claim(h.db, Date.now(), ["DELETE"]);
    if (!job) throw new Error("Missing deletion job");
    const id = await createDeletionHandler(h.db, h.ai)(job, new AbortController().signal);
    expect(complete(h.db, job, id, h.clock.now())).toBe(true);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM datasets").get()).toMatchObject({ n: 0 });
    expect(h.sourceDb.prepare("SELECT COUNT(*) AS n FROM source_records").get()).toMatchObject({
      n: 38,
    });
  } finally {
    await h.close();
  }
});
it("만료 처리기가 아직 실행되지 않아도 만료 시각부터 평가 조회를 차단한다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    h.clock.set(new Date("2026-11-27T00:00:00+09:00"));
    const response = await h.request(
      "officer",
      "GET",
      `/api/applications/${h.applicationId}/assessment`,
    );
    expect(response.status).toBe(403);
  } finally {
    await h.close();
  }
});
it("SDK 삭제 실패는 COMPLETE가 아니며 재시도해 소유 세션만 제거한다", async () => {
  const h = await createReviewFixture();
  try {
    h.db
      .prepare(
        "INSERT INTO ai_sessions VALUES ('owned','old-job','shop-a',?,'test-model','UNDERWRITING','CLEANUP_FAILED',NULL)",
      )
      .run(JSON.stringify(h.consentIds));
    h.db
      .prepare(
        "INSERT INTO ai_sessions VALUES ('other','other-job','shop-b','[]','test-model','COLLECTIONS','RUNNING',NULL)",
      )
      .run();
    const revoke = await h.request("shop-a", "POST", `/api/consents/${h.consentIds[0]}/revoke`, {});
    expect(revoke.status).toBe(202);
    let job = claim(h.db, Date.now(), ["DELETE"]);
    if (!job) throw new Error("Missing deletion job");
    h.ai.deleteSession = async () => {
      throw new Error("Synthetic SDK cleanup failure");
    };
    const handler = createDeletionHandler(h.db, h.ai);
    const result = handler(job, new AbortController().signal);
    await expect(result).rejects.toThrow("AI_CLEANUP_FAILED");
    fail(h.db, job, new DomainError("AI_CLEANUP_FAILED", 502));
    const status = await h.request("shop-a", "GET", `/api/consents/${h.consentIds[0]}/deletion`);
    expect(status.body).toMatchObject({ access: "BLOCKED", state: "CLEANUP_FAILED" });
    const retry = await h.request(
      "shop-a",
      "POST",
      `/api/jobs/${job.id}/retry`,
      {},
      { "idempotency-key": "cleanup-retry" },
    );
    expect(retry.status).toBe(202);
    job = claim(h.db, Date.now(), ["DELETE"]);
    if (!job) throw new Error("Missing retried deletion job");
    h.ai.deleteSession = async (id) => {
      expect(id).toBe("owned");
    };
    const id = await handler(job, new AbortController().signal);
    expect(complete(h.db, job, id, h.clock.now())).toBe(true);
    const rows = h.db
      .prepare("SELECT id FROM ai_sessions")
      .all()
      .map((row) => z.object({ id: z.string() }).parse(row).id);
    expect(rows).toEqual(["other"]);
  } finally {
    await h.close();
  }
});
