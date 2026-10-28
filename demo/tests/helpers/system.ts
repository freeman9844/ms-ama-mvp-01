import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { randomBytes } from "node:crypto";
import { createMockApp } from "../../src/mock/server.js";
import { openSourceDb } from "../../src/mock/seed.js";
import type { AiPort } from "../../src/copilot/port.js";

export async function startTestSystem(services: { ai?: AiPort } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "capstone-test-"));
  const db = openDb(join(directory, "app.db"));
  let now = new Date("2026-10-28T00:00:00+09:00");
  const clock = {
    now: () => new Date(now),
    set: (value: Date) => {
      now = value;
    },
  };
  const serviceToken = randomBytes(32).toString("hex");
  const options = { db, clock, origin: "", serviceToken, ai: services.ai };
  const server = createServer(createApp(options));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  const url = `http://127.0.0.1:${address.port}`;
  options.origin = url;
  const sourceDb = openSourceDb(join(directory, "source.db"));
  const mockServer = createServer(
    createMockApp({
      db: sourceDb,
      clock,
      serviceToken,
      appUrl: url,
    }),
  );
  mockServer.listen(0, "127.0.0.1");
  await once(mockServer, "listening");
  const mockAddress = mockServer.address();
  if (!mockAddress || typeof mockAddress === "string") throw new Error("Missing mock port");
  const mockUrl = `http://127.0.0.1:${mockAddress.port}`;
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
    serviceToken,
    mockUrl,
    sourceDb,
    sourceRequest(source: string, query: unknown, cursor: string | null) {
      const paths: Record<string, string> = {
        BANK: "/v1/bank/transactions",
        PG: "/v1/pg/settlements",
        TAX: "/v1/tax/documents",
      };
      const search = new URLSearchParams({ query: JSON.stringify(query) });
      if (cursor) search.set("cursor", cursor);
      return fetch(`${mockUrl}${paths[source]}?${search}`, {
        headers: { authorization: `Bearer ${serviceToken}` },
      });
    },
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
      mockServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        mockServer.close((error) => (error ? reject(error) : resolve()));
      });
      sourceDb.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      db.close();
      await rm(directory, { recursive: true });
    },
  };
}
