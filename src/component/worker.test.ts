import { describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { createLogger } from "./logging.js";
import { completeInline } from "./worker.js";

describe("completeInline", () => {
  it("schedules complete without inline onComplete when the inline run fails", async () => {
    // Simulates `complete` aborting in a way its own try/catch can't catch,
    // for example the inline onComplete going over a transaction limit.
    const runMutation = vi
      .fn()
      .mockRejectedValue(new Error("Too many documents read"));
    const runAfter = vi.fn().mockResolvedValue("scheduled-id");
    const ctx = {
      runMutation,
      scheduler: { runAfter },
    } as unknown as ActionCtx;
    const job = {
      workId: "work-id" as Id<"work">,
      attempt: 0,
      runResult: { kind: "success" as const, returnValue: null },
      runOnCompleteInline: true,
    };

    await completeInline(ctx, createLogger("ERROR"), job);

    expect(runMutation).toHaveBeenCalledTimes(1);
    expect(runMutation.mock.calls[0][1]).toEqual({ jobs: [job] });
    // The scheduled retry of `complete` must not run onComplete inline again,
    // or it fails the same way and the job never completes.
    expect(runAfter).toHaveBeenCalledTimes(1);
    expect(runAfter.mock.calls[0][2]).toEqual({
      jobs: [{ ...job, runOnCompleteInline: false }],
    });
  });
});
