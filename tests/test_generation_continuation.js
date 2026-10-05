const assert = require("assert");
const { buildAdditionalGenerationRequest } = require("../gallery_web/generation_continuation.js");

function testAutoContinuationUsesSnapshotAndNewSeed() {
  const snapshot = {
    freeform_character: "girl",
    explicit_tags: ["portrait"],
    count: 4,
    variation: "auto",
    variation_offset: 0,
    seed: 123456,
    reference_mode: "composition",
    reference_image_id: "opaque-reference-id",
    loras: [{ key: "style", lora_type: "style", strength: 0.5 }],
  };
  const original = JSON.parse(JSON.stringify(snapshot));
  const request = buildAdditionalGenerationRequest(snapshot);
  assert.deepStrictEqual(snapshot, original);
  assert.strictEqual(request.count, 4);
  assert.strictEqual(request.seed, -1);
  assert.strictEqual(request.variation_offset, 4);
  assert.strictEqual(request.reference_image_id, "opaque-reference-id");
  assert.deepStrictEqual(request.loras, snapshot.loras);
}

function testOffContinuationKeepsVariationOffsetAtZero() {
  const request = buildAdditionalGenerationRequest({ count: 4, variation: "off", seed: 42 });
  assert.strictEqual(request.count, 4);
  assert.strictEqual(request.seed, -1);
  assert.strictEqual(request.variation_offset, 0);
}

function testInvalidSnapshotIsIgnored() {
  assert.strictEqual(buildAdditionalGenerationRequest(null), null);
  assert.strictEqual(buildAdditionalGenerationRequest("not-an-object"), null);
}

testAutoContinuationUsesSnapshotAndNewSeed();
testOffContinuationKeepsVariationOffsetAtZero();
testInvalidSnapshotIsIgnored();
console.log("generation continuation tests: OK");
