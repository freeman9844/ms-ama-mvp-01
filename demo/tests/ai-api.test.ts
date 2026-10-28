import { expect, it } from "vitest";
import { startTestSystem } from "./helpers/system.js";
import type { AiPort } from "../src/copilot/port.js";

it("모델 선택은 운영자만 가능하며 목록에 없는 모델은 저장하지 않는다", async () => {
  const ai: AiPort = {
    async listModels() {
      return [{ id: "test-model", name: "Test" }];
    },
    async run() {
      throw new Error("Not an inference test");
    },
    async deleteSession() {},
    async stop() {},
  };
  const h = await startTestSystem({ ai });
  try {
    expect(
      (await h.request("shop-a", "PUT", "/api/ai/settings", { modelId: "test-model" })).status,
    ).toBe(403);
    expect(
      (await h.request("operator", "PUT", "/api/ai/settings", { modelId: "missing" })).status,
    ).toBe(409);
    expect(
      (await h.request("operator", "PUT", "/api/ai/settings", { modelId: "test-model" })).status,
    ).toBe(200);
    expect(h.db.prepare("SELECT value FROM settings WHERE key='model_id'").get()).toMatchObject({
      value: "test-model",
    });
  } finally {
    await h.close();
  }
});
