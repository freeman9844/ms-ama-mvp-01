import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createAi } from "../src/copilot/client.js";
import { openDb } from "../src/server/db.js";
import { DomainError } from "../src/server/errors.js";

const args = process.argv.slice(2);
const root = resolve(".local", "ai-smoke");
await mkdir(root, { recursive: true });
const db = openDb(join(root, "app.db"));
const ai = createAi({
  db,
  root,
  authorize(request) {
    if (request.businessId !== "shop-a" || request.jobId !== "smoke" || request.dataset !== null) {
      throw new DomainError("SMOKE_SCOPE", 403);
    }
  },
});
try {
  if (args.includes("--list-models")) {
    console.log(JSON.stringify(await ai.listModels(), null, 2));
  } else {
    const modelId = args[args.indexOf("--model") + 1];
    if (!args.includes("--model") || !modelId) throw new DomainError("MODEL_NOT_SELECTED", 400);
    const result = await ai.run(
      {
        role: "COLLECTIONS",
        businessId: "shop-a",
        jobId: "smoke",
        dataset: null,
        modelId,
        prompt:
          "실제 고객이 아닌 합성 점검입니다. 먼저 get_policy 도구를 사용하세요. " +
          "현재 현금은 300만 원, 예정 정산은 500만 원입니다. " +
          "안내 절차에 대한 일반 문의로 분류하되 금액이나 채무 변경을 약속하지 마세요. " +
          "원천 근거 ID는 없으므로 evidenceIds는 빈 배열입니다.",
      },
      new AbortController().signal,
    );
    console.log(
      JSON.stringify(
        {
          status: "실제 SDK 응답 완료",
          modelId: result.modelId,
          response: JSON.parse(result.text),
          usage: result.usage,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "AI_SMOKE_FAILED");
  process.exitCode = 1;
} finally {
  await ai.stop();
  db.close();
}
