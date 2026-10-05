(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GenerationTags = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function normalize(value) {
    return String(value == null ? "" : value).trim().replace(/[\s-]+/g, "_").toLowerCase();
  }

  function parse(value) {
    const tags = [];
    const seen = new Set();
    for (const item of String(value == null ? "" : value).split(/[,\n]/)) {
      const tag = item.trim();
      const key = normalize(tag);
      if (!tag || !key || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
    return tags;
  }

  function serialize(value) {
    return parse(value).join(", ");
  }

  function remove(value, target) {
    const targetKey = normalize(target);
    return parse(value).filter((tag) => normalize(tag) !== targetKey).join(", ");
  }

  return { normalize, parse, serialize, remove };
});
