import { z } from "zod";
import { useRef, useState } from "react";
import type { Actor } from "../../domain/contracts.js";
import { consentBody } from "./Application.js";
import { applicationView, timelineView } from "../../domain/views.js";
import { ErrorNotice, label, money, useAction, useQuery } from "../hooks.js";
import { send } from "../api.js";

const applications = z.array(applicationView);
const timeline = z.array(timelineView);
export function ApplicationStatus({
  epoch,
  refresh,
  id,
  home = false,
  actor,
  now,
}: {
  epoch: number;
  refresh(): void;
  id?: string;
  home?: boolean;
  actor: Actor;
  now: string;
}) {
  const [renew, setRenew] = useState<Record<string, boolean>>({});
  const grants = useRef(new Map<string, { key: string; id?: string }>());
  const jobs = useQuery("/api/timeline", timeline, epoch, (data) =>
    data.some((row) => ["QUEUED", "RUNNING"].includes(row.status)),
  );
  const jobVersion = jobs.data?.map((job) => `${job.id}:${job.status}`).join(",");
  const apps = useQuery("/api/applications", applications, `${epoch}:${jobVersion}`, (data) =>
    data.some(
      (row) =>
        ["SUBMITTED", "COLLECTING", "ANALYZING"].includes(row.status) &&
        jobs.data?.some(
          (job) => job.applicationId === row.id && ["QUEUED", "RUNNING"].includes(job.status),
        ),
    ),
  );
  const action = useAction();
  return (
    <section>
      <h1>{home ? "사업자 홈" : "내 신청 현황"}</h1>
      <p>신청 → 동의 확인·자료 수집 → AI 의견 → 담당자 결정</p>
      <button className="secondary" onClick={refresh}>
        새로고침
      </button>
      <ErrorNotice error={apps.error ?? jobs.error ?? action.error} />
      {apps.data?.length === 0 && (
        <p>
          아직 신청이 없습니다. <a href="#apply">첫 대출 신청하기</a>
        </p>
      )}
      {apps.data
        ?.filter((app) => !id || app.id === id)
        .map((app) => (
          <article key={app.id}>
            <h2>
              {app.companyName} · {money(app.requestedAmountKrw)}
            </h2>
            <strong className="badge">{label(app.status)}</strong>
            <p className="reference">신청 ID: {app.id}</p>
            {app.evidenceDeleted && (
              <p>근거 자료 삭제됨 · 대출·사람의 결정은 별도 업무 기록입니다.</p>
            )}
            {app.status === "NEEDS_INFORMATION" && (
              <>
                <p>
                  기존 동의가 현재 조회기간을 포함하지 않으면 새 동의가 필요합니다. BANK 거래·잔액,
                  PG 정산, TAX 신고 자료를 신청 심사 목적으로 2026-04-28부터 {now}까지 제공합니다.
                  유효기한은 동의 시점부터 30일입니다.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={renew[app.id] ?? false}
                    onChange={(event) => setRenew({ ...renew, [app.id]: event.target.checked })}
                  />
                  보완 심사 자료 제공 동의 갱신
                </label>
                <button
                  disabled={action.busy}
                  onClick={() => {
                    void action.run(async () => {
                      let consentIds: string[] | undefined;
                      if (renew[app.id]) {
                        consentIds = [];
                        for (const source of ["BANK", "PG", "TAX"]) {
                          const cacheKey = `${app.id}:${now}:${source}`;
                          let grant = grants.current.get(cacheKey);
                          if (!grant) {
                            grant = { key: crypto.randomUUID() };
                            grants.current.set(cacheKey, grant);
                          }
                          grant.id ??= (
                            await send(
                              "/api/consents",
                              z.object({ id: z.string() }),
                              consentBody(source, actor.businessId!, "ASSESSMENT", now),
                              grant.key,
                            )
                          ).id;
                          consentIds.push(grant.id);
                        }
                      }
                      await send(
                        `/api/applications/${app.id}/corrections`,
                        z.object({ jobId: z.string() }),
                        { fixtureId: "synthetic-confirmation", consentIds },
                      );
                      refresh();
                    });
                  }}
                >
                  합성 보완자료 제출
                </button>
              </>
            )}
            {jobs.data
              ?.filter((job) => job.applicationId === app.id)
              .map((job) => (
                <p key={job.id}>
                  {job.kind} · {label(job.status)}{" "}
                  {job.errorCode && <span className="error">{job.errorCode}</span>}
                  {job.status === "FAILED" && (
                    <button
                      disabled={action.busy}
                      onClick={() => {
                        void action.run(async () => {
                          await send(
                            `/api/jobs/${job.id}/retry`,
                            z.object({ jobId: z.string() }),
                            {},
                          );
                          refresh();
                        });
                      }}
                    >
                      작업 재시도
                    </button>
                  )}
                </p>
              ))}
          </article>
        ))}
    </section>
  );
}
