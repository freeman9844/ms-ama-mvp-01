import { z } from "zod";
import { actorSchema, sourceRecordSchema } from "./contracts.js";
import { assessmentSchema, warningSchema } from "../copilot/schemas.js";

export const sessionSchema = z.object({ actor: actorSchema, csrf: z.string() });
export const demoStateSchema = z.object({
  now: z.string(),
  modelId: z.string().nullable(),
  maintenance: z.string(),
});
export const applicationView = z.object({
  id: z.string(),
  status: z.string(),
  companyName: z.string(),
  requestedAmountKrw: z.number(),
  consentIds: z.array(z.string()),
  evidenceDeleted: z.boolean(),
});
export const consentView = z.object({
  id: z.string(),
  purpose: z.string(),
  source: z.string(),
  resourceIds: z.array(z.string()),
  from: z.string(),
  to: z.string(),
  validUntil: z.string(),
  status: z.string(),
});
export const loanView = z.object({
  id: z.string(),
  applicationId: z.string(),
  businessId: z.string(),
  status: z.string(),
  schedules: z.array(
    z.object({
      id: z.string(),
      dueAt: z.string(),
      amountKrw: z.number(),
      status: z.string(),
      version: z.number(),
    }),
  ),
});
export const supportView = z.object({
  id: z.string(),
  applicationId: z.string(),
  kind: z.string(),
  text: z.string(),
  route: z.string().nullable(),
  status: z.string(),
  errorCode: z.string().nullable(),
  messages: z.array(
    z.object({ text: z.string(), state: z.string(), reason: z.string().nullable() }),
  ),
});
export const timelineView = z.object({
  id: z.string(),
  applicationId: z.string().nullable(),
  kind: z.string(),
  status: z.string(),
  errorCode: z.string().nullable(),
  modelId: z.string(),
  toolCount: z.number(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
});
const forecastView = z.object({
  minimumKrw: z.number(),
  closingKrw: z.number(),
  shortageDays: z.array(z.number()),
  uncertainties: z.array(z.string()),
});
export const assessmentView = z.object({
  dataset: z.object({
    id: z.string(),
    version: z.number(),
    asOf: z.string(),
    balanceKrw: z.number(),
    operatingNetKrw: z.number(),
    forecast7: forecastView,
    forecast30: forecastView,
    records: z.array(sourceRecordSchema),
  }),
  assessment: assessmentSchema,
  assessmentVersion: z.number(),
});
export const alertView = z.object({
  id: z.string(),
  applicationId: z.string(),
  code: z.string(),
  state: z.string(),
  minimumKrw: z.number(),
  explanationStatus: z.string(),
  explanation: warningSchema.nullable(),
});
