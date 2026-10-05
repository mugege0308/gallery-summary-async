const assert = require("assert");
const tags = require("../gallery_web/generation_tags.js");

function testEmptyAndSingleTag() {
  assert.deepStrictEqual(tags.parse(""), []);
  assert.deepStrictEqual(tags.parse(" smile "), ["smile"]);
}

function testCommaAndNewlineParsingPreservesTagText() {
  assert.deepStrictEqual(tags.parse("izayoi_sakuya, full body\nfrom side"), [
    "izayoi_sakuya",
    "full body",
    "from side",
  ]);
}

function testDuplicateNormalizationKeepsFirstValue() {
  assert.deepStrictEqual(tags.parse("smile, Smile, full-body, full body"), ["smile", "full-body"]);
  assert.strictEqual(tags.serialize("smile, smile\nfull body"), "smile, full body");
}

function testRemoveFirstMiddleLastAndClear() {
  const value = "izayoi_sakuya, smile, full body";
  assert.strictEqual(tags.remove(value, "izayoi_sakuya"), "smile, full body");
  assert.strictEqual(tags.remove(value, "smile"), "izayoi_sakuya, full body");
  assert.strictEqual(tags.remove(value, "full body"), "izayoi_sakuya, smile");
  assert.strictEqual(tags.remove("smile", "smile"), "");
}

function testCanonicalKeyIsNotDisplayed() {
  assert.strictEqual(tags.normalize("full body"), "full_body");
  assert.deepStrictEqual(tags.parse("full body"), ["full body"]);
}

testEmptyAndSingleTag();
testCommaAndNewlineParsingPreservesTagText();
testDuplicateNormalizationKeepsFirstValue();
testRemoveFirstMiddleLastAndClear();
testCanonicalKeyIsNotDisplayed();
console.log("generation tags tests: OK");
