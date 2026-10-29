import { createServer } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { openSourceDb } from "../src/mock/seed.js";
import { createMockApp } from "../src/mock/server.js";
import { persistentClock } from "../src/server/clock.js";

const db = openSourceDb(join(z.string().parse(process.env.DEMO_DATA_DIRECTORY), "source.db"));
const clock = persistentClock(db);
const server = createServer(
  createMockApp({
    db,
    clock,
    setTime: clock.set,
    serviceToken: z.string().min(32).parse(process.env.DEMO_SERVICE_TOKEN),
    appUrl: z.string().parse(process.env.DEMO_APP_URL),
  }),
);
server.on("error", (error) => {
  closing = true;
  process.send?.({
    type: "error",
    code: "code" in error && error.code === "EADDRINUSE" ? "PORT_IN_USE" : "MOCK_START_FAILED",
  });
  db.close();
  process.exitCode = 1;
  process.disconnect?.();
});
server.listen(
  z.coerce.number().int().min(0).max(65535).parse(process.env.DEMO_MOCK_PORT),
  "127.0.0.1",
  () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing mock port");
    process.send?.({ type: "ready", url: `http://127.0.0.1:${address.port}` });
  },
);
let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  server.close((error) => {
    db.close();
    process.exitCode = error ? 1 : 0;
    process.disconnect?.();
  });
};
process.on("message", (message) => {
  if (z.object({ type: z.literal("stop") }).safeParse(message).success) stop();
});
process.on("disconnect", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
