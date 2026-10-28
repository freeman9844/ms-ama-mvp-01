import { z } from "zod";

export const assessmentSchema = z.object({
  recommendation: z.enum(["REVIEW", "REQUEST_INFORMATION", "DECLINE_RECOMMENDED"]),
  factors: z.array(
    z.object({
      label: z.string().min(1),
      evidenceIds: z.array(z.string()),
    }),
  ),
  uncertainties: z.array(z.string()),
  explanation: z.string().min(1),
});
export const warningSchema = z.object({
  explanation: z.string().min(1),
  evidenceIds: z.array(z.string()),
  uncertainties: z.array(z.string()),
});
export const supportSchema = z.object({
  route: z.enum(["GENERAL_INQUIRY", "PAYMENT_DIFFICULTY", "DISPUTE_OR_CORRECTION", "HUMAN_REVIEW"]),
  explanation: z.string().min(1),
  evidenceIds: z.array(z.string()),
});
export const schemas = {
  UNDERWRITING: assessmentSchema,
  WARNING: warningSchema,
  COLLECTIONS: supportSchema,
};
