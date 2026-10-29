import { z } from "zod";
import { sourceSchema, timestampSchema } from "./contracts.js";

const base = { id: z.string().min(1).max(120), businessId: z.enum(["shop-a", "shop-b"]) };
export const eventSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("SETTLEMENT_DELAY"),
    settlementId: z.string(),
    dueAt: timestampSchema,
  }),
  z.object({ ...base, type: z.literal("SETTLEMENT_PAID"), settlementId: z.string() }),
  z.object({ ...base, type: z.literal("MISSED_PAYMENT"), scheduleId: z.string() }),
  z.object({ ...base, type: z.literal("PAYMENT_RECEIVED"), scheduleId: z.string() }),
  z.object({
    ...base,
    type: z.literal("SOURCE_FAILURE"),
    source: sourceSchema,
    requests: z.number().int().min(1).max(10),
  }),
  z.object({ ...base, type: z.literal("ADVANCE_TIME"), days: z.number().int().min(1).max(365) }),
]);
export const sourceEventSchema = z.object({
  event: eventSchema,
  generation: z.number().int(),
  occurredAt: timestampSchema,
  nextTime: timestampSchema,
  paymentKrw: z.number().int().positive().safe().optional(),
});
