import { defineTool, type SessionConfig } from "@github/copilot-sdk";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { readDataset } from "../agents/assembly.js";
import { forecast } from "../domain/forecast.js";
import { DomainError } from "../server/errors.js";
import type { AiRequest } from "./port.js";

export function toolsFor(
  db: DatabaseSync,
  request: AiRequest,
  beforeTool: (name: string) => void,
): NonNullable<SessionConfig["tools"]> {
  const tools: NonNullable<SessionConfig["tools"]> = [
    defineTool("get_policy", {
      description: "이 역할에 승인된 데모 업무 정책만 조회합니다.",
      parameters: z.object({ role: z.literal(request.role) }).strict(),
      skipPermission: true,
      handler: (args) => {
        beforeTool("get_policy");
        z.object({ role: z.literal(request.role) })
          .strict()
          .parse(args);
        return {
          role: request.role,
          humanApprovalRequired: true,
          actions: ["recommend_only", "no_real_messages", "no_debt_changes"],
          warningDoesNotMeanDelinquency: true,
        };
      },
    }),
  ];
  if (!request.dataset) return tools;
  const ref = request.dataset;
  const dataset = () => {
    const data = readDataset(db, ref.id);
    if (data.businessId !== request.businessId || data.version !== ref.version) {
      throw new DomainError("AI_DATASET_SCOPE", 403);
    }
    return data;
  };
  tools.push(
    defineTool("get_evidence", {
      description: "현재 작업 자료에서 지정한 근거 ID만 조회합니다.",
      parameters: z.object({ ids: z.array(z.string()).max(10) }).strict(),
      skipPermission: true,
      handler: (args) => {
        beforeTool("get_evidence");
        const { ids } = z
          .object({ ids: z.array(z.string()).max(10) })
          .strict()
          .parse(args);
        const data = dataset();
        if (ids.some((id) => !data.records.some((row) => row.id === id))) {
          throw new DomainError("AI_UNKNOWN_EVIDENCE", 403);
        }
        return data.records.filter((row) => ids.includes(row.id));
      },
    }),
  );
  tools.push(
    defineTool("run_cashflow_scenario", {
      description: "확인된 미지급 PG 정산을 0~30일 지연하는 코드 계산입니다.",
      parameters: z.object({ settlement_delay_days: z.number().int().min(0).max(30) }).strict(),
      skipPermission: true,
      handler: (args) => {
        beforeTool("run_cashflow_scenario");
        const { settlement_delay_days: delay } = z
          .object({
            settlement_delay_days: z.number().int().min(0).max(30),
          })
          .strict()
          .parse(args);
        const data = dataset();
        const settlementIds = new Set(
          data.records
            .filter((row) => row.kind === "PG" && row.status === "UNPAID")
            .map((row) => row.id),
        );
        return forecast(
          data.balanceKrw,
          data.scheduledFlows.map((flow) =>
            settlementIds.has(flow.id) ? { ...flow, day: flow.day + delay } : flow,
          ),
          30,
        );
      },
    }),
  );
  return tools;
}
