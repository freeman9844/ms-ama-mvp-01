import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const correlationId = randomUUID();
  const status =
    error instanceof DomainError
      ? error.status
      : error instanceof ZodError || error instanceof SyntaxError
        ? 400
        : 500;
  const code =
    error instanceof DomainError
      ? error.code
      : status === 400
        ? "INVALID_REQUEST"
        : "INTERNAL_ERROR";
  if (status === 500)
    console.error(
      JSON.stringify({
        correlationId,
        code,
        type: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  res.status(status).json({ error: { code, correlationId } });
};

export function handler(fn: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(next);
  };
}
