(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GenerationPollGuard = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function create() {
    return { activeJobId: "", sequence: 0 };
  }

  function activate(state, jobId) {
    state.activeJobId = String(jobId);
    state.sequence += 1;
    return { jobId: state.activeJobId, sequence: state.sequence };
  }

  function invalidate(state) {
    state.activeJobId = "";
    state.sequence += 1;
    return state.sequence;
  }

  function isCurrent(state, jobId, sequence) {
    return state.activeJobId === String(jobId) && state.sequence === sequence;
  }

  return { create, activate, invalidate, isCurrent };
});
