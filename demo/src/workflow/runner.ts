import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../domain/clock.js";
import { assertJob, claim, complete, fail, type Job, type JobKind } from "./queue.js";
import { startConsentSweeper } from "../agents/consent.js";
import { DomainError } from "../server/errors.js";
export type JobHandler = (job: Job, signal: AbortSignal) => Promise<string>;
export function startRunner(
  db: DatabaseSync,
  clock: Clock,
  handlers: ReadonlyMap<JobKind, JobHandler>,
): { stop(): Promise<void> } {
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const sweeper = startConsentSweeper(db, clock);
  const tick = async () => {
    if (stopped) return;
    const job = claim(db, Date.now(), [...handlers.keys()]);
    if (!job) return;
    const handler = handlers.get(job.kind);
    if (!handler) throw new Error("Missing registered job handler");
    controller = new AbortController();
    const heartbeat = setInterval(() => {
      try {
        assertJob(db, job, clock.now());
      } catch (error) {
        controller?.abort(error);
        return;
      }
      const result = db
        .prepare(
          "UPDATE jobs SET lease_until_ms=? WHERE id=? AND claim_token=? AND status='RUNNING' AND generation=?",
        )
        .run(Date.now() + 60_000, job.id, job.claimToken, job.generation);
      if (result.changes !== 1) controller?.abort();
    }, 1_000);
    try {
      const resultId = await handler(job, controller.signal);
      if (!complete(db, job, resultId, clock.now()))
        fail(db, job, new DomainError("JOB_INVALIDATED", 409));
    } catch (error) {
      if (!stopped) fail(db, job, error);
    } finally {
      clearInterval(heartbeat);
      controller = undefined;
    }
  };
  const schedule = () => {
    pending = tick()
      .catch((error) => {
        stopped = true;
        sweeper.stop();
        console.error(
          JSON.stringify({
            code: "RUNNER_FAILED",
            type: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(schedule, 500);
      });
  };
  schedule();
  return {
    async stop() {
      stopped = true;
      sweeper.stop();
      if (timer) clearTimeout(timer);
      controller?.abort();
      await pending;
    },
  };
}
