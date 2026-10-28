import { z } from "zod";

export const accountSchema = z.enum(["shop-a", "shop-b", "officer", "operator"]);
export type Account = z.infer<typeof accountSchema>;
export type Role = "BORROWER" | "OFFICER" | "OPERATOR";
export const actorSchema = z.object({
  id: accountSchema,
  role: z.enum(["BORROWER", "OFFICER", "OPERATOR"]),
  businessId: z.string().nullable(),
});
export type Actor = z.infer<typeof actorSchema>;

export const timestampSchema = z.iso.datetime({ offset: true });
export const sourceSchema = z.enum(["BANK", "PG", "TAX"]);
export const purposeSchema = z.enum(["ASSESSMENT", "MONITORING"]);
export type Source = z.infer<typeof sourceSchema>;
export type Purpose = z.infer<typeof purposeSchema>;
export const consentQuerySchema = z
  .object({
    consentId: z.string(),
    businessId: z.string(),
    purpose: purposeSchema,
    source: sourceSchema,
    resourceIds: z.array(z.string()).min(1),
    from: timestampSchema,
    to: timestampSchema,
  })
  .refine((x) => Date.parse(x.from) < Date.parse(x.to), "Invalid interval");
export type ConsentQuery = z.infer<typeof consentQuerySchema>;
export type ConsentProof = { id: string; version: number; validUntil: string };
const commonRecord = {
  id: z.string(),
  businessId: z.string(),
  resourceId: z.string(),
  occurredAt: timestampSchema,
};
export const sourceRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    ...commonRecord,
    kind: z.literal("BANK"),
    amountKrw: z.number().int().safe(),
    category: z.enum(["OPERATING", "INTERNAL_TRANSFER", "FINANCING"]),
    settlementId: z.string().nullable(),
  }),
  z.object({
    ...commonRecord,
    kind: z.literal("PG"),
    netKrw: z.number().int().nonnegative().safe(),
    dueAt: timestampSchema,
    status: z.enum(["UNPAID", "PAID", "UNKNOWN"]),
  }),
  z.object({
    ...commonRecord,
    kind: z.literal("TAX"),
    periodStart: timestampSchema,
    periodEnd: timestampSchema,
    reportedRevenueKrw: z.number().int().nonnegative().safe(),
  }),
]);
export type SourceRecord = z.infer<typeof sourceRecordSchema>;
export const sourcePageSchema = z.object({
  snapshotId: z.string(),
  asOf: timestampSchema,
  totalCount: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  items: z.array(sourceRecordSchema),
  balances: z
    .object({
      openingKrw: z.number().int().safe(),
      closingKrw: z.number().int().safe(),
    })
    .nullable(),
});
export type SourcePage = z.infer<typeof sourcePageSchema>;
