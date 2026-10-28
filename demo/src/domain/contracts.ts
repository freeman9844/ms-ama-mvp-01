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
