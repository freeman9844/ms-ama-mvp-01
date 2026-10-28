import { useState } from "react";
import { z } from "zod";
import { applicationView, supportView } from "../../domain/views.js";
import { ErrorNotice, label, useAction, useQuery } from "../hooks.js";
import { send } from "../api.js";
const applications = z.array(applicationView);
const requests = z.array(supportView);
export function Support({ epoch, refresh }: { epoch: number; refresh(): void }) {
  const apps = useQuery("/api/applications", applications, epoch);
  const query = useQuery("/api/support-requests", requests, epoch, (data) =>
    data.some((row) => row.status === "QUEUED"),
  );
  const [applicationId, setApplication] = useState("");
  const [kind, setKind] = useState("GENERAL_INQUIRY");
  const [text, setText] = useState("");
  const action = useAction();
  return (
    <section>
      <h1>도움·상환 지원</h1>
      <p>실제 개인정보·금융정보를 입력하지 마세요. 합성 문의만 사용합니다.</p>
      <label>
        대상 신청
        <select value={applicationId} onChange={(e) => setApplication(e.target.value)}>
          <option value="">선택</option>
          {apps.data?.map((app) => (
            <option key={app.id} value={app.id}>
              {app.companyName} · {app.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      <label>
        요청 유형
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="GENERAL_INQUIRY">문의·설명</option>
          <option value="PAYMENT_DIFFICULTY">상환 곤란</option>
          <option value="DISPUTE_OR_CORRECTION">이의·정정</option>
          <option value="COMPLAINT">고충</option>
        </select>
      </label>
      <label>
        합성 요청 내용
        <textarea value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
      </label>
      <button
        disabled={!applicationId || !text.trim() || action.busy}
        onClick={() => {
          void action.run(async () => {
            await send("/api/support-requests", z.object({ id: z.string() }), {
              applicationId,
              kind,
              text,
            });
            setText("");
            refresh();
          });
        }}
      >
        지원 요청 접수
      </button>
      <ErrorNotice error={apps.error ?? query.error ?? action.error} />
      {query.data?.map((request) => (
        <article key={request.id}>
          <h2>{label(request.status)}</h2>
          <p>{request.text}</p>
          <p>{request.errorCode}</p>
          {request.messages.map((message, i) => (
            <p key={i}>
              {message.state === "SENT" ? "모의 발송함" : "자동 안내 억제"}: {message.text}{" "}
              {message.reason}
            </p>
          ))}
        </article>
      ))}
    </section>
  );
}
