import { z } from "zod";
import { startTestSystem } from "./system.js";
import { consentInput } from "./consent.js";
import { createTestAi } from "./fake-ai.js";
import { claim, complete, fail } from "../../src/workflow/queue.js";
import { createAssembler } from "../../src/workflow/handlers.js";
import { createUnderwriter } from "../../src/agents/underwriting.js";
import type { AiPort } from "../../src/copilot/port.js";

export async function createReviewFixture(ai: AiPort = createTestAi()) {
  const h = await startTestSystem({ ai });
  const consentIds: string[] = [];
  for (const source of ["BANK", "PG", "TAX"]) {
    const response = await h.request("shop-a", "POST", "/api/consents", {
      ...consentInput,
      source,
      resourceIds: [`${source.toLowerCase()}-shop-a`],
    });
    consentIds.push(z.object({ id: z.string() }).parse(response.body).id);
  }
  await h.request("operator", "PUT", "/api/ai/settings", { modelId: "test-model" });
  const result = await h.request(
    "shop-a",
    "POST",
    "/api/applications",
    {
      companyName: "합성 가게 A",
      requestedAmountKrw: 10_000_000,
      consentIds,
    },
    { "idempotency-key": "review-fixture" },
  );
  const { applicationId } = z.object({ applicationId: z.string() }).parse(result.body);
  const assembly = claim(h.db, Date.now(), ["ASSEMBLE"]);
  if (!assembly) throw new Error("Missing assembly job");
  const datasetId = await createAssembler(
    h.db,
    h.clock,
    h.mockUrl,
    h.serviceToken,
  )(assembly, new AbortController().signal);
  if (!complete(h.db, assembly, datasetId, h.clock.now()))
    throw new Error("Assembly not published");
  return {
    ...h,
    applicationId,
    consentIds,
    datasetId,
    ai,
    async runAssessment() {
      const job = claim(h.db, Date.now(), ["UNDERWRITE"]);
      if (!job) throw new Error("Missing assessment job");
      try {
        const id = await createUnderwriter(h.db, h.clock, ai)(job, new AbortController().signal);
        if (!complete(h.db, job, id, h.clock.now())) throw new Error("Assessment not published");
      } catch (error) {
        fail(h.db, job, error);
        throw error;
      }
    },
    review(overrides: Record<string, unknown> = {}, actor = "officer", key = "review-a") {
      return h.request(
        actor,
        "POST",
        `/api/applications/${applicationId}/review`,
        {
          datasetVersion: 1,
          assessmentVersion: 1,
          decision: "APPROVE",
          reason: "합성 현금흐름 확인",
          ...overrides,
        },
        { "idempotency-key": key },
      );
    },
  };
}
