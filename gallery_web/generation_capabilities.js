(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GenerationCapabilities = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const FEATURE_KEYS = ["lora", "reference", "pose", "variation", "bulk", "overnight"];

  function boolValue(value, fallback = true) {
    return value == null ? fallback : Boolean(value);
  }

  function capabilities(profile) {
    const raw = profile && typeof profile.capabilities === "object" ? profile.capabilities : (profile || {});
    // Accept both the compact Gallery API names and the backend profile names.
    const result = {
      lora: boolValue(raw.lora ?? raw.supports_lora),
      reference: boolValue(raw.reference ?? raw.supports_reference),
      pose: boolValue(raw.pose ?? raw.supports_pose),
      // Variation is a multi-image feature in the current API.  A profile that
      // cannot bulk-generate therefore cannot expose variation either.
      variation: boolValue(raw.variation ?? raw.supports_variation ?? raw.bulk ?? raw.supports_bulk),
      bulk: boolValue(raw.bulk ?? raw.supports_bulk),
      overnight: boolValue(raw.overnight ?? raw.supports_overnight),
    };
    return result;
  }

  function profileFor(options, modelKey) {
    const models = Array.isArray(options?.models) ? options.models : [];
    return models.find((item) => item && String(item.key) === String(modelKey)) || null;
  }

  function sizeEntries(options, profile) {
    if (!profile) return Array.isArray(options?.sizes) ? options.sizes.slice() : [];
    const byModel = options?.model_sizes && typeof options.model_sizes === "object"
      ? options.model_sizes[profile.key]
      : null;
    if (Array.isArray(byModel) && byModel.length) return byModel.slice();
    const supported = Array.isArray(profile.supported_sizes)
      ? new Set(profile.supported_sizes.map((item) => String(item?.key ?? item)))
      : null;
    const sizes = Array.isArray(options?.sizes) ? options.sizes : [];
    return supported && supported.size ? sizes.filter((item) => supported.has(String(item?.key ?? item))) : sizes.slice();
  }

  function supportedSizeKeys(options, profile) {
    return sizeEntries(options, profile).map((item) => String(item?.key ?? item)).filter(Boolean);
  }

  function sanitizePayload(options, payload) {
    const source = payload && typeof payload === "object" ? payload : {};
    const profile = profileFor(options, source.model_key);
    const caps = capabilities(profile);
    const result = { ...source };
    if (!caps.lora) result.loras = [];
    if (!caps.reference || (result.reference_mode === "pose" && !caps.pose)) {
      result.reference_mode = "none";
      result.reference_image_id = null;
      result.reference_strength = null;
      result.reference_fit = null;
    }
    if (!caps.variation) {
      result.variation = "off";
      result.variation_offset = 0;
    }
    if (!caps.bulk) result.count = 1;
    const sizes = supportedSizeKeys(options, profile);
    if (sizes.length && !sizes.includes(String(result.size))) result.size = sizes[0];
    return result;
  }

  function featureKeys() { return FEATURE_KEYS.slice(); }

  return { capabilities, profileFor, sizeEntries, supportedSizeKeys, sanitizePayload, featureKeys };
});
