import type { Express } from "express";
import { authorize, grantConsent, listConsents } from "../../agents/consent.js";
import { consentQuerySchema } from "../../domain/contracts.js";
import type { ServerOptions } from "../app.js";
import { context, serviceAuthentication } from "../auth.js";

export function internalConsentRoutes(app: Express, options: ServerOptions) {
  app.post(
    "/internal/consents/authorize",
    serviceAuthentication(options.serviceToken),
    (req, res) => {
      res.json(authorize(options.db, consentQuerySchema.parse(req.body), options.clock.now()));
    },
  );
}
export function consentRoutes(app: Express, options: ServerOptions) {
  app.post("/api/consents", (req, res) => {
    res.status(201).json(grantConsent(options.db, options.clock, context(req).actor, req.body));
  });
  app.get("/api/consents", (req, res) => {
    res.json(listConsents(options.db, context(req).actor));
  });
}
