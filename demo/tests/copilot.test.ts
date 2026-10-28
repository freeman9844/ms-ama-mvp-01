import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb } from "../src/server/db.js";
import { createAi } from "../src/copilot/client.js";
import { createFakeRuntime } from "./helpers/fake-ai.js";
import type { AiRequest } from "../src/copilot/port.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter, once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { claim, enqueue, fail } from "../src/workflow/queue.js";

it.each([
  ["query", 503, undefined, true],
  ["rate_limit", 429, "rate_limited", true],
  ["authentication", 401, undefined, false],
  ["policy", 503, undefined, false],
  ["rate_limit", 429, "user_weekly_rate_limited", false],
] as const)(
  "SDK %s/%s 오류의 명시적 메타데이터로만 최대 두 번 시도한다",
  async (errorType, statusCode, errorCode, retryable) => {
    const fake = createFakeRuntime();
    const create = fake.runtime.createSession;
    fake.runtime.createSession = async (config) => ({
      ...(await create(config)),
      async sendAndWait() {
        config.onEvent?.({
          type: "session.error",
          id: "error-event",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: { errorType, statusCode, errorCode, message: "Synthetic service error" },
        });
        throw new Error("Synthetic service error");
      },
    });
    const ai = createAi({ db, root, runtime: fake.runtime, authorize() {} });
    const id = enqueue(db, {
      kind: "SUPPORT",
      applicationId: null,
      businessId: "shop-a",
      consentIds: [],
      modelId: "test-model",
      referenceId: null,
    });
    for (let i = 0; i < (retryable ? 2 : 1); i++) {
      const job = claim(db, Date.now() + i * 2000);
      if (!job) throw new Error("Missing retry");
      try {
        await ai.run({ ...request, jobId: id }, signal());
      } catch (error) {
        fail(db, job, error);
      }
      expect(db.prepare("SELECT status FROM jobs WHERE id=?").get(id)).toMatchObject({
        status: retryable && i === 0 ? "QUEUED" : "FAILED",
      });
    }
    expect(claim(db, Date.now() + 10000)).toBeNull();
    expect(fake.deleted).toHaveLength(retryable ? 2 : 1);
  },
);

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
it.each([true, false])(
  "SDK 사용량은 보고된 수치 또는 미확인 null로 보존한다 (%s)",
  async (reported) => {
    const fake = createFakeRuntime();
    const create = fake.runtime.createSession;
    fake.runtime.createSession = async (config) => {
      if (reported)
        for (let i = 0; i < 2; i++)
          config.onEvent?.({
            type: "assistant.usage",
            id: `usage-${i}`,
            timestamp: new Date().toISOString(),
            parentId: null,
            ephemeral: true,
            data: { model: "test-model", inputTokens: 10, outputTokens: 3 },
          });
      return create(config);
    };
    const ai = createAi({ db, root, runtime: fake.runtime, authorize() {} });
    const result = await ai.run(request, signal());
    expect(
      db
        .prepare("SELECT input_tokens,output_tokens FROM ai_usage WHERE session_id=?")
        .get(result.sessionId),
    ).toMatchObject({ input_tokens: reported ? 20 : null, output_tokens: reported ? 6 : null });
  },
);

it("세션 생성 도중 삭제는 생성 완료·실행 중단을 기다리며 다시 살아나는 세션을 남기지 않는다", async () => {
  const fake = createFakeRuntime();
  const create = fake.runtime.createSession;
  const events = new EventEmitter();
  const started = once(events, "started");
  const finish = once(events, "finish");
  fake.runtime.createSession = async (config) => {
    events.emit("started");
    await finish;
    return create(config);
  };
  const ai = createAi({ db, root, runtime: fake.runtime, authorize() {} });
  const running = ai.run(request, signal());
  await started;
  const { id } = z.object({ id: z.string() }).parse(db.prepare("SELECT id FROM ai_sessions").get());
  let deleted = false;
  const deleting = ai.deleteSession(id).then(() => {
    deleted = true;
  });
  await setImmediate();
  const prematurelyDeleted = deleted;
  events.emit("finish");
  const results = await Promise.allSettled([running, deleting]);
  expect(prematurelyDeleted).toBe(false);
  expect(results[0]?.status).toBe("rejected");
  expect(results[1]?.status).toBe("fulfilled");
  expect(db.prepare("SELECT state FROM ai_sessions WHERE id=?").get(id)).toMatchObject({
    state: "DELETED",
  });
});

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
