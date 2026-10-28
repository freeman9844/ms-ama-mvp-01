import { resolve } from "node:path";
import { startTestSystem } from "./system.js";
import { createTestAi } from "./fake-ai.js";
import { startRunner, type JobHandler } from "../../src/workflow/runner.js";
import type { JobKind } from "../../src/workflow/queue.js";
import { createAssembler } from "../../src/workflow/handlers.js";
import { createUnderwriter } from "../../src/agents/underwriting.js";
import { createMonitor } from "../../src/agents/warning.js";
import { createSupportAgent } from "../../src/agents/collections.js";
import { createDeletionHandler } from "../../src/server/deletion.js";

const ai = createTestAi();
const h = await startTestSystem({ ai, port: 3100, webRoot: resolve("dist") });
h.db.prepare("INSERT OR REPLACE INTO settings VALUES ('model_id','test-model')").run();
const runner = startRunner(
  h.db,
  h.clock,
  new Map<JobKind, JobHandler>([
    ["ASSEMBLE", createAssembler(h.db, h.clock, h.mockUrl, h.serviceToken)],
    ["UNDERWRITE", createUnderwriter(h.db, h.clock, ai)],
    ["MONITOR", createMonitor(h.db, h.clock, ai, h.mockUrl, h.serviceToken)],
    ["SUPPORT", createSupportAgent(h.db, h.clock, ai)],
    ["DELETE", createDeletionHandler(h.db, ai)],
  ]),
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await runner.stop();
  await h.close();
};
process.on("SIGINT", () => {
  void close();
});
process.on("SIGTERM", () => {
  void close();
});
