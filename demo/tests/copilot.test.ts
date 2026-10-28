import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb } from "../src/server/db.js";
import { createAi } from "../src/copilot/client.js";
import { createFakeRuntime } from "./helpers/fake-ai.js";
import type { AiRequest } from "../src/copilot/port.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

let db: ReturnType<typeof openDb>;
let root: string;
beforeEach(async () => {
  db = openDb(":memory:");
  root = await mkdtemp(join(tmpdir(), "ai-test-"));
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true });
});
const request: AiRequest = {
  role: "COLLECTIONS",
  businessId: "shop-a",
  jobId: "job-a",
  dataset: null,
  modelId: "test-model",
  prompt: "합성 상환 지원 요청",
};
const signal = () => new AbortController().signal;

it("모델 미선택은 기본 모델로 대체하지 않는다", async () => {
  const fake = createFakeRuntime();
  const ai = createAi({ db, root, runtime: fake.runtime, authorize() {} });
  await expect(ai.run({ ...request, modelId: "" }, signal())).rejects.toThrow("MODEL_NOT_SELECTED");
  expect(fake.created).toHaveLength(0);
});
it("접근할 수 없는 모델은 대체하지 않는다", async () => {
  const fake = createFakeRuntime();
  const ai = createAi({ db, root, runtime: fake.runtime, authorize() {} });
  await expect(ai.run({ ...request, modelId: "missing" }, signal())).rejects.toThrow(
    "MODEL_UNAVAILABLE",
  );
});
it("일반 지원 세션에는 원천·셸 도구를 노출하지 않고 로컬 세션을 정리한다", async () => {
  const fake = createFakeRuntime();
  const ai = createAi({ db, root, runtime: fake.runtime, authorize() {} });
  const result = await ai.run(request, signal());
  expect(JSON.parse(result.text)).toMatchObject({ route: "HUMAN_REVIEW" });
  expect(fake.created[0]?.tools?.map((tool) => tool.name)).toEqual(["get_policy"]);
  expect(fake.created[0]?.enableConfigDiscovery).toBe(false);
  expect(fake.created[0]?.enableSessionStore).toBe(false);
  expect(fake.deleted).toEqual([result.sessionId]);
});
it("모델의 잘못된 JSON을 정상 평가로 저장하지 않는다", async () => {
  const fake = createFakeRuntime("not JSON");
  const ai = createAi({ db, root, runtime: fake.runtime, authorize() {} });
  await expect(ai.run(request, signal())).rejects.toThrow("AI_INVALID_OUTPUT");
});
it("작업 권한이 무효하면 모델을 호출하지 않는다", async () => {
  const fake = createFakeRuntime();
  const ai = createAi({
    db,
    root,
    runtime: fake.runtime,
    authorize() {
      throw new Error("CONSENT_INACTIVE");
    },
  });
  await expect(ai.run(request, signal())).rejects.toThrow("CONSENT_INACTIVE");
  expect(fake.created).toHaveLength(0);
});

it("세션 disconnect 실패에도 소유 세션 삭제를 시도한다", async () => {
  const fake = createFakeRuntime();
  const create = fake.runtime.createSession;
  fake.runtime.createSession = async (config) => ({
    ...(await create(config)),
    async disconnect() {
      throw new Error("DISCONNECT_FAILED");
    },
  });
  const ai = createAi({ db, root, runtime: fake.runtime, authorize() {} });
  await expect(ai.run(request, signal())).rejects.toThrow();
  expect(fake.deleted).toHaveLength(1);
});

it("셸 권한 요청을 거부하고 아홉 번째 도구 호출을 차단한다", async () => {
  const fake = createFakeRuntime();
  const create = fake.runtime.createSession;
  fake.runtime.createSession = async (config) => {
    const session = await create(config);
    return {
      ...session,
      async sendAndWait() {
        const permission = await config.onPermissionRequest?.(
          {
            kind: "shell",
            canOfferSessionApproval: false,
            commands: [{ identifier: "whoami", readOnly: true }],
            fullCommandText: "whoami",
            hasWriteFileRedirection: false,
            intention: "권한 거부 검증",
            possiblePaths: [],
            possibleUrls: [],
          },
          { sessionId: session.sessionId },
        );
        expect(permission).toMatchObject({ kind: "reject" });
        const tool = config.tools?.find((value) => value.name === "get_policy");
        if (!tool?.handler) throw new Error("Missing policy tool");
        for (let i = 0; i < 9; i++) {
          await tool.handler(
            { role: "COLLECTIONS" },
            {
              sessionId: session.sessionId,
              toolCallId: `call-${i}`,
              toolName: tool.name,
              arguments: { role: "COLLECTIONS" },
            },
          );
        }
        return { data: { content: "{}" } };
      },
    };
  };
  const ai = createAi({ db, root, runtime: fake.runtime, authorize() {} });
  await expect(ai.run(request, signal())).rejects.toThrow("AI_TOOL_LIMIT");
});
