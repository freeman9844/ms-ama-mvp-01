import type { SourceClient } from "./assembly.js";
import { sourcePageSchema } from "../domain/contracts.js";
import { DomainError } from "../server/errors.js";

export function createSourceClient(
  baseUrl: string,
  token: string,
  signal: AbortSignal,
): SourceClient {
  const paths = {
    BANK: "/v1/bank/transactions",
    PG: "/v1/pg/settlements",
    TAX: "/v1/tax/documents",
  };
  return {
    async page(query, cursor) {
      const params = new URLSearchParams({ query: JSON.stringify(query) });
      if (cursor) params.set("cursor", cursor);
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        let response: Response;
        try {
          response = await fetch(`${baseUrl}${paths[query.source]}?${params}`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          });
        } catch (error) {
          signal.throwIfAborted();
          if (
            !(error instanceof TypeError) &&
            !(error instanceof DOMException && error.name === "TimeoutError")
          )
            throw error;
          if (attempt === 2) throw new DomainError("SOURCE_UNAVAILABLE", 502);
          await wait((attempt + 1) * 1_000, signal);
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          throw new DomainError("SOURCE_ACCESS_DENIED", 403);
        }
        if (response.status === 409) throw new DomainError("SOURCE_SNAPSHOT_CHANGED", 409);
        if (response.status >= 500) {
          await response.body?.cancel();
          if (attempt === 2) throw new DomainError("SOURCE_UNAVAILABLE", 502);
          await wait((attempt + 1) * 1_000, signal);
          continue;
        }
        if (!response.ok) throw new DomainError("SOURCE_REQUEST_REJECTED", 502);
        return sourcePageSchema.parse(await response.json());
      }
      throw new DomainError("SOURCE_UNAVAILABLE", 502);
    },
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
