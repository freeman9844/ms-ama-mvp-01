import { useState } from "react";
import { z } from "zod";
import {
  alertView,
  applicationView,
  assessmentView,
  loanView,
  supportView,
  timelineView,
} from "../../domain/views.js";
import { ErrorNotice, date, label, money, useAction, useQuery } from "../hooks.js";
import { send } from "../api.js";
const applications = z.array(applicationView);
const alerts = z.array(alertView);
const requests = z.array(supportView);
const loans = z.array(loanView);
const timeline = z.array(timelineView);

function Assessment({
  id,
  epoch,
  refresh,
  reviewable,
}: {
  id: string;
  epoch: number;
  refresh(): void;
  reviewable: boolean;
}) {
  const query = useQuery(`/api/applications/${id}/assessment`, assessmentView, epoch);
  const [reason, setReason] = useState("합성 자료와 불확실성 검토");
  const action = useAction();
  const data = query.data;
  return (
    <article>
      <h2>심사 상세</h2>
      <ErrorNotice error={query.error ?? action.error} />
      {data && (
        <>
          <h3>코드 계산 결과</h3>
          <div className="metrics">
            <p>
              현재 잔액<strong>{money(data.dataset.balanceKrw)}</strong>
            </p>
            <p>
              7일 최저<strong>{money(data.dataset.forecast7.minimumKrw)}</strong>
            </p>
            <p>
              30일 최저<strong>{money(data.dataset.forecast30.minimumKrw)}</strong>
            </p>
          </div>
          <p>
            기준 {date(data.dataset.asOf)} · 데이터 v{data.dataset.version} · 평가 v
            {data.assessmentVersion}
          </p>
          <h3>AI 의견 · 승인 권한 없음</h3>
          <p>{data.assessment.explanation}</p>
          {data.assessment.factors.map((factor, index) => (
            <p key={index}>
              {factor.label} · 근거: {factor.evidenceIds.join(", ")}
            </p>
          ))}
          <h3>불확실성</h3>
          <p>
            {[...data.assessment.uncertainties, ...data.dataset.forecast30.uncertainties].join(
              " · ",
            )}
          </p>
          <details>
            <summary>수집 근거 {data.dataset.records.length}건</summary>
            {data.dataset.records.map((row) => (
              <p className="reference" key={row.id}>
                {row.kind} · {row.id} · {date(row.occurredAt)}
              </p>
            ))}
          </details>
          <label>
            담당자 결정 사유
            <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="actions">
            {[
              ["APPROVE", "모의 대출 승인"],
              ["REJECT", "거절"],
              ["REQUEST_INFORMATION", "보완 요청"],
            ].map(([decision, name]) => (
              <button
                key={decision}
                disabled={!reviewable || action.busy || !reason.trim()}
                onClick={() => {
                  void action.run(async () => {
                    await send(
                      `/api/applications/${id}/review`,
                      z.object({ decisionId: z.string() }),
                      {
                        decision,
                        reason,
                        datasetVersion: data.dataset.version,
                        assessmentVersion: data.assessmentVersion,
                      },
                    );
                    refresh();
                  });
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </>
      )}
    </article>
  );
}
function SupportReview({
  request,
  schedules,
  refresh,
}: {
  request: z.infer<typeof supportView>;
  schedules: z.infer<typeof loanView>["schedules"];
  refresh(): void;
}) {
  const [scheduleId, setSchedule] = useState("");
  const [due, setDue] = useState("");
  const action = useAction();
  const selected = schedules.find((s) => s.id === scheduleId);
  const enabled = ["AWAITING_REVIEW", "AWAITING_HUMAN"].includes(request.status);
  return (
    <article>
      <h3>
        {label(request.status)} · {request.kind}
      </h3>
      <p>{request.text}</p>
      <p>분류: {request.route ?? "미확정"}</p>
      <ErrorNotice error={action.error} />
      <button
        disabled={!enabled || action.busy}
        onClick={() => {
          void action.run(async () => {
            await send(
              `/api/support-requests/${request.id}/review`,
              z.object({ reviewId: z.string() }),
              { action: "COMPLETE" },
            );
            refresh();
          });
        }}
      >
        검토 완료
      </button>
      <details>
        <summary>모의 납부일 변경 승인</summary>
        <p>기존 납부일 이후 최대 30일, 현재 업무 날짜 이후만 허용하는 시연 정책입니다.</p>
        <label>
          상환 일정
          <select value={scheduleId} onChange={(e) => setSchedule(e.target.value)}>
            <option value="">선택</option>
            {schedules.map((s) => (
              <option key={s.id} value={s.id}>
                {date(s.dueAt)} · v{s.version}
              </option>
            ))}
          </select>
        </label>
        <label>
          새 납부일
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <button
          disabled={!enabled || !selected || !due || action.busy}
          onClick={() => {
            void action.run(async () => {
              if (!selected) return;
              await send(
                `/api/support-requests/${request.id}/review`,
                z.object({ reviewId: z.string() }),
                {
                  action: "CHANGE_DUE_DATE",
                  scheduleId,
                  scheduleVersion: selected.version,
                  dueAt: `${due}T00:00:00+09:00`,
                },
              );
              refresh();
            });
          }}
        >
          납부일 변경 승인
        </button>
      </details>
    </article>
  );
}
export function Officer({ epoch, refresh }: { epoch: number; refresh(): void }) {
  const apps = useQuery("/api/applications", applications, epoch);
  const warning = useQuery("/api/alerts", alerts, epoch);
  const support = useQuery("/api/support-requests", requests, epoch);
  const lending = useQuery("/api/loans", loans, epoch);
  const jobs = useQuery("/api/timeline", timeline, epoch, (rows) =>
    rows.some((row) => ["QUEUED", "RUNNING"].includes(row.status)),
  );
  const [id, setId] = useState("");
  return (
    <section>
      <h1>담당자 업무</h1>
      <button className="secondary" onClick={refresh}>
        새로고침
      </button>
      <ErrorNotice
        error={apps.error ?? warning.error ?? support.error ?? lending.error ?? jobs.error}
      />
      <h2>신청 검토</h2>
      {apps.data?.map((app) => (
        <article key={app.id}>
          <h3>
            {app.companyName} · {label(app.status)}
          </h3>
          {app.evidenceDeleted ? (
            <p>근거 자료 삭제됨</p>
          ) : (
            <button onClick={() => setId(app.id)}>심사 상세 열기</button>
          )}
          <p className="reference">{app.id}</p>
        </article>
      ))}
      {id && (
        <Assessment
          key={id}
          id={id}
          epoch={epoch}
          refresh={refresh}
          reviewable={apps.data?.find((app) => app.id === id)?.status === "AWAITING_REVIEW"}
        />
      )}
      <h2>유동성 경보 · 미납과 별개</h2>
      {warning.data?.length === 0 && <p>유효한 동의로 열람 가능한 경보가 없습니다.</p>}
      {warning.data?.map((alert) => (
        <article key={alert.id}>
          <h3>
            {alert.code} · {alert.state}
          </h3>
          <p>코드 계산 최저 잔액: {money(alert.minimumKrw)}</p>
          <p>AI 설명: {label(alert.explanationStatus)}</p>
          <p>{alert.explanation?.explanation}</p>
        </article>
      ))}
      <h2>상환 지원 검토</h2>
      {support.data?.map((request) => (
        <SupportReview
          key={request.id}
          request={request}
          refresh={refresh}
          schedules={
            lending.data?.find((loan) => loan.applicationId === request.applicationId)?.schedules ??
            []
          }
        />
      ))}
      <details>
        <summary>작업·도구 활동</summary>
        {jobs.data?.map((job) => (
          <p key={job.id}>
            {job.kind} · {label(job.status)}· 모델 {job.modelId || "미선택"} · 도구 {job.toolCount}
            회 · {job.errorCode}
          </p>
        ))}
      </details>
    </section>
  );
}
