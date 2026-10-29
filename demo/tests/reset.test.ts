import { expect, it } from "vitest";
import { createReviewFixture } from "./helpers/review.js";
import { createReset, maintenance } from "../src/server/reset.js";
import { claim, complete } from "../src/workflow/queue.js";

it("실패한 초기화는 유지보수로 닫히고 같은 generation에서 복구한 뒤 세션을 폐기한다", async () => {
  const h = await createReviewFixture();
  try {
    let starts = 0;
    h.appOptions.reset = createReset({
      db: h.db,
      clock: h.clock,
      ai: h.ai,
      sourceUrl: h.mockUrl,
      serviceToken: h.serviceToken,
      async stopWork() {},
      startWork() {
        starts++;
      },
    });
    expect((await h.request("shop-a", "POST", "/api/demo/reset", { confirmed: true })).status).toBe(
      403,
    );
    expect(
      (await h.request("operator", "POST", "/api/demo/reset", { confirmed: false })).status,
    ).toBe(400);
    const old = claim(h.db, Date.now(), ["UNDERWRITE"]);
    if (!old) throw new Error("Missing old job");
    h.db
      .prepare(
        "INSERT INTO ai_sessions VALUES ('reset-owned',?,'shop-a',?,'test-model','UNDERWRITING','CLEANUP_FAILED',NULL)",
      )
      .run(old.id, JSON.stringify(h.consentIds));
    h.ai.deleteSession = async () => {
      throw new Error("Synthetic cleanup failure");
    };
    expect(
      (await h.request("operator", "POST", "/api/demo/reset", { confirmed: true })).status,
    ).toBe(500);
    expect(maintenance(h.db)).toBe("BLOCKED");
    expect((await h.request("shop-a", "GET", "/api/applications")).status).toBe(503);
    expect(complete(h.db, old, "late-result", h.clock.now())).toBe(false);
    h.ai.deleteSession = async (id) => {
      expect(id).toBe("reset-owned");
    };
    expect(
      (await h.request("operator", "POST", "/api/demo/reset", { confirmed: true })).body,
    ).toMatchObject({ state: "RESET", generation: 2 });
    expect(starts).toBe(1);
    expect(maintenance(h.db)).toBe("NONE");
    expect((await h.request("operator", "GET", "/api/demo/state")).status).toBe(401);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM applications").get()).toMatchObject({ n: 0 });
    expect(h.sourceDb.prepare("SELECT COUNT(*) AS n FROM source_records").get()).toMatchObject({
      n: 38,
    });
  } finally {
    await h.close();
  }
});
