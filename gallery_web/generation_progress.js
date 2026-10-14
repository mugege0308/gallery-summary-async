(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GenerationProgress = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  function isTerminalFailure(result) {
    return ["failed", "cancelled", "stopped"].includes(String(result?.state || "").toLowerCase());
  }

  function formatSingleProgress(result) {
    const state = String(result?.state || "").toLowerCase();
    if (state === "completed") return " / 100%";
    if (isTerminalFailure(result)) return "";
    if (result?.progress == null) return "";
    const progress = Number(result.progress);
    return Number.isFinite(progress) ? ` / ${Math.round(progress * 100)}%` : "";
  }

  function formatProgress(result) {
    if (Number(result?.total_count || 0) > 1) {
      if (result?.progress == null) return "";
      const progress = Number(result.progress);
      return Number.isFinite(progress) ? ` / ${Math.round(progress * 100)}%` : "";
    }
    return formatSingleProgress(result);
  }

  return { formatProgress, formatSingleProgress, isTerminalFailure };
});
