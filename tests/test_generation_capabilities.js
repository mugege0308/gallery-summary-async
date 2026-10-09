const assert = require("assert");
const capabilities = require("../gallery_web/generation_capabilities.js");

const options = {
  models: [
    {
      key: "animagine",
      capabilities: { lora: true, reference: true, pose: true, bulk: true, overnight: true },
      supported_sizes: ["square", "portrait", "landscape"],
    },
    {
      key: "qwen_image_2_1",
      capabilities: { supports_lora: false, supports_reference: false, supports_pose: false, supports_bulk: false, supports_overnight: false },
      supported_sizes: ["square"],
    },
  ],
  sizes: [
    { key: "square", width: 512, height: 512 },
    { key: "portrait", width: 768, height: 1024 },
    { key: "landscape", width: 1024, height: 768 },
  ],
};

function testQwenCapabilitiesAndSizes() {
  const profile = capabilities.profileFor(options, "qwen_image_2_1");
  assert.strictEqual(capabilities.capabilities(profile).lora, false);
  assert.strictEqual(capabilities.capabilities(profile).reference, false);
  assert.strictEqual(capabilities.capabilities(profile).pose, false);
  assert.strictEqual(capabilities.capabilities(profile).bulk, false);
  assert.deepStrictEqual(capabilities.supportedSizeKeys(options, profile), ["square"]);
}

function testQwenPayloadRemovesStaleUnsupportedState() {
  const sanitized = capabilities.sanitizePayload(options, {
    model_key: "qwen_image_2_1",
    loras: [{ key: "style", lora_type: "style", strength: 0.5 }],
    reference_mode: "pose",
    reference_image_id: "reference-1",
    reference_strength: 0.7,
    reference_fit: "cover",
    variation: "auto",
    variation_offset: 2,
    count: 4,
    size: "portrait",
  });
  assert.deepStrictEqual(sanitized.loras, []);
  assert.strictEqual(sanitized.reference_mode, "none");
  assert.strictEqual(sanitized.reference_image_id, null);
  assert.strictEqual(sanitized.variation, "off");
  assert.strictEqual(sanitized.count, 1);
  assert.strictEqual(sanitized.size, "square");
}

function testAnimaginePayloadRemainsUnchanged() {
  const payload = { model_key: "animagine", loras: [{ key: "style" }], count: 4, variation: "auto", size: "portrait" };
  assert.deepStrictEqual(capabilities.sanitizePayload(options, payload), payload);
}

function testMissingQwenProfileIsNonFatal() {
  const payload = { model_key: "removed-model", count: 2, size: "portrait" };
  assert.deepStrictEqual(capabilities.sanitizePayload(options, payload), payload);
}

testQwenCapabilitiesAndSizes();
testQwenPayloadRemovesStaleUnsupportedState();
testAnimaginePayloadRemainsUnchanged();
testMissingQwenProfileIsNonFatal();
console.log("generation capabilities tests: OK");
