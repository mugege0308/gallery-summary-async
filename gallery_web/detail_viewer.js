(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DetailViewer = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function navigation(sequence, imageId) {
    const items = Array.isArray(sequence)
      ? sequence.filter((item) => item && item.id != null)
      : [];
    const index = items.findIndex((item) => String(item.id) === String(imageId));
    return {
      index,
      total: items.length,
      previous: index > 0 ? items[index - 1] : null,
      next: index >= 0 && index < items.length - 1 ? items[index + 1] : null,
    };
  }

  return { navigation };
});
