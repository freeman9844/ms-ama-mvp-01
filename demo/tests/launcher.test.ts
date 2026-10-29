import { expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDemo } from "../scripts/start.js";

it.each(["app", "mock"])(
  "사용 중인 %s 포트를 준비 완료로 표시하거나 기존 서버를 종료하지 않는다",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "capstone-launcher-"));
    const server = createServer((_req, res) => res.end("existing"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    try {
      await expect(
        startDemo({
          appPort: kind === "app" ? address.port : 0,
          mockPort: kind === "mock" ? address.port : 0,
          dataDirectory: directory,
        }),
      ).rejects.toThrow("PORT_IN_USE");
      expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe("existing");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true });
    }
  },
);
it("실제 앱·원천 자식 서버 준비를 확인하고 자신이 시작한 서버만 종료한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "capstone-launcher-"));
  try {
    const running = await startDemo({ appPort: 0, mockPort: 0, dataDirectory: directory });
    try {
      expect((await fetch(`${running.appUrl}/health`)).status).toBe(200);
      expect((await fetch(`${running.mockUrl}/health`)).status).toBe(200);
      expect(await (await fetch(running.appUrl)).text()).toContain('lang="ko"');
    } finally {
      await running.stop();
    }
    await expect(fetch(`${running.appUrl}/health`)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true });
  }
}, 20_000);
