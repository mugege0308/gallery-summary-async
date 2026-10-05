const assert = require("assert");
const viewer = require("../gallery_web/detail_viewer.js");

const images = ["a", "b", "c"].map((id) => ({ id }));

function testPositionAndBoundaries() {
  const first = viewer.navigation(images, "a");
  assert.strictEqual(first.index, 0);
  assert.strictEqual(first.total, 3);
  assert.strictEqual(first.previous, null);
  assert.strictEqual(first.next.id, "b");

  const middle = viewer.navigation(images, "b");
  assert.strictEqual(middle.index, 1);
  assert.strictEqual(middle.previous.id, "a");
  assert.strictEqual(middle.next.id, "c");

  const last = viewer.navigation(images, "c");
  assert.strictEqual(last.index, 2);
  assert.strictEqual(last.previous.id, "b");
  assert.strictEqual(last.next, null);
}

function testCurrentSequenceIsIndependent() {
  const filtered = [images[2], images[0]];
  const state = viewer.navigation(filtered, "a");
  assert.strictEqual(state.index, 1);
  assert.strictEqual(state.previous.id, "c");
  assert.strictEqual(state.next, null);
}

function testUnknownImageIsSafe() {
  const state = viewer.navigation(images, "missing");
  assert.strictEqual(state.index, -1);
  assert.strictEqual(state.previous, null);
  assert.strictEqual(state.next, null);
}

testPositionAndBoundaries();
testCurrentSequenceIsIndependent();
testUnknownImageIsSafe();
console.log("gallery detail viewer tests: OK");
