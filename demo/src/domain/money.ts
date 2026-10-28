import { DomainError } from "../server/errors.js";

export function addKrw(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a + b)) {
    throw new DomainError("INVALID_MONEY", 400);
  }
  return a + b;
}
