import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { accountSchema, actorSchema, type Actor, type Role } from "../domain/contracts.js";
import { DomainError } from "./errors.js";

const sessionSchema = z.object({
  id: z.string(),
  actor_json: z.string(),
  csrf: z.string(),
  expires_at_ms: z.number(),
});
type Session = { id: string; actor: Actor; csrf: string };
const sessions = new WeakMap<Request, Session>();

export function requireRole(actor: Actor, roles: readonly Role[]): void {
  if (!roles.includes(actor.role)) throw new DomainError("FORBIDDEN", 403);
}

export function serviceAuthentication(token: string): RequestHandler {
  return (req, _res, next) => {
    const value = req.get("authorization") ?? "";
    const expected = `Bearer ${token}`;
    if (
      !token ||
      Buffer.byteLength(value) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(value), Buffer.from(expected))
    ) {
      return next(new DomainError("SERVICE_UNAUTHENTICATED", 401));
    }
    next();
  };
}

export function context(req: Request): Session {
  const session = sessions.get(req);
  if (!session) throw new DomainError("UNAUTHENTICATED", 401);
  return session;
}

export function login(db: DatabaseSync, input: unknown): Session {
  const { account } = z.object({ account: accountSchema }).parse(input);
  const actor: Actor = {
    id: account,
    role: account === "officer" ? "OFFICER" : account === "operator" ? "OPERATOR" : "BORROWER",
    businessId: account.startsWith("shop-") ? account : null,
  };
  const session = {
    id: randomBytes(32).toString("hex"),
    csrf: randomBytes(32).toString("hex"),
    actor,
  };
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(
    session.id,
    JSON.stringify(actor),
    session.csrf,
    Date.now() + 8 * 60 * 60 * 1000,
  );
  return session;
}

export function authentication(db: DatabaseSync): RequestHandler {
  return (req, _res, next) => {
    try {
      const id = req.headers.cookie
        ?.split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("demo_session="))
        ?.slice("demo_session=".length);
      const row = id ? db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) : undefined;
      if (!row) throw new DomainError("UNAUTHENTICATED", 401);
      const parsed = sessionSchema.parse(row);
      if (parsed.expires_at_ms <= Date.now()) throw new DomainError("SESSION_EXPIRED", 401);
      const actor = actorSchema.parse(JSON.parse(parsed.actor_json));
      sessions.set(req, { id: parsed.id, actor, csrf: parsed.csrf });
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const provided = req.get("x-csrf-token") ?? "";
        const expected = parsed.csrf;
        if (
          Buffer.byteLength(provided) !== Buffer.byteLength(expected) ||
          !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
        ) {
          throw new DomainError("CSRF_REJECTED", 403);
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
