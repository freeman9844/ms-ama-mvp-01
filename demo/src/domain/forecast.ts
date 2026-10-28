import { z } from "zod";
import { addKrw } from "./money.js";
import { DomainError } from "../server/errors.js";

export const scheduledFlowSchema = z.object({
  id: z.string(),
  day: z.number().int().nonnegative(),
  amountKrw: z.number(),
  certainty: z.enum(["CONFIRMED", "UNKNOWN"]),
});
export type ScheduledFlow = z.infer<typeof scheduledFlowSchema>;
export const forecastSchema = z.object({
  closingKrw: z.number().int().safe(),
  minimumKrw: z.number().int().safe(),
  shortageDays: z.array(z.number().int()),
  daily: z.array(z.object({ day: z.number().int(), closingKrw: z.number().int().safe() })),
  uncertainties: z.array(z.string()),
});
export type Forecast = z.infer<typeof forecastSchema>;
export function forecast(
  openingKrw: number,
  input: readonly ScheduledFlow[],
  horizonDays: 7 | 30,
): Forecast {
  const flows = z.array(scheduledFlowSchema).parse(input);
  let balance = addKrw(0, openingKrw);
  let minimum = balance;
  const ids = new Set<string>();
  const uncertainties = new Set(["FUTURE_FLOWS_INCOMPLETE"]);
  for (const flow of flows) {
    addKrw(0, flow.amountKrw);
    if (ids.has(flow.id)) throw new DomainError("DUPLICATE_FLOW", 400);
    ids.add(flow.id);
    if (flow.certainty === "UNKNOWN") uncertainties.add("UNCONFIRMED_FLOW");
  }
  const daily: Forecast["daily"] = [];
  const shortageDays: number[] = [];
  for (let day = 0; day <= horizonDays; day++) {
    const today = flows.filter((x) => x.day === day && x.certainty === "CONFIRMED");
    if (today.some((x) => x.amountKrw > 0) && today.some((x) => x.amountKrw < 0)) {
      uncertainties.add("INTRADAY_ORDER_UNKNOWN");
    }
    balance = today.reduce((sum, flow) => addKrw(sum, flow.amountKrw), balance);
    minimum = Math.min(minimum, balance);
    daily.push({ day, closingKrw: balance });
    if (balance < 0) shortageDays.push(day);
  }
  return {
    closingKrw: balance,
    minimumKrw: minimum,
    shortageDays,
    daily,
    uncertainties: [...uncertainties],
  };
}
