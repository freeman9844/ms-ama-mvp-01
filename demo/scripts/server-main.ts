import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { openDb } from "../src/server/db.js";
import { createApp, type ServerOptions } from "../src/server/app.js";
import { persistentClock } from "../src/server/clock.js";
import { createAi } from "../src/copilot/client.js";
import { authorizeAiRequest, createAssembler } from "../src/workflow/handlers.js";
import { startRunner, type JobHandler } from "../src/workflow/runner.js";
import type { JobKind } from "../src/workflow/queue.js";
import { createUnderwriter } from "../src/agents/underwriting.js";
import { createMonitor } from "../src/agents/warning.js";
import { createSupportAgent } from "../src/agents/collections.js";
import { createDeletionHandler } from "../src/server/deletion.js";
import { createReset, maintenance } from "../src/server/reset.js";

const root = z.string().parse(process.env.DEMO_DATA_DIRECTORY);
const db = openDb(join(root, "app.db"));
const clock = persistentClock(db);
const token = z.string().min(32).parse(process.env.DEMO_SERVICE_TOKEN);
const ai = createAi({ db, root, authorize: (request) => authorizeAiRequest(db, clock, request) });
const options: ServerOptions = {
  db,
  clock,
  ai,
  serviceToken: token,
  origin: "",
  setTime: clock.set,
  webRoot: fileURLToPath(new URL("../dist", import.meta.url)),
};
const server = createServer(createApp(options));
let runner: ReturnType<typeof startRunner> | undefined;
let closing = false;
const stopWork = async () => {
  const active = runner;
  runner = undefined;
  await active?.stop();
};
const startWork = () => {
  if (closing) throw new Error("SERVER_STOPPING");
  if (runner) return;
  const sourceUrl = z.string().min(1).parse(options.sourceUrl);
  runner = startRunner(
    db,
    clock,
    new Map<JobKind, JobHandler>([
      ["ASSEMBLE", createAssembler(db, clock, sourceUrl, token)],
      ["UNDERWRITE", createUnderwriter(db, clock, ai)],
      ["MONITOR", createMonitor(db, clock, ai, sourceUrl, token)],
      ["SUPPORT", createSupportAgent(db, clock, ai)],
      ["DELETE", createDeletionHandler(db, ai)],
    ]),
  );
};
async function stop() {
  if (closing) return;
  closing = true;
  try {
    await stopWork();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await ai.stop();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "APP_STOP_FAILED");
    process.exitCode = 1;
  } finally {
    db.close();
    process.disconnect?.();
  }
}
server.on("error", (error) => {
  process.send?.({
    type: "error",
    code: "code" in error && error.code === "EADDRINUSE" ? "PORT_IN_USE" : "APP_START_FAILED",
  });
  closing = true;
  db.close();
  process.exitCode = 1;
  process.disconnect?.();
});
server.listen(
  z.coerce.number().int().min(0).max(65535).parse(process.env.DEMO_APP_PORT),
  "127.0.0.1",
  () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing app port");
    options.origin = `http://127.0.0.1:${address.port}`;
    process.send?.({ type: "ready", url: options.origin });
  },
);
process.on("message", (message) => {
  const input = z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("stop") }),
      z.object({ type: z.literal("initialize"), mockUrl: z.string().url() }),
    ])
    .parse(message);
  if (input.type === "stop") {
    void stop();
    return;
  }
  options.sourceUrl = input.mockUrl;
  options.reset = createReset({
    db,
    clock,
    ai,
    sourceUrl: input.mockUrl,
    serviceToken: token,
    stopWork,
    startWork,
  });
  if (maintenance(db) === "NONE") startWork();
  process.send?.({ type: "initialized" });
});
process.on("disconnect", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
