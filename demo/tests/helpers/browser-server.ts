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
import { createReset } from "../../src/server/reset.js";

const ai = createTestAi();
const h = await startTestSystem({ ai, port: 3100, webRoot: resolve("dist") });
h.db.prepare("INSERT OR REPLACE INTO settings VALUES ('model_id','test-model')").run();
let runner: ReturnType<typeof startRunner> | undefined;
const startWork = () => {
  runner = startRunner(
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
};
const stopWork = async () => {
  await runner?.stop();
  runner = undefined;
};
startWork();
h.appOptions.reset = createReset({
  db: h.db,
  clock: h.clock,
  ai,
  sourceUrl: h.mockUrl,
  serviceToken: h.serviceToken,
  startWork,
  stopWork,
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await stopWork();
  await h.close();
};
process.on("SIGINT", () => {
  void close();
});
process.on("SIGTERM", () => {
  void close();
});
