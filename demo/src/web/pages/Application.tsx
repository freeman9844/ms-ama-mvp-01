import { useRef, useState } from "react";
import { z } from "zod";
import { send } from "../api.js";
import { ErrorNotice, useAction, date, money } from "../hooks.js";
import type { Actor } from "../../domain/contracts.js";

const grantSchema = z.object({ id: z.string() });
export function consentBody(
  source: string,
  businessId: string,
  purpose: "ASSESSMENT" | "MONITORING",
  now: string,
) {
  const validUntil = new Date(
    Date.parse(now) + (purpose === "ASSESSMENT" ? 30 : 60) * 86_400_000,
  ).toISOString();
  return {
    source,
    purpose,
    resourceIds: [`${source.toLowerCase()}-${businessId}`],
    from: "2026-04-28T00:00:00+09:00",
    to: purpose === "ASSESSMENT" ? now : validUntil,
    validUntil,
    accepted: true,
  };
}
export function Application({ actor, now }: { actor: Actor; now: string }) {
  const [companyName, setName] = useState(
    actor.businessId === "shop-a" ? "합성 가게 A" : "합성 가게 B",
  );
  const [amount, setAmount] = useState(10_000_000);
  const [accepted, setAccepted] = useState(false);
  const grants = useRef(new Map<string, { key: string; id?: string }>());
  const attempt = useRef({ body: "", key: "" });
  const action = useAction();
  return (
    <section>
      <h1>대출 신청</h1>
      <p>실제 대출이 아닌 합성 데이터 기반 시연입니다.</p>
      <h2>1. 기본 정보</h2>
      <label>
        사업자명
        <input value={companyName} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        희망 금액 (원)
        <input
          type="number"
          min="1"
          step="1"
          value={amount}
          onChange={(e) => setAmount(e.target.valueAsNumber)}
        />
      </label>
      <h2>2. 신청 심사 동의</h2>
      <p>
        동의하지 않으면 원천 자료를 수집하거나 신청을 제출할 수 없습니다. 모니터링은 별도
        동의입니다.
      </p>
      {["BANK", "PG", "TAX"].map((source) => (
        <details key={source}>
          <summary>{source} 자료 제공 범위</summary>
          <p>
            목적: 신청 심사 · 항목:{" "}
            {source === "BANK"
              ? "합성 계좌 거래·잔액"
              : source === "PG"
                ? "합성 정산 상태·예정일·순금액"
                : "합성 신고 매출·기간"}
          </p>
          <p>
            허용 자원: {source.toLowerCase()}-{actor.businessId} · 조회 시작: 2026-04-28
          </p>
          <p>
            기준 시각: {date(now)} · 유효기한:{" "}
            {date(consentBody(source, actor.businessId!, "ASSESSMENT", now).validUntil)}
          </p>
        </details>
      ))}
      <label className="check">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        신청 심사 데이터 제공 동의
      </label>
      <h2>3. 최종 확인</h2>
      <p>
        {companyName} · 신청 금액 {Number.isFinite(amount) ? money(amount) : "입력 필요"}
      </p>
      <ErrorNotice error={action.error} />
      <button
        disabled={
          !accepted || action.busy || !companyName || !Number.isSafeInteger(amount) || amount <= 0
        }
        onClick={() => {
          void action.run(async () => {
            const consentIds: string[] = [];
            for (const source of ["BANK", "PG", "TAX"]) {
              let grant = grants.current.get(source);
              if (!grant) {
                grant = { key: crypto.randomUUID() };
                grants.current.set(source, grant);
              }
              if (!grant.id)
                grant.id = (
                  await send(
                    "/api/consents",
                    grantSchema,
                    consentBody(source, actor.businessId!, "ASSESSMENT", now),
                    grant.key,
                  )
                ).id;
              consentIds.push(grant.id);
            }
            const body = { companyName, requestedAmountKrw: amount, consentIds };
            if (attempt.current.body !== JSON.stringify(body))
              attempt.current = { body: JSON.stringify(body), key: crypto.randomUUID() };
            const result = await send(
              "/api/applications",
              z.object({ applicationId: z.string() }),
              body,
              attempt.current.key,
            );
            location.hash = `status/${result.applicationId}`;
          });
        }}
      >
        {action.busy ? "동의 등록·제출 중" : "최종 제출"}
      </button>
    </section>
  );
}
