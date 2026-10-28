import type { DatasetRef } from "../agents/assembly.js";
import type { SessionConfig } from "@github/copilot-sdk";

export type AiRole = "UNDERWRITING" | "WARNING" | "COLLECTIONS";
export type AiRequest = {
  role: AiRole;
  businessId: string;
  jobId: string;
  dataset: DatasetRef | null;
  modelId: string;
  prompt: string;
};
export type AiResult = {
  text: string;
  sessionId: string;
  modelId: string;
  usage: { inputTokens: number; outputTokens: number } | null;
};
export interface AiPort {
  listModels(): Promise<{ id: string; name: string }[]>;
  run(request: AiRequest, signal: AbortSignal): Promise<AiResult>;
  deleteSession(id: string): Promise<void>;
  stop(): Promise<void>;
}
export interface SdkSession {
  sessionId: string;
  sendAndWait(
    options: { prompt: string },
    timeout: number,
  ): Promise<{ data: { content: string } } | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}
export interface SdkRuntime {
  start(): Promise<void>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean }>;
  listModels(): Promise<{ id: string; name: string }[]>;
  createSession(config: SessionConfig): Promise<SdkSession>;
  deleteSession(id: string): Promise<void>;
  stop(): Promise<Error[]>;
}
