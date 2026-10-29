import type { SessionConfig } from "@github/copilot-sdk";
import type { SdkRuntime, AiPort } from "../../src/copilot/port.js";

export function createTestAi(): AiPort {
  return {
    async listModels() {
      return [{ id: "test-model", name: "Test model" }];
    },
    async run(request) {
      const payload =
        request.role === "UNDERWRITING"
          ? {
              recommendation: "REVIEW",
              factors: [],
              uncertainties: ["합성 예제"],
              explanation: "담당자의 검토가 필요합니다.",
            }
          : request.role === "WARNING"
            ? { explanation: "예상 유동성 부족을 검토하세요.", evidenceIds: [], uncertainties: [] }
            : { route: "PAYMENT_DIFFICULTY", explanation: "상환 지원 검토 요청", evidenceIds: [] };
      return {
        text: JSON.stringify(payload),
        sessionId: "test-session",
        modelId: request.modelId,
        usage: null,
      };
    },
    async deleteSession() {},
    async stop() {},
  };
}

export function createFakeRuntime(
  reply = JSON.stringify({
    route: "HUMAN_REVIEW",
    explanation: "합성 지원 요청입니다.",
    evidenceIds: [],
  }),
) {
  const created: SessionConfig[] = [];
  const deleted: string[] = [];
  const runtime: SdkRuntime = {
    async start() {},
    async getAuthStatus() {
      return { isAuthenticated: true };
    },
    async listModels() {
      return [{ id: "test-model", name: "Test model" }];
    },
    async createSession(config) {
      created.push(config);
      return {
        sessionId: `test-session-${created.length}`,
        async sendAndWait() {
          return { data: { content: reply } };
        },
        async abort() {},
        async disconnect() {},
      };
    },
    async deleteSession(id) {
      deleted.push(id);
    },
    async stop() {
      return [];
    },
  };
  return { runtime, created, deleted };
}
