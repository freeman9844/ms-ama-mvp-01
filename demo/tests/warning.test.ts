import { expect, it } from "vitest";
import { createReviewFixture } from "./helpers/review.js";
import { createTestAi } from "./helpers/fake-ai.js";
import { consentInput } from "./helpers/consent.js";
import { claim, enqueue, getJob, complete } from "../src/workflow/queue.js";
import { createAssembler } from "../src/workflow/handlers.js";
import { createUnderwriter } from "../src/agents/underwriting.js";
import { z } from "zod";
import { createMonitor } from "../src/agents/warning.js";
import { DomainError } from "../src/server/errors.js";

it("같은 사업자의 모든 승인 대출을 한 번씩 반영하여 부족 경보를 생성한다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    await h.review();
    for (let i = 0; i < 2; i++) {
      const response = await h.request(
        "shop-a",
        "POST",
        "/api/applications",
        {
          companyName: "추가 합성 신청",
          requestedAmountKrw: 10000000,
          consentIds: h.consentIds,
        },
        { "idempotency-key": `additional-${i}` },
      );
      const { applicationId } = z.object({ applicationId: z.string() }).parse(response.body);
      for (const kind of ["ASSEMBLE", "UNDERWRITE"] as const) {
        const job = claim(h.db, Date.now(), [kind]);
        if (!job) throw new Error("Missing new application job");
        const handler =
          kind === "ASSEMBLE"
            ? createAssembler(h.db, h.clock, h.mockUrl, h.serviceToken)
            : createUnderwriter(h.db, h.clock, h.ai);
        complete(h.db, job, await handler(job, new AbortController().signal), h.clock.now());
      }
      expect(
        (
          await h.request(
            "officer",
            "POST",
            `/api/applications/${applicationId}/review`,
            {
              datasetVersion: 1,
              assessmentVersion: 1,
              decision: "APPROVE",
              reason: "합성 복수 대출",
            },
            { "idempotency-key": `approve-${i}` },
          )
        ).status,
      ).toBe(200);
    }
    for (const source of ["BANK", "PG", "TAX"])
      await h.request("shop-a", "POST", "/api/consents", {
        ...consentInput,
        source,
        resourceIds: [`${source.toLowerCase()}-shop-a`],
        purpose: "MONITORING",
        to: "2026-12-27T00:00:00+09:00",
        validUntil: "2026-12-27T00:00:00+09:00",
      });
    await h.request("operator", "POST", "/api/demo/events", {
      id: "same-due",
      businessId: "shop-a",
      type: "SETTLEMENT_DELAY",
      settlementId: "shop-a-settlement",
      dueAt: "2026-11-01T00:00:00+09:00",
    });
    const job = claim(h.db, Date.now(), ["MONITOR"]);
    if (!job) throw new Error("Missing monitor");
    await createMonitor(
      h.db,
      h.clock,
      h.ai,
      h.mockUrl,
      h.serviceToken,
    )(job, new AbortController().signal);
    expect(h.db.prepare("SELECT minimum_krw FROM alerts").get()).toMatchObject({
      minimum_krw: -1000000,
    });
  } finally {
    await h.close();
  }
});

it("정산 지연 경보는 AI 설명 실패에도 남고 추심을 시작하지 않는다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    await h.review();
    for (const source of ["BANK", "PG", "TAX"])
      await h.request("shop-a", "POST", "/api/consents", {
        ...consentInput,
        source,
        resourceIds: [`${source.toLowerCase()}-shop-a`],
        purpose: "MONITORING",
        to: "2026-12-27T00:00:00+09:00",
        validUntil: "2026-12-27T00:00:00+09:00",
      });
    const response = await h.request("operator", "POST", "/api/demo/events", {
      id: "delay-1",
      businessId: "shop-a",
      type: "SETTLEMENT_DELAY",
      settlementId: "shop-a-settlement",
      dueAt: "2026-11-05T00:00:00+09:00",
    });
    expect(response.status).toBe(200);
    const job = claim(h.db, Date.now(), ["MONITOR"]);
    expect(job).not.toBeNull();
    if (!job) throw new Error("Missing monitoring job");
    const ai = createTestAi();
    ai.run = async () => {
      throw new DomainError("AI_UNAVAILABLE", 502);
    };
    await expect(
      createMonitor(
        h.db,
        h.clock,
        ai,
        h.mockUrl,
        h.serviceToken,
      )(job, new AbortController().signal),
    ).rejects.toThrow("AI_UNAVAILABLE");
    expect(h.db.prepare("SELECT code,explanation_status FROM alerts").get()).toMatchObject({
      code: "LIQUIDITY_SHORTFALL",
      explanation_status: "FAILED",
    });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM support_requests").get()).toMatchObject({
      n: 0,
    });
    await createMonitor(
      h.db,
      h.clock,
      h.ai,
      h.mockUrl,
      h.serviceToken,
    )(getJob(h.db, job.id), new AbortController().signal);
    enqueue(h.db, { ...job, referenceId: null });
    const duplicate = claim(h.db, Date.now(), ["MONITOR"]);
    if (!duplicate) throw new Error("Missing repeated monitor");
    await createMonitor(
      h.db,
      h.clock,
      h.ai,
      h.mockUrl,
      h.serviceToken,
    )(duplicate, new AbortController().signal);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM alerts").get()).toMatchObject({ n: 1 });
    expect(h.db.prepare("SELECT explanation_status FROM alerts").get()).toMatchObject({
      explanation_status: "COMPLETE",
    });
  } finally {
    await h.close();
  }
});
