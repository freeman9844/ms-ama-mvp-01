import { useRef, useState } from "react";
import { z } from "zod";
import { loanView } from "../../domain/views.js";
import { send } from "../api.js";
import { date, ErrorNotice, useAction, useQuery } from "../hooks.js";
const models = z.array(z.object({ id: z.string(), name: z.string() }));
const loans = z.array(loanView);

export function DemoControls({
  now,
  epoch,
  refresh,
}: {
  now: string;
  epoch: number;
  refresh(): void;
}) {
  const available = useQuery("/api/ai/models", models, epoch);
  const lending = useQuery("/api/loans", loans, epoch);
  const [modelId, setModel] = useState("");
  const [businessId, setBusiness] = useState("shop-a");
  const [type, setType] = useState("SETTLEMENT_DELAY");
  const [due, setDue] = useState("2026-11-05");
  const [scheduleId, setSchedule] = useState("");
  const [days, setDays] = useState(10);
  const [source, setSource] = useState("BANK");
  const [requests, setRequests] = useState(3);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState("");
  const attempt = useRef({ body: "", key: "" });
  const action = useAction();
  return (
    <section>
      <h1>데모 운영</h1>
      <p>현재 업무 시각: {date(now)} · 모든 사건은 합성입니다.</p>
      <h2>Copilot 모델 명시적 선택</h2>
      <label>
        사용 가능한 모델
        <select value={modelId} onChange={(e) => setModel(e.target.value)}>
          <option value="">모델을 선택하세요</option>
          {available.data?.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} ({model.id})
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={!modelId || action.busy}
        onClick={() => {
          void action.run(async () => {
            await send(
              "/api/ai/settings",
              z.object({ modelId: z.string() }),
              { modelId },
              undefined,
              "PUT",
            );
            refresh();
          });
        }}
      >
        선택 모델 저장
      </button>
      <button className="secondary" onClick={refresh}>
        설정 새로고침
      </button>
      <h2>합성 사건</h2>
      <label>
        사업자
        <select
          value={businessId}
          onChange={(e) => {
            setBusiness(e.target.value);
            setSchedule("");
          }}
        >
          <option value="shop-a">합성 사업자 A</option>
          <option value="shop-b">합성 사업자 B</option>
        </select>
      </label>
      <label>
        사건 유형
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {[
            ["SETTLEMENT_DELAY", "정산 지연"],
            ["SETTLEMENT_PAID", "정산 지급"],
            ["MISSED_PAYMENT", "모의 미납"],
            ["PAYMENT_RECEIVED", "모의 납부"],
            ["SOURCE_FAILURE", "일시적 원천 장애"],
            ["ADVANCE_TIME", "업무 시간 이동"],
          ].map(([value, text]) => (
            <option value={value} key={value}>
              {text}
            </option>
          ))}
        </select>
      </label>
      {type === "SETTLEMENT_DELAY" && (
        <label>
          새 정산 예정일
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
      )}
      {["MISSED_PAYMENT", "PAYMENT_RECEIVED"].includes(type) && (
        <label>
          대상 상환 일정
          <select value={scheduleId} onChange={(e) => setSchedule(e.target.value)}>
            <option value="">선택</option>
            {lending.data
              ?.filter((loan) => loan.businessId === businessId)
              .flatMap((loan) =>
                loan.schedules.map((s) => (
                  <option key={s.id} value={s.id}>
                    {date(s.dueAt)} · {s.id}
                  </option>
                )),
              )}
          </select>
        </label>
      )}
      {type === "ADVANCE_TIME" && (
        <label>
          이동 일수
          <input
            type="number"
            min="1"
            max="365"
            value={days}
            onChange={(e) => setDays(e.target.valueAsNumber)}
          />
        </label>
      )}
      {type === "SOURCE_FAILURE" && (
        <>
          <label>
            원천
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {["BANK", "PG", "TAX"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            실패할 요청 수
            <input
              type="number"
              min="1"
              max="10"
              value={requests}
              onChange={(e) => setRequests(e.target.valueAsNumber)}
            />
          </label>
        </>
      )}
      <button
        disabled={
          action.busy || (["MISSED_PAYMENT", "PAYMENT_RECEIVED"].includes(type) && !scheduleId)
        }
        onClick={() => {
          void action.run(async () => {
            const body = {
              businessId,
              type,
              ...(type.startsWith("SETTLEMENT")
                ? { settlementId: `${businessId}-settlement` }
                : {}),
              ...(type === "SETTLEMENT_DELAY" ? { dueAt: `${due}T00:00:00+09:00` } : {}),
              ...(["MISSED_PAYMENT", "PAYMENT_RECEIVED"].includes(type) ? { scheduleId } : {}),
              ...(type === "ADVANCE_TIME" ? { days } : {}),
              ...(type === "SOURCE_FAILURE" ? { source, requests } : {}),
            };
            if (attempt.current.body !== JSON.stringify(body))
              attempt.current = { body: JSON.stringify(body), key: crypto.randomUUID() };
            const response = await send(
              "/api/demo/events",
              z.object({ state: z.string() }),
              { ...body, id: attempt.current.key },
              attempt.current.key,
            );
            setResult(`합성 사건 ${response.state}`);
            attempt.current = { body: "", key: "" };
            refresh();
          });
        }}
      >
        사건 실행
      </button>
      <p role="status">{result}</p>
      <ErrorNotice error={available.error ?? lending.error ?? action.error} />
      <h2>앱 소유 데모 초기화</h2>
      <p>
        진행 중 작업을 중단하고 앱·mock 합성 데이터를 초기화합니다. 원격 사용량·기록은 초기화하지
        않습니다.
      </p>
      <button className="secondary" onClick={() => setConfirm(true)}>
        초기화 준비
      </button>
      {confirm && (
        <div role="group" aria-label="초기화 확인">
          <p>합성 데모 데이터를 초기 상태로 되돌릴까요?</p>
          <button
            disabled={action.busy}
            onClick={() => {
              void action.run(async () => {
                await send("/api/demo/reset", z.object({ state: z.literal("RESET") }), {
                  confirmed: true,
                });
                setConfirm(false);
                refresh();
              });
            }}
          >
            초기화 확인
          </button>
          <button className="secondary" onClick={() => setConfirm(false)}>
            취소
          </button>
        </div>
      )}
    </section>
  );
}
