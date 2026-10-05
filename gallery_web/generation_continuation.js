(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GenerationContinuation = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function buildAdditionalGenerationRequest(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    const request = JSON.parse(JSON.stringify(snapshot));
    request.count = 4;
    request.seed = -1;
    request.variation_offset = request.variation === "auto" ? 4 : 0;
    return request;
  }

  return { buildAdditionalGenerationRequest };
});
