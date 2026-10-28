import type { SessionConfig } from "@github/copilot-sdk";
import type { SdkRuntime } from "../../src/copilot/port.js";

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
