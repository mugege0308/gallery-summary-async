const assert = require("assert");
const guard = require("../gallery_web/generation_poll_guard.js");
const progress = require("../gallery_web/generation_progress.js");

function testNonActiveCompletionCannotWin() {
  const state = guard.create();
  const active = guard.activate(state, "job-a");

  assert.strictEqual(guard.isCurrent(state, "job-a", active.sequence), true);
  assert.strictEqual(guard.isCurrent(state, "job-b", active.sequence), false);
}

function testStaleResponseAfterNewJobIsIgnored() {
  const state = guard.create();
  const oldJob = guard.activate(state, "job-a");
  const newJob = guard.activate(state, "job-b");

  assert.strictEqual(guard.isCurrent(state, "job-a", oldJob.sequence), false);
  assert.strictEqual(guard.isCurrent(state, "job-b", newJob.sequence), true);
}

function testActiveCompletionAndFailureRemainCurrent() {
  const state = guard.create();
  const active = guard.activate(state, "job-b");

  assert.strictEqual(guard.isCurrent(state, "job-b", active.sequence), true);
  assert.strictEqual(guard.isCurrent(state, "job-b", active.sequence + 1), false);
}

function testInvalidationIgnoresOldPoll() {
  const state = guard.create();
  const active = guard.activate(state, "job-a");

  guard.invalidate(state);

  assert.strictEqual(guard.isCurrent(state, "job-a", active.sequence), false);
  assert.strictEqual(state.activeJobId, "");
}

function applyPollResult(state, ui, jobId, sequence, result) {
  if (!guard.isCurrent(state, jobId, sequence)) return;
  ui.status = `${result.state}${progress.formatSingleProgress(result)} / job_id=${jobId}`;
  if (result.state === "completed") {
    ui.filter = jobId;
    ui.synced += 1;
    ui.buttonEnabled = true;
  } else if (result.state === "failed") {
    ui.error = result.error;
    ui.buttonEnabled = true;
  }
}

function testUiEffectsAreScopedToActiveJob() {
  const state = guard.create();
  const ui = { status: "", filter: "", error: "", synced: 0, buttonEnabled: false };
  const active = guard.activate(state, "job-a");

  applyPollResult(state, ui, "job-b", active.sequence, { state: "completed" });
  assert.deepStrictEqual(ui, { status: "", filter: "", error: "", synced: 0, buttonEnabled: false });

  applyPollResult(state, ui, "job-a", active.sequence, { state: "generating" });
  assert.strictEqual(ui.status, "generating / job_id=job-a");

  const newer = guard.activate(state, "job-b");
  applyPollResult(state, ui, "job-a", active.sequence, { state: "failed", error: "stale" });
  assert.strictEqual(ui.error, "");

  applyPollResult(state, ui, "job-b", newer.sequence, { state: "completed" });
  assert.strictEqual(ui.status, "completed / 100% / job_id=job-b");
  assert.strictEqual(ui.filter, "job-b");
  assert.strictEqual(ui.synced, 1);
  assert.strictEqual(ui.buttonEnabled, true);
}

function testSingleJobLifecycle() {
  const state = guard.create();
  const ui = { status: "", filter: "", error: "", synced: 0, buttonEnabled: false };
  const active = guard.activate(state, "job-a");
  for (const stage of ["queued", "resolving", "generating", "completed"]) {
    applyPollResult(state, ui, "job-a", active.sequence, { state: stage });
  }
  assert.strictEqual(ui.status, "completed / 100% / job_id=job-a");
  assert.strictEqual(ui.filter, "job-a");
  assert.strictEqual(ui.synced, 1);
}

function testCompletedResultWithStaleProgressIsComplete() {
  const state = guard.create();
  const ui = { status: "", filter: "", error: "", synced: 0, buttonEnabled: false };
  const active = guard.activate(state, "job-result");
  applyPollResult(state, ui, "job-result", active.sequence, {
    state: "completed",
    progress: 0.5,
    output: { images: [{ filename: "result.png" }] },
  });
  assert.strictEqual(ui.status, "completed / 100% / job_id=job-result");
  assert.strictEqual(ui.synced, 1);
}

function testSingleProgressTerminalStates() {
  assert.strictEqual(progress.formatSingleProgress({ state: "generating", progress: 0.5 }), " / 50%");
  assert.strictEqual(progress.formatSingleProgress({ state: "completed", progress: 0.5 }), " / 100%");
  assert.strictEqual(progress.formatSingleProgress({ state: "completed", progress: 0 }), " / 100%");
  assert.strictEqual(progress.formatSingleProgress({ state: "failed", progress: 0.5 }), "");
  assert.strictEqual(progress.formatSingleProgress({ state: "cancelled", progress: 0.5 }), "");
  assert.strictEqual(progress.formatSingleProgress({ state: "stopped", progress: 0.5 }), "");
  assert.strictEqual(progress.isTerminalFailure({ state: "failed" }), true);
  assert.strictEqual(progress.isTerminalFailure({ state: "cancelled" }), true);
  assert.strictEqual(progress.isTerminalFailure({ state: "stopped" }), true);
  assert.strictEqual(progress.isTerminalFailure({ state: "completed" }), false);
  assert.strictEqual(progress.formatProgress({ state: "generating", total_count: 2, progress: 0.5 }), " / 50%");
  assert.strictEqual(progress.formatProgress({ state: "completed", total_count: 2, progress: 0.5 }), " / 50%");
  assert.strictEqual(progress.formatProgress({ state: "completed", progress: 0.5 }), " / 100%");
  assert.strictEqual(progress.formatProgress({ state: "completed", interaction_id: "", progress: 0.5 }), " / 100%");
  assert.strictEqual(progress.formatProgress({ state: "completed", interaction_id: "holding_hands", progress: 0.5 }), " / 100%");
}

testNonActiveCompletionCannotWin();
testStaleResponseAfterNewJobIsIgnored();
testActiveCompletionAndFailureRemainCurrent();
testInvalidationIgnoresOldPoll();
testUiEffectsAreScopedToActiveJob();
testSingleJobLifecycle();
testCompletedResultWithStaleProgressIsComplete();
testSingleProgressTerminalStates();
console.log("generation poll guard tests: OK");
