import { z } from "zod";

let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
const messages: Record<string, string> = {
  CONSENT_INACTIVE: "동의가 철회되었거나 만료되었습니다.",
  MODEL_NOT_SELECTED: "운영자 화면에서 사용할 모델을 선택하세요.",
  STALE_REVIEW: "자료가 변경되었습니다. 새로 조회한 뒤 검토하세요.",
  AI_AUTH_REQUIRED: "로컬 Copilot 인증을 확인하세요.",
  SOURCE_UNAVAILABLE: "원천 서버에 연결할 수 없습니다. 잠시 후 재시도하세요.",
  NETWORK_ERROR: "서버 연결을 확인하세요.",
  INVALID_SERVER_RESPONSE: "서버 응답 형식을 확인할 수 없습니다.",
};
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    correlationId?: string,
  ) {
    super(
      `${messages[code] ?? "요청을 처리하지 못했습니다."} (${code})${correlationId ? ` · 문의 ID: ${correlationId}` : ""}`,
    );
  }
}
export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET") {
    headers.set("content-type", "application/json");
    headers.set("x-csrf-token", csrf);
    if (!headers.has("idempotency-key")) headers.set("idempotency-key", crypto.randomUUID());
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(0, "NETWORK_ERROR");
  }
  const body: unknown = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const failure = z
      .object({ error: z.object({ code: z.string(), correlationId: z.string().optional() }) })
      .safeParse(body);
    throw new ApiError(
      response.status,
      failure.success ? failure.data.error.code : "HTTP_ERROR",
      failure.success ? failure.data.error.correlationId : undefined,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(502, "INVALID_SERVER_RESPONSE");
  return parsed.data;
}
export function send<T>(
  path: string,
  schema: z.ZodType<T>,
  body: unknown,
  key?: string,
  method = "POST",
) {
  return apiRequest(path, schema, {
    method,
    body: JSON.stringify(body),
    headers: key ? { "idempotency-key": key } : undefined,
  });
}
