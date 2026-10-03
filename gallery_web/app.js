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
    aiJob: null,
    generation: {
      options: null,
      jobId: "",
      pollTimer: null,
      submitting: false,
      lastRequest: null,
      lastOutput: null,
      reference: { imageId: "", fileName: "", previewUrl: "" },
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
  let aiPollTimer = null;
  const $ = (selector) => document.querySelector(selector);

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
      ["Character / Subject", character],
      ["Tags", generationTags($("#generation-explicit-tags")?.value).join(", ")],
      ["Appearance", $("#generation-appearance")?.value.trim() || ""],
      ["Request", $("#generation-request")?.value.trim() || ""],
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
  }

  async function copyGenerationJobId() {
    const jobId = state.generation.jobId.trim();
    const status = $("#generation-copy-status");
    if (!jobId || !status) return;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(jobId);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = jobId;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) throw new Error("clipboard unavailable");
      }
      status.textContent = "コピーしました";
    } catch (_error) {
      status.textContent = "コピーできません。job_idを長押しして選択してください。";
    }
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
      generationSubmit.disabled = Boolean(state.generation.submitting);
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
      generationSubmit.disabled = Boolean(state.generation.submitting);
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
    } catch (error) {
      $("#generation-capability").textContent = "生成オプションを取得できません";
      setGenerationStatus(error.message || String(error), true);
    }
  }

  function generationTags(value) {
    return String(value || "").split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
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
    text.textContent = reference.fileName ? `Reference image selected: ${reference.fileName}` : "";
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
    if (reference.previewUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(reference.previewUrl);
    state.generation.reference = { imageId: "", fileName: "", previewUrl: "" };
    const fileInput = $("#generation-reference-file");
    if (fileInput) fileInput.value = "";
    renderGenerationReferenceSelection();
    renderGenerationRequestSummary();
  }

  function handleGenerationReferenceFileChange() {
    const file = $("#generation-reference-file")?.files?.[0];
    const previousUrl = state.generation.reference.previewUrl;
    if (previousUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(previousUrl);
    state.generation.reference = {
      imageId: "",
      fileName: file?.name || "",
      previewUrl: file && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "",
    };
    renderGenerationReferenceSelection();
    renderGenerationRequestSummary();
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
      setGenerationStatus(error.message || String(error), true);
    }
  }

  async function submitGeneration() {
    if (state.generation.submitting) return;
    if (state.generation.auth.required && !state.generation.auth.authenticated) {
      setGenerationStatus("リモート生成キーで認証してください。", true);
      return;
    }
    invalidateGenerationTracking();
    hideGenerationResultSummary();
    state.generation.submitting = true;
    $("#generation-submit").disabled = true;
    renderGenerationRequestSummary();
    setGenerationStatus("送信中…");
    try {
      const referenceMode = generationReferenceMode();
      if (referenceMode !== "none") setGenerationStatus("参考画像を登録中…");
      const referenceImageId = await uploadGenerationReference();
      const payload = generationPayload(referenceImageId);
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
      setGenerationStatus(error.message || String(error), true);
    }
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

  function render() {
    const gallery = $("#gallery");
    gallery.replaceChildren();
    const firstItem = state.total ? ((state.page - 1) * state.pageSize) + 1 : 0;
    const lastItem = state.total ? Math.min(state.total, firstItem + state.images.length - 1) : 0;
    const rangeText = `全${state.total.toLocaleString()}件中 ${firstItem.toLocaleString()}〜${lastItem.toLocaleString()}件を表示`;
    renderDispersionFilter();
    $("#result-count").textContent = rangeText;
    $("#empty").hidden = state.images.length !== 0;
    for (const element of document.querySelectorAll("[data-page-range]")) element.textContent = rangeText;
    for (const element of document.querySelectorAll("[data-page-info]")) {
      element.textContent = `ページ ${state.page} / ${state.totalPages}`;
    }
    for (const button of document.querySelectorAll('[data-page-change="-1"]')) button.disabled = state.page <= 1;
    for (const button of document.querySelectorAll('[data-page-change="1"]')) button.disabled = state.page >= state.totalPages;
    for (const image of state.images) {
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
        openDetail(image);
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
      detail.className = "detail-icon";
      detail.type = "button";
      detail.textContent = "ⓘ";
      detail.title = "詳細を開く";
      detail.setAttribute("aria-label", `${image.filename}の詳細を開く`);
      detail.addEventListener("click", (event) => { event.stopPropagation(); openDetail(image); });
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
      info.append(name, meta);
      card.append(info);
      gallery.append(card);
    }
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
    } catch (error) {
      setMessage(error.message || String(error), true);
    }
  }

  function setDetail(id, value) { $(id).textContent = escapeText(value); }

  function openDetail(image) {
    state.detailImageId = image.id;
    const metadata = image.metadata || {};
    $("#detail-title").textContent = image.filename;
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
    const dialog = $("#detail-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    loadDetailMatchInfo(image);
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
    $("#refresh").addEventListener("click", () => load({ page: state.page }));
    $("#generation-submit").addEventListener("click", submitGeneration);
    $("#generation-auth-submit").addEventListener("click", unlockGeneration);
    $("#generation-auth-logout").addEventListener("click", logoutGeneration);
    $("#generation-count").addEventListener("change", updateGenerationVariationState);
    $("#generation-reference-mode").addEventListener("change", updateGenerationReferenceState);
    $("#generation-reference-file").addEventListener("change", handleGenerationReferenceFileChange);
    $("#generation-reference-clear").addEventListener("click", clearGenerationReferenceSelection);
    $("#generation-copy-job-id").addEventListener("click", copyGenerationJobId);
    for (const input of document.querySelectorAll("#generation-panel input:not([type='file']), #generation-panel select, #generation-panel textarea")) {
      input.addEventListener("input", renderGenerationRequestSummary);
      input.addEventListener("change", renderGenerationRequestSummary);
    }
    updateGenerationReferenceState();
    updateGenerationVariationState();
    loadGenerationAuthStatus();
    for (const type of ["character", "style", "additional"]) {
      $(`#generation-${type}-lora`).addEventListener("change", () => updateGenerationLoraDefault(type));
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
    $("#detail-set-anchor").addEventListener("click", () => {
      const image = state.images.find((item) => item.id === state.detailImageId);
      if (image) setRangeAnchor(image);
    });
    $("#detail-select-range").addEventListener("click", () => {
      const image = state.images.find((item) => item.id === state.detailImageId);
      if (image) selectRangeTo(image);
    });
    $("#detail-select-prompt").addEventListener("click", () => selectDetailMatch("prompt"));
    $("#detail-select-group").addEventListener("click", () => selectDetailMatch("group"));
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
    loadGenerationOptions();
    load();
    loadAiStatus();
  });
})();
