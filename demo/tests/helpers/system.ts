import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";

export async function startTestSystem() {
  const directory = await mkdtemp(join(tmpdir(), "capstone-test-"));
  const db = openDb(join(directory, "app.db"));
  const clock = { now: () => new Date("2026-10-28T00:00:00+09:00") };
  const options = { db, clock, origin: "" };
  const server = createServer(createApp(options));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  const url = `http://127.0.0.1:${address.port}`;
  options.origin = url;
  const sessions = new Map<string, { cookie: string; csrf: string }>();
  const raw = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${url}${path}`, {
      method,
      headers: { origin: url, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    db,
    url,
    clock,
    raw,
    async request(
      account: string,
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) {
      let session = sessions.get(account);
      if (!session) {
        const login = await raw("POST", "/api/demo-login", { account });
        const value = z.object({ csrf: z.string() }).parse(await login.json());
        const cookie = login.headers.get("set-cookie")?.split(";")[0];
        if (!cookie) throw new Error("Login did not return a session cookie");
        session = { cookie, csrf: value.csrf };
        sessions.set(account, session);
      }
      const response = await raw(method, path, body, {
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        ...headers,
      });
      const content = await response.text();
      const result: unknown = content ? JSON.parse(content) : null;
      return { status: response.status, body: result };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      db.close();
      await rm(directory, { recursive: true });
    },
  };
}
