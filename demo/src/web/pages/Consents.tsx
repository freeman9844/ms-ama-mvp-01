import { useRef, useState } from "react";
import { z } from "zod";
import type { Actor } from "../../domain/contracts.js";
import { consentView } from "../../domain/views.js";
import { ErrorNotice, date, label, useAction, useQuery } from "../hooks.js";
import { send } from "../api.js";
import { consentBody } from "./Application.js";

const consents = z.array(consentView);
const deletionSchema = z.object({
  access: z.string(),
  state: z.string(),
  job_id: z.string().nullable(),
});
function Deletion({ id, epoch, refresh }: { id: string; epoch: number; refresh(): void }) {
  const info = useQuery(
    `/api/consents/${id}/deletion`,
    deletionSchema,
    epoch,
    (value) => value.access === "BLOCKED" && ["PENDING", "DELETING"].includes(value.state),
  );
  const action = useAction();
  return (
    <div>
      <ErrorNotice error={info.error ?? action.error} />
      <p>
        접근: {info.data?.access} · 삭제: {info.data ? label(info.data.state) : "조회 중"}
      </p>
      {info.data?.state === "CLEANUP_FAILED" && (
        <button
          disabled={action.busy}
          onClick={() => {
            void action.run(async () => {
              await send(
                `/api/jobs/${info.data!.job_id}/retry`,
                z.object({ jobId: z.string() }),
                {},
              );
              refresh();
            });
          }}
        >
          삭제 재시도
        </button>
      )}
    </div>
  );
}
export function Consents({
  actor,
  now,
  epoch,
  refresh,
}: {
  actor: Actor;
  now: string;
  epoch: number;
  refresh(): void;
}) {
  const data = useQuery("/api/consents", consents, epoch);
  const [accepted, setAccepted] = useState(false);
  const [confirm, setConfirm] = useState<string>();
  const keys = useRef(new Map<string, string>());
  const action = useAction();
  return (
    <section>
      <h1>데이터 동의</h1>
      <p>
        철회하면 접근을 즉시 차단하고 앱 자료·파생 결과와 로컬 SDK 세션을 삭제합니다. 원천기관
        DB·원격 Copilot 기록 삭제를 의미하지 않습니다.
      </p>
      <h2>별도 사후 모니터링 동의</h2>
      <p>
        BANK·PG·TAX 합성 자료, 각 사업자 자원, 2026-04-28부터{" "}
        {date(consentBody("BANK", actor.businessId!, "MONITORING", now).to)}까지. 은행은 조회 시점
        이전 거래만 조회합니다. 유효기간 60일이며 자동 갱신하지 않습니다.
      </p>
      <label className="check">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        사후 모니터링 데이터 제공 동의
      </label>
      <button
        disabled={!accepted || action.busy}
        onClick={() => {
          void action.run(async () => {
            for (const source of ["BANK", "PG", "TAX"]) {
              const key = keys.current.get(source) ?? crypto.randomUUID();
              keys.current.set(source, key);
              await send(
                "/api/consents",
                z.object({ id: z.string() }),
                consentBody(source, actor.businessId!, "MONITORING", now),
                key,
              );
            }
            keys.current.clear();
            setAccepted(false);
            refresh();
          });
        }}
      >
        모니터링 동의 등록·갱신
      </button>
      <p>미동의 시 모니터링을 실행하지 않으며 자동 거절 사유로 사용하지 않습니다.</p>
      <ErrorNotice error={data.error ?? action.error} />
      {data.data?.map((row) => (
        <article key={row.id}>
          <h2>
            {row.source} · {row.purpose === "ASSESSMENT" ? "신청 심사" : "사후 모니터링"}
          </h2>
          <p>
            {date(row.from)} ~ {date(row.to)} · 유효기한 {date(row.validUntil)}
          </p>
          <p>
            {row.resourceIds.join(", ")} ·{" "}
            {label(
              Date.parse(row.validUntil) <= Date.parse(now) && row.status === "ACTIVE"
                ? "EXPIRED"
                : row.status,
            )}
          </p>
          <Deletion id={row.id} epoch={epoch} refresh={refresh} />
          {row.status === "ACTIVE" && (
            <button className="secondary" onClick={() => setConfirm(row.id)}>
              이 동의 철회
            </button>
          )}
          {confirm === row.id && (
            <div role="group" aria-label="철회 확인">
              <p>연결된 수집·파생 자료를 삭제합니다.</p>
              <button
                disabled={action.busy}
                onClick={() => {
                  void action.run(async () => {
                    await send(
                      `/api/consents/${row.id}/revoke`,
                      z.object({ access: z.literal("BLOCKED") }),
                      {},
                    );
                    setConfirm(undefined);
                    refresh();
                  });
                }}
              >
                철회 및 삭제 요청 확인
              </button>
              <button className="secondary" onClick={() => setConfirm(undefined)}>
                취소
              </button>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
