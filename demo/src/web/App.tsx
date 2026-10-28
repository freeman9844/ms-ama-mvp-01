import { useEffect, useState } from "react";
import { z } from "zod";
import type { Actor } from "../domain/contracts.js";
import { demoStateSchema, sessionSchema } from "../domain/views.js";
import { apiRequest, ApiError, send, setCsrf } from "./api.js";
import { ErrorNotice, useAction, useQuery } from "./hooks.js";
import { Application } from "./pages/Application.js";
import { ApplicationStatus } from "./pages/ApplicationStatus.js";
import { Consents } from "./pages/Consents.js";
import { Repayments } from "./pages/Repayments.js";
import { Support } from "./pages/Support.js";
import { Officer } from "./pages/Officer.js";
import { DemoControls } from "./pages/DemoControls.js";

function Portal({ actor, logout }: { actor: Actor; logout(): void }) {
  const [route, setRoute] = useState(location.hash.slice(1) || "home");
  const [epoch, setEpoch] = useState(0);
  const refresh = () => setEpoch((n) => n + 1);
  const state = useQuery("/api/demo/state", demoStateSchema, epoch);
  useEffect(() => {
    const update = () => setRoute(location.hash.slice(1) || "home");
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return (
    <div className="layout">
      <aside>
        <h2>합성 금융 포털</h2>
        <p>{actor.id}</p>
        <nav aria-label="주 메뉴">
          {actor.role === "BORROWER" ? (
            [
              ["home", "홈"],
              ["apply", "대출 신청"],
              ["status", "내 신청"],
              ["consents", "데이터 동의"],
              ["repayments", "내 대출·상환"],
              ["support", "도움·상환 지원"],
            ].map(([path, text]) => (
              <a
                key={path}
                href={`#${path}`}
                aria-current={route.split("/")[0] === path ? "page" : undefined}
              >
                {text}
              </a>
            ))
          ) : (
            <a href="#home">{actor.role === "OFFICER" ? "담당자 업무" : "데모 운영"}</a>
          )}
        </nav>
        <button className="secondary" onClick={logout}>
          로그아웃·계정 변경
        </button>
      </aside>
      <main>
        <div className="notice">
          합성 데이터 전용 · 실제 금융정보 입력 금지 · 실제 대출·송금·고객 발송 없음
        </div>
        <p className="muted">
          앱·DB는 로컬, Copilot 추론은 원격이며 사용량이 발생합니다. 국내 처리 요구를 충족하는
          구성이 아닙니다. 현재 모델: <strong>{state.data?.modelId ?? "미선택"}</strong>
        </p>
        <ErrorNotice error={state.error} />
        {state.data && state.data.maintenance !== "NONE" && (
          <p role="alert" className="error">
            유지보수 상태: {state.data.maintenance}. 일반 업무는 차단되었습니다. 운영자가 초기화를
            재시도하세요.
          </p>
        )}
        {state.data &&
          (actor.role === "OFFICER" ? (
            <Officer epoch={epoch} refresh={refresh} />
          ) : actor.role === "OPERATOR" ? (
            <DemoControls now={state.data.now} epoch={epoch} refresh={refresh} />
          ) : route === "apply" ? (
            <Application actor={actor} now={state.data.now} />
          ) : route === "consents" ? (
            <Consents actor={actor} now={state.data.now} epoch={epoch} refresh={refresh} />
          ) : route === "repayments" ? (
            <Repayments epoch={epoch} />
          ) : route === "support" ? (
            <Support epoch={epoch} refresh={refresh} />
          ) : (
            <ApplicationStatus
              epoch={epoch}
              refresh={refresh}
              id={route.split("/")[1]}
              home={route === "home"}
            />
          ))}
      </main>
    </div>
  );
}
export function App() {
  const [actor, setActor] = useState<Actor>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const action = useAction();
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest("/api/me", sessionSchema, { signal: controller.signal })
      .then((session) => {
        if (!controller.signal.aborted) {
          setCsrf(session.csrf);
          setActor(session.actor);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && !(error instanceof ApiError && error.status === 401))
          setError(error instanceof Error ? error.message : "로그인 상태 조회 실패");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  if (loading)
    return (
      <main>
        <p>접속 상태 확인 중…</p>
      </main>
    );
  if (actor)
    return (
      <>
        <ErrorNotice error={action.error} />
        <Portal
          key={actor.id}
          actor={actor}
          logout={() => {
            void action.run(async () => {
              await send("/api/logout", z.null(), {});
              setCsrf("");
              setActor(undefined);
              location.hash = "";
            });
          }}
        />
      </>
    );
  return (
    <main className="login">
      <div className="eyebrow">CAPSTONE · LOCAL DEMO</div>
      <h1>
        사업자의 다음 흐름을
        <br />
        함께 확인합니다.
      </h1>
      <p>신청부터 심사·경보·상환 지원·동의 삭제까지 연결된 합성 금융 데모입니다.</p>
      <div className="notice">
        고정 테스트 계정입니다. 실제 본인확인·운영 인증이 아니며 로컬 사용자는 다른 계정을 선택할 수
        있습니다.
      </div>
      <ErrorNotice error={error ?? action.error} />
      <div className="accounts">
        {[
          ["shop-a", "합성 사업자 A로 시작"],
          ["shop-b", "합성 사업자 B로 시작"],
          ["officer", "담당자로 시작"],
          ["operator", "운영자로 시작"],
        ].map(([account, text]) => (
          <button
            key={account}
            disabled={action.busy}
            onClick={() => {
              void action.run(async () => {
                const session = await send("/api/demo-login", sessionSchema, { account });
                setCsrf(session.csrf);
                setActor(session.actor);
              });
            }}
          >
            {text}
          </button>
        ))}
      </div>
      <p className="muted">
        합성 데이터만 사용하세요. 원격 Copilot 추론 비용이 발생하며 실제 금융 거래는 실행하지
        않습니다.
      </p>
    </main>
  );
}
