import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { apiRequest } from "./api.js";

export function useQuery<T>(
  path: string,
  schema: z.ZodType<T>,
  epoch = 0,
  poll?: (data: T) => boolean,
) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const pollRef = useRef(poll);
  pollRef.current = poll;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(undefined);
    setError(undefined);
    const load = async () => {
      try {
        const result = await apiRequest(path, schema, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(result);
        if (pollRef.current?.(result))
          timer = setTimeout(() => {
            void load();
          }, 2_000);
      } catch (error) {
        if (!controller.signal.aborted) {
          setData(undefined);
          setError(error instanceof Error ? error.message : "조회 실패");
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path, schema, epoch]);
  return { data, error };
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : "처리 실패");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
export const labels: Record<string, string> = {
  SUBMITTED: "접수 완료",
  COLLECTING: "자료 수집 중",
  ANALYZING: "AI 심사 중",
  AWAITING_REVIEW: "담당자 검토 대기",
  APPROVED: "승인 완료",
  REJECTED: "거절",
  NEEDS_INFORMATION: "보완 요청",
  ACTIVE: "활성",
  REVOKED: "철회",
  EXPIRED: "만료",
  QUEUED: "작업 대기",
  RUNNING: "처리 중",
  COMPLETED: "완료",
  COMPLETE: "완료",
  FAILED: "실패",
  BLOCKED_BY_CONSENT: "동의로 인해 차단됨",
  CANCELLED: "취소됨",
  SCHEDULED: "납부 예정",
  MISSED: "모의 미납",
  PAID: "모의 납부 완료",
  AWAITING_HUMAN: "AI 처리 실패 · 담당자 검토 대기",
  REVIEWED: "검토 완료",
  PENDING: "삭제 대기",
  DELETING: "삭제 중",
  CLEANUP_FAILED: "SDK 정리 실패",
};
export const label = (value: string) => labels[value] ?? value;
export const money = (value: number) => `${value.toLocaleString("ko-KR")}원`;
export const date = (value: string) =>
  new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
export function ErrorNotice({ error }: { error?: string }) {
  return error ? (
    <p role="alert" className="error">
      {error}
    </p>
  ) : null;
}
