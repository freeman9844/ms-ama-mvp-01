import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { startDemo } from "../../scripts/start.js";
import { login, revokeFromUi, runApprovedLoanJourney, runWarningAndSupport } from "./helpers.js";
import { supportView } from "../../src/domain/views.js";

test("실제 선택 모델로 세 역할을 실행하고 앱 소유 세션을 정리한다", async ({ page }) => {
  const modelId = process.env.DEMO_MODEL_ID;
  if (!modelId) throw new Error("DEMO_MODEL_ID를 명시적으로 지정해야 합니다.");
  const directory = await mkdtemp(join(tmpdir(), "capstone-real-ai-"));
  const running = await startDemo({ appPort: 0, mockPort: 0, dataDirectory: directory });
  try {
    await page.goto(running.appUrl);
    await login(page, "operator");
    await expect(
      page.getByLabel("사용 가능한 모델").locator("option", { hasText: modelId }),
    ).toHaveCount(1, { timeout: 60_000 });
    await page.getByLabel("사용 가능한 모델").selectOption(modelId);
    await page.getByRole("button", { name: "선택 모델 저장" }).click();
    await expect(page.getByText(modelId, { exact: true })).toBeVisible();
    await runApprovedLoanJourney(page);
    await runWarningAndSupport(page);
    const requests = await page.request.get(`${running.appUrl}/api/support-requests`);
    const support = z.array(supportView).parse(await requests.json());
    expect(support).toHaveLength(1);
    expect(support[0]?.route).not.toBeNull();
    expect(support[0]?.status).toBe("AWAITING_REVIEW");
    const db = new DatabaseSync(join(directory, "app.db"), { readOnly: true });
    try {
      const sessions = db
        .prepare("SELECT role,state,model_id FROM ai_sessions")
        .all()
        .map((row) =>
          z.object({ role: z.string(), state: z.string(), model_id: z.string() }).parse(row),
        );
      expect(new Set(sessions.map((s) => s.role))).toEqual(
        new Set(["UNDERWRITING", "WARNING", "COLLECTIONS"]),
      );
      expect(sessions.every((s) => s.state === "DELETED" && s.model_id === modelId)).toBe(true);
      const usage = db
        .prepare(
          "SELECT s.role,u.input_tokens,u.output_tokens FROM ai_usage u JOIN ai_sessions s ON s.id=u.session_id",
        )
        .all();
      expect(usage).toHaveLength(sessions.length);
      console.log(
        JSON.stringify({
          actualModel: modelId,
          roles: sessions,
          toolCalls: db.prepare("SELECT COUNT(*) AS n FROM tool_events").get(),
          usage,
        }),
      );
    } finally {
      db.close();
    }
    await revokeFromUi(page);
  } finally {
    await running.stop();
    await rm(directory, { recursive: true });
  }
});
