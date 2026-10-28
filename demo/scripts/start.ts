import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { z } from "zod";

const messageSchema = z.object({
  type: z.string(),
  url: z.string().optional(),
  code: z.string().optional(),
});
function message(child: ChildProcess, type: string) {
  return new Promise<z.infer<typeof messageSchema>>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("START_TIMEOUT")), 30_000);
    const receive = (value: unknown) => {
      const parsed = messageSchema.safeParse(value);
      if (!parsed.success) {
        finish(new Error("INVALID_CHILD_MESSAGE"));
        return;
      }
      if (parsed.data.type === "error") finish(new Error(parsed.data.code ?? "CHILD_FAILED"));
      else if (parsed.data.type === type) {
        cleanup();
        resolve(parsed.data);
      }
    };
    const exit = () => finish(new Error("CHILD_EXITED"));
    const finish = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", receive);
      child.off("exit", exit);
      child.off("error", finish);
    };
    child.on("message", receive);
    child.once("exit", exit);
    child.once("error", finish);
  });
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (child.connected) child.send({ type: "stop" });
  const timer = setTimeout(() => {
    child.kill();
  }, 15_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
export async function startDemo(options: {
  appPort: number;
  mockPort: number;
  dataDirectory: string;
}) {
  z.object({
    appPort: z.number().int().min(0).max(65535),
    mockPort: z.number().int().min(0).max(65535),
    dataDirectory: z.string().min(1),
  }).parse(options);
  const root = resolve(options.dataDirectory);
  await mkdir(root, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const children: ChildProcess[] = [];
  let stopping: Promise<void> | undefined;
  let ready = false;
  const stop = () =>
    (stopping ??= (async () => {
      for (const child of children) await stopChild(child);
    })());
  const launch = (file: string, extra: Record<string, string> = {}) => {
    const child = fork(fileURLToPath(new URL(file, import.meta.url)), [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        DEMO_DATA_DIRECTORY: root,
        DEMO_SERVICE_TOKEN: token,
        DEMO_APP_PORT: String(options.appPort),
        DEMO_MOCK_PORT: String(options.mockPort),
        ...extra,
      },
    });
    children.push(child);
    child.once("exit", () => {
      if (ready && !stopping) {
        console.error("DEMO_CHILD_EXITED");
        process.exitCode = 1;
        void stop().catch((error) =>
          console.error(error instanceof Error ? error.message : "DEMO_STOP_FAILED"),
        );
      }
    });
    return child;
  };
  try {
    const app = launch("./server-main.ts");
    const appUrl = z
      .string()
      .url()
      .parse((await message(app, "ready")).url);
    const mock = launch("./mock-main.ts", { DEMO_APP_URL: appUrl });
    const mockUrl = z
      .string()
      .url()
      .parse((await message(mock, "ready")).url);
    const initialized = message(app, "initialized");
    app.send({ type: "initialize", mockUrl });
    await initialized;
    for (const url of [appUrl, mockUrl]) {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error("HEALTH_CHECK_FAILED");
      await response.arrayBuffer();
    }
    ready = true;
    return { appUrl, mockUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const running = await startDemo({
      appPort: Number(process.env.DEMO_APP_PORT ?? 3000),
      mockPort: Number(process.env.DEMO_MOCK_PORT ?? 3001),
      dataDirectory: resolve(".local", "demo"),
    });
    console.log(`앱: ${running.appUrl}\n합성 원천: ${running.mockUrl}\n종료: Ctrl+C`);
    const stop = () => {
      void running.stop().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "DEMO_START_FAILED");
    process.exitCode = 1;
  }
}
