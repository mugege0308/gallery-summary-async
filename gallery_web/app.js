(() => {
  const labels = {
    unreviewed: "未選別",
    adopted: "採用",
    hold: "保留",
    rejected: "没",
    lora_candidate: "LoRA候補",
  };
  const state = {
    images: [],
    recentImages: [],
    recentTotal: 0,
    selected: new Set(),
    selectionMeta: new Map(),
    pending: new Map(),
    pendingLora: new Map(),
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
    lastSelectedId: null,
    rangeAnchorId: null,
    detailImageId: null,
    detailImage: null,
    detailSequence: [],
    detailActualSeed: null,
    detailProvenanceToken: 0,
    comparison: new Map(),
    comparisonRenderToken: 0,
    comparisonDiffOnly: false,
    aiJob: null,
    generation: {
      options: null,
      jobId: "",
      pollTimer: null,
      submitting: false,
      lastRequest: null,
      lastCompletedRequest: null,
      lastOutput: null,
      bulk: {
        bulkId: "",
        pollTimer: null,
        submitting: false,
        stopping: false,
        sequence: 0,
        lastRequest: null,
        lastOutput: null,
        selectedFilenames: [],
        selectedVariationIndexes: [],
        selectedGlobalIndexes: [],
        selectedJobId: "",
        selectedOnly: false,
         overnightSelectionJobId: "",
        overnightSelectionView: "all",
        overnightRoundGlobalIndexes: [],
        overnightFinalGlobalIndexes: [],
        overnightFinalRanks: {},
         overnightPreviewJobId: "",
         overnightPreviewImages: [],
      },
      overnight: {
        jobId: "",
        pollTimer: null,
        submitting: false,
        pausing: false,
        resuming: false,
        stopping: false,
        sequence: 0,
        lastOutput: null,
         reconnecting: false,
         lastSuccessfulPollAt: 0,
      },
      reference: { imageId: "", fileName: "", previewUrl: "", source: "" },
      tagSearch: { selected: [], results: [], query: "", category: "all", warning: "" },
      restoreWarnings: [],
      settingsRestored: false,
      tracking: GenerationPollGuard.create(),
      auth: {
        required: false,
        authenticated: false,
        remembered: false,
        csrfToken: "",
        network: "unknown",
      },
    },
    dispersionFilter: { dimension: "", value: "", label: "" },
  };

  const initialJobId = new URLSearchParams(window.location.search).get("job_id") || "";
  let loadToken = 0;
  let recentLoadToken = 0;
  let aiPollTimer = null;
  let generationSettingsSaveTimer = null;
  const $ = (selector) => document.querySelector(selector);

  const generationSettingSelectors = [
    "#generation-character-preset",
    "#generation-freeform-character",
    "#generation-explicit-tags",
    "#generation-appearance",
    "#generation-request",
    "#generation-model",
    "#generation-rating",
    "#generation-size",
    "#generation-seed",
    "#generation-character-lora",
    "#generation-character-strength",
    "#generation-style-lora",
    "#generation-style-strength",
    "#generation-additional-lora",
    "#generation-additional-strength",
    "#generation-count",
    "#generation-variation",
  ];

  function generationSettingsStorage() {
    try {
      return window.localStorage;
    } catch (_error) {
      return null;
    }
  }

  function generationFormSettings() {
    const loras = {};
    for (const type of ["character", "style", "additional"]) {
      loras[type] = {
        key: $(`#generation-${type}-lora`)?.value || "",
        strength: $(`#generation-${type}-strength`)?.value || "0.5",
      };
    }
    return {
      character_preset: $("#generation-character-preset")?.value || "",
      freeform_character: $("#generation-freeform-character")?.value || "",
      explicit_tags: generationTags($("#generation-explicit-tags")?.value).join(", "),
      appearance_text: $("#generation-appearance")?.value || "",
      request_text: $("#generation-request")?.value || "",
      model_key: $("#generation-model")?.value || "",
      rating: $("#generation-rating")?.value || "",
      size: $("#generation-size")?.value || "",
      loras,
      count: $("#generation-count")?.value || "1",
      variation: $("#generation-variation")?.value || "off",
      seed: $("#generation-seed")?.value || "-1",
    };
  }

  function saveGenerationSettings() {
    if (typeof GenerationSettings === "undefined") return false;
    return GenerationSettings.write(generationSettingsStorage(), generationFormSettings());
  }

  function scheduleGenerationSettingsSave() {
    if (generationSettingsSaveTimer) window.clearTimeout(generationSettingsSaveTimer);
    generationSettingsSaveTimer = window.setTimeout(() => {
      generationSettingsSaveTimer = null;
      saveGenerationSettings();
    }, 180);
  }

  function setView(view, { focus = false } = {}) {
    for (const section of document.querySelectorAll("[data-view-section]")) {
      const active = section.dataset.viewSection === view;
      if (section.dataset.viewSection === "generate") section.hidden = !active;
      else section.classList.toggle("view-hidden", !active);
      // A content panel may be state-hidden (for example an empty job
      // summary or comparison panel) even while its parent view is active.
      // Keep the accessibility tree aligned with the actual rendered state.
      const shown = active && !section.hidden;
      section.setAttribute("aria-hidden", shown ? "false" : "true");
    }
    for (const button of document.querySelectorAll("[data-view-target]")) {
      const active = button.dataset.viewTarget === view;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    }
    if (view === "generate") {
      renderGenerationRequestSummary();
      if (focus) $("#generation-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function setMessage(text, error = false) {
    const element = $("#message");
    element.textContent = text || "";
    element.classList.toggle("error", error);
  }

  function setGenerationStatus(text, error = false) {
    const element = $("#generation-status");
    element.textContent = text || "";
    element.classList.toggle("error", error);
  }

  function generationOptionLabel(selector) {
    const select = $(selector);
    if (!select) return "";
    return select.selectedOptions?.[0]?.textContent?.trim() || select.value || "";
  }

  function generationSummaryLoras(loras = null) {
    const values = loras || ["character", "style", "additional"].flatMap((type) => {
      const select = $(`#generation-${type}-lora`);
      const input = $(`#generation-${type}-strength`);
      if (!select?.value) return [];
      const strength = Number(input?.value);
      return [{ key: select.value, lora_type: type, strength: Number.isFinite(strength) ? strength : "?" }];
    });
    return values.map((item) => {
      const entries = state.generation.options?.loras?.[item.lora_type] || [];
      const entry = entries.find((candidate) => candidate.key === item.key);
      const label = entry?.display_name || entry?.label || item.key;
      return `${label} / ${item.strength}`;
    });
  }

  function renderGenerationSummaryRows(selector, rows) {
    const container = $(selector);
    if (!container) return;
    container.replaceChildren();
    for (const [label, value] of rows) {
      if (value == null || value === "") continue;
      const block = document.createElement("div");
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = String(value);
      block.append(term, description);
      container.appendChild(block);
    }
  }

  function renderGenerationRequestSummary() {
    const container = $("#generation-request-summary");
    if (!container) return;
    const count = Number($("#generation-count")?.value || 1);
    const variation = count > 1 ? generationOptionLabel("#generation-variation") : "Off";
    const characterPreset = generationOptionLabel("#generation-character-preset");
    const freeform = $("#generation-freeform-character")?.value.trim() || "";
    const character = [characterPreset && characterPreset !== "なし" ? characterPreset : "", freeform].filter(Boolean).join(" / ");
    const mode = generationReferenceMode();
    const loras = generationSummaryLoras();
    const reference = mode === "none"
      ? "None"
      : `${mode === "pose" ? "Pose" : "Composition"}${state.generation.reference.fileName ? ` / ${state.generation.reference.fileName}` : ""}${mode === "pose" ? ` / ${generationOptionLabel("#generation-reference-fit")}` : ""}`;
    const rows = [
      ["キャラクター / 被写体", character],
      ["追加タグ", generationTags($("#generation-explicit-tags")?.value).join(", ")],
      ["見た目", $("#generation-appearance")?.value.trim() || ""],
      ["内容", $("#generation-request")?.value.trim() || ""],
      ["Model", generationOptionLabel("#generation-model")],
      ["Rating", generationOptionLabel("#generation-rating")],
      ["Count / Variation", `${count} / ${variation}`],
      ["LoRA", loras.join(", ")],
      ["Reference", reference],
    ];
    renderGenerationSummaryRows("#generation-request-summary-list", rows);
    container.hidden = false;
  }

  function generationResultUrl(jobId) {
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("job_id", jobId);
    url.hash = "";
    return `${url.pathname}${url.search}`;
  }

  function renderGenerationResultSummary(data, jobId) {
    const container = $("#generation-result-summary");
    const output = data?.output || {};
    const request = state.generation.lastRequest || {};
    const total = Number(data?.total_count ?? output.total_count ?? request.count ?? output.image_count ?? 1);
    const completed = Number(data?.completed_count ?? output.completed_count ?? output.image_count ?? 0);
    const failed = Number(data?.failed_count ?? output.failed_count ?? 0);
    const stateLabel = data?.state === "failed" ? "Failed" : "Completed";
    const progressLabel = total > 1 ? `${stateLabel} ${completed} / ${total}${failed ? ` / Failed ${failed}` : ""}` : stateLabel;
    const actualSeeds = Array.isArray(output.actual_seeds)
      ? output.actual_seeds
      : Array.isArray(data?.actual_seeds) ? data.actual_seeds
        : output.actual_seed != null ? [output.actual_seed]
          : data?.actual_seed != null ? [data.actual_seed] : [];
    const imageSeeds = Array.isArray(output.images) ? output.images.map((image) => image?.seed).filter((seed) => seed != null) : [];
    const seeds = [...(actualSeeds.length ? actualSeeds : imageSeeds)].map((seed) => String(seed));
    const loras = generationSummaryLoras(request.loras || []);
    const mode = request.reference_mode || "none";
    const reference = mode === "none" ? "None" : (mode === "pose" ? "Pose" : "Composition");
    $("#generation-result-state").textContent = progressLabel;
    $("#generation-result-job-id").textContent = jobId;
    $("#generation-result-link").href = generationResultUrl(jobId);
    $("#generation-result-link").hidden = false;
    const moreButton = $("#generation-more-four");
    if (moreButton) {
      const canContinue = data?.state === "completed" && total === 4 && completed === 4 && failed === 0;
      moreButton.hidden = !canContinue;
      moreButton.disabled = Boolean(state.generation.submitting);
    }
    renderGenerationSummaryRows("#generation-result-details", [
      ["枚数", `${completed} / ${total}`],
      ["actual seed", seeds.join(", ")],
      ["Model", request.model_key || ""],
      ["Rating", request.rating || ""],
      ["LoRA", loras.join(", ")],
      ["Reference", reference],
      ["Count / Variation", `${request.count || total} / ${request.variation || "off"}`],
    ]);
    $("#generation-copy-status").textContent = "";
    container.hidden = false;
  }

  function hideGenerationResultSummary() {
    const container = $("#generation-result-summary");
    if (container) container.hidden = true;
    const status = $("#generation-copy-status");
    if (status) status.textContent = "";
    const moreButton = $("#generation-more-four");
    if (moreButton) {
      moreButton.hidden = true;
      moreButton.disabled = false;
    }
  }

  async function copyTextWithFallback(value) {
    const text = String(value || "").trim();
    if (!text) throw new Error("empty clipboard value");
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("clipboard unavailable");
  }

  async function copyGenerationJobId() {
    const jobId = state.generation.jobId.trim();
    const status = $("#generation-copy-status");
    if (!jobId || !status) return;
    try {
      await copyTextWithFallback(jobId);
      status.textContent = "コピーしました";
    } catch (_error) {
      status.textContent = "コピーできません。job_idを長押しして選択してください。";
    }
  }

  function generationHasReferenceLoraConflict() {
    if (generationReferenceMode() === "none") return false;
    return ["character", "style", "additional"].some((type) => Boolean($(`#generation-${type}-lora`)?.value));
  }

  function clearDetailActualSeed() {
    state.detailActualSeed = null;
    const container = $("#detail-actual-seed-tools");
    const value = $("#detail-actual-seed");
    const button = $("#detail-use-actual-seed");
    const regeneration = $(".detail-regeneration-tools");
    if (container) container.hidden = true;
    if (regeneration) regeneration.hidden = true;
    if (value) value.textContent = "";
    if (button) {
      button.disabled = true;
      button.dataset.actualSeed = "";
    }
  }

  function updateDetailComparisonUi() {
    const button = $("#detail-toggle-comparison");
    const status = $("#detail-comparison-status");
    if (!button || !status) return;
    const selected = Boolean(state.detailImage && state.comparison.has(state.detailImage.id));
    button.textContent = selected ? "比較から外す" : "比較に追加";
    status.textContent = selected ? "比較対象に追加済みです。" : "この画像を比較対象に追加できます。";
  }

  function toggleDetailComparison() {
    if (!state.detailImage) return;
    toggleComparison(state.detailImage);
    updateDetailComparisonUi();
  }

  async function loadDetailActualSeed(imageId) {
    clearDetailActualSeed();
    try {
      const response = await fetch(`/api/images/${encodeURIComponent(imageId)}/generation-settings`, { cache: "no-store" });
      const data = await response.json();
      if (state.detailImageId !== imageId) return;
      const regeneration = $(".detail-regeneration-tools");
      if (regeneration) regeneration.hidden = !response.ok || data.ok === false || data.available !== true;
      if (!response.ok || data.ok === false || data.available !== true) return;
      const actualSeed = Number(data.settings?.actual_seed);
      if (!Number.isInteger(actualSeed) || actualSeed < 0) return;
      state.detailActualSeed = actualSeed;
      const container = $("#detail-actual-seed-tools");
      const value = $("#detail-actual-seed");
      const button = $("#detail-use-actual-seed");
      if (value) value.textContent = String(actualSeed);
      if (button) {
        button.disabled = false;
        button.dataset.actualSeed = String(actualSeed);
      }
      if (container) container.hidden = false;
    } catch (_error) {
      clearDetailActualSeed();
    }
  }

  function useDetailActualSeed() {
    const button = $("#detail-use-actual-seed");
    const actualSeed = Number(button?.dataset.actualSeed ?? state.detailActualSeed);
    if (!Number.isInteger(actualSeed) || actualSeed < 0) return;
    applyActualSeed(actualSeed);
  }

  function applyActualSeed(actualSeed) {
    if (!Number.isInteger(actualSeed) || actualSeed < 0) return;
    const seedInput = $("#generation-seed");
    if (!seedInput) return;
    seedInput.value = String(actualSeed);
    seedInput.dispatchEvent(new Event("input", { bubbles: true }));
    seedInput.dispatchEvent(new Event("change", { bubbles: true }));
    renderGenerationRequestSummary();
    saveGenerationSettings();
    $("#detail-dialog")?.close();
    setView("generate", { focus: true });
    setMessage(`実seed ${actualSeed} を設定しました。生成前に内容を確認してください。`);
  }

  function comparisonItems() {
    return [...state.comparison.values()];
  }

  function renderComparisonPanel() {
    const panel = $("#comparison-panel");
    const count = $("#comparison-count");
    const hint = $("#comparison-hint");
    const open = $("#comparison-open");
    if (!panel || !count || !hint || !open) return;
    const total = state.comparison.size;
    panel.hidden = total === 0;
    count.textContent = `${total} / 2`;
    open.disabled = total !== 2;
    hint.textContent = total === 2 ? "2枚を比較できます。" : "画像を2枚追加すると比較できます。";
  }

  function toggleComparison(image) {
    if (!image?.id) return;
    if (state.comparison.has(image.id)) {
      state.comparison.delete(image.id);
      render();
      const dialog = $("#comparison-dialog");
      if (dialog?.open) {
        if (state.comparison.size === 2) renderComparisonView();
        else dialog.close();
      }
      setMessage(`「${image.filename}」を比較対象から外しました。`);
      return;
    }
    if (state.comparison.size >= 2) {
      setMessage("比較対象は2枚までです。先に比較を解除してください。", true);
      return;
    }
    state.comparison.set(image.id, image);
    render();
    setMessage(`「${image.filename}」を比較対象に追加しました。`);
  }

  async function fetchComparisonSettings(imageId) {
    const response = await fetch(`/api/images/${encodeURIComponent(imageId)}/generation-settings`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || "生成設定を読み込めません。");
    return data.available === true && data.settings && typeof data.settings === "object" ? data.settings : null;
  }

  function comparisonLoras(settings) {
    if (!Array.isArray(settings?.loras) || !settings.loras.length) return "なし";
    return settings.loras.map((item) => {
      const key = item?.key || item?.name || "";
      const strength = item?.strength == null ? "" : ` / ${item.strength}`;
      return `${key}${strength}`;
    }).filter(Boolean).join(", ") || "なし";
  }

  function comparisonCharacter(settings, image) {
    const values = [settings?.character_preset, settings?.freeform_character].filter(Boolean);
    return values.join(" / ") || image.character_name || image.dataset_name || "-";
  }

  function comparisonValue(display, compare = display) {
    const text = display == null ? "" : String(display).trim();
    return {
      display: text || "None",
      compare: compare == null ? "" : String(compare).trim(),
    };
  }

  function comparisonUnavailable() {
    return { display: "Unavailable", compare: "__unavailable__" };
  }

  function comparisonTextValue(value) {
    if (value == null) return comparisonValue("None", "");
    const display = String(value).trim();
    if (!display) return comparisonValue("None", "");
    return comparisonValue(display, display.replace(/\s+/g, " "));
  }

  function comparisonTagValue(value) {
    const tags = Array.isArray(value)
      ? value.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const compare = [...tags].map((tag) => tag.toLowerCase().replace(/\s+/g, " ")).sort().join("|");
    return comparisonValue(tags.join(", "), compare);
  }

  function comparisonSizeValue(settings) {
    const size = settings?.size;
    if (!size || typeof size !== "object") return comparisonValue(size);
    const preset = String(size.preset || "").trim();
    const width = Number.isInteger(size.width) ? size.width : null;
    const height = Number.isInteger(size.height) ? size.height : null;
    const dimensions = width && height ? `${width}x${height}` : "";
    const display = [preset, dimensions].filter(Boolean).join(" / ");
    return comparisonValue(display, display.toLowerCase());
  }

  function comparisonLoraValue(settings, loraType) {
    const item = Array.isArray(settings?.loras)
      ? settings.loras.find((candidate) => candidate?.lora_type === loraType)
      : null;
    if (!item || !item.key) return comparisonValue("None", "");
    const key = String(item.key).trim();
    const strength = item.strength == null ? "" : String(item.strength).trim();
    const normalizedStrength = strength && Number.isFinite(Number(strength)) ? String(Number(strength)) : strength;
    return comparisonValue(strength ? `${key} / ${strength}` : key, `${key.toLowerCase()}|${normalizedStrength}`);
  }

  function comparisonReferenceValue(settings) {
    if (!settings) return comparisonUnavailable();
    const reference = settings.reference && typeof settings.reference === "object" ? settings.reference : {};
    const mode = reference.mode && reference.mode !== "none" ? String(reference.mode) : "none";
    if (mode === "none") return comparisonValue("None", "none");
    const strength = reference.strength == null ? "" : String(reference.strength).trim();
    const fit = reference.fit == null ? "" : String(reference.fit).trim();
    const display = [mode, strength, fit].filter(Boolean).join(" / ");
    const normalizedStrength = strength && Number.isFinite(Number(strength)) ? String(Number(strength)) : strength;
    return comparisonValue(display, `${mode.toLowerCase()}|${normalizedStrength}|${fit.toLowerCase()}`);
  }

  function comparisonReferenceImageValue(settings) {
    if (!settings) return comparisonUnavailable();
    const reference = settings.reference && typeof settings.reference === "object" ? settings.reference : {};
    const imageId = String(reference.image_id || "").trim();
    return comparisonValue(imageId ? "Selected" : "None", imageId || "");
  }

  function comparisonFieldValues(settings) {
    if (!settings) {
      return [
        ["Character preset", comparisonUnavailable()],
        ["Free-form character", comparisonUnavailable()],
        ["Explicit tags", comparisonUnavailable()],
        ["Appearance", comparisonUnavailable()],
        ["Request", comparisonUnavailable()],
        ["Model", comparisonUnavailable()],
        ["Rating", comparisonUnavailable()],
        ["Size", comparisonUnavailable()],
        ["Character LoRA", comparisonUnavailable()],
        ["Style LoRA", comparisonUnavailable()],
        ["Additional LoRA", comparisonUnavailable()],
        ["Reference", comparisonUnavailable()],
        ["Reference image", comparisonUnavailable()],
        ["Requested seed", comparisonUnavailable()],
        ["Actual seed", comparisonUnavailable()],
        ["Count", comparisonUnavailable()],
        ["Variation", comparisonUnavailable()],
      ];
    }
    return [
      ["Character preset", comparisonTextValue(settings.character_preset)],
      ["Free-form character", comparisonTextValue(settings.freeform_character)],
      ["Explicit tags", comparisonTagValue(settings.explicit_tags)],
      ["Appearance", comparisonTextValue(settings.appearance_text)],
      ["Request", comparisonTextValue(settings.request_text)],
      ["Model", comparisonTextValue(settings.model_key)],
      ["Rating", comparisonTextValue(settings.rating)],
      ["Size", comparisonSizeValue(settings)],
      ["Character LoRA", comparisonLoraValue(settings, "character")],
      ["Style LoRA", comparisonLoraValue(settings, "style")],
      ["Additional LoRA", comparisonLoraValue(settings, "additional")],
      ["Reference", comparisonReferenceValue(settings)],
      ["Reference image", comparisonReferenceImageValue(settings)],
      ["Requested seed", settings.seed == null ? comparisonValue("None", "") : comparisonValue(settings.seed)],
      ["Actual seed", settings.actual_seed == null ? comparisonValue("None", "") : comparisonValue(settings.actual_seed)],
      ["Count", comparisonValue(settings.count == null ? 1 : settings.count)],
      ["Variation", comparisonTextValue(settings.variation || "off")],
    ];
  }

  function comparisonDiffRows(settingsList) {
    const fields = comparisonFieldValues(settingsList[0]).map(([label], index) => ({
      label,
      values: settingsList.map((settings) => comparisonFieldValues(settings)[index][1]),
    }));
    return fields.filter((field) => field.values[0].compare !== field.values[1].compare);
  }

  function comparisonRows(image, settings) {
    const reference = settings?.reference && typeof settings.reference === "object" ? settings.reference : {};
    const mode = reference.mode && reference.mode !== "none" ? reference.mode : "none";
    const rows = [
      ["ファイル", image.filename],
      ["生成日時", image.generated_at || image.modified_at || "-"],
      ["Character", comparisonCharacter(settings, image)],
    ];
    if (!settings) return rows;
    rows.push(
      ["Request", settings.request_text || "-"],
      ["Appearance", settings.appearance_text || "-"],
      ["Model", settings.model_key || "-"],
      ["Rating", settings.rating || "-"],
      ["LoRA", comparisonLoras(settings)],
      ["Reference", mode],
      ["requested seed", settings.seed == null ? "-" : String(settings.seed)],
      ["actual seed", settings.actual_seed == null ? "-" : String(settings.actual_seed)],
      ["Count / Variation", `${settings.count || 1} / ${settings.variation || "off"}`],
    );
    return rows;
  }

  function comparisonActionButton(label, handler, options = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary";
    button.textContent = label;
    if (options.disabled) button.disabled = true;
    button.addEventListener("click", handler);
    return button;
  }

  function renderComparisonItem(image, settings, error = "", rowsOverride = null, sideLabel = "") {
    const article = document.createElement("article");
    article.className = "comparison-item";
    if (sideLabel) {
      const label = document.createElement("span");
      label.className = "comparison-side-label";
      label.textContent = sideLabel;
      article.append(label);
    }
    const imageWrap = document.createElement("div");
    imageWrap.className = "comparison-image-wrap";
    const imageElement = document.createElement("img");
    imageElement.src = image.url || image.thumbnail_url;
    imageElement.alt = image.filename || "比較画像";
    imageWrap.append(imageElement);
    article.append(imageWrap);

    const heading = document.createElement("h3");
    heading.textContent = image.filename || "画像";
    article.append(heading);
    const metadata = document.createElement("dl");
    metadata.className = "comparison-metadata";
    for (const [label, value] of rowsOverride || comparisonRows(image, settings)) {
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = String(value);
      metadata.append(term, description);
    }
    if (error) {
      const warning = document.createElement("p");
      warning.className = "comparison-warning";
      warning.textContent = "生成設定は利用できません。画像情報だけ表示しています。";
      metadata.append(warning);
    }
    article.append(metadata);

    const primaryActions = document.createElement("div");
    primaryActions.className = "comparison-primary-actions";
    if (settings) {
      primaryActions.append(comparisonActionButton("この設定を使う", async (event) => {
        state.detailImageId = image.id;
        await restoreDetailGenerationSettings(event.currentTarget, image.id);
      }));
    }

    const secondary = document.createElement("details");
    secondary.className = "comparison-secondary-actions";
    const secondarySummary = document.createElement("summary");
    secondarySummary.textContent = "その他の操作";
    secondary.append(secondarySummary);
    const actions = document.createElement("div");
    actions.className = "comparison-item-actions";
    if (settings) {
      const actualSeed = Number(settings.actual_seed);
      if (Number.isInteger(actualSeed) && actualSeed >= 0) {
        actions.append(comparisonActionButton("実seedを使用", () => {
          applyActualSeed(actualSeed);
          $("#comparison-dialog")?.close();
        }));
      }
    }
    actions.append(
      comparisonActionButton("Compositionに使う", async (event) => {
        state.detailImageId = image.id;
        await useDetailImageAsReference("composition", event.currentTarget, image.id, image);
      }),
      comparisonActionButton("Poseに使う", async (event) => {
        state.detailImageId = image.id;
        await useDetailImageAsReference("pose", event.currentTarget, image.id, image);
      }),
      comparisonActionButton("詳細を開く", () => {
        $("#comparison-dialog")?.close();
        openDetail(image);
      }),
      comparisonActionButton("比較から外す", () => toggleComparison(image)),
    );
    secondary.append(actions);
    if (settings) article.append(primaryActions);
    article.append(secondary);
    return article;
  }

  async function renderComparisonView() {
    const grid = $("#comparison-grid");
    if (!grid) return;
    const token = ++state.comparisonRenderToken;
    grid.replaceChildren();
    const images = comparisonItems();
    const entries = await Promise.all(images.map(async (image) => {
      try {
        return { image, settings: await fetchComparisonSettings(image.id), error: "" };
      } catch (_error) {
        return { image, settings: null, error: "settings unavailable" };
      }
    }));
    if (token !== state.comparisonRenderToken || images.some((image) => !state.comparison.has(image.id))) return;

    const hasLegacy = entries.some((entry) => !entry.settings);
    const allDiffRows = state.comparisonDiffOnly ? comparisonDiffRows(entries.map((entry) => entry.settings)) : [];
    const diffRows = hasLegacy
      ? allDiffRows.filter((row) => row.values.every((value) => value.compare !== "__unavailable__"))
      : allDiffRows;
    if (state.comparisonDiffOnly) {
      const summary = document.createElement("p");
      summary.className = "comparison-diff-summary";
      summary.textContent = hasLegacy
        ? "Legacy画像では比較可能な設定が限られます。"
        : diffRows.length
        ? `${diffRows.length}項目に差分があります。`
        : "保存されている生成設定に差分はありません。";
      grid.append(summary);
    }
    entries.forEach((entry, index) => {
      const rows = state.comparisonDiffOnly
        ? diffRows.map((row) => {
          let display = row.values[index].display;
          if (row.label === "Reference image" && row.values[0].compare !== row.values[1].compare && display === "Selected") {
            display += " (different image)";
          }
          return [row.label, display];
        })
        : null;
      grid.append(renderComparisonItem(entry.image, entry.settings, entry.error, rows, index === 0 ? "A" : "B"));
    });
  }

  function updateComparisonDiffToggle() {
    const button = $("#comparison-diff-toggle");
    const status = $("#comparison-diff-status");
    if (!button) return;
    button.textContent = state.comparisonDiffOnly ? "全項目を表示" : "差分のみ表示";
    button.setAttribute("aria-pressed", state.comparisonDiffOnly ? "true" : "false");
    if (status) status.textContent = state.comparisonDiffOnly ? "A / Bで異なる設定だけを表示中" : "全項目を表示中";
  }

  function toggleComparisonDiff() {
    state.comparisonDiffOnly = !state.comparisonDiffOnly;
    updateComparisonDiffToggle();
    renderComparisonView();
  }

  function openComparison() {
    if (state.comparison.size !== 2) {
      setMessage("比較対象を2枚選択してください。", true);
      return;
    }
    const dialog = $("#comparison-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    updateComparisonDiffToggle();
    renderComparisonView();
  }

  function clearComparison() {
    state.comparison.clear();
    state.comparisonRenderToken += 1;
    state.comparisonDiffOnly = false;
    updateComparisonDiffToggle();
    $("#comparison-dialog")?.close();
    render();
    setMessage("比較対象を解除しました。");
  }

  function renderGenerationRestoreStatus(warnings = []) {
    const element = $("#generation-restore-status");
    if (!element) return;
    const values = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
    element.textContent = values.join("\n");
    element.hidden = values.length === 0;
    element.classList.toggle("error", generationHasReferenceLoraConflict());
  }

  function updateGenerationAuthUi() {
    const auth = state.generation.auth;
    const capability = $("#generation-capability");
    const authStatus = $("#generation-auth-status");
    const authSubmit = $("#generation-auth-submit");
    const authLogout = $("#generation-auth-logout");
    const tokenInput = $("#generation-auth-token");
    const rememberInput = $("#generation-auth-remember");
    const generationSubmit = $("#generation-submit");
    const bulkStart = $("#generation-bulk-start");
    if (!capability || !authStatus || !authSubmit || !authLogout || !tokenInput || !rememberInput || !generationSubmit) return;
    const tokenLabel = tokenInput.closest("label");
    const rememberLabel = rememberInput.closest("label");
    if (!auth.required) {
      capability.textContent = "生成可能（このPC）";
      capability.classList.add("ready");
      capability.classList.remove("remote");
      authStatus.textContent = "この端末では追加認証は不要です。";
      authSubmit.hidden = true;
      authLogout.hidden = true;
      if (tokenLabel) tokenLabel.hidden = true;
      if (rememberLabel) rememberLabel.hidden = true;
      generationSubmit.disabled = Boolean(state.generation.submitting) || generationHasReferenceLoraConflict();
      if (bulkStart) bulkStart.disabled = Boolean(state.generation.bulk.submitting) || Boolean(state.generation.submitting) || generationHasReferenceLoraConflict();
      return;
    }
    if (auth.authenticated) {
      capability.textContent = "生成可能（認証済みTailscale）";
      capability.classList.add("ready");
      capability.classList.remove("remote");
      authStatus.textContent = auth.remembered
        ? "リモート生成が解除されています（この端末を30日間記憶中）。"
        : "リモート生成が解除されています。";
      authSubmit.hidden = true;
      authLogout.hidden = false;
      if (tokenLabel) tokenLabel.hidden = true;
      if (rememberLabel) rememberLabel.hidden = true;
      generationSubmit.disabled = Boolean(state.generation.submitting) || generationHasReferenceLoraConflict();
      if (bulkStart) bulkStart.disabled = Boolean(state.generation.bulk.submitting) || Boolean(state.generation.submitting) || generationHasReferenceLoraConflict();
    } else {
      capability.textContent = "リモート生成は認証が必要です";
      capability.classList.remove("ready");
      capability.classList.add("remote");
      authStatus.textContent = "キーを入力して生成を解除してください。";
      authSubmit.hidden = false;
      authLogout.hidden = true;
      if (tokenLabel) tokenLabel.hidden = false;
      if (rememberLabel) rememberLabel.hidden = false;
      generationSubmit.disabled = true;
      if (bulkStart) bulkStart.disabled = true;
    }
  }

  function generationMutationHeaders(headers = {}) {
    const result = { ...headers };
    if (state.generation.auth.csrfToken) result["X-Gallery-Generation-CSRF"] = state.generation.auth.csrfToken;
    return result;
  }

  function addSelectOption(select, value, label) {
    const option = document.createElement("option");
    option.value = value == null ? "" : String(value);
    option.textContent = label == null ? String(value || "") : String(label);
    select.appendChild(option);
  }

  function fillGenerationSelect(selector, values, emptyLabel = null) {
    const select = $(selector);
    select.replaceChildren();
    if (emptyLabel != null) addSelectOption(select, "", emptyLabel);
    for (const item of values || []) {
      if (item && typeof item === "object") addSelectOption(select, item.key, item.display_name || item.label || item.key);
      else if (item != null) addSelectOption(select, item, item);
    }
  }

  function generationLoraEntries(type) {
    return state.generation.options?.loras?.[type] || [];
  }

  function updateGenerationLoraDefault(type) {
    const select = $(`#generation-${type}-lora`);
    const input = $(`#generation-${type}-strength`);
    const entry = generationLoraEntries(type).find((item) => item.key === select.value);
    if (entry && entry.default_strength != null) input.value = entry.default_strength;
  }

  function renderGenerationOptions(data) {
    state.generation.options = data || {};
    fillGenerationSelect("#generation-character-preset", data.character_presets, "なし");
    fillGenerationSelect("#generation-model", data.models);
    fillGenerationSelect("#generation-rating", data.ratings);
    fillGenerationSelect("#generation-size", data.sizes);
    for (const type of ["character", "style", "additional"]) {
      fillGenerationSelect(`#generation-${type}-lora`, generationLoraEntries(type), "なし");
      updateGenerationLoraDefault(type);
    }
    const capability = $("#generation-capability");
    capability.textContent = "生成可能（この端末）";
    capability.classList.add("ready");
    updateGenerationAuthUi();
    restoreSavedGenerationSettings();
    renderGenerationRequestSummary();
  }

  async function loadGenerationAuthStatus() {
    try {
      const response = await fetch("/api/generation/auth/status", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "生成認証状態を取得できません。");
      state.generation.auth.required = Boolean(data.requires_auth);
      state.generation.auth.authenticated = Boolean(data.authenticated);
      state.generation.auth.remembered = Boolean(data.remembered);
      state.generation.auth.csrfToken = typeof data.csrf_token === "string" ? data.csrf_token : "";
      state.generation.auth.network = data.network || "unknown";
      updateGenerationAuthUi();
    } catch (error) {
      state.generation.auth.required = true;
      state.generation.auth.authenticated = false;
      state.generation.auth.remembered = false;
      state.generation.auth.csrfToken = "";
      updateGenerationAuthUi();
      setGenerationStatus(error.message || String(error), true);
    }
  }

  async function unlockGeneration() {
    const tokenInput = $("#generation-auth-token");
    const token = tokenInput.value;
    if (!token) {
      setGenerationStatus("リモート生成キーを入力してください。", true);
      return;
    }
    const button = $("#generation-auth-submit");
    button.disabled = true;
    try {
      const response = await fetch("/api/generation/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          remember_device: Boolean($("#generation-auth-remember").checked),
        }),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "生成認証に失敗しました。");
      tokenInput.value = "";
      state.generation.auth.authenticated = true;
      state.generation.auth.remembered = Boolean(data.remembered);
      state.generation.auth.csrfToken = typeof data.csrf_token === "string" ? data.csrf_token : "";
      updateGenerationAuthUi();
      setGenerationStatus("リモート生成を解除しました。");
    } catch (error) {
      state.generation.auth.authenticated = false;
      state.generation.auth.remembered = false;
      state.generation.auth.csrfToken = "";
      updateGenerationAuthUi();
      setGenerationStatus(error.message || String(error), true);
    } finally {
      button.disabled = false;
    }
  }

  async function logoutGeneration() {
    const button = $("#generation-auth-logout");
    button.disabled = true;
    try {
      const response = await fetch("/api/generation/auth/logout", {
        method: "POST",
        headers: generationMutationHeaders(),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "端末認証を解除できません。");
      state.generation.auth.authenticated = false;
      state.generation.auth.remembered = false;
      state.generation.auth.csrfToken = "";
      $("#generation-auth-token").value = "";
      $("#generation-auth-remember").checked = false;
      updateGenerationAuthUi();
      setGenerationStatus("この端末の認証を解除しました。");
    } catch (error) {
      setGenerationStatus(error.message || String(error), true);
    } finally {
      button.disabled = false;
    }
  }

  async function loadGenerationOptions() {
    try {
      const response = await fetch("/api/generation/options", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "生成オプションを読み込めません。");
      renderGenerationOptions(data);
      return data;
    } catch (error) {
      $("#generation-capability").textContent = "生成オプションを取得できません";
      setGenerationStatus(error.message || String(error), true);
      return null;
    }
  }

  function generationTags(value) {
    if (typeof GenerationTags !== "undefined") return GenerationTags.parse(value);
    const tags = [];
    const seen = new Set();
    for (const item of String(value || "").split(/[,\n]/)) {
      const tag = item.trim();
      const key = normalizeGenerationTag(tag);
      if (!tag || !key || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
    return tags;
  }

  function normalizeGenerationTag(value) {
    if (typeof GenerationTags !== "undefined") return GenerationTags.normalize(value);
    return String(value || "").trim().replace(/[\s-]+/g, "_").toLowerCase();
  }

  function renderExplicitTagChips() {
    const container = $("#generation-explicit-tags-chips");
    const clearButton = $("#generation-explicit-tags-clear");
    if (!container) return;
    const tags = generationTags($("#generation-explicit-tags")?.value);
    container.replaceChildren();
    for (const tag of tags) {
      const chip = document.createElement("span");
      chip.className = "generation-explicit-tag-chip";
      const text = document.createElement("span");
      text.className = "generation-explicit-tag-text";
      text.textContent = tag;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "generation-explicit-tag-remove";
      remove.setAttribute("aria-label", tag + " を削除");
      remove.textContent = "×";
      remove.addEventListener("click", () => removeExplicitTag(tag));
      chip.append(text, remove);
      container.appendChild(chip);
    }
    if (clearButton) clearButton.hidden = tags.length < 2;
  }

  function removeExplicitTag(tag) {
    const input = $("#generation-explicit-tags");
    if (!input) return;
    input.value = typeof GenerationTags !== "undefined"
      ? GenerationTags.remove(input.value, tag)
      : generationTags(input.value).filter((item) => normalizeGenerationTag(item) !== normalizeGenerationTag(tag)).join(", ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    renderExplicitTagChips();
  }

  function clearExplicitTags() {
    const input = $("#generation-explicit-tags");
    if (!input) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    renderExplicitTagChips();
  }

  function renderTagSearch() {
    const search = state.generation.tagSearch;
    const results = $("#generation-tag-search-results");
    const selected = $("#generation-tag-search-selected");
    const warning = $("#generation-tag-search-warning");
    const status = $("#generation-tag-search-status");
    const categoryInput = $("#generation-tag-search-category");
    if (!results || !selected || !warning || !status) return;
    if (categoryInput) categoryInput.value = search.category || "all";
    results.replaceChildren();
    for (const candidate of search.results) {
      const tag = String(candidate?.tag || "").trim();
      if (!tag) continue;
      const label = document.createElement("label");
      label.className = "generation-tag-result";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = search.selected.some((item) => normalizeGenerationTag(item) === normalizeGenerationTag(tag));
      checkbox.addEventListener("change", () => toggleGenerationTagSelection(tag));
      const text = document.createElement("span");
      text.textContent = tag;
      const meta = document.createElement("small");
      const category = String(candidate.category || "general");
      const posts = Number(candidate.post_count);
      const categoryLabels = { general: "一般", character: "キャラクター", copyright: "作品" };
      const translation = String(candidate.translation_ja || "").trim();
      const categoryLabel = categoryLabels[category] || category;
      meta.textContent = `${translation ? `${translation} · ` : ""}${categoryLabel}${Number.isFinite(posts) ? ` / ${posts.toLocaleString()} posts` : ""}`;
      label.append(checkbox, text, meta);
      results.appendChild(label);
    }
    if (search.selected.length) {
      for (const tag of search.selected) {
        const chip = document.createElement("span");
        chip.className = "generation-tag-chip";
        chip.textContent = tag;
        selected.appendChild(chip);
      }
    } else {
      selected.textContent = search.results.length ? "候補を選択してください。" : "";
    }
    warning.textContent = search.warning;
    warning.hidden = !search.warning;
    status.textContent = search.query && !search.results.length && !search.warning ? "候補がありません。" : (search.query ? `${search.results.length}件` : "");
    $("#generation-tag-search-add").disabled = search.selected.length === 0;
    $("#generation-tag-search-copy").disabled = search.selected.length === 0;
    $("#generation-tag-search-clear").disabled = search.selected.length === 0;
  }

  function toggleGenerationTagSearch() {
    const button = $("#generation-tag-search-toggle");
    const panel = $("#generation-tag-search-panel");
    if (!button || !panel) return;
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) $("#generation-tag-search-query")?.focus();
  }

  function toggleGenerationTagSelection(tag) {
    const search = state.generation.tagSearch;
    const key = normalizeGenerationTag(tag);
    const index = search.selected.findIndex((item) => normalizeGenerationTag(item) === key);
    if (index >= 0) search.selected.splice(index, 1);
    else search.selected.push(tag);
    renderTagSearch();
  }

  async function searchGenerationTags() {
    const input = $("#generation-tag-search-query");
    const categoryInput = $("#generation-tag-search-category");
    const button = $("#generation-tag-search-submit");
    const query = input?.value.trim() || "";
    const category = categoryInput?.value || "all";
    if (!query) {
      state.generation.tagSearch = { ...state.generation.tagSearch, query: "", category, results: [], warning: "検索語を入力してください。" };
      renderTagSearch();
      return;
    }
    if (button) button.disabled = true;
    state.generation.tagSearch = { ...state.generation.tagSearch, query, category, results: [], warning: "" };
    renderTagSearch();
    try {
      const response = await fetch(`/api/generation/tags/search?q=${encodeURIComponent(query)}&limit=20&category=${encodeURIComponent(category)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "タグ検索に失敗しました。");
      state.generation.tagSearch = {
        ...state.generation.tagSearch,
        results: Array.isArray(data.results) ? data.results : [],
        warning: typeof data.warning === "string" ? data.warning : "",
      };
    } catch (error) {
      state.generation.tagSearch = { ...state.generation.tagSearch, results: [], warning: error.message || "タグ検索に失敗しました。" };
    } finally {
      if (button) button.disabled = false;
      renderTagSearch();
    }
  }

  function addSelectedGenerationTags() {
    const textarea = $("#generation-explicit-tags");
    if (!textarea) return;
    const merged = generationTags(textarea.value);
    const existing = new Set(merged.map(normalizeGenerationTag));
    for (const tag of state.generation.tagSearch.selected) {
      const key = normalizeGenerationTag(tag);
      if (key && !existing.has(key)) {
        merged.push(tag);
        existing.add(key);
      }
    }
    textarea.value = merged.join(", ");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    renderGenerationRequestSummary();
    setGenerationStatus("選択したタグを追加タグへ反映しました。");
  }

  async function copySelectedGenerationTags() {
    const status = $("#generation-tag-search-status");
    try {
      await copyTextWithFallback(state.generation.tagSearch.selected.join(", "));
      if (status) status.textContent = "コピーしました";
    } catch (_error) {
      if (status) status.textContent = "コピーできません。タグを長押しして選択してください。";
    }
  }

  function clearGenerationTagSelection() {
    state.generation.tagSearch = { ...state.generation.tagSearch, selected: [] };
    renderTagSearch();
  }

  function generationLoras() {
    const result = [];
    for (const type of ["character", "style", "additional"]) {
      const key = $(`#generation-${type}-lora`).value;
      if (!key) continue;
      const strength = Number($(`#generation-${type}-strength`).value);
      if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error("LoRA strengthは0～1で指定してください。");
      result.push({ key, lora_type: type, strength });
    }
    return result;
  }

  function generationReferenceMode() {
    return $("#generation-reference-mode").value || "none";
  }

  function renderGenerationReferenceSelection() {
    const selection = $("#generation-reference-selection");
    const preview = $("#generation-reference-preview");
    const text = $("#generation-reference-selection-text");
    if (!selection || !preview || !text) return;
    const reference = state.generation.reference;
    selection.hidden = !reference.fileName;
    const label = reference.source === "gallery" ? "Gallery image selected" : "Reference image selected";
    text.textContent = reference.fileName ? `${label}: ${reference.fileName}` : "";
    if (reference.previewUrl) {
      preview.src = reference.previewUrl;
      preview.hidden = false;
    } else {
      preview.removeAttribute("src");
      preview.hidden = true;
    }
  }

  function clearGenerationReferenceSelection() {
    const reference = state.generation.reference;
    if (reference.previewUrl?.startsWith("blob:") && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(reference.previewUrl);
    state.generation.reference = { imageId: "", fileName: "", previewUrl: "", source: "" };
    const fileInput = $("#generation-reference-file");
    if (fileInput) fileInput.value = "";
    renderGenerationReferenceSelection();
    renderGenerationRequestSummary();
    renderGenerationRestoreStatus(state.generation.restoreWarnings);
    updateGenerationAuthUi();
  }

  function handleGenerationReferenceFileChange() {
    const file = $("#generation-reference-file")?.files?.[0];
    const previousUrl = state.generation.reference.previewUrl;
    if (previousUrl?.startsWith("blob:") && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(previousUrl);
    state.generation.reference = {
      imageId: "",
      fileName: file?.name || "",
      previewUrl: file && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "",
      source: "upload",
    };
    renderGenerationReferenceSelection();
    renderGenerationRequestSummary();
  }

  function restoreGenerationSelect(selector, value, label, warnings) {
    const select = $(selector);
    if (!select) return;
    const normalized = value == null ? "" : String(value);
    if (!normalized) {
      select.value = "";
      return;
    }
    const option = [...select.options].find((item) => item.value === normalized);
    if (option) select.value = normalized;
    else warnings.push(`${label}「${normalized}」は現在利用できないため、既定値を使用します。`);
  }

  function restoreGenerationLoras(loras, warnings) {
    for (const type of ["character", "style", "additional"]) {
      const select = $(`#generation-${type}-lora`);
      if (select) select.value = "";
      updateGenerationLoraDefault(type);
    }
    const items = Array.isArray(loras)
      ? loras
      : Object.entries(loras && typeof loras === "object" ? loras : {}).map(([lora_type, item]) => ({
        ...(item && typeof item === "object" ? item : {}),
        lora_type,
      }));
    for (const item of items) {
      const type = item?.lora_type;
      const key = item?.key;
      const select = $(`#generation-${type}-lora`);
      if (!select || !key || !["character", "style", "additional"].includes(type)) continue;
      if (![...select.options].some((option) => option.value === String(key))) {
        warnings.push(`LoRA「${key}」は現在利用できないため、スロットを空にしました。`);
        continue;
      }
      select.value = String(key);
      const strength = Number(item.strength);
      if (Number.isFinite(strength) && strength >= 0 && strength <= 1) {
        $(`#generation-${type}-strength`).value = String(strength);
      }
    }
  }

  function restoreSavedGenerationSettings() {
    if (state.generation.settingsRestored) return;
    state.generation.settingsRestored = true;
    if (typeof GenerationSettings === "undefined") return;
    const saved = GenerationSettings.read(generationSettingsStorage());
    if (!saved) return;

    const warnings = [];
    $("#generation-character-preset").value = "";
    $("#generation-freeform-character").value = saved.freeform_character;
    $("#generation-explicit-tags").value = generationTags(saved.explicit_tags).join(", ");
    $("#generation-appearance").value = saved.appearance_text;
    $("#generation-request").value = saved.request_text;
    restoreGenerationSelect("#generation-character-preset", saved.character_preset, "Character preset", warnings);
    if (saved.model_key) restoreGenerationSelect("#generation-model", saved.model_key, "Model", warnings);
    if (saved.rating) restoreGenerationSelect("#generation-rating", saved.rating, "Rating", warnings);
    if (saved.size) restoreGenerationSelect("#generation-size", saved.size, "Size", warnings);
    restoreGenerationLoras(saved.loras, warnings);

    $("#generation-count").value = saved.count;
    updateGenerationVariationState();
    $("#generation-variation").value = $("#generation-count").value === "1" ? "off" : saved.variation;
    $("#generation-seed").value = saved.seed;

    // References are intentionally session-only.  A normal Generate view
    // always starts without a previous upload or Gallery-selected asset.
    $("#generation-reference-mode").value = "none";
    state.generation.reference = { imageId: "", fileName: "", previewUrl: "", source: "" };
    const referenceFile = $("#generation-reference-file");
    if (referenceFile) referenceFile.value = "";
    state.generation.restoreWarnings = warnings;
    updateGenerationReferenceState();
    renderExplicitTagChips();
    renderGenerationRestoreStatus(warnings);
    renderGenerationRequestSummary();
    // Persist normalized catalog-safe values so removed LoRAs/presets do not
    // keep coming back on every page load.
    saveGenerationSettings();
  }

  function resetGenerationForm() {
    if (typeof GenerationSettings !== "undefined") GenerationSettings.clear(generationSettingsStorage());
    if (state.generation.options) renderGenerationOptions(state.generation.options);
    $("#generation-character-preset").value = "";
    $("#generation-freeform-character").value = "";
    $("#generation-explicit-tags").value = "";
    $("#generation-appearance").value = "";
    $("#generation-request").value = "";
    $("#generation-seed").value = $("#generation-seed").defaultValue || "-1";
    $("#generation-count").value = $("#generation-count").querySelector("option")?.value || "1";
    $("#generation-variation").value = $("#generation-variation").defaultValue || "off";
    $("#generation-reference-mode").value = "none";
    $("#generation-reference-strength").value = $("#generation-reference-strength").defaultValue || "0.5";
    $("#generation-reference-fit").value = $("#generation-reference-fit").defaultValue || "contain";
    for (const type of ["character", "style", "additional"]) {
      $(`#generation-${type}-lora`).value = "";
      updateGenerationLoraDefault(type);
    }
    clearGenerationReferenceSelection();
    state.generation.restoreWarnings = [];
    state.generation.tagSearch = { selected: [], results: [], query: "", category: "all", warning: "" };
    state.generation.lastRequest = null;
    state.generation.lastCompletedRequest = null;
    state.generation.lastOutput = null;
    hideGenerationResultSummary();
    setGenerationStatus("未実行");
    updateGenerationVariationState();
    updateGenerationReferenceState();
    renderExplicitTagChips();
    renderTagSearch();
    renderGenerationRestoreStatus([]);
    renderGenerationRequestSummary();
    setMessage("入力をリセットしました。次回Generateでは既定値を使用します。");
  }

  async function restoreDetailGenerationSettings(buttonOverride = null, imageIdOverride = "") {
    const imageId = imageIdOverride || state.detailImageId;
    const button = buttonOverride || $("#detail-restore-generation-settings");
    if (!imageId || !button) return;
    button.disabled = true;
    try {
      const response = await fetch(`/api/images/${encodeURIComponent(imageId)}/generation-settings`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "生成設定を読み込めません。");
      if (!state.generation.options && !await loadGenerationOptions()) throw new Error("生成オプションを読み込めません。");
      const settings = data.settings || {};
      const warnings = Array.isArray(data.warnings) ? [...data.warnings] : [];

      $("#generation-character-preset").value = "";
      $("#generation-freeform-character").value = settings.freeform_character || "";
      $("#generation-explicit-tags").value = generationTags(Array.isArray(settings.explicit_tags) ? settings.explicit_tags.join(", ") : "").join(", ");
      $("#generation-appearance").value = settings.appearance_text || "";
      $("#generation-request").value = settings.request_text || "";
      restoreGenerationSelect("#generation-character-preset", settings.character_preset, "Character preset", warnings);
      restoreGenerationSelect("#generation-model", settings.model_key, "Model", warnings);
      restoreGenerationSelect("#generation-rating", settings.rating, "Rating", warnings);

      const size = settings.size && typeof settings.size === "object" ? settings.size : {};
      restoreGenerationSelect("#generation-size", size.preset || settings.size, "Size", warnings);
      restoreGenerationLoras(settings.loras, warnings);

      const count = Number(settings.count);
      $("#generation-count").value = [1, 2, 3, 4, 8].includes(count) ? String(count) : "1";
      updateGenerationVariationState();
      $("#generation-variation").value = $("#generation-count").value === "1" ? "off" : (settings.variation === "auto" ? "auto" : "off");
      const seed = Number(settings.seed);
      $("#generation-seed").value = Number.isInteger(seed) && seed >= -1 ? String(seed) : "-1";

      clearGenerationReferenceSelection();
      const reference = settings.reference && typeof settings.reference === "object" ? settings.reference : {};
      if (["composition", "pose"].includes(reference.mode) && reference.image_id) {
        $("#generation-reference-mode").value = reference.mode;
        state.generation.reference = {
          imageId: String(reference.image_id),
          fileName: "保存済みReference",
          previewUrl: "",
          source: "restored",
        };
        if (reference.strength != null) $("#generation-reference-strength").value = String(reference.strength);
        if (["contain", "cover", "stretch"].includes(reference.fit)) $("#generation-reference-fit").value = reference.fit;
      } else {
        $("#generation-reference-mode").value = "none";
      }

      state.generation.restoreWarnings = warnings;
      updateGenerationReferenceState();
      renderExplicitTagChips();
      renderGenerationRestoreStatus(warnings);
      renderGenerationRequestSummary();
      saveGenerationSettings();
      $("#detail-dialog")?.close();
      $("#comparison-dialog")?.close();
      setView("generate", { focus: true });
      setMessage(warnings.length ? "設定を読み込みました。一部に確認が必要です。" : "設定を読み込みました。生成前に内容を確認してください。");
    } catch (error) {
      setMessage(error.message || String(error), true);
    } finally {
      button.disabled = false;
    }
  }

  async function useDetailImageAsReference(mode, buttonOverride = null, imageIdOverride = "", imageOverride = null) {
    const imageId = imageIdOverride || state.detailImageId;
    if (!imageId || !["composition", "pose"].includes(mode)) return;
    const button = buttonOverride || $(`#detail-use-${mode}-reference`);
    if (button) button.disabled = true;
    try {
      const response = await fetch("/api/generation/references/from-gallery", {
        method: "POST",
        headers: generationMutationHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ gallery_image_id: imageId }),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false || !data.reference_image_id) {
        throw new Error(data.error || "Gallery画像をReferenceに登録できません。");
      }
      const image = imageOverride || state.images.find((item) => item.id === imageId) || state.detailImage;
      $("#generation-reference-mode").value = mode;
      state.generation.reference = {
        imageId: data.reference_image_id,
        fileName: data.filename || image?.filename || "Gallery image",
        previewUrl: image?.thumbnail_url || image?.url || "",
        source: "gallery",
      };
      saveGenerationSettings();
      updateGenerationReferenceState();
      setView("generate", { focus: true });
      $("#detail-dialog")?.close();
      $("#comparison-dialog")?.close();
      setMessage(`${mode === "pose" ? "Pose" : "Composition"} Referenceに設定しました。`);
    } catch (error) {
      setMessage(error.message || String(error), true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function updateGenerationReferenceState() {
    const mode = generationReferenceMode();
    const enabled = mode !== "none";
    $("#generation-reference-file").disabled = !enabled;
    $("#generation-reference-strength").disabled = !enabled;
    // The existing composition/IP-Adapter workflow has no fit input.  Fit is
    // exposed only for the existing pose preprocessing path.
    $("#generation-reference-fit").disabled = mode !== "pose";
    const defaults = state.generation.options?.reference?.default_strengths || {};
    if (enabled && defaults[mode] != null) $("#generation-reference-strength").value = defaults[mode];
    const hint = $("#generation-reference-mode-hint");
    const help = $("#generation-reference-help");
    if (mode === "none") {
      if ($("#generation-reference-file").value || state.generation.reference.fileName) clearGenerationReferenceSelection();
      if (hint) hint.textContent = "Referenceなし";
      if (help) help.textContent = "Composition または Pose を選ぶと画像を指定できます。";
    } else if (mode === "composition") {
      if (hint) hint.textContent = "Composition referenceを使用中";
      if (help) help.textContent = "画像を指定してください。Compositionではfit modeは使用しません。";
    } else {
      if (hint) hint.textContent = "Pose referenceを使用中";
      if (help) help.textContent = "画像を指定し、必要に応じてfit modeを選択してください。";
    }
    renderGenerationReferenceSelection();
    renderGenerationRequestSummary();
  }

  async function uploadGenerationReference() {
    const mode = generationReferenceMode();
    if (mode === "none") return null;
    if ((state.generation.reference.source === "gallery" || state.generation.reference.source === "restored") && state.generation.reference.imageId) {
      return state.generation.reference.imageId;
    }
    const file = $("#generation-reference-file").files[0];
    if (!file) throw new Error("Reference modeを使う場合は画像を1枚選択してください。");
    const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
    const maxBytes = Number(state.generation.options?.reference?.max_upload_bytes || 10 * 1024 * 1024);
    if (file.size > maxBytes) throw new Error("参考画像が大きすぎます。");
    if (file.type && !allowed.has(file.type)) throw new Error("参考画像はPNG / JPEG / WebPだけ対応しています。");
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await fetch("/api/generation/references", {
      method: "POST",
      headers: generationMutationHeaders(),
      body: form,
    });
    const data = await response.json();
    if (!response.ok || data.ok === false || !data.reference_image_id) {
      throw new Error(data.error || "参考画像を登録できません。");
    }
    state.generation.reference.imageId = data.reference_image_id;
    state.generation.reference.fileName = file.name;
    renderGenerationReferenceSelection();
    return data.reference_image_id;
  }

  function generationPayload(referenceImageId = null) {
    const rawSeed = $("#generation-seed").value.trim();
    const seed = rawSeed === "" ? -1 : Number(rawSeed);
    if (!Number.isInteger(seed) || seed < -1) throw new Error("Seedは-1または0以上の整数で指定してください。");
    return {
      character_preset: $("#generation-character-preset").value || null,
      freeform_character: $("#generation-freeform-character").value.trim() || null,
      explicit_tags: generationTags($("#generation-explicit-tags").value),
      appearance_text: $("#generation-appearance").value.trim() || null,
      request_text: $("#generation-request").value.trim() || null,
      model_key: $("#generation-model").value,
      rating: $("#generation-rating").value,
      loras: generationLoras(),
      size: $("#generation-size").value,
      count: Number($("#generation-count").value || 1),
      variation: $("#generation-variation").value || "off",
      variation_offset: 0,
      seed,
      reference_mode: generationReferenceMode(),
      reference_image_id: referenceImageId,
      reference_strength: Number($("#generation-reference-strength").value),
      reference_fit: $("#generation-reference-fit").value || "contain",
    };
  }

  function updateGenerationVariationState() {
    const count = Number($("#generation-count").value || 1);
    const variation = $("#generation-variation");
    variation.disabled = count <= 1;
    if (count <= 1) variation.value = "off";
    renderGenerationRequestSummary();
  }

  function stopGenerationPolling() {
    if (state.generation.pollTimer) {
      clearTimeout(state.generation.pollTimer);
      state.generation.pollTimer = null;
    }
  }

  function invalidateGenerationTracking() {
    stopGenerationPolling();
    GenerationPollGuard.invalidate(state.generation.tracking);
    state.generation.jobId = "";
  }

  function activateGenerationTracking(jobId) {
    const tracking = GenerationPollGuard.activate(state.generation.tracking, jobId);
    state.generation.jobId = tracking.jobId;
    return tracking;
  }

  function isCurrentGeneration(jobId, sequence) {
    return GenerationPollGuard.isCurrent(state.generation.tracking, jobId, sequence);
  }

  async function pollGenerationJob(jobId, sequence) {
    if (!isCurrentGeneration(jobId, sequence)) return;
    try {
      const response = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      const data = await response.json();
      if (!isCurrentGeneration(jobId, sequence)) return;
      if (!response.ok || data.ok === false) throw new Error(data.error || "生成状態を取得できません。");
      const progress = data.progress == null ? "" : ` / ${Math.round(Number(data.progress) * 100)}%`;
      const stage = data.stage ? ` / ${data.stage}` : "";
      const counts = data.total_count > 1
        ? ` / ${data.completed_count || 0}/${data.total_count}完了${data.failed_count ? ` / 失敗${data.failed_count}` : ""}`
        : "";
      const stateLabel = { queued: "Queued", resolving: "Resolving", generating: "Generating", completed: "Completed", failed: "Failed" }[data.state] || data.state || "Unknown";
      const visibleCounts = data.total_count > 1 ? ` ${data.completed_count || 0} / ${data.total_count}` : "";
      setGenerationStatus(`${stateLabel}${visibleCounts}${progress}${stage}${counts} / job_id=${jobId}`);
      state.generation.lastOutput = data;
      if (data.state === "completed") {
        stopGenerationPolling();
        state.generation.submitting = false;
        $("#generation-submit").disabled = false;
        updateGenerationAuthUi();
        state.generation.lastCompletedRequest = state.generation.lastRequest
          ? JSON.parse(JSON.stringify(state.generation.lastRequest))
          : null;
        $("#job-filter").value = jobId;
        renderGenerationResultSummary(data, jobId);
        setMessage("生成が完了しました。Galleryを同期しています。");
        await load({
          page: 1,
          generationGuard: { jobId, sequence },
        });
        return;
      }
      if (data.state === "failed") {
        stopGenerationPolling();
        state.generation.submitting = false;
        $("#generation-submit").disabled = false;
        updateGenerationAuthUi();
        renderGenerationResultSummary(data, jobId);
        setGenerationStatus(`${data.state} / ${data.error_summary || "生成に失敗しました。"} / job_id=${jobId}`, true);
        return;
      }
      state.generation.pollTimer = setTimeout(() => pollGenerationJob(jobId, sequence), 1500);
    } catch (error) {
      if (!isCurrentGeneration(jobId, sequence)) return;
      stopGenerationPolling();
      state.generation.submitting = false;
      $("#generation-submit").disabled = false;
      updateGenerationAuthUi();
      setGenerationStatus(error.message || String(error), true);
    }
  }

  async function submitGeneration(requestOverride = null) {
    if (state.generation.submitting || state.generation.bulk.submitting) return;
    if (state.generation.auth.required && !state.generation.auth.authenticated) {
      setGenerationStatus("リモート生成キーで認証してください。", true);
      return;
    }
    invalidateGenerationTracking();
    hideGenerationResultSummary();
    state.generation.submitting = true;
    $("#generation-submit").disabled = true;
    $("#generation-more-four").disabled = true;
    updateGenerationAuthUi();
    renderGenerationRequestSummary();
    if (!requestOverride) saveGenerationSettings();
    setGenerationStatus("送信中…");
    try {
      let payload;
      if (requestOverride && typeof requestOverride === "object") {
        payload = JSON.parse(JSON.stringify(requestOverride));
        if (payload.reference_mode !== "none" && !payload.reference_image_id) {
          throw new Error("直前のReference画像が利用できないため、追加生成できません。Referenceを再指定してください。");
        }
      } else {
        const referenceMode = generationReferenceMode();
        if (referenceMode !== "none") setGenerationStatus("参考画像を登録中…");
        const referenceImageId = await uploadGenerationReference();
        payload = generationPayload(referenceImageId);
      }
      state.generation.lastRequest = payload;
      const response = await fetch("/api/generation/jobs", {
        method: "POST",
        headers: generationMutationHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "生成を開始できません。");
      if (!data.job_id) throw new Error("Generation Backendのjob_idがありません。");
      const tracking = activateGenerationTracking(data.job_id);
      setGenerationStatus(`${data.state || "queued"} / job_id=${tracking.jobId}`);
      stopGenerationPolling();
      await pollGenerationJob(tracking.jobId, tracking.sequence);
    } catch (error) {
      state.generation.submitting = false;
      $("#generation-submit").disabled = false;
      updateGenerationAuthUi();
      setGenerationStatus(error.message || String(error), true);
    }
  }

  function stopBulkGenerationPolling() {
    if (state.generation.bulk.pollTimer) {
      clearTimeout(state.generation.bulk.pollTimer);
      state.generation.bulk.pollTimer = null;
    }
  }

  function renderBulkResults(data, bulkId) {
    const container = $("#generation-bulk-results");
    if (!container) return;
    const selected = Array.isArray(data?.output?.selected_images) ? data.output.selected_images : [];
    const allCount = Number(data?.completed_count || 0);
    const failed = Number(data?.failed_count || 0);
    const selectionLabel = data?.selection_mode === "none"
      ? "AI選別なし（全画像を保持）"
      : data?.selection_state === "completed"
        ? `AI選別済み / ${selected.length}枚`
        : data?.selection_state === "failed"
          ? `AI選別失敗（生成画像は保持）${data.selection_error ? `: ${data.selection_error}` : ""}`
          : "AI選別未実行";
    container.replaceChildren();
    const summary = document.createElement("p");
    summary.textContent = `${allCount}枚生成 / 失敗${failed} / ${selectionLabel}`;
    container.append(summary);
    if (selected.length) {
      const heading = document.createElement("strong");
      heading.textContent = "選別結果（選別された画像のみ）";
      container.append(heading);
      const list = document.createElement("ul");
      for (const item of selected) {
        const row = document.createElement("li");
        row.textContent = item?.filename || "画像";
        list.append(row);
      }
      container.append(list);
      const selectedButton = document.createElement("button");
      selectedButton.className = "button secondary";
      selectedButton.type = "button";
      selectedButton.textContent = "選別結果だけを見る";
      selectedButton.addEventListener("click", () => {
        state.generation.bulk.selectedFilenames = selected.map((item) => String(item?.filename || "")).filter(Boolean);
        state.generation.bulk.selectedVariationIndexes = selected
          .map((item) => Number(item?.variation_index))
          .filter((value) => Number.isInteger(value) && value > 0);
        state.generation.bulk.selectedGlobalIndexes = [];
        state.generation.bulk.selectedJobId = "";
        state.generation.bulk.selectedOnly = true;
        setView("gallery");
        render();
        setMessage("選別結果だけを表示しています。『全画像に戻る』で解除できます。");
      });
      container.append(selectedButton);
    }
    const link = document.createElement("a");
    link.className = "button secondary";
    link.href = generationResultUrl(bulkId);
    link.textContent = "全画像を見る";
    link.addEventListener("click", () => { state.generation.bulk.selectedOnly = false; });
    container.append(link);
    container.hidden = false;
  }

  async function pollBulkGeneration(bulkId, sequence) {
    if (state.generation.bulk.bulkId !== bulkId || state.generation.bulk.sequence !== sequence) return;
    try {
      const response = await fetch(`/api/generation/bulk-jobs/${encodeURIComponent(bulkId)}`, { cache: "no-store" });
      const data = await response.json();
      if (state.generation.bulk.bulkId !== bulkId || state.generation.bulk.sequence !== sequence) return;
      if (!response.ok || data.ok === false) throw new Error(data.error || "大量生成状態を取得できません。");
      const total = Number(data.requested_total || data.total_count || 0);
      const completed = Number(data.completed_count || 0);
      const failed = Number(data.failed_count || 0);
      const current = Number(data.current_index || completed + failed);
      const stage = data.state === "selecting" ? " / AI選別中…" : data.stop_requested ? " / 停止要求済み" : "";
      const stateLabel = { queued: "Queued", resolving: "Resolving", generating: "Generating", selecting: "Selecting", stopped: "Stopped", completed: "Completed", failed: "Failed" }[data.state] || data.state || "Unknown";
      $("#generation-bulk-status").textContent = `${stateLabel} ${completed} / ${total}${failed ? ` / Failed ${failed}` : ""}（処理 ${current} / ${total}）${stage}`;
      state.generation.bulk.lastOutput = data;
      if (["completed", "failed", "stopped"].includes(data.state)) {
        stopBulkGenerationPolling();
        state.generation.bulk.submitting = false;
        state.generation.bulk.stopping = false;
        $("#generation-bulk-start").disabled = false;
        $("#generation-bulk-stop").disabled = true;
        updateGenerationAuthUi();
        renderBulkResults(data, bulkId);
        state.generation.bulk.selectedFilenames = selectedFilenamesFromBulk(data);
        state.generation.bulk.selectedVariationIndexes = selectedVariationIndexesFromBulk(data);
        state.generation.bulk.selectedGlobalIndexes = [];
        state.generation.bulk.selectedJobId = "";
        state.generation.bulk.selectedOnly = false;
        $("#job-filter").value = bulkId;
        setMessage(data.state === "completed" ? "大量生成が完了しました。全画像をGalleryへ同期しています。" : `大量生成は${stateLabel}になりました。`);
        await load({ page: 1 });
        return;
      }
      state.generation.bulk.pollTimer = setTimeout(() => pollBulkGeneration(bulkId, sequence), 1500);
    } catch (error) {
      if (state.generation.bulk.bulkId !== bulkId || state.generation.bulk.sequence !== sequence) return;
      stopBulkGenerationPolling();
      state.generation.bulk.submitting = false;
      state.generation.bulk.stopping = false;
      $("#generation-bulk-start").disabled = false;
      $("#generation-bulk-stop").disabled = true;
      updateGenerationAuthUi();
      $("#generation-bulk-status").textContent = error.message || String(error);
      setMessage(error.message || String(error), true);
    }
  }

  function selectedFilenamesFromBulk(data) {
    return (Array.isArray(data?.output?.selected_images) ? data.output.selected_images : [])
      .map((item) => String(item?.filename || ""))
      .filter(Boolean);
  }

  function selectedVariationIndexesFromBulk(data) {
    return (Array.isArray(data?.output?.selected_images) ? data.output.selected_images : [])
      .map((item) => Number(item?.variation_index))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  async function startBulkGeneration() {
    if (state.generation.bulk.submitting || state.generation.submitting) return;
    if (state.generation.auth.required && !state.generation.auth.authenticated) {
      setGenerationStatus("リモート生成キーで認証してください。", true);
      return;
    }
    const total = Number($("#generation-bulk-count")?.value || 16);
    const selectionMode = $("#generation-bulk-selection")?.value || "none";
    state.generation.bulk.sequence += 1;
    const sequence = state.generation.bulk.sequence;
    stopBulkGenerationPolling();
    state.generation.bulk.submitting = true;
    state.generation.bulk.stopping = false;
    $("#generation-bulk-start").disabled = true;
    $("#generation-bulk-stop").disabled = false;
    updateGenerationAuthUi();
    $("#generation-bulk-results").hidden = true;
    saveGenerationSettings();
    $("#generation-bulk-status").textContent = "送信中…";
    try {
      const referenceMode = generationReferenceMode();
      if (referenceMode !== "none") $("#generation-bulk-status").textContent = "参考画像を登録中…";
      const referenceImageId = await uploadGenerationReference();
      const request = JSON.parse(JSON.stringify(generationPayload(referenceImageId)));
      request.total_count = total;
      request.selection_mode = selectionMode;
      state.generation.bulk.lastRequest = JSON.parse(JSON.stringify(request));
      const response = await fetch("/api/generation/bulk-jobs", {
        method: "POST",
        headers: generationMutationHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(request),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "大量生成を開始できません。");
      if (!data.bulk_id) throw new Error("大量生成のbulk_idがありません。");
      state.generation.bulk.bulkId = data.bulk_id;
      await pollBulkGeneration(data.bulk_id, sequence);
    } catch (error) {
      state.generation.bulk.submitting = false;
      state.generation.bulk.stopping = false;
      $("#generation-bulk-start").disabled = false;
      $("#generation-bulk-stop").disabled = true;
      updateGenerationAuthUi();
      $("#generation-bulk-status").textContent = error.message || String(error);
      setMessage(error.message || String(error), true);
    }
  }

  async function stopBulkGeneration() {
    const bulkId = state.generation.bulk.bulkId;
    if (!bulkId || !state.generation.bulk.submitting || state.generation.bulk.stopping) return;
    state.generation.bulk.stopping = true;
    $("#generation-bulk-stop").disabled = true;
    $("#generation-bulk-status").textContent = "停止要求を送信中…";
    try {
      const response = await fetch(`/api/generation/bulk-jobs/${encodeURIComponent(bulkId)}/stop`, {
        method: "POST",
        headers: generationMutationHeaders({ "Content-Type": "application/json" }),
        body: "{}",
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "大量生成を停止できません。");
      $("#generation-bulk-status").textContent = "停止要求済み。現在の1枚が終わるまで待機します…";
    } catch (error) {
      state.generation.bulk.stopping = false;
      $("#generation-bulk-stop").disabled = false;
      setMessage(error.message || String(error), true);
    }
  }

  function stopOvernightGenerationPolling() {
    if (state.generation.overnight.pollTimer) {
      clearTimeout(state.generation.overnight.pollTimer);
      state.generation.overnight.pollTimer = null;
    }
  }

  function overnightStorage() {
    try { return window.localStorage; } catch (_error) { return null; }
  }

  function overnightSelectionEntries(data) {
    const roundEntries = [];
    for (const round of Array.isArray(data?.rounds) ? data.rounds : []) {
      for (const item of Array.isArray(round?.selected) ? round.selected : []) {
        const globalIndex = Number(item?.global_index);
        if (!Number.isInteger(globalIndex) || globalIndex <= 0) continue;
        roundEntries.push({ ...item, round_index: Number(round.round_index || 0), global_index: globalIndex });
      }
    }
    const finalEntries = (Array.isArray(data?.final_selected) ? data.final_selected : [])
      .map((item) => ({ ...item, global_index: Number(item?.global_index) }))
      .filter((item) => Number.isInteger(item.global_index) && item.global_index > 0);
    const uniqueByGlobalIndex = (items) => [...new Map(items.map((item) => [item.global_index, item])).values()];
    return {
      roundEntries: uniqueByGlobalIndex(roundEntries),
      finalEntries: uniqueByGlobalIndex(finalEntries),
    };
  }

  function overnightSelectionViewEntries(data, view) {
    const entries = overnightSelectionEntries(data);
    if (view === "final") return entries.finalEntries;
    if (view === "round") return entries.roundEntries;
    return [];
  }

  function setOvernightSelectionMetadata(data, overnightId) {
    const bulk = state.generation.bulk;
    const allEntries = overnightSelectionEntries(data);
    bulk.overnightSelectionJobId = String(overnightId || data?.overnight_job_id || "");
    bulk.overnightRoundGlobalIndexes = allEntries.roundEntries.map((item) => item.global_index);
    bulk.overnightFinalGlobalIndexes = allEntries.finalEntries.map((item) => item.global_index);
    bulk.overnightFinalRanks = Object.fromEntries(
      allEntries.finalEntries
        .filter((item) => Number.isInteger(Number(item?.rank)) && Number(item.rank) > 0)
        .map((item) => [String(item.global_index), Number(item.rank)]),
    );
    return allEntries;
  }

  function overnightSelectionBadge(image) {
    const jobId = String(state.generation.bulk.overnightSelectionJobId || state.generation.bulk.selectedJobId || "");
    if (!jobId) return null;
    const sidecar = image?.metadata?.source_metadata?.sidecar || {};
    const imageJobId = String(image?.job_id || sidecar.overnight_job_id || "");
    if (imageJobId !== jobId) return null;
    const globalIndex = Number(sidecar.global_index);
    if (!Number.isInteger(globalIndex) || globalIndex <= 0) return null;
    const finalIndexes = new Set(state.generation.bulk.overnightFinalGlobalIndexes);
    const roundIndexes = new Set(state.generation.bulk.overnightRoundGlobalIndexes);
    if (finalIndexes.has(globalIndex)) {
      const rank = state.generation.bulk.overnightFinalRanks[String(globalIndex)];
      const badge = document.createElement("span");
      badge.className = "badge overnight-selection-badge final-selection-badge";
      badge.textContent = Number.isInteger(rank) && rank > 0 ? `Final #${rank}` : "Final Best4";
      badge.title = "Final Best4";
      badge.setAttribute("aria-label", badge.textContent);
      badge.dataset.globalIndex = String(globalIndex);
      return badge;
    }
    if (roundIndexes.has(globalIndex)) {
      const badge = document.createElement("span");
      badge.className = "badge overnight-selection-badge round-selection-badge";
      badge.textContent = "Round Best4";
      badge.title = "Round Best4";
      badge.setAttribute("aria-label", badge.textContent);
      badge.dataset.globalIndex = String(globalIndex);
      return badge;
    }
    return null;
  }

  async function showOvernightSelectionView(overnightId, data, view) {
    const entries = overnightSelectionViewEntries(data, view);
    const allEntries = setOvernightSelectionMetadata(data, overnightId);
    state.generation.bulk.overnightSelectionView = view;
    state.generation.bulk.selectedFilenames = entries.map((item) => String(item?.filename || "")).filter(Boolean);
    state.generation.bulk.selectedVariationIndexes = [];
    state.generation.bulk.selectedGlobalIndexes = entries.map((item) => item.global_index);
    state.generation.bulk.selectedJobId = overnightId;
    state.generation.bulk.selectedOnly = view !== "all";
    $("#job-filter").value = overnightId;
    setView("gallery");
    setMessage(view === "final" ? "Final Best4を読み込んでいます…" : view === "round" ? "Round Best4を読み込んでいます…" : "全画像を読み込んでいます…");
    await loadOvernightSelectionImages(overnightId);
    const label = view === "final" ? "Final Best4" : view === "round" ? "Round Best4" : "全画像";
    setMessage(`${label}を表示しています。`);
  }

  function renderOvernightResults(data, overnightId) {
    const container = $("#generation-overnight-results");
    if (!container) return;
    const entries = setOvernightSelectionMetadata(data, overnightId);
    const finalSelected = entries.finalEntries;
    const roundSelected = entries.roundEntries;
    const rounds = Array.isArray(data?.rounds) ? data.rounds : [];
    const currentView = state.generation.bulk.overnightSelectionView || "all";
    container.replaceChildren();
    const summary = document.createElement("div");
    summary.className = "overnight-selection-summary";
    const generated = document.createElement("span");
    generated.textContent = `生成: ${Number(data?.generated_count || 0).toLocaleString()} / ${Number(data?.total_requested || 0).toLocaleString()}`;
    const roundCount = document.createElement("span");
    roundCount.textContent = `Round選抜: ${roundSelected.length.toLocaleString()}`;
    const finalCount = document.createElement("span");
    finalCount.textContent = finalSelected.length
      ? `最終選抜: ${finalSelected.length.toLocaleString()}`
      : "最終選抜: 選別待ち";
    summary.append(generated, roundCount, finalCount);
    container.append(summary);

    const finalAction = document.createElement("button");
    finalAction.className = "button primary overnight-final-primary-action";
    finalAction.type = "button";
    finalAction.textContent = finalSelected.length ? `最終Best4を見る（${finalSelected.length}）` : "最終Best4: 選別待ち";
    finalAction.disabled = !finalSelected.length;
    finalAction.addEventListener("click", async () => {
      if (!finalSelected.length) return;
      try {
        await showOvernightSelectionView(overnightId, data, "final");
      } catch (error) {
        setMessage(error.message || String(error), true);
        render();
      }
    });
    container.append(finalAction);

    const viewControls = document.createElement("div");
    viewControls.className = "overnight-selection-controls";
    viewControls.setAttribute("aria-label", "夜間生成の表示切替");
    const views = [
      ["all", `全画像 ${Number(data?.generated_count || data?.total_requested || 0).toLocaleString()}`, "secondary"],
      ["round", `Round Best4 ${roundSelected.length.toLocaleString()}`, "secondary"],
      ["final", finalSelected.length ? `★ Final Best4 ${finalSelected.length.toLocaleString()}` : "★ Final Best4 選別待ち", "primary"],
    ];
    for (const [view, label, style] of views) {
      const button = document.createElement("button");
      button.className = `button ${style} overnight-selection-view-button${currentView === view ? " active" : ""}`;
      button.type = "button";
      button.textContent = label;
      button.dataset.selectionView = view;
      button.setAttribute("aria-pressed", currentView === view ? "true" : "false");
      button.disabled = view !== "all" && !overnightSelectionViewEntries(data, view).length;
      button.addEventListener("click", async () => {
        try {
          await showOvernightSelectionView(overnightId, data, view);
        } catch (error) {
          setMessage(error.message || String(error), true);
          render();
        }
      });
      viewControls.append(button);
    }
    container.append(viewControls);
    if (rounds.length) {
      const roundInfo = document.createElement("span");
      roundInfo.textContent = `完了ラウンド ${rounds.filter((round) => round?.generation_finished_at).length} / ${Number(data?.total_rounds || 0)}`;
      container.append(roundInfo);
    }
    const preview = document.createElement("div");
    preview.className = "overnight-final-preview";
    container.append(preview);
    renderOvernightFinalPreview(preview, data, overnightId);
    container.hidden = false;
  }

  async function fetchOvernightImages(overnightId, { refresh = false } = {}) {
    const bulk = state.generation.bulk;
    if (!refresh && bulk.overnightPreviewJobId === String(overnightId || "") && bulk.overnightPreviewImages.length) {
      return { images: bulk.overnightPreviewImages, total: bulk.overnightPreviewImages.length };
    }
    const images = [];
    let page = 1;
    let totalPages = 1;
    let total = 0;
    do {
      const params = new URLSearchParams({
        job_id: String(overnightId || ""),
        page: String(page),
        page_size: "100",
        sort: "recent",
      });
      const response = await fetch(`/api/images?${params}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "選別結果を読み込めません。");
      images.push(...(Array.isArray(data.images) ? data.images : []));
      total = Number(data.total || total || images.length);
      totalPages = Math.max(1, Number(data.total_pages || 1));
      page += 1;
    } while (page <= totalPages && page <= 50);
    bulk.overnightPreviewJobId = String(overnightId || "");
    bulk.overnightPreviewImages = images;
    return { images, total };
  }

  async function renderOvernightFinalPreview(target, data, overnightId) {
    if (!target) return;
    const finalEntries = overnightSelectionEntries(data).finalEntries
      .slice()
      .sort((left, right) => (Number(left.rank) || 999) - (Number(right.rank) || 999));
    target.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = finalEntries.length ? "最終Best4" : "最終Best4: 選別待ち";
    target.append(heading);
    if (!finalEntries.length) return;
    const loading = document.createElement("span");
    loading.className = "job-selection-preview-status";
    loading.textContent = "Final Best4を読み込んでいます…";
    target.append(loading);
    try {
      const { images } = await fetchOvernightImages(overnightId);
      if (!target.isConnected) return;
      target.replaceChildren(heading);
      const imageByGlobalIndex = new Map(images.map((image) => [Number(image?.metadata?.source_metadata?.sidecar?.global_index), image]));
      const finalImages = finalEntries.map((entry) => imageByGlobalIndex.get(Number(entry.global_index))).filter(Boolean);
      const grid = document.createElement("div");
      grid.className = "job-selection-preview-grid";
      for (const entry of finalEntries) {
        const globalIndex = Number(entry.global_index);
        const image = imageByGlobalIndex.get(globalIndex);
        const rank = Number(entry.rank);
        const button = document.createElement("button");
        button.className = "job-selection-preview-item";
        button.type = "button";
        button.disabled = !image;
        button.setAttribute("aria-label", Number.isInteger(rank) && rank > 0 ? `Final #${rank}を開く` : "Final Best4を開く");
        if (image) {
          const imageElement = document.createElement("img");
          imageElement.src = image.thumbnail_url || image.url;
          imageElement.alt = Number.isInteger(rank) && rank > 0 ? `Final #${rank}` : "Final Best4";
          imageElement.loading = "lazy";
          button.append(imageElement);
          button.addEventListener("click", () => openDetail(image, finalImages));
        }
        const label = document.createElement("span");
        label.textContent = Number.isInteger(rank) && rank > 0 ? `#${rank}` : "Final";
        button.append(label);
        grid.append(button);
      }
      target.append(grid);
    } catch (_error) {
      if (!target.isConnected) return;
      target.replaceChildren(heading);
      const status = document.createElement("span");
      status.className = "job-selection-preview-status";
      status.textContent = "Final Best4 previewを再接続後に再表示します。";
      target.append(status);
    }
  }

  async function loadOvernightSelectionImages(overnightId) {
    const { images, total } = await fetchOvernightImages(overnightId, { refresh: true });
    state.images = images;
    state.page = 1;
    state.pageSize = 100;
    state.total = total;
    // Selected-only mode is a local view over the fetched job set. Keep
    // pagination controls from replacing the four-image detail sequence.
    state.totalPages = 1;
    render();
    loadJobSummary(String(overnightId || ""));
  }

  function updateOvernightButtons(data = state.generation.overnight.lastOutput || {}) {
    const stateValue = String(data?.state || "");
    const active = ["queued", "running", "selecting", "stopping"].includes(stateValue);
    const start = $("#generation-overnight-start");
    const pause = $("#generation-overnight-pause");
    const resume = $("#generation-overnight-resume");
    const stop = $("#generation-overnight-stop");
    if (start) start.disabled = active || Boolean(state.generation.overnight.submitting) || Boolean(state.generation.submitting);
    if (pause) pause.disabled = !active || stateValue === "stopping" || Boolean(state.generation.overnight.pausing);
    if (resume) resume.disabled = !["paused", "paused_error"].includes(stateValue) || Boolean(state.generation.overnight.resuming);
    if (stop) stop.disabled = !active || Boolean(state.generation.overnight.stopping);
  }

  async function pollOvernightGeneration(overnightId, sequence) {
    if (state.generation.overnight.jobId !== overnightId || state.generation.overnight.sequence !== sequence) return;
    try {
      const response = await fetch(`/api/generation/overnight-jobs/${encodeURIComponent(overnightId)}`, { cache: "no-store" });
      const data = await response.json();
      if (state.generation.overnight.jobId !== overnightId || state.generation.overnight.sequence !== sequence) return;
      if (!response.ok || data.ok === false) throw new Error(data.error || "夜間生成状態を取得できません。");
      state.generation.overnight.lastOutput = data;
      state.generation.overnight.reconnecting = false;
      state.generation.overnight.lastSuccessfulPollAt = Date.now();
      const total = Number(data.total_requested || 0);
      const generated = Number(data.generated_count || 0);
      const failed = Number(data.failed_count || 0);
      const current = Number(data.current_slot || 1);
      const round = Number(data.current_round || 1);
      const stateLabel = { queued: "Queued", running: "Generating", selecting: "AI選別中", paused: "Paused", paused_error: "Paused (error)", stopping: "Stopping", stopped: "Stopped", completed: "Completed", completed_selection_failed: "Completed (selection failed)", failed: "Failed" }[data.state] || data.state || "Unknown";
      const suffix = data.state === "selecting" ? "" : ` / Round ${round} / slot ${Math.min(current, 32)} / ${total}`;
      const shutdownStatus = data.shutdown?.status === "scheduled"
        ? " / PCシャットダウン予約済み（60秒後）"
        : data.shutdown?.status === "blocked"
          ? " / PCシャットダウン未予約"
          : "";
      const statusElement = $("#generation-overnight-status");
      statusElement.classList.remove("stale");
      statusElement.textContent = `${stateLabel} ${generated} / ${total}${failed ? ` / Failed ${failed}` : ""}${suffix}${shutdownStatus}`;
      updateOvernightButtons(data);
      if (["completed", "completed_selection_failed", "failed", "stopped"].includes(data.state)) {
        stopOvernightGenerationPolling();
        state.generation.overnight.submitting = false;
        renderOvernightResults(data, overnightId);
        const storage = overnightStorage();
        try { storage?.setItem("gallery.generation.overnight_job_id", overnightId); } catch (_error) { /* best effort */ }
        setMessage(data.state === "completed" ? "夜間生成が完了しました。" : `夜間生成は${stateLabel}になりました。`, data.state === "failed");
        updateOvernightButtons(data);
        await load({ page: 1 });
        return;
      }
      state.generation.overnight.pollTimer = setTimeout(() => pollOvernightGeneration(overnightId, sequence), 2000);
    } catch (error) {
      if (state.generation.overnight.jobId !== overnightId || state.generation.overnight.sequence !== sequence) return;
      state.generation.overnight.reconnecting = true;
      const last = state.generation.overnight.lastOutput || {};
      const stateLabel = { queued: "Queued", running: "Generating", selecting: "AI選別中", paused: "Paused", paused_error: "Paused (error)", stopping: "Stopping" }[last.state] || "状態保持中";
      const generated = Number(last.generated_count || 0);
      const total = Number(last.total_requested || 0);
      const updatedAt = state.generation.overnight.lastSuccessfulPollAt
        ? new Date(state.generation.overnight.lastSuccessfulPollAt).toLocaleTimeString("ja-JP")
        : "未取得";
      const statusElement = $("#generation-overnight-status");
      statusElement.classList.add("stale");
      statusElement.textContent = `${stateLabel} ${generated} / ${total} / 接続が一時的に切れました。再接続しています… / 最終更新: ${updatedAt}`;
      updateOvernightButtons(last);
      state.generation.overnight.pollTimer = setTimeout(() => pollOvernightGeneration(overnightId, sequence), 3000);
    }
  }

  async function startOvernightGeneration() {
    if (state.generation.overnight.submitting || state.generation.submitting || state.generation.bulk.submitting) return;
    if (state.generation.auth.required && !state.generation.auth.authenticated) {
      setGenerationStatus("リモート生成キーで認証してください。", true);
      return;
    }
    state.generation.overnight.sequence += 1;
    const sequence = state.generation.overnight.sequence;
    state.generation.overnight.submitting = true;
    state.generation.overnight.lastOutput = null;
    stopOvernightGenerationPolling();
    updateOvernightButtons({ state: "queued" });
    $("#generation-overnight-status").textContent = "送信中…";
    saveGenerationSettings();
    try {
      const referenceMode = generationReferenceMode();
      if (referenceMode !== "none") $("#generation-overnight-status").textContent = "参考画像を登録中…";
      const referenceImageId = await uploadGenerationReference();
      const payload = JSON.parse(JSON.stringify(generationPayload(referenceImageId)));
      payload.total_count = Number($("#generation-overnight-count")?.value || 256);
      payload.shutdown_after_completion = $("#generation-overnight-completion-action")?.value === "shutdown";
      const response = await fetch("/api/generation/overnight-jobs", {
        method: "POST",
        headers: generationMutationHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "夜間生成を開始できません。");
      if (!data.overnight_job_id) throw new Error("夜間生成job_idがありません。");
      // This choice is serialized into one job only, then reset for the next job.
      const completionAction = $("#generation-overnight-completion-action");
      if (completionAction) completionAction.value = "none";
      state.generation.overnight.jobId = data.overnight_job_id;
      try { overnightStorage()?.setItem("gallery.generation.overnight_job_id", data.overnight_job_id); } catch (_error) { /* best effort */ }
      await pollOvernightGeneration(data.overnight_job_id, sequence);
    } catch (error) {
      state.generation.overnight.submitting = false;
      $("#generation-overnight-status").textContent = error.message || String(error);
      setMessage(error.message || String(error), true);
      updateOvernightButtons({ state: "" });
    }
  }

  async function sendOvernightAction(action) {
    const overnightId = state.generation.overnight.jobId;
    if (!overnightId) return;
    const flag = action === "pause" ? "pausing" : action === "resume" ? "resuming" : "stopping";
    state.generation.overnight[flag] = true;
    updateOvernightButtons(state.generation.overnight.lastOutput || {});
    try {
      const response = await fetch(`/api/generation/overnight-jobs/${encodeURIComponent(overnightId)}/${action}`, {
        method: "POST",
        headers: generationMutationHeaders({ "Content-Type": "application/json" }),
        body: "{}",
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || `夜間生成を${action}できません。`);
      state.generation.overnight.lastOutput = data;
      $("#generation-overnight-status").textContent = action === "pause" ? "一時停止を要求しました。現在の画像後に停止します。" : action === "stop" ? "停止を要求しました。現在の画像後に終了します。" : "再開しました。";
      updateOvernightButtons(data);
      if (action === "resume") await pollOvernightGeneration(overnightId, state.generation.overnight.sequence);
    } catch (error) {
      setMessage(error.message || String(error), true);
    } finally {
      state.generation.overnight[flag] = false;
      updateOvernightButtons(state.generation.overnight.lastOutput || {});
    }
  }

  function restoreOvernightJobState() {
    let overnightId = "";
    try { overnightId = overnightStorage()?.getItem("gallery.generation.overnight_job_id") || ""; } catch (_error) { overnightId = ""; }
    if (!overnightId) return;
    state.generation.overnight.jobId = overnightId;
    state.generation.overnight.sequence += 1;
    const panel = $("#generation-overnight-panel");
    if (panel) panel.open = true;
    pollOvernightGeneration(overnightId, state.generation.overnight.sequence);
  }

  function submitSameSettingsFourMore() {
    if (state.generation.submitting || !state.generation.lastCompletedRequest) return;
    if (typeof GenerationContinuation === "undefined") return;
    const request = GenerationContinuation.buildAdditionalGenerationRequest(
      state.generation.lastCompletedRequest,
    );
    if (!request) return;
    setMessage("直前の設定で追加4枚を送信します。seedだけ新しくします。");
    submitGeneration(request);
  }

  function filters() {
    const params = new URLSearchParams();
    const values = {
      status: $("#status-filter").value,
      character: $("#character-filter").value,
      dataset: $("#dataset-filter").value,
      job_id: $("#job-filter").value,
      q: $("#query-filter").value,
      from: $("#date-from").value,
      to: $("#date-to").value,
      sort: $("#sort-filter").value,
      exclude_similar: $("#exclude-similar").checked ? "1" : "",
      lora_candidate: $("#lora-filter").checked ? "1" : "",
      dispersion_dimension: state.dispersionFilter.dimension,
      dispersion_value: state.dispersionFilter.value,
    };
    for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
    return params;
  }

  function selectionParams(extra = {}) {
    const params = filters();
    for (const [key, value] of Object.entries(extra)) {
      if (value != null && value !== "") params.set(key, String(value));
    }
    return params;
  }

  async function fetchSelection(extra = {}) {
    const response = await fetch(`/api/images/ids?${selectionParams(extra)}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "選択対象を取得できません。");
    return data;
  }

  function addSelectedIds(ids, items = []) {
    for (const item of items || []) {
      if (item && item.id) state.selectionMeta.set(String(item.id), {
        status: item.status || "unreviewed",
        lora_candidate: Boolean(item.lora_candidate),
      });
    }
    for (const id of ids || []) state.selected.add(String(id));
    if (ids?.length) state.lastSelectedId = String(ids[ids.length - 1]);
    render();
  }

  function escapeText(value) { return value == null || value === "" ? "-" : String(value); }

  function formatLoras(value) {
    if (!Array.isArray(value)) return escapeText(value);
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return String(item);
      const name = item.name || item.lora_name || item.lora || "LoRA";
      const strength = item.strength_model ?? item.strength ?? item.weight;
      return strength == null ? name : `${name} (${strength})`;
    }).join(", ") || "-";
  }

  function currentStatus(image) { return state.pending.get(image.id) || image.status; }
  function currentLoraCandidate(image) {
    return state.pendingLora.has(image.id) ? state.pendingLora.get(image.id) : Boolean(image.lora_candidate);
  }

  function formatAi(image) {
    if (!image.ai) return "AI未評価";
    const ai = image.ai;
    const score = (value) => value == null ? "-" : `${(Number(value) * 100).toFixed(1)}%`;
    const candidate = { adopt_candidate: "採用候補", hold_candidate: "保留候補", reject_candidate: "没候補" }[ai.candidate] || ai.candidate || "-";
    return `${candidate} / 総合 ${score(ai.final_score)} / 品質 ${score(ai.quality_score)} / キャラ ${score(ai.character_score)} / 類似ペナルティ ${score(ai.duplicate_penalty)} / 好み ${score(ai.preference_score)}`;
  }

  function updateAiStatus(job) {
    state.aiJob = job || null;
    const element = $("#ai-status");
    if (!job || !job.status || job.status === "idle") {
      element.textContent = "AI評価未実行";
      return;
    }
    const progress = job.total ? ` (${job.processed || 0}/${job.total})` : "";
    if (job.status === "running" || job.status === "starting") element.textContent = `AI評価中: ${job.stage || "準備中"}${progress}`;
    else if (job.status === "completed") element.textContent = `AI評価完了: ${job.total || 0}枚`;
    else if (job.status === "failed") element.textContent = `AI評価失敗: ${job.error || "詳細不明"}`;
    else element.textContent = job.stage || job.status;
  }

  async function loadAiStatus() {
    try {
      const response = await fetch("/api/ai/status", { cache: "no-store" });
      const data = await response.json();
      if (response.ok && data.ok) {
        updateAiStatus(data.job);
        if (data.job && (data.job.status === "running" || data.job.status === "starting")) {
          if (!aiPollTimer) aiPollTimer = setInterval(loadAiStatus, 2000);
        } else if (aiPollTimer) {
          clearInterval(aiPollTimer);
          aiPollTimer = null;
          if (data.job.status === "completed") load({ page: state.page });
        }
      }
    } catch (error) {
      updateAiStatus({ status: "failed", error: error.message || String(error) });
    }
  }

  function renderJobSelectionSummary(data, overnightId) {
    const section = $("#job-selection-summary");
    if (!section) return;
    section.hidden = true;
    const preview = $("#job-selection-preview");
    if (preview) {
      preview.replaceChildren();
      preview.hidden = true;
    }
    const finalButton = $("#job-selection-final-button");
    if (finalButton) {
      finalButton.hidden = true;
      finalButton.disabled = true;
    }
    const controls = $("#job-selection-controls");
    if (controls) controls.replaceChildren();
    if (!data || !(data.overnight_job_id || Array.isArray(data.rounds) || data.total_rounds != null)) return;
    const entries = setOvernightSelectionMetadata(data, overnightId);
    const generated = Number(data.generated_count || 0).toLocaleString();
    const total = Number(data.total_requested || 0).toLocaleString();
    const roundCount = $("#job-selection-round");
    const finalCount = $("#job-selection-final");
    const generatedCount = $("#job-selection-generated");
    const status = $("#job-selection-status");
    if (generatedCount) generatedCount.textContent = `${generated} / ${total}`;
    if (roundCount) roundCount.textContent = entries.roundEntries.length.toLocaleString();
    if (finalCount) finalCount.textContent = entries.finalEntries.length
      ? entries.finalEntries.length.toLocaleString()
      : "選別待ち";
    if (status) {
      status.textContent = entries.finalEntries.length
        ? "Final Best4が選別済みです。"
        : "Final Best4: 選別待ち";
      status.className = entries.finalEntries.length ? "job-selection-status ready" : "job-selection-status pending";
    }
    if (controls) {
      const currentView = state.generation.bulk.overnightSelectionView || "all";
      const views = [
        ["all", `全画像 ${Number(data.generated_count || data.total_requested || 0).toLocaleString()}`, "secondary"],
        ["round", `Round Best4 ${entries.roundEntries.length.toLocaleString()}`, "secondary"],
        ["final", entries.finalEntries.length ? `★ Final Best4 ${entries.finalEntries.length.toLocaleString()}` : "★ Final Best4 選別待ち", "primary"],
      ];
      for (const [view, label, style] of views) {
        const button = document.createElement("button");
        button.className = `button ${style} overnight-selection-view-button${currentView === view ? " active" : ""}`;
        button.type = "button";
        button.textContent = label;
        button.dataset.selectionView = view;
        button.setAttribute("aria-pressed", currentView === view ? "true" : "false");
        button.disabled = view !== "all" && !overnightSelectionViewEntries(data, view).length;
        button.addEventListener("click", async () => {
          try {
            await showOvernightSelectionView(String(overnightId), data, view);
          } catch (error) {
            setMessage(error.message || String(error), true);
          }
        });
        controls.append(button);
      }
      controls.hidden = false;
    }
    if (finalButton && entries.finalEntries.length) {
      finalButton.hidden = false;
      finalButton.disabled = false;
      finalButton.textContent = `最終Best4を見る（${entries.finalEntries.length}）`;
      finalButton.onclick = async () => {
        try {
          await showOvernightSelectionView(String(overnightId), data, "final");
        } catch (error) {
          setMessage(error.message || String(error), true);
        }
      };
    }
    section.hidden = false;
    if (preview) {
      preview.hidden = !entries.finalEntries.length;
      renderOvernightFinalPreview(preview, data, String(overnightId));
    }
  }

  async function loadJobSummary(jobId = $("#job-filter").value.trim(), generationGuard = null) {
    const section = $("#job-summary");
    if (!jobId) {
      section.hidden = true;
      return;
    }
    if (generationGuard && !isCurrentGeneration(generationGuard.jobId, generationGuard.sequence)) return;
    try {
      const response = await fetch(`/api/images/summary?job_id=${encodeURIComponent(jobId)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "job集計を読み込めません。");
      if ($("#job-filter").value.trim() !== jobId) return;
      if (generationGuard && !isCurrentGeneration(generationGuard.jobId, generationGuard.sequence)) return;
      const summary = data.summary || {};
      $("#job-summary-title").textContent = `今回の生成（${jobId}）`;
      $("#job-summary-total").textContent = Number(summary.total || 0).toLocaleString();
      $("#job-summary-batches").textContent = Number(summary.batch_count || 0).toLocaleString();
      $("#job-summary-scored").textContent = Number(summary.ai_scored || 0).toLocaleString();
      $("#job-summary-adopt").textContent = Number(summary.adopt_candidate || 0).toLocaleString();
      $("#job-summary-hold").textContent = Number(summary.hold_candidate || 0).toLocaleString();
      $("#job-summary-reject").textContent = Number(summary.reject_candidate || 0).toLocaleString();
      let overnightData = null;
      try {
        const overnightResponse = await fetch(`/api/generation/overnight-jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        if (overnightResponse.ok) {
          const overnightValue = await overnightResponse.json();
          if (overnightValue && overnightValue.ok !== false) overnightData = overnightValue;
        }
      } catch (_error) {
        overnightData = null;
      }
      if ($("#job-filter").value.trim() !== jobId) return;
      renderJobSelectionSummary(overnightData, jobId);
      render();
      section.hidden = false;
    } catch (_error) {
      section.hidden = true;
    }
  }

  const statusLabels = { adopted: "採用", hold: "保留", rejected: "没", unreviewed: "未選別", "": "すべて" };

  function renderDispersionFilter() {
    const active = state.dispersionFilter.dimension && state.dispersionFilter.value;
    const container = $("#dispersion-active");
    container.hidden = !active;
    if (active) {
      $("#dispersion-active-text").textContent = `分類フィルタ: ${state.dispersionFilter.label || state.dispersionFilter.value}`;
    }
  }

  function renderDispersion(summary) {
    const value = summary || { total: 0, dimensions: {}, warnings: [] };
    const scope = value.scope || {};
    const scopeParts = [
      `対象: ${statusLabels[scope.status] || scope.status || "すべて"}`,
      `${Number(scope.total || 0).toLocaleString()}枚`,
    ];
    if (scope.dataset) scopeParts.push(`dataset=${scope.dataset}`);
    if (scope.character) scopeParts.push(`character=${scope.character}`);
    if (scope.job_id) scopeParts.push(`job_id=${scope.job_id}`);
    $("#dispersion-scope").textContent = `${scopeParts.join(" / ")}。prompt / caption / metadataから判定し、不明なものはunknownのままです。`;

    const warnings = $("#dispersion-warnings");
    warnings.replaceChildren();
    for (const warning of value.warnings || []) {
      const item = document.createElement("div");
      item.className = "dispersion-warning";
      item.textContent = `${warning.label}: ${warning.message}`;
      warnings.appendChild(item);
    }
    if (!(value.warnings || []).length) {
      const item = document.createElement("div");
      item.className = "dispersion-ok";
      item.textContent = "大きな不足警告はありません。分類できない画像は各項目のunknownで確認できます。";
      warnings.appendChild(item);
    }

    const grid = $("#dispersion-grid");
    grid.replaceChildren();
    const dimensions = value.dimensions || {};
    for (const [dimension, data] of Object.entries(dimensions)) {
      const block = document.createElement("section");
      block.className = "dispersion-block";
      const title = document.createElement("h3");
      title.textContent = data.label || dimension;
      block.appendChild(title);
      const classified = document.createElement("p");
      const classifiedCount = Number(data.known_count || 0);
      const classifiedTotal = Number(data.total || 0);
      const classifiedRatio = classifiedTotal ? ((classifiedCount / classifiedTotal) * 100).toFixed(1) : "0.0";
      classified.className = "dispersion-classified";
      classified.textContent = `classified: ${classifiedCount.toLocaleString()} / ${classifiedTotal.toLocaleString()} (${classifiedRatio}%)`;
      block.appendChild(classified);
      const sourceCounts = data.source_counts || {};
      const provenance = document.createElement("p");
      provenance.className = "dispersion-provenance";
      provenance.textContent = `分類元: 明示 ${Number(sourceCounts.explicit || 0).toLocaleString()} / 推測 ${Number(sourceCounts.inferred || 0).toLocaleString()} / unknown ${Number(sourceCounts.unknown || 0).toLocaleString()}`;
      block.appendChild(provenance);
      const list = document.createElement("div");
      list.className = "dispersion-categories";
      for (const category of data.categories || []) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "dispersion-category";
        button.disabled = Number(category.count || 0) === 0;
        button.title = button.disabled ? "該当画像はありません" : "この分類の画像だけを一覧表示";
        const count = Number(category.count || 0);
        const ratio = (Number(category.ratio || 0) * 100).toFixed(1);
        button.innerHTML = `<span>${category.label || category.value}</span><strong>${count.toLocaleString()} / ${Number(data.total || 0).toLocaleString()}</strong><em>${ratio}%</em>`;
        button.addEventListener("click", () => {
          state.dispersionFilter = {
            dimension,
            value: category.value,
            label: `${data.label || dimension}: ${category.label || category.value}`,
          };
          renderDispersionFilter();
          load({ page: 1 });
        });
        list.appendChild(button);
      }
      block.appendChild(list);
      grid.appendChild(block);
    }
    if (!Object.keys(dimensions).length) {
      const empty = document.createElement("p");
      empty.className = "dispersion-empty";
      empty.textContent = "対象画像がありません。";
      grid.appendChild(empty);
    }
  }

  async function loadDispersion(generationGuard = null) {
    if (generationGuard && !isCurrentGeneration(generationGuard.jobId, generationGuard.sequence)) return;
    try {
      const params = filters();
      params.delete("dispersion_dimension");
      params.delete("dispersion_value");
      params.delete("status");
      params.set("status", $("#dispersion-status").value);
      const response = await fetch(`/api/dispersion?${params}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "分散情報を読み込めません。");
      if (generationGuard && !isCurrentGeneration(generationGuard.jobId, generationGuard.sequence)) return;
      renderDispersion(data.summary);
    } catch (error) {
      if (generationGuard && !isCurrentGeneration(generationGuard.jobId, generationGuard.sequence)) return;
      renderDispersion({ total: 0, dimensions: {}, warnings: [] });
      const item = document.createElement("div");
      item.className = "dispersion-warning";
      item.textContent = error.message || String(error);
      $("#dispersion-warnings").replaceChildren(item);
    }
  }

  function renderRecent() {
    const gallery = $("#recent-gallery");
    const empty = $("#recent-empty");
    const count = $("#recent-count");
    if (!gallery || !empty || !count) return;
    gallery.replaceChildren();
    const jobId = $("#job-filter")?.value.trim() || "";
    count.textContent = jobId
      ? `${state.recentImages.length}件 / job_id絞り込み中`
      : `最新${state.recentImages.length}件 / 全${state.recentTotal.toLocaleString()}件`;
    empty.hidden = state.recentImages.length !== 0;
    for (const image of state.recentImages) {
      const card = document.createElement("article");
      card.className = "card recent-card";
      const imageElement = document.createElement("img");
      imageElement.className = "card-image";
      imageElement.src = image.thumbnail_url || image.url;
      imageElement.alt = image.filename;
      imageElement.loading = "lazy";
      imageElement.addEventListener("error", () => {
        if (imageElement.src !== new URL(image.url, window.location.href).href) imageElement.src = image.url;
      }, { once: true });
      card.append(imageElement);

      const overlay = document.createElement("div");
      overlay.className = "card-overlay";
      const detail = document.createElement("button");
      detail.className = "detail-icon card-detail-button";
      detail.type = "button";
      detail.textContent = "詳細";
      detail.title = "詳細を開く";
      detail.setAttribute("aria-label", `${image.filename}の詳細を開く`);
      detail.addEventListener("click", (event) => { event.stopPropagation(); openDetail(image, state.recentImages); });
      overlay.append(detail);
      card.append(overlay);

      const info = document.createElement("div");
      info.className = "card-info";
      const name = document.createElement("div");
      name.className = "card-name";
      name.textContent = image.filename;
      const meta = document.createElement("div");
      meta.className = "card-meta";
      const character = document.createElement("span");
      character.textContent = image.character_name || image.dataset_name || "-";
      character.title = character.textContent;
      const date = document.createElement("span");
      date.textContent = (image.generated_at || "").slice(0, 10) || "-";
      meta.append(character, date);
      const comparisonButton = document.createElement("button");
      comparisonButton.type = "button";
      comparisonButton.className = "button secondary card-compare-button";
      comparisonButton.textContent = state.comparison.has(image.id) ? "比較から外す" : "比較に追加";
      comparisonButton.setAttribute("aria-label", `${image.filename}を${state.comparison.has(image.id) ? "比較から外す" : "比較に追加"}`);
      comparisonButton.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleComparison(image);
      });
      info.append(name, meta, comparisonButton);
      card.append(info);
      gallery.append(card);
    }
  }

  function render() {
    const gallery = $("#gallery");
    gallery.replaceChildren();
    const selectedOnly = Boolean(
      state.generation.bulk.selectedOnly
      && (
        state.generation.bulk.selectedFilenames.length
        || state.generation.bulk.selectedVariationIndexes.length
        || state.generation.bulk.selectedGlobalIndexes.length
      ),
    );
    const selectedVariationIndexes = new Set(state.generation.bulk.selectedVariationIndexes);
    const selectedGlobalIndexes = new Set(state.generation.bulk.selectedGlobalIndexes);
    const visibleImages = selectedOnly
      ? state.images.filter((image) => {
        const sidecar = image?.metadata?.source_metadata?.sidecar || {};
        const selectedJobId = String(state.generation.bulk.selectedJobId || "");
        const imageJobId = String(image?.job_id || sidecar?.overnight_job_id || "");
        const jobMatches = !selectedJobId || imageJobId === selectedJobId || String(sidecar?.overnight_job_id || "") === selectedJobId;
        const globalIndex = Number(sidecar?.global_index);
        if (jobMatches && Number.isInteger(globalIndex) && selectedGlobalIndexes.has(globalIndex)) return true;
        if (selectedJobId) return false;
        if (jobMatches && state.generation.bulk.selectedFilenames.includes(String(image.filename || ""))) return true;
        const variationIndex = Number(image?.metadata?.source_metadata?.sidecar?.variation_index);
        return jobMatches && Number.isInteger(variationIndex) && selectedVariationIndexes.has(variationIndex);
      })
      : state.images;
    const firstItem = state.total ? ((state.page - 1) * state.pageSize) + 1 : 0;
    const lastItem = state.total ? Math.min(state.total, firstItem + visibleImages.length - 1) : 0;
    const rangeText = selectedOnly
      ? `選別結果 ${visibleImages.length}件を表示（全${state.total.toLocaleString()}件中）`
      : `全${state.total.toLocaleString()}件中 ${firstItem.toLocaleString()}〜${lastItem.toLocaleString()}件を表示`;
    renderDispersionFilter();
    updateJobFilterUi();
    renderRecent();
    $("#result-count").textContent = rangeText;
    $("#empty").hidden = visibleImages.length !== 0;
    for (const element of document.querySelectorAll("[data-page-range]")) element.textContent = rangeText;
    for (const element of document.querySelectorAll("[data-page-info]")) {
      element.textContent = `ページ ${state.page} / ${state.totalPages}`;
    }
    for (const button of document.querySelectorAll('[data-page-change="-1"]')) button.disabled = selectedOnly || state.page <= 1;
    for (const button of document.querySelectorAll('[data-page-change="1"]')) button.disabled = selectedOnly || state.page >= state.totalPages;
    for (const image of visibleImages) {
      const card = document.createElement("article");
      card.className = "card" + (state.selected.has(image.id) ? " selected" : "");
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-pressed", state.selected.has(image.id) ? "true" : "false");
      let clickTimer = null;
      card.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        if (event.detail > 1) return;
        clickTimer = setTimeout(() => toggleSelection(image.id, event), 220);
      });
      card.addEventListener("dblclick", (event) => {
        if (event.target.closest("button")) return;
        if (clickTimer) clearTimeout(clickTimer);
        if (selectedOnly) openDetail(image, visibleImages);
        else openDetail(image, state.images);
      });
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleSelection(image.id);
        }
      });

      const imageElement = document.createElement("img");
      imageElement.className = "card-image";
      imageElement.src = image.thumbnail_url || image.url;
      imageElement.alt = image.filename;
      imageElement.loading = "lazy";
      imageElement.addEventListener("error", () => {
        if (imageElement.src !== new URL(image.url, window.location.href).href) {
          imageElement.src = image.url;
        }
      }, { once: true });
      card.append(imageElement);

      const overlay = document.createElement("div");
      overlay.className = "card-overlay";
      const overlayLeft = document.createElement("div");
      overlayLeft.className = "card-overlay-left";
      const mark = document.createElement("span");
      mark.className = "selection-mark";
      mark.textContent = state.selected.has(image.id) ? "✓" : "";
      const badge = document.createElement("span");
      const status = currentStatus(image);
      badge.className = `badge ${status}`;
      badge.textContent = labels[status] || status;
      if (state.pending.has(image.id)) badge.textContent += "（未確定）";
      overlayLeft.append(mark, badge);
      const overnightBadge = overnightSelectionBadge(image);
      if (overnightBadge) {
        overlayLeft.append(overnightBadge);
        card.classList.add(overnightBadge.classList.contains("final-selection-badge") ? "overnight-final-card" : "overnight-round-card");
      }
      if (currentLoraCandidate(image)) {
        const loraBadge = document.createElement("span");
        loraBadge.className = "badge lora_candidate";
        loraBadge.textContent = state.pendingLora.has(image.id) ? "LoRA候補（未確定）" : "LoRA候補";
        overlayLeft.append(loraBadge);
      }
      if (image.ai) {
        const aiBadge = document.createElement("span");
        aiBadge.className = "ai-badge";
        aiBadge.textContent = ({ adopt_candidate: "AI採用候補", hold_candidate: "AI保留候補", reject_candidate: "AI没候補" }[image.ai.candidate] || "AI評価済み");
        aiBadge.title = formatAi(image);
        overlayLeft.append(aiBadge);
      }
      const detail = document.createElement("button");
      detail.className = "detail-icon card-detail-button";
      detail.type = "button";
      detail.textContent = "詳細";
      detail.title = "詳細を開く";
      detail.setAttribute("aria-label", `${image.filename}の詳細を開く`);
      detail.addEventListener("click", (event) => {
        event.stopPropagation();
        if (selectedOnly) openDetail(image, visibleImages);
        else openDetail(image, state.images);
      });
      overlay.append(overlayLeft, detail);
      card.append(overlay);

      const info = document.createElement("div");
      info.className = "card-info";
      const name = document.createElement("div");
      name.className = "card-name";
      name.textContent = image.filename;
      const meta = document.createElement("div");
      meta.className = "card-meta";
      const character = document.createElement("span");
      character.textContent = image.character_name || image.dataset_name || "-";
      character.title = character.textContent;
      const date = document.createElement("span");
      date.textContent = (image.generated_at || "").slice(0, 10) || "-";
      const aiScore = document.createElement("span");
      aiScore.className = "ai-score";
      aiScore.textContent = image.ai?.final_score == null ? "AI -" : `AI ${(Number(image.ai.final_score) * 100).toFixed(0)}`;
      meta.append(character, date, aiScore);
      const comparisonButton = document.createElement("button");
      comparisonButton.type = "button";
      comparisonButton.className = "button secondary card-compare-button";
      comparisonButton.textContent = state.comparison.has(image.id) ? "比較から外す" : "比較に追加";
      comparisonButton.setAttribute("aria-label", `${image.filename}を${state.comparison.has(image.id) ? "比較から外す" : "比較に追加"}`);
      comparisonButton.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleComparison(image);
      });
      info.append(name, meta, comparisonButton);
      card.append(info);
      gallery.append(card);
    }
    renderComparisonPanel();
    updateCounters();
  }

  async function toggleSelection(id, event = {}) {
    const currentIndex = state.images.findIndex((image) => image.id === id);
    const anchorIndex = state.images.findIndex((image) => image.id === state.lastSelectedId);
    if (event.shiftKey && state.lastSelectedId && state.lastSelectedId !== id) {
      if (currentIndex >= 0 && anchorIndex >= 0) {
        const start = Math.min(currentIndex, anchorIndex);
        const end = Math.max(currentIndex, anchorIndex);
        for (let index = start; index <= end; index += 1) {
          const rangeImage = state.images[index];
          state.selected.add(rangeImage.id);
          state.selectionMeta.set(rangeImage.id, { status: rangeImage.status, lora_candidate: Boolean(rangeImage.lora_candidate) });
        }
        state.lastSelectedId = id;
        render();
        return;
      }
      setMessage("ページをまたぐ範囲を取得中…");
      try {
        const data = await fetchSelection({ range_start: state.lastSelectedId, range_end: id });
        addSelectedIds(data.ids, data.items);
        setMessage(`${data.total}枚を範囲選択しました。確定前なら取り消せます。`);
      } catch (error) {
        setMessage(error.message || String(error), true);
      }
      return;
    }
    if (state.selected.has(id)) {
      state.selected.delete(id);
      state.selectionMeta.delete(id);
    } else {
      state.selected.add(id);
      const image = state.images.find((item) => item.id === id);
      if (image) state.selectionMeta.set(id, { status: image.status, lora_candidate: Boolean(image.lora_candidate) });
    }
    state.lastSelectedId = id;
    render();
  }

  function selectCurrentPage() {
    for (const image of state.images) {
      state.selected.add(image.id);
      state.selectionMeta.set(image.id, { status: image.status, lora_candidate: Boolean(image.lora_candidate) });
    }
    state.lastSelectedId = state.images.at(-1)?.id || state.lastSelectedId;
    render();
    setMessage(`このページの${state.images.length}枚を選択しました。`);
  }

  function clearCurrentPageSelection() {
    for (const image of state.images) {
      state.selected.delete(image.id);
      state.selectionMeta.delete(image.id);
    }
    if (state.lastSelectedId && !state.selected.has(state.lastSelectedId)) state.lastSelectedId = null;
    render();
    setMessage(`このページの選択を解除しました。`);
  }

  async function selectAllResults() {
    setMessage("検索結果の選択対象を取得中…");
    try {
      const data = await fetchSelection();
      if (data.total > 100 && !window.confirm(`検索結果${data.total.toLocaleString()}件をすべて選択します。続けますか？`)) {
        setMessage("検索結果の全選択を取り消しました。");
        return;
      }
      addSelectedIds(data.ids, data.items);
      setMessage(`${data.total.toLocaleString()}件の検索結果を選択しました。確定前なら取り消せます。`);
    } catch (error) {
      setMessage(error.message || String(error), true);
    }
  }

  async function clearAllResultsSelection() {
    setMessage("検索結果の選択対象を取得中…");
    try {
      const data = await fetchSelection();
      for (const id of data.ids || []) {
        state.selected.delete(String(id));
        state.selectionMeta.delete(String(id));
      }
      render();
      setMessage(`${data.total.toLocaleString()}件の検索結果から選択を解除しました。仮指定は「指定を取り消す」で戻せます。`);
    } catch (error) {
      setMessage(error.message || String(error), true);
    }
  }

  function setRangeAnchor(image) {
    state.rangeAnchorId = image.id;
    render();
    setMessage(`範囲の始点を「${image.filename}」に設定しました。別ページの画像でも「この画像まで選択」できます。`);
  }

  async function selectRangeTo(image) {
    if (!state.rangeAnchorId) {
      setRangeAnchor(image);
      return;
    }
    setMessage("指定範囲を取得中…");
    try {
      const data = await fetchSelection({ range_start: state.rangeAnchorId, range_end: image.id });
      addSelectedIds(data.ids, data.items);
      setMessage(`${data.total.toLocaleString()}枚を範囲選択しました。確定前なら取り消せます。`);
    } catch (error) {
      setMessage(error.message || String(error), true);
    }
  }

  async function selectDetailMatch(mode) {
    if (!state.detailImageId) return;
    const button = mode === "prompt" ? $("#detail-select-prompt") : $("#detail-select-group");
    button.disabled = true;
    try {
      const data = await fetchSelection({ match: mode, image_id: state.detailImageId });
      if (data.total > 100 && !window.confirm(`${data.label}の${data.total.toLocaleString()}件をすべて選択します。続けますか？`)) {
        setMessage("一括選択を取り消しました。");
        return;
      }
      addSelectedIds(data.ids, data.items);
      setMessage(`${data.label}の${data.total.toLocaleString()}件を選択しました。確定前なら取り消せます。`);
    } catch (error) {
      setMessage(error.message || String(error), true);
    } finally {
      button.disabled = false;
    }
  }

  async function loadDetailMatchInfo(image) {
    state.detailImageId = image.id;
    $("#detail-match-info").textContent = "同じprompt / 生成グループの件数を確認中…";
    $("#detail-select-prompt").disabled = true;
    $("#detail-select-group").disabled = true;
    try {
      const [promptResponse, groupResponse] = await Promise.all([
        fetch(`/api/images/ids?match=prompt&image_id=${encodeURIComponent(image.id)}`, { cache: "no-store" }),
        fetch(`/api/images/ids?match=group&image_id=${encodeURIComponent(image.id)}`, { cache: "no-store" }),
      ]);
      const [prompt, group] = await Promise.all([promptResponse.json(), groupResponse.json()]);
      if (state.detailImageId !== image.id) return;
      const promptText = prompt.ok ? `同じprompt ${Number(prompt.total).toLocaleString()}件` : "同じprompt 利用不可";
      const groupText = group.ok ? `${group.label || "同じ生成グループ"} ${Number(group.total).toLocaleString()}件` : "生成グループ 利用不可";
      $("#detail-match-info").textContent = `${promptText} / ${groupText}`;
      if (prompt.ok) {
        $("#detail-select-prompt").disabled = false;
        $("#detail-select-prompt").textContent = `同じpromptをすべて選択（${Number(prompt.total).toLocaleString()}件）`;
      }
      if (group.ok) {
        $("#detail-select-group").disabled = false;
        $("#detail-select-group").textContent = `同じ生成グループをすべて選択（${Number(group.total).toLocaleString()}件）`;
      }
    } catch (error) {
      if (state.detailImageId === image.id) $("#detail-match-info").textContent = `件数確認失敗: ${error.message || String(error)}`;
    }
  }

  function updateCounters() {
    $("#selection-count").textContent = `選択中 ${state.selected.size}枚`;
    $("#pending-count").textContent = state.pending.size ? `未確定 ${state.pending.size}件` : "";
    $("#commit").disabled = state.pending.size === 0 && state.pendingLora.size === 0;
    $("#select-page").textContent = `このページの${state.images.length}枚をすべて選択`;
    $("#select-page").disabled = state.images.length === 0;
    $("#clear-page-selection").disabled = state.images.length === 0;
    $("#select-results").textContent = `検索結果${state.total.toLocaleString()}件をすべて選択`;
    $("#select-results").disabled = state.total === 0;
    $("#clear-results-selection").textContent = `検索結果${state.total.toLocaleString()}件の選択を解除`;
    $("#clear-results-selection").disabled = state.total === 0;
    const anchorImage = state.images.find((image) => image.id === state.rangeAnchorId);
    $("#range-anchor").textContent = state.rangeAnchorId
      ? `範囲の始点: ${anchorImage?.filename || state.rangeAnchorId.slice(0, 10)}`
      : "範囲の始点: 未設定";
    for (const button of document.querySelectorAll("[data-set-status]")) button.disabled = state.selected.size === 0;
    for (const button of document.querySelectorAll("[data-set-lora]")) button.disabled = state.selected.size === 0;
  }

  function updateJobFilterUi() {
    const button = $("#clear-job-filter");
    if (button) button.hidden = !$("#job-filter")?.value.trim();
  }

  function setSelectedStatus(status) {
    for (const id of state.selected) {
      state.pending.set(id, status);
      if (status !== "adopted") state.pendingLora.set(id, false);
      const meta = state.selectionMeta.get(id);
      if (meta) meta.status = status;
    }
    render();
    setMessage(`${state.selected.size}枚に「${labels[status]}」を仮指定しました。確定前なら取り消せます。`);
  }

  function setSelectedLoraCandidate(enabled) {
    if (!state.selected.size) return;
    if (enabled) {
      const invalid = [...state.selected].filter((id) => {
        const status = state.pending.get(id) || state.selectionMeta.get(id)?.status;
        return status !== "adopted";
      });
      if (invalid.length) {
        setMessage(`LoRA候補にできるのは採用画像だけです。未採用の${invalid.length}枚を先に採用へ仮指定してください。`, true);
        return;
      }
    }
    for (const id of state.selected) state.pendingLora.set(id, enabled);
    render();
    setMessage(`${state.selected.size}枚のLoRA候補フラグを${enabled ? "付与" : "解除"}しました。確定前なら取り消せます。`);
  }

  async function load(options = {}) {
    const requestedPage = options.page || state.page;
    const generationGuard = options.generationGuard || null;
    const requestToken = ++loadToken;
    setMessage("読み込み中…");
    try {
      const params = filters();
      params.set("page", requestedPage);
      params.set("page_size", state.pageSize);
      const response = await fetch(`/api/images?${params}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "画像一覧を読み込めません。");
      if (requestToken !== loadToken) return;
      if (generationGuard && !isCurrentGeneration(generationGuard.jobId, generationGuard.sequence)) return;
      state.images = data.images || [];
      state.page = data.page || requestedPage;
      state.pageSize = data.page_size || state.pageSize;
      state.total = data.total || 0;
      state.totalPages = data.total_pages || 1;
      $("#root-label").textContent = data.images_root || "";
      setMessage("");
      render();
      loadJobSummary(params.get("job_id") || "", generationGuard);
      loadDispersion(generationGuard);
      if (requestedPage === 1 && (params.get("sort") || "recent") === "recent") {
        state.recentImages = state.images.slice(0, 12);
        state.recentTotal = state.total;
        renderRecent();
      } else if (requestedPage === 1 || !state.recentImages.length) {
        loadRecent(generationGuard);
      }
    } catch (error) {
      setMessage(error.message || String(error), true);
    }
  }

  async function loadRecent(generationGuard = null) {
    const requestToken = ++recentLoadToken;
    try {
      const params = filters();
      params.set("page", "1");
      params.set("page_size", "12");
      params.set("sort", "recent");
      const response = await fetch(`/api/images?${params}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "最近の画像を読み込めません。");
      if (requestToken !== recentLoadToken) return;
      if (generationGuard && !isCurrentGeneration(generationGuard.jobId, generationGuard.sequence)) return;
      state.recentImages = data.images || [];
      state.recentTotal = data.total || 0;
      renderRecent();
    } catch (_error) {
      if (requestToken !== recentLoadToken) return;
      state.recentImages = [];
      state.recentTotal = 0;
      renderRecent();
      const count = $("#recent-count");
      if (count) count.textContent = "読み込み失敗";
    }
  }

  function setDetail(id, value) { $(id).textContent = escapeText(value); }

  const provenanceSourceLabels = {
    user_explicit: "明示指定",
    user_request: "明示リクエスト",
    character_preset: "キャラクター設定",
    character_confirmed: "キャラクター確認済み",
    appearance_resolver: "見た目の解決",
    reference_lock: "Reference固定",
    variation_auto: "Variation Auto",
    prompt_designer: "Prompt Designer",
    request_resolver: "Prompt Designer",
    inference: "推測",
    system: "既定値",
    finalizer_default: "既定値",
    quality_default: "品質補完",
    lora_trigger: "LoRA trigger",
  };

  function provenanceSourceLabel(source) {
    return provenanceSourceLabels[String(source || "").trim()] || String(source || "自動処理");
  }

  function renderProvenanceGroup(container, title, entries, formatter) {
    if (!Array.isArray(entries) || !entries.length) return;
    const heading = document.createElement("strong");
    heading.textContent = title;
    container.appendChild(heading);
    const list = document.createElement("ul");
    list.className = "detail-provenance-list";
    for (const entry of entries.slice(0, 64)) {
      const item = document.createElement("li");
      item.textContent = formatter(entry);
      list.appendChild(item);
    }
    container.appendChild(list);
  }

  function renderDetailProvenance(provenance) {
    const panel = $("#detail-prompt-provenance");
    const body = $("#detail-prompt-provenance-body");
    if (!panel || !body) return;
    body.replaceChildren();
    const data = provenance && typeof provenance === "object" ? provenance : {};
    const finalTags = Array.isArray(data.tag_provenance) ? data.tag_provenance : [];
    const suppressed = Array.isArray(data.suppressed_tags) ? data.suppressed_tags : [];
    const conflicts = Array.isArray(data.prompt_conflicts) ? data.prompt_conflicts : [];
    const explicit = finalTags.filter((entry) => ["user_explicit", "user_request"].includes(entry?.source));
    const automatic = finalTags.filter((entry) => !["user_explicit", "user_request"].includes(entry?.source));
    renderProvenanceGroup(body, "明示指定", explicit, (entry) => `${entry.tag} — ${provenanceSourceLabel(entry.source)}`);
    renderProvenanceGroup(body, "自動補完", automatic, (entry) => `${entry.tag} — ${provenanceSourceLabel(entry.source)}`);
    renderProvenanceGroup(body, "抑制されたタグ", suppressed, (entry) => {
      const reason = entry.reason ? ` → ${entry.reason}` : "";
      return `${entry.tag} — ${provenanceSourceLabel(entry.source)}${reason}`;
    });
    renderProvenanceGroup(body, "明示指定同士の警告", conflicts, (entry) => {
      const tags = Array.isArray(entry.tags) ? entry.tags.join(" / ") : "";
      return `${entry.category || "制約"}: ${tags}`;
    });
    panel.hidden = !body.childElementCount;
  }

  async function loadDetailProvenance(imageId) {
    const panel = $("#detail-prompt-provenance");
    if (!panel || !imageId) return;
    const token = ++state.detailProvenanceToken;
    panel.hidden = true;
    try {
      const response = await fetch(`/api/images/${encodeURIComponent(imageId)}/generation-settings`, { cache: "no-store" });
      const data = await response.json();
      if (token !== state.detailProvenanceToken || String(state.detailImageId) !== String(imageId)) return;
      renderDetailProvenance(data.settings?.prompt_provenance || null);
    } catch (_error) {
      if (token === state.detailProvenanceToken) renderDetailProvenance(null);
    }
  }

  function detailSequenceFor(image, preferredSequence = null) {
    const preferred = Array.isArray(preferredSequence) ? preferredSequence : [];
    if (preferred.some((item) => item && String(item.id) === String(image.id))) return preferred.slice();
    if (state.images.some((item) => String(item.id) === String(image.id))) return state.images.slice();
    if (state.recentImages.some((item) => String(item.id) === String(image.id))) return state.recentImages.slice();
    return [image];
  }

  function detailNavigation(sequence, imageId) {
    if (typeof DetailViewer !== "undefined" && DetailViewer.navigation) {
      return DetailViewer.navigation(sequence, imageId);
    }
    const items = Array.isArray(sequence) ? sequence : [];
    const index = items.findIndex((item) => item && String(item.id) === String(imageId));
    return {
      index,
      total: items.length,
      previous: index > 0 ? items[index - 1] : null,
      next: index >= 0 && index < items.length - 1 ? items[index + 1] : null,
    };
  }

  function updateDetailNavigation() {
    const navigation = detailNavigation(state.detailSequence, state.detailImageId);
    const previous = $("#detail-previous");
    const next = $("#detail-next");
    const position = $("#detail-position");
    if (!previous || !next || !position) return;
    previous.disabled = !navigation.previous;
    next.disabled = !navigation.next;
    position.textContent = navigation.index >= 0
      ? `${navigation.index + 1} / ${navigation.total}`
      : "";
  }

  function navigateDetail(direction) {
    const navigation = detailNavigation(state.detailSequence, state.detailImageId);
    const target = direction < 0 ? navigation.previous : navigation.next;
    if (target) openDetail(target, state.detailSequence);
  }

  function openDetail(image, preferredSequence = null) {
    state.detailSequence = detailSequenceFor(image, preferredSequence);
    state.detailImageId = image.id;
    state.detailImage = image;
    const metadata = image.metadata || {};
    $("#detail-title").textContent = image.filename;
    const detailSelectionBadge = $("#detail-selection-badge");
    if (detailSelectionBadge) {
      detailSelectionBadge.replaceChildren();
      const selectionBadge = overnightSelectionBadge(image);
      detailSelectionBadge.hidden = !selectionBadge;
      if (selectionBadge) detailSelectionBadge.append(selectionBadge);
    }
    $("#detail-image").src = image.url;
    $("#detail-image").alt = image.filename;
    setDetail("#detail-status", `${labels[currentStatus(image)] || currentStatus(image)}${state.pending.has(image.id) ? "（未確定）" : ""}`);
    setDetail("#detail-lora-candidate", currentLoraCandidate(image) ? (state.pendingLora.has(image.id) ? "付与（未確定）" : "付与") : "なし");
    setDetail("#detail-file", `${image.relative_path} (${image.width || "?"}×${image.height || "?"})`);
    setDetail("#detail-character", image.character_name || image.dataset_name);
    setDetail("#detail-generated", metadata.generated_at || image.generated_at || image.modified_at);
    setDetail("#detail-batch", image.batch_id || metadata.batch_id);
    setDetail("#detail-job", image.job_id || metadata.job_id);
    setDetail("#detail-original", metadata.original_image);
    setDetail("#detail-seed", metadata.seed);
    setDetail("#detail-model", metadata.checkpoint || metadata.model);
    setDetail("#detail-loras", formatLoras(metadata.loras));
    setDetail("#detail-lora-strength", metadata.lora_strength);
    setDetail("#detail-ai", formatAi(image));
    setDetail("#detail-prompt", metadata.prompt);
    setDetail("#detail-negative", metadata.negative_prompt);
    setDetail("#detail-caption", metadata.caption);
    clearDetailActualSeed();
    updateDetailNavigation();
    updateDetailComparisonUi();
    const dialog = $("#detail-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    loadDetailMatchInfo(image);
    loadDetailActualSeed(image.id);
    loadDetailProvenance(image.id);
  }

  async function commit() {
    if (!state.pending.size && !state.pendingLora.size) return;
    $("#commit").disabled = true;
    setMessage("確定中…");
    try {
      const updateIds = new Set([...state.pending.keys(), ...state.pendingLora.keys()]);
      const updates = [...updateIds].map((id) => ({
        id,
        status: state.pending.get(id)
          || state.selectionMeta.get(id)?.status
          || state.images.find((image) => image.id === id)?.status
          || "unreviewed",
        ...(state.pendingLora.has(id) ? { lora_candidate: state.pendingLora.get(id) } : {}),
      }));
      const response = await fetch("/api/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "確定に失敗しました。");
      state.pending.clear();
      state.pendingLora.clear();
      state.selected.clear();
      state.selectionMeta.clear();
      setMessage(`${data.updated.length}枚のレビュー結果を確定しました。`);
      await load();
    } catch (error) {
      setMessage(error.message || String(error), true);
      updateCounters();
    }
  }

  function clearFilters() {
    $("#status-filter").value = "";
    $("#character-filter").value = "";
    $("#dataset-filter").value = "";
    $("#job-filter").value = "";
    $("#query-filter").value = "";
    $("#date-from").value = "";
    $("#date-to").value = "";
    $("#sort-filter").value = "recent";
    $("#exclude-similar").checked = false;
    $("#lora-filter").checked = false;
    state.dispersionFilter = { dimension: "", value: "", label: "" };
    load({ page: 1 });
  }

  document.addEventListener("DOMContentLoaded", () => {
    for (const button of document.querySelectorAll("[data-view-target]")) {
      button.addEventListener("click", () => setView(button.dataset.viewTarget, { focus: button.dataset.viewTarget === "generate" }));
    }
    $("#refresh").addEventListener("click", () => load({ page: state.page }));
    $("#generation-submit").addEventListener("click", () => submitGeneration());
    $("#generation-bulk-start").addEventListener("click", startBulkGeneration);
    $("#generation-bulk-stop").addEventListener("click", stopBulkGeneration);
    $("#generation-overnight-start").addEventListener("click", startOvernightGeneration);
    $("#generation-overnight-pause").addEventListener("click", () => sendOvernightAction("pause"));
    $("#generation-overnight-resume").addEventListener("click", () => sendOvernightAction("resume"));
    $("#generation-overnight-stop").addEventListener("click", () => sendOvernightAction("stop"));
    $("#generation-auth-submit").addEventListener("click", unlockGeneration);
    $("#generation-auth-logout").addEventListener("click", logoutGeneration);
    $("#generation-count").addEventListener("change", updateGenerationVariationState);
    $("#generation-reference-mode").addEventListener("change", updateGenerationReferenceState);
    $("#generation-reference-file").addEventListener("change", handleGenerationReferenceFileChange);
    $("#generation-reference-clear").addEventListener("click", clearGenerationReferenceSelection);
    $("#generation-copy-job-id").addEventListener("click", copyGenerationJobId);
    $("#generation-more-four").addEventListener("click", submitSameSettingsFourMore);
    $("#generation-tag-search-toggle").addEventListener("click", toggleGenerationTagSearch);
    $("#generation-tag-search-submit").addEventListener("click", searchGenerationTags);
    $("#generation-tag-search-category").addEventListener("change", () => {
      state.generation.tagSearch = { ...state.generation.tagSearch, category: $("#generation-tag-search-category").value, results: [], warning: "" };
      renderTagSearch();
    });
    $("#generation-tag-search-add").addEventListener("click", addSelectedGenerationTags);
    $("#generation-tag-search-copy").addEventListener("click", copySelectedGenerationTags);
    $("#generation-tag-search-clear").addEventListener("click", clearGenerationTagSelection);
    $("#generation-explicit-tags-clear").addEventListener("click", clearExplicitTags);
    $("#generation-tag-search-query").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        searchGenerationTags();
      }
    });
    $("#comparison-open").addEventListener("click", openComparison);
    $("#comparison-clear").addEventListener("click", clearComparison);
    $("#comparison-diff-toggle").addEventListener("click", toggleComparisonDiff);
    $("#close-comparison").addEventListener("click", () => $("#comparison-dialog").close());
    for (const input of document.querySelectorAll("#generation-panel input:not([type='file']), #generation-panel select, #generation-panel textarea")) {
      input.addEventListener("input", renderGenerationRequestSummary);
      input.addEventListener("change", renderGenerationRequestSummary);
      input.addEventListener("change", updateGenerationAuthUi);
    }
    $("#generation-explicit-tags").addEventListener("input", renderExplicitTagChips);
    $("#generation-explicit-tags").addEventListener("change", renderExplicitTagChips);
    for (const selector of generationSettingSelectors) {
      const input = $(selector);
      if (!input) continue;
      input.addEventListener("input", scheduleGenerationSettingsSave);
      input.addEventListener("change", scheduleGenerationSettingsSave);
    }
    $("#generation-reset").addEventListener("click", resetGenerationForm);
    updateGenerationReferenceState();
    updateGenerationVariationState();
    renderExplicitTagChips();
    renderTagSearch();
    loadGenerationAuthStatus().finally(() => restoreOvernightJobState());
    for (const type of ["character", "style", "additional"]) {
      $(`#generation-${type}-lora`).addEventListener("change", () => {
        updateGenerationLoraDefault(type);
        updateGenerationAuthUi();
        renderGenerationRestoreStatus(state.generation.restoreWarnings);
      });
    }
    for (const button of document.querySelectorAll("[data-page-change]")) {
      button.addEventListener("click", () => {
        const direction = Number(button.dataset.pageChange);
        const nextPage = state.page + direction;
        if (nextPage >= 1 && nextPage <= state.totalPages) load({ page: nextPage });
      });
    }
    $("#commit").addEventListener("click", commit);
    $("#select-page").addEventListener("click", selectCurrentPage);
    $("#clear-page-selection").addEventListener("click", clearCurrentPageSelection);
    $("#select-results").addEventListener("click", selectAllResults);
    $("#clear-results-selection").addEventListener("click", clearAllResultsSelection);
    $("#clear-pending").addEventListener("click", () => {
      state.pending.clear();
      state.pendingLora.clear();
      render();
      setMessage("未確定の指定を取り消しました。");
    });
    $("#clear-filters").addEventListener("click", clearFilters);
    $("#clear-job-filter").addEventListener("click", () => {
      $("#job-filter").value = "";
      state.generation.bulk.selectedOnly = false;
      state.generation.bulk.selectedFilenames = [];
      state.generation.bulk.selectedVariationIndexes = [];
      state.generation.bulk.selectedGlobalIndexes = [];
      state.generation.bulk.selectedJobId = "";
      setMessage("全画像を表示しています。");
      load({ page: 1 });
    });
    $("#dispersion-refresh").addEventListener("click", loadDispersion);
    $("#dispersion-status").addEventListener("change", loadDispersion);
    $("#dispersion-clear").addEventListener("click", () => {
      state.dispersionFilter = { dimension: "", value: "", label: "" };
      renderDispersionFilter();
      load({ page: 1 });
    });
    $("#ai-review").addEventListener("click", async () => {
      const button = $("#ai-review");
      button.disabled = true;
      setMessage("AI評価を開始しています…");
      try {
        const response = await fetch("/api/ai/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference_name: $("#ai-reference").value.trim() }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "AI評価を開始できません。");
        updateAiStatus(data.job);
        setMessage("AI評価を開始しました。既存の手動状態は変更されません。");
        loadAiStatus();
      } catch (error) {
        setMessage(error.message || String(error), true);
      } finally {
        button.disabled = false;
      }
    });
    $("#register-reference").addEventListener("click", async () => {
      const name = $("#reference-name").value.trim();
      if (!name || !state.selected.size) {
        setMessage("参照名を入力し、参照に使う画像を選択してください。", true);
        return;
      }
      try {
        const response = await fetch("/api/ai/references", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, image_ids: [...state.selected] }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "参照登録に失敗しました。");
        $("#ai-reference").value = name;
        setMessage(`参照キャラクター「${name}」を${data.reference.image_ids.length}枚で登録しました。`);
      } catch (error) {
        setMessage(error.message || String(error), true);
      }
    });
    $("#close-detail").addEventListener("click", () => $("#detail-dialog").close());
    $("#detail-previous").addEventListener("click", () => navigateDetail(-1));
    $("#detail-next").addEventListener("click", () => navigateDetail(1));
    $("#detail-set-anchor").addEventListener("click", () => {
      const image = state.detailImage || state.images.find((item) => item.id === state.detailImageId);
      if (image) setRangeAnchor(image);
    });
    $("#detail-select-range").addEventListener("click", () => {
      const image = state.detailImage || state.images.find((item) => item.id === state.detailImageId);
      if (image) selectRangeTo(image);
    });
    $("#detail-select-prompt").addEventListener("click", () => selectDetailMatch("prompt"));
    $("#detail-select-group").addEventListener("click", () => selectDetailMatch("group"));
    $("#detail-use-composition-reference").addEventListener("click", () => useDetailImageAsReference("composition"));
    $("#detail-use-pose-reference").addEventListener("click", () => useDetailImageAsReference("pose"));
    $("#detail-restore-generation-settings").addEventListener("click", restoreDetailGenerationSettings);
    $("#detail-use-actual-seed").addEventListener("click", useDetailActualSeed);
    $("#detail-toggle-comparison").addEventListener("click", toggleDetailComparison);
    $("#detail-dialog").addEventListener("click", (event) => {
      if (event.target === $("#detail-dialog")) $("#detail-dialog").close();
    });
    for (const button of document.querySelectorAll("[data-set-status]")) {
      button.addEventListener("click", () => setSelectedStatus(button.dataset.setStatus));
    }
    for (const button of document.querySelectorAll("[data-set-lora]")) {
      button.addEventListener("click", () => setSelectedLoraCandidate(button.dataset.setLora === "true"));
    }
    for (const input of document.querySelectorAll("#status-filter, #date-from, #date-to, #sort-filter, #exclude-similar, #lora-filter")) input.addEventListener("change", () => load({ page: 1 }));
    let searchTimer;
    for (const input of document.querySelectorAll("#character-filter, #dataset-filter, #job-filter, #query-filter")) {
      input.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => load({ page: 1 }), 220); });
    }
    $("#job-filter").value = initialJobId;
    setView("gallery");
    loadGenerationOptions();
    load();
    loadAiStatus();
  });
})();
