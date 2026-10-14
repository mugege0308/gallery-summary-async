(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GenerationSettings = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const STORAGE_KEY = "gallery.generate.settings.v1";
  const VERSION = 1;
  const LORA_TYPES = ["character", "style", "additional"];
  const MULTI_PERSON_FRAMING_VALUES = ["auto", "both_faces", "upper_body", "cowboy", "full_body", "partial_partner_ok"];

  function defaults() {
    return {
      version: VERSION,
      character_preset: "",
      freeform_character: "",
      explicit_tags: "",
      appearance_text: "",
      request_text: "",
      model_key: "",
      rating: "",
      size: "",
      multi_person_framing: "auto",
      interaction_id: "",
      loras: {
        character: { key: "", strength: "0.5" },
        style: { key: "", strength: "0.5" },
        additional: { key: "", strength: "0.5" },
      },
      count: "1",
      variation: "off",
      seed: "-1",
    };
  }

  function text(value) {
    return value == null ? "" : String(value);
  }

  function normalize(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const result = defaults();
    for (const key of [
      "character_preset",
      "freeform_character",
      "explicit_tags",
      "appearance_text",
      "request_text",
      "model_key",
      "rating",
      "size",
      "multi_person_framing",
      "interaction_id",
      "count",
      "variation",
      "seed",
    ]) {
      if (source[key] != null) result[key] = text(source[key]);
    }
    if (!MULTI_PERSON_FRAMING_VALUES.includes(result.multi_person_framing)) result.multi_person_framing = "auto";
    for (const type of LORA_TYPES) {
      const item = source.loras && typeof source.loras === "object" ? source.loras[type] : null;
      if (item && typeof item === "object") {
        result.loras[type] = {
          key: text(item.key),
          strength: text(item.strength),
        };
      }
    }
    if (!["off", "auto"].includes(result.variation)) result.variation = "off";
    const count = Number(result.count);
    result.count = [1, 2, 3, 4, 8].includes(count) ? String(count) : "1";
    if (result.count === "1") result.variation = "off";
    const seed = Number(result.seed);
    result.seed = Number.isInteger(seed) && seed >= -1 ? String(seed) : "-1";
    return result;
  }

  function capture(values) {
    const normalized = normalize(values);
    return {
      version: VERSION,
      character_preset: normalized.character_preset,
      freeform_character: normalized.freeform_character,
      explicit_tags: normalized.explicit_tags,
      appearance_text: normalized.appearance_text,
      request_text: normalized.request_text,
      model_key: normalized.model_key,
      rating: normalized.rating,
      size: normalized.size,
      multi_person_framing: normalized.multi_person_framing,
      interaction_id: normalized.interaction_id,
      loras: normalized.loras,
      count: normalized.count,
      variation: normalized.variation,
      seed: normalized.seed,
    };
  }

  function read(storage) {
    try {
      if (!storage || typeof storage.getItem !== "function") return null;
      const raw = storage.getItem(STORAGE_KEY);
      return raw ? normalize(JSON.parse(raw)) : null;
    } catch (_error) {
      return null;
    }
  }

  function write(storage, values) {
    try {
      if (!storage || typeof storage.setItem !== "function") return false;
      storage.setItem(STORAGE_KEY, JSON.stringify(capture(values)));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function clear(storage) {
    try {
      if (!storage || typeof storage.removeItem !== "function") return false;
      storage.removeItem(STORAGE_KEY);
      return true;
    } catch (_error) {
      return false;
    }
  }

  return { STORAGE_KEY, VERSION, LORA_TYPES, MULTI_PERSON_FRAMING_VALUES, defaults, normalize, capture, read, write, clear };
});
