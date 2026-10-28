import express from "express";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../domain/clock.js";
import { authentication, context, login, requireRole } from "./auth.js";
import { DomainError, errorHandler } from "./errors.js";
import { consentRoutes, internalConsentRoutes } from "./routes/consents.js";
import type { AiPort } from "../copilot/port.js";
import { aiRoutes } from "./routes/ai.js";
import { applicationRoutes } from "./routes/applications.js";
import { jobRoutes } from "./routes/jobs.js";

export type ServerOptions = {
  db: DatabaseSync;
  clock: Clock;
  origin: string;
  serviceToken: string;
  ai?: AiPort;
};

export function createApp(options: ServerOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    if (req.get("content-encoding") && req.get("content-encoding") !== "identity") {
      return next(new DomainError("COMPRESSED_REQUEST_REJECTED", 415));
    }
    if (
      !req.path.startsWith("/internal/") &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("origin") !== options.origin
    ) {
      return next(new DomainError("ORIGIN_REJECTED", 403));
    }
    next();
  });
  app.use(express.json({ limit: "32kb", inflate: false }));
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  internalConsentRoutes(app, options);
  app.post("/api/demo-login", (req, res) => {
    const session = login(options.db, req.body);
    res.cookie("demo_session", session.id, { httpOnly: true, sameSite: "strict", path: "/" });
    res.json({ actor: session.actor, csrf: session.csrf });
  });
  app.use("/api", authentication(options.db));
  consentRoutes(app, options);
  aiRoutes(app, options);
  applicationRoutes(app, options);
  jobRoutes(app, options);
  app.get("/api/me", (req, res) => {
    const { actor, csrf } = context(req);
    res.json({ actor, csrf });
  });
  app.post("/api/logout", (req, res) => {
    options.db.prepare("DELETE FROM sessions WHERE id = ?").run(context(req).id);
    res.clearCookie("demo_session", { path: "/" });
    res.status(204).end();
  });
  app.post("/api/demo/events", (req, _res) => {
    requireRole(context(req).actor, ["OPERATOR"]);
    throw new DomainError("NOT_IMPLEMENTED", 501);
  });
  app.use((_req, _res, next) => {
    next(new DomainError("NOT_FOUND", 404));
  });
  app.use(errorHandler);
  return app;
}
