import type { Express } from "express";
import {
  authorize,
  grantConsent,
  listConsents,
  revokeConsent,
  consentInputSchema,
} from "../../agents/consent.js";
import { consentQuerySchema } from "../../domain/contracts.js";
import type { ServerOptions } from "../app.js";
import { context, serviceAuthentication } from "../auth.js";
import { z } from "zod";
import { DomainError } from "../errors.js";
import { idempotent } from "../transactions.js";

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
  app.post("/api/consents/:id/revoke", (req, res) => {
    res
      .status(202)
      .json(
        revokeConsent(
          options.db,
          options.clock,
          context(req).actor,
          z.string().parse(req.params.id),
        ),
      );
  });
  app.get("/api/consents/:id/deletion", (req, res) => {
    const id = z.string().parse(req.params.id);
    const raw = options.db.prepare("SELECT * FROM consents WHERE id=?").get(id);
    if (!raw) throw new DomainError("NOT_FOUND", 404);
    const consent = z
      .object({ business_id: z.string(), status: z.string(), payload: z.string() })
      .parse(raw);
    const actor = context(req).actor;
    if (actor.role === "BORROWER" && actor.businessId !== consent.business_id)
      throw new DomainError("FORBIDDEN", 403);
    const blocked =
      consent.status !== "ACTIVE" ||
      Date.parse(consentInputSchema.parse(JSON.parse(consent.payload)).validUntil) <=
        options.clock.now().getTime();
    const deletion = options.db
      .prepare("SELECT state,error_code,job_id FROM deletion_requests WHERE consent_id=?")
      .get(id);
    res.json({
      access: blocked ? "BLOCKED" : "ACTIVE",
      ...(deletion
        ? z
            .object({ state: z.string(), error_code: z.string().nullable(), job_id: z.string() })
            .parse(deletion)
        : { state: blocked ? "PENDING" : "NOT_REQUESTED", error_code: null, job_id: null }),
    });
  });
  app.post("/api/consents", (req, res) => {
    const actor = context(req).actor;
    const body = consentInputSchema.parse(req.body);
    const grant = () => grantConsent(options.db, options.clock, actor, body);
    const key = req.get("idempotency-key");
    res
      .status(201)
      .json(
        key
          ? idempotent(
              options.db,
              actor.id,
              req.path,
              key,
              body,
              z.object({ id: z.string(), version: z.number(), validUntil: z.string() }),
              grant,
            )
          : grant(),
      );
  });
  app.get("/api/consents", (req, res) => {
    res.json(listConsents(options.db, context(req).actor));
  });
}
