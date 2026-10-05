const assert = require("assert");
const settings = require("../gallery_web/generation_settings.js");

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function testRoundTripStoresOnlyFormSettings() {
  const storage = new MemoryStorage();
  const values = {
    character_preset: "character-key",
    freeform_character: "かわいい女の子",
    explicit_tags: "portrait, smile",
    appearance_text: "黒髪、青い目",
    request_text: "白背景",
    model_key: "animagine",
    rating: "safe",
    size: "square",
    loras: {
      character: { key: "", strength: "0.5" },
      style: { key: "matuTake_style_v1", strength: "0.5" },
      additional: { key: "", strength: "0.5" },
    },
    count: "4",
    variation: "auto",
    seed: "-1",
    reference_image_id: "opaque-reference-must-not-persist",
    auth_token: "raw-token-must-not-persist",
  };
  assert.strictEqual(settings.write(storage, values), true);
  const raw = storage.getItem(settings.STORAGE_KEY);
  assert.ok(raw.includes("matuTake_style_v1"));
  assert.ok(!raw.includes("opaque-reference-must-not-persist"));
  assert.ok(!raw.includes("raw-token-must-not-persist"));
  assert.deepStrictEqual(settings.read(storage), settings.capture(values));
}

function testNormalizationAndSeedPreservation() {
  const normalized = settings.normalize({ count: "1", variation: "auto", seed: "-1" });
  assert.strictEqual(normalized.count, "1");
  assert.strictEqual(normalized.variation, "off");
  assert.strictEqual(normalized.seed, "-1");

  const fixed = settings.normalize({ count: "4", variation: "auto", seed: "123456" });
  assert.strictEqual(fixed.count, "4");
  assert.strictEqual(fixed.variation, "auto");
  assert.strictEqual(fixed.seed, "123456");

  const eight = settings.normalize({ count: "8", variation: "auto", seed: "-1" });
  assert.strictEqual(eight.count, "8");
  assert.strictEqual(eight.variation, "auto");
}

function testInvalidSavedValuesFallBackSafely() {
  const normalized = settings.normalize({ count: "6", variation: "invalid", seed: "not-a-seed" });
  assert.strictEqual(normalized.count, "1");
  assert.strictEqual(normalized.variation, "off");
  assert.strictEqual(normalized.seed, "-1");
}

function testUnavailableStorageIsNonFatal() {
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.strictEqual(settings.read(broken), null);
  assert.strictEqual(settings.write(broken, {}), false);
  assert.strictEqual(settings.clear(broken), false);
}

function testClear() {
  const storage = new MemoryStorage();
  settings.write(storage, { seed: "42" });
  assert.strictEqual(settings.clear(storage), true);
  assert.strictEqual(settings.read(storage), null);
}

testRoundTripStoresOnlyFormSettings();
testNormalizationAndSeedPreservation();
testInvalidSavedValuesFallBackSafely();
testUnavailableStorageIsNonFatal();
testClear();
console.log("generation settings tests: OK");
