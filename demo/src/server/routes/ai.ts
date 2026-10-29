import type { Express } from "express";
import { z } from "zod";
import type { ServerOptions } from "../app.js";
import { context, requireRole } from "../auth.js";
import { DomainError, handler } from "../errors.js";

export function aiRoutes(app: Express, options: ServerOptions) {
  app.get(
    "/api/ai/models",
    handler(async (req, res) => {
      requireRole(context(req).actor, ["OPERATOR"]);
      if (!options.ai) throw new DomainError("AI_NOT_CONFIGURED", 503);
      res.json(
        (await options.ai.listModels())
          .filter((model) => model.id !== "auto")
          .map(({ id, name }) => ({ id, name })),
      );
    }),
  );
  app.put(
    "/api/ai/settings",
    handler(async (req, res) => {
      requireRole(context(req).actor, ["OPERATOR"]);
      if (!options.ai) throw new DomainError("AI_NOT_CONFIGURED", 503);
      const { modelId } = z.object({ modelId: z.string().min(1) }).parse(req.body);
      if (
        modelId === "auto" ||
        !(await options.ai.listModels()).some((model) => model.id === modelId)
      ) {
        throw new DomainError("MODEL_UNAVAILABLE", 409);
      }
      options.db
        .prepare(
          "INSERT INTO settings VALUES ('model_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(modelId);
      res.json({ modelId });
    }),
  );
}
