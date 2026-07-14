const STORAGE_KEYS = {
  reviewers: "clinic-reviewer-profiles",
  customLabels: "clinic-reviewer-custom-labels",
  reviewPairs: "clinic-reviewer-pairs",
};

const MAPBOX_TOKEN = "pk.eyJ1IjoicGI4IiwiYSI6ImNtcmRvc3B1ZzBobDYzMW9kODloMXgza2cifQ.IR7p4ByuDed_uz4pA4KIkw";
const MAP_SOURCE_ID = "review-clinics";
const COMPLETENESS_FIELDS = ["name", "address", "phone", "website", "state", "service"];
const DEFAULT_LABELS = ["hospital", "clinic", "other"];
const DEFAULT_LABEL_SET = new Set(DEFAULT_LABELS);
const MAX_DUPLICATE_DISTANCE_KM = 5;
const SUPABASE_TABLES = {
  reviewers: "reviewers",
  clinicReviews: "clinic_reviews",
  mergeReviews: "merge_reviews",
};
const DECISIONS = {
  KEEP: "keep",
  REMOVE: "remove",
  RESEARCH: "research",
};
const THEMES = {
  DEFAULT: "default",
  SOFT: "soft",
};

const state = {
  geojson: null,
  clinics: [],
  queue: [],
  itemIndex: 0,
  decisions: new Map(),
  labels: new Map(),
  customTags: new Map(),
  homeDialysisPrograms: new Set(),
  aboriginalSupport: new Set(),
  homeDialysisReviewed: new Set(),
  aboriginalSupportReviewed: new Set(),
  mergedOverrides: new Map(),
  mergePlans: new Map(),
  reviewAllMode: false,
  missingFieldsMode: false,
  editsMode: false,
  reviewUrgency: "non-urgent",
  redoMode: false,
  hasUnsavedChanges: false,
  seenPairKeys: new Set(),
  touchedClinics: new Set(),
  reviewerName: "",
  customLabels: ["hospital", "clinic", "other"],
  map: null,
  mapReady: false,
  syncMode: "local",
};

const loadDefaultBtn = document.getElementById("load-default");
const geojsonInput = document.getElementById("geojson-file");
const loadStatus = document.getElementById("load-status");
const reviewerNameInput = document.getElementById("reviewer-name");
const reviewerSelect = document.getElementById("reviewer-select");
const reviewerStatus = document.getElementById("reviewer-status");

const controls = document.getElementById("controls");
const summary = document.getElementById("summary");
const saveBar = document.getElementById("save-bar");
const saveBarCopy = document.getElementById("save-bar-copy");
const reviewItem = document.getElementById("review-item");
const guide = document.getElementById("guide");

const urgencyNormalBtn = document.getElementById("urgency-normal");
const urgencyUrgentBtn = document.getElementById("urgency-urgent");
const queueStatus = document.getElementById("queue-status");

const sumTotal = document.getElementById("sum-total");
const sumKeep = document.getElementById("sum-keep");
const sumRemove = document.getElementById("sum-remove");
const sumResearch = document.getElementById("sum-research");
const sumItems = document.getElementById("sum-items");
const sumProcessed = document.getElementById("sum-processed");

const rebuildBtn = document.getElementById("rebuild");
const redoListBtn = document.getElementById("redo-list");
const reviewAllBtn = document.getElementById("review-all");
const missingFieldsModeBtn = document.getElementById("missing-fields-mode");
const editsModeBtn = document.getElementById("edits-mode");
const resetItemBtn = document.getElementById("reset-item");

const exportDecisionsBtn = document.getElementById("export-decisions");
const exportCleanedBtn = document.getElementById("export-cleaned");
const themeToggleBtn = document.getElementById("theme-toggle");

const REVIEW_URGENCY = {
  NON_URGENT: "non-urgent",
  URGENT: "urgent",
};

const URGENCY_THRESHOLDS = {
  [REVIEW_URGENCY.NON_URGENT]: 0.86,
  [REVIEW_URGENCY.URGENT]: 0.95,
};

const MIN_SIMILARITY_FALLBACK = 0.2;
const MAX_PAIR_HISTORY = 12000;
const DECK_SIZE = 10;
const RANDOM_PAIR_SAMPLE = 500;

const supabaseClient = createSupabaseClient();

// Theme helpers

function getTheme() {
  return localStorage.getItem("clinic-reviewer-theme") || THEMES.DEFAULT;
}

function mapStyleForTheme(theme) {
  return theme === THEMES.SOFT ? "mapbox://styles/mapbox/light-v11" : "mapbox://styles/mapbox/dark-v11";
}

function applyTheme(theme) {
  const normalizedTheme = theme === THEMES.SOFT ? THEMES.SOFT : THEMES.DEFAULT;
  document.body.dataset.theme = normalizedTheme;
  localStorage.setItem("clinic-reviewer-theme", normalizedTheme);
  if (themeToggleBtn) {
    themeToggleBtn.textContent = normalizedTheme === THEMES.SOFT ? "Switch To Dark Theme" : "Switch To Softer Theme";
  }
  if (state.map) {
    state.map.setStyle(mapStyleForTheme(normalizedTheme));
    state.map.once("style.load", () => {
      state.mapReady = true;
      updateReviewMap();
    });
  }
}

function toggleTheme() {
  applyTheme(getTheme() === THEMES.SOFT ? THEMES.DEFAULT : THEMES.SOFT);
}

// Basic utilities

function createSupabaseClient() {
  const url = window.RENOVA_SUPABASE_URL || "";
  const key = window.RENOVA_SUPABASE_ANON_KEY || "";

  if (!url || !key || !window.supabase?.createClient) {
    return null;
  }

  return window.supabase.createClient(url, key);
}

function hasSupabase() {
  return Boolean(supabaseClient);
}

function isMissingColumnError(error, columnName) {
  if (!error || !columnName) return false;
  const message = String(error.message || "").toLowerCase();
  return message.includes("column") && message.includes(String(columnName).toLowerCase()) && message.includes("does not exist");
}

function withoutMetaColumns(row) {
  const { home_dialysis_program, aboriginal_support, ...rest } = row;
  return rest;
}

function currentEditCount() {
  let total = state.mergedOverrides.size + state.customTags.size + state.homeDialysisPrograms.size + state.aboriginalSupport.size;
  for (const decision of state.decisions.values()) {
    if (decision === DECISIONS.REMOVE || decision === DECISIONS.RESEARCH) {
      total += 1;
    }
  }
  return total;
}

function updateSaveCtaState() {
  if (!exportDecisionsBtn) return;
  exportDecisionsBtn.classList.toggle("is-dirty", state.hasUnsavedChanges);
  exportDecisionsBtn.textContent = state.hasUnsavedChanges ? "Save before leaving" : "Save shared review";
  if (saveBarCopy) {
    saveBarCopy.textContent = state.hasUnsavedChanges
      ? "You have unsaved changes. Save before leaving this page."
      : "No unsaved changes yet.";
  }
}

function setUnsavedChanges(dirty) {
  state.hasUnsavedChanges = Boolean(dirty);
  updateSaveCtaState();
}

function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function readJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getReviewerProfiles() {
  return readJsonStorage(STORAGE_KEYS.reviewers, {});
}

function pairHistoryStorageKey(name) {
  const normalized = normalizeName(name || "");
  return `${STORAGE_KEYS.reviewPairs}:${normalized || "anonymous"}`;
}

function loadReviewerPairHistory() {
  if (!state.reviewerName) {
    state.seenPairKeys = new Set();
    return;
  }
  const rows = readJsonStorage(pairHistoryStorageKey(state.reviewerName), []);
  state.seenPairKeys = new Set((rows || []).map(value => String(value || "")).filter(Boolean));
}

function saveReviewerPairHistory() {
  if (!state.reviewerName) return;
  const values = Array.from(state.seenPairKeys);
  writeJsonStorage(pairHistoryStorageKey(state.reviewerName), values.slice(-MAX_PAIR_HISTORY));
}

function markQueueItemsSeen(items = state.queue) {
  let changed = false;
  for (const item of items || []) {
    if (!item?.pairKey) continue;
    if (!state.seenPairKeys.has(item.pairKey)) {
      state.seenPairKeys.add(item.pairKey);
      changed = true;
    }
  }
  if (changed) {
    saveReviewerPairHistory();
  }
}

function saveReviewerProfiles(profiles) {
  writeJsonStorage(STORAGE_KEYS.reviewers, profiles);
}

function loadCustomLabels() {
  const labels = readJsonStorage(STORAGE_KEYS.customLabels, DEFAULT_LABELS);
  state.customLabels = Array.from(new Set(labels.map(label => String(label).trim().toLowerCase()).filter(Boolean)));
}

function saveCustomLabels() {
  writeJsonStorage(STORAGE_KEYS.customLabels, state.customLabels);
}

function refreshReviewerSelect() {
  if (hasSupabase()) {
    void refreshReviewerSelectFromSupabase();
    return;
  }

  const profiles = getReviewerProfiles();
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
  reviewerSelect.innerHTML = '<option value="">Select saved name</option>' + names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  if (state.reviewerName && profiles[state.reviewerName]) {
    reviewerSelect.value = state.reviewerName;
  }
}

async function refreshReviewerSelectFromSupabase() {
  const { data, error } = await supabaseClient
    .from(SUPABASE_TABLES.reviewers)
    .select("name")
    .order("name", { ascending: true });

  if (error) {
    console.error("Could not load reviewers from Supabase", error);
    return;
  }

  const names = (data || []).map(row => row.name).filter(Boolean);
  reviewerSelect.innerHTML = '<option value="">Select saved name</option>' + names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  if (state.reviewerName && names.includes(state.reviewerName)) {
    reviewerSelect.value = state.reviewerName;
  }
}

function updateReviewerStatus() {
  if (!state.reviewerName) {
    reviewerStatus.textContent = hasSupabase()
      ? "No reviewer selected yet. Shared saving is ready once you pick a name."
      : "No reviewer selected yet. Right now this is only saving in your browser.";
    return;
  }
  const saveLabel = hasSupabase() ? "shared save on" : "browser-only save";
  reviewerStatus.textContent = `${state.reviewerName} | saved edits suggested: ${currentEditCount()} | clinics processed: ${state.touchedClinics.size} | ${saveLabel}`;
}

function setReviewerName(name) {
  state.reviewerName = String(name || "").trim();
  reviewerNameInput.value = state.reviewerName;
  loadReviewerPairHistory();

  if (hasSupabase() && state.reviewerName) {
    void ensureReviewerInSupabase(state.reviewerName).then(() => {
      resetAllReviewState();
      loadReviewerState(state.reviewerName);
    });
    return;
  }

  if (state.reviewerName) {
    const profiles = getReviewerProfiles();
    if (!profiles[state.reviewerName]) {
      profiles[state.reviewerName] = { processed: 0, edits: 0, lastUsed: new Date().toISOString() };
      saveReviewerProfiles(profiles);
    }
  }
  refreshReviewerSelect();
  updateReviewerStatus();
}

async function ensureReviewerInSupabase(name) {
  const payload = {
    name,
    processed_count: state.touchedClinics.size,
    edit_count: currentEditCount(),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabaseClient
    .from(SUPABASE_TABLES.reviewers)
    .upsert(payload, { onConflict: "name" });

  if (error) {
    console.error("Could not save reviewer in Supabase", error);
  }
}

function persistReviewerProgress() {
  if (!state.reviewerName) return;
  const profiles = getReviewerProfiles();
  profiles[state.reviewerName] = {
    processed: state.touchedClinics.size,
    edits: currentEditCount(),
    lastUsed: new Date().toISOString(),
  };
  saveReviewerProfiles(profiles);
  updateReviewerStatus();

  if (hasSupabase()) {
    void ensureReviewerInSupabase(state.reviewerName);
  }
}

function markClinicTouched(featureIndex) {
  reconcileTouchedClinic(featureIndex);
}

function resetAllReviewState() {
  state.decisions.clear();
  state.labels.clear();
  state.customTags.clear();
  state.homeDialysisPrograms.clear();
  state.aboriginalSupport.clear();
  state.homeDialysisReviewed.clear();
  state.aboriginalSupportReviewed.clear();
  state.mergedOverrides.clear();
  state.mergePlans.clear();
  state.touchedClinics.clear();

  for (const clinic of state.clinics) {
    state.decisions.set(clinic.featureIndex, DECISIONS.KEEP);
    state.labels.set(clinic.featureIndex, inferLabel(clinic));
  }

  setUnsavedChanges(false);
}

function clinicHasCoordinates(clinic) {
  return clinic.lon != null && clinic.lat != null;
}

function missingFieldsForClinic(clinic) {
  const missing = COMPLETENESS_FIELDS.filter(key => !String(clinic[key] || "").trim());
  if (!clinicHasCoordinates(clinic)) {
    missing.push("location");
  }
  return missing;
}

function formatFieldLabel(key) {
  return key === "location" ? "Location" : key.charAt(0).toUpperCase() + key.slice(1);
}

function clinicDecision(featureIndex) {
  return state.decisions.get(featureIndex) || DECISIONS.KEEP;
}

function isMeaningfulClinicState(featureIndex, decision = clinicDecision(featureIndex), label = getLabel(featureIndex)) {
  const clinic = state.clinics[featureIndex - 1];
  if (!clinic) return false;
  if (state.mergedOverrides.has(featureIndex)) return true;
  return decision !== DECISIONS.KEEP
    || label !== inferLabel(clinic)
    || state.customTags.has(featureIndex)
    || state.homeDialysisPrograms.has(featureIndex)
    || state.aboriginalSupport.has(featureIndex);
}

function reconcileTouchedClinic(featureIndex) {
  if (isMeaningfulClinicState(featureIndex)) {
    state.touchedClinics.add(featureIndex);
  } else {
    state.touchedClinics.delete(featureIndex);
  }
  persistReviewerProgress();
}

function buildTouchedClinicRows() {
  return state.clinics
    .filter(clinic => state.touchedClinics.has(clinic.featureIndex))
    .filter(clinic => isMeaningfulClinicState(clinic.featureIndex))
    .map(clinic => ({
      clinic_id: clinic.featureIndex,
      reviewer_name: state.reviewerName,
      decision: clinicDecision(clinic.featureIndex),
      label: getLabel(clinic.featureIndex),
      updated_at: new Date().toISOString(),
    }));
}

function similarityDice(a, b) {
  const s1 = normalizeName(a);
  const s2 = normalizeName(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;

  const bigrams = str => {
    const list = [];
    for (let i = 0; i < str.length - 1; i += 1) {
      list.push(str.slice(i, i + 2));
    }
    return list;
  };

  const aBi = bigrams(s1);
  const bBi = bigrams(s2);
  const bMap = new Map();

  for (const item of bBi) {
    bMap.set(item, (bMap.get(item) || 0) + 1);
  }

  let overlap = 0;
  for (const item of aBi) {
    const count = bMap.get(item) || 0;
    if (count > 0) {
      overlap += 1;
      bMap.set(item, count - 1);
    }
  }

  return (2 * overlap) / (aBi.length + bBi.length);
}

function haversineKm(lon1, lat1, lon2, lat2) {
  const r = 6371;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

function parseClinics(geojson) {
  return (geojson.features || []).map((feature, i) => {
    const props = feature.properties || {};
    const coords = (feature.geometry || {}).coordinates || [];
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    return {
      featureIndex: i + 1,
      name: String(props.name || ""),
      address: String(props.address || ""),
      state: String(props.state || ""),
      phone: String(props.phone || ""),
      website: String(props.website || ""),
      service: String(props.service || ""),
      source: String(props.source || ""),
      lon: Number.isFinite(lon) ? lon : null,
      lat: Number.isFinite(lat) ? lat : null,
      completeness: COMPLETENESS_FIELDS.reduce(
        (acc, key) => acc + (String(props[key] || "").trim() ? 1 : 0),
        0,
      ),
      normalizedName: normalizeName(String(props.name || "")),
    };
  });
}

// Map helpers

function initReviewMap() {
  if (state.map || typeof mapboxgl === "undefined") return;
  mapboxgl.accessToken = MAPBOX_TOKEN;
  state.map = new mapboxgl.Map({
    container: "review-map",
    style: mapStyleForTheme(getTheme()),
    center: [134.5, -25.5],
    zoom: 3.2,
    interactive: true,
  });

  state.map.addControl(new mapboxgl.NavigationControl(), "top-right");

  state.map.on("load", () => {
    state.mapReady = true;
    updateReviewMap();
  });
}

function clinicStatus(clinic) {
  if (clinicDecision(clinic.featureIndex) === DECISIONS.RESEARCH) {
    return "research";
  }
  if (state.touchedClinics.has(clinic.featureIndex)) {
    return "verified";
  }
  if (state.reviewAllMode) {
    return "unverified";
  }
  const inQueue = state.queue.some(item => item.clinics.some(entry => entry.featureIndex === clinic.featureIndex));
  return inQueue ? "review" : "unverified";
}

function buildMapGeojson() {
  return {
    type: "FeatureCollection",
    features: state.clinics
      .filter(clinic => clinicDecision(clinic.featureIndex) !== DECISIONS.REMOVE)
      .filter(clinicHasCoordinates)
      .map(clinic => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [clinic.lon, clinic.lat],
        },
        properties: {
          name: clinic.name,
          status: clinicStatus(clinic),
        },
      })),
  };
}

// Review state helpers

function updateReviewMap() {
  if (!state.mapReady || !state.map) return;
  const data = buildMapGeojson();

  if (state.map.getSource(MAP_SOURCE_ID)) {
    state.map.getSource(MAP_SOURCE_ID).setData(data);
    return;
  }

  state.map.addSource(MAP_SOURCE_ID, {
    type: "geojson",
    data,
  });

  state.map.addLayer({
    id: "review-clinic-dots",
    type: "circle",
    source: MAP_SOURCE_ID,
    paint: {
      "circle-radius": 6,
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#17191c",
      "circle-color": [
        "match",
        ["get", "status"],
        "verified",
        "#65a76a",
        "research",
        "#5a88c9",
        "review",
        "#eac247",
        "#bf5848",
      ],
    },
  });
}

function inferLabel(clinic) {
  const hay = `${clinic.name} ${clinic.service}`.toLowerCase();
  if (hay.includes("hospital")) return "hospital";
  if (hay.includes("clinic") || hay.includes("dialysis")) return "clinic";
  return "other";
}

function getLabel(featureIndex) {
  return state.labels.get(featureIndex) || "other";
}

function getCustomTag(featureIndex) {
  return state.customTags.get(featureIndex) || "";
}

function hasHomeDialysisProgram(featureIndex) {
  return state.homeDialysisPrograms.has(featureIndex);
}

function hasAboriginalSupport(featureIndex) {
  return state.aboriginalSupport.has(featureIndex);
}

function setLabel(featureIndex, label) {
  state.labels.set(featureIndex, label);
  markClinicTouched(featureIndex);
  setUnsavedChanges(true);
}

function setCustomTag(featureIndex, tag) {
  const normalized = String(tag || "").trim().toLowerCase();
  if (normalized) {
    state.customTags.set(featureIndex, normalized);
    if (!state.customLabels.includes(normalized)) {
      state.customLabels.push(normalized);
      saveCustomLabels();
    }
  } else {
    state.customTags.delete(featureIndex);
  }
  markClinicTouched(featureIndex);
  setUnsavedChanges(true);
}

function setHomeDialysisProgram(featureIndex, enabled) {
  state.homeDialysisReviewed.add(featureIndex);
  if (enabled) {
    state.homeDialysisPrograms.add(featureIndex);
  } else {
    state.homeDialysisPrograms.delete(featureIndex);
  }
  markClinicTouched(featureIndex);
  setUnsavedChanges(true);
}

function setAboriginalSupport(featureIndex, enabled) {
  state.aboriginalSupportReviewed.add(featureIndex);
  if (enabled) {
    state.aboriginalSupport.add(featureIndex);
  } else {
    state.aboriginalSupport.delete(featureIndex);
  }
  markClinicTouched(featureIndex);
  setUnsavedChanges(true);
}

function applyLabel(featureIndex, label) {
  if (!label) return;
  setLabel(featureIndex, label);
  void saveClinicReview(featureIndex);
  updateReviewMap();
  renderCurrentItem();
}

function cycleLabel(featureIndex) {
  const labels = DEFAULT_LABELS;
  const currentLabel = getLabel(featureIndex);
  const currentIndex = labels.indexOf(currentLabel);
  const nextLabel = labels[(currentIndex + 1 + labels.length) % labels.length] || labels[0] || "other";
  applyLabel(featureIndex, nextLabel);
}

function addCustomLabel(featureIndex) {
  const label = window.prompt("Enter a custom tag for this clinic:", getCustomTag(featureIndex));
  if (label == null) return;
  setCustomTag(featureIndex, label);
  void saveClinicMetaReview(featureIndex);
  updateReviewMap();
  renderCurrentItem();
}

function toggleHomeDialysisProgram(featureIndex) {
  setHomeDialysisProgram(featureIndex, !hasHomeDialysisProgram(featureIndex));
  void saveClinicMetaReview(featureIndex);
  updateReviewMap();
  renderCurrentItem();
}

function decisionPresentation(decision) {
  if (decision === DECISIONS.REMOVE) {
    return { className: "status-remove", text: "REMOVE" };
  }
  if (decision === DECISIONS.RESEARCH) {
    return { className: "status-research", text: "NEEDS RESEARCH" };
  }
  return { className: "status-keep", text: "KEEP" };
}

function itemKey(item) {
  return item.clinics.map(c => c.featureIndex).sort((a, b) => a - b).join("-");
}

function pairKeyForClinics(clinics) {
  return clinics.map(c => c.featureIndex).sort((a, b) => a - b).join("-");
}

function shuffleArray(values) {
  const array = [...values];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function buildRandomVerificationPairs(clinics, maxPairs = RANDOM_PAIR_SAMPLE) {
  const pairs = [];
  const seen = new Set();
  const indices = clinics.map((_, idx) => idx);
  const tries = Math.min(20000, clinics.length * clinics.length * 2);

  for (let attempt = 0; attempt < tries && pairs.length < maxPairs; attempt += 1) {
    const i = indices[Math.floor(Math.random() * indices.length)];
    const j = indices[Math.floor(Math.random() * indices.length)];
    if (i === j) continue;
    const a = clinics[Math.min(i, j)];
    const b = clinics[Math.max(i, j)];
    if (!a || !b) continue;

    const key = pairKeyForClinics([a, b]);
    if (seen.has(key)) continue;
    seen.add(key);

    pairs.push({
      type: "random",
      title: "Random verification pair",
      clinics: [a, b],
      meta: "random verification",
      similarity: similarityDice(a.name, b.name),
      pairKey: key,
    });
  }

  return pairs;
}

function bestDuplicateCompanion(target, clinics) {
  if (!target) return null;

  const exactCandidates = clinics.filter(candidate =>
    candidate.featureIndex !== target.featureIndex
    && candidate.normalizedName
    && candidate.normalizedName === target.normalizedName,
  );

  if (exactCandidates.length) {
    return exactCandidates.reduce((best, candidate) =>
      candidate.completeness > best.completeness ? candidate : best,
    exactCandidates[0]);
  }

  let best = null;
  let bestScore = -1;

  for (const candidate of clinics) {
    if (candidate.featureIndex === target.featureIndex) continue;
    const ratio = similarityDice(target.name, candidate.name);
    if (ratio < MIN_SIMILARITY_FALLBACK) continue;

    let distance = null;
    if (target.lon != null && target.lat != null && candidate.lon != null && candidate.lat != null) {
      distance = haversineKm(target.lon, target.lat, candidate.lon, candidate.lat);
      if (distance > MAX_DUPLICATE_DISTANCE_KM) continue;
    }

    const score = ratio + (distance == null ? 0 : Math.max(0, (MAX_DUPLICATE_DISTANCE_KM - distance) / 100));
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function buildQueue(clinics, threshold, preferUnseen = true) {
  if (state.editsMode) {
    const editItems = clinics
      .filter(clinic => isMeaningfulClinicState(clinic.featureIndex))
      .map(clinic => {
        const featureIndex = clinic.featureIndex;
        const decision = clinicDecision(featureIndex);
        const isRemovalReview = decision === DECISIONS.REMOVE || decision === DECISIONS.RESEARCH;
        const companion = isRemovalReview ? bestDuplicateCompanion(clinic, clinics) : null;
        const notes = [];

        if (decision === DECISIONS.REMOVE) notes.push("marked remove");
        if (decision === DECISIONS.RESEARCH) notes.push("needs research");
        if (state.mergedOverrides.has(featureIndex)) notes.push("details edited");
        if (state.customTags.has(featureIndex)) notes.push(`custom tag: ${getCustomTag(featureIndex)}`);
        if (state.homeDialysisReviewed.has(featureIndex)) {
          notes.push(`home dialysis: ${hasHomeDialysisProgram(featureIndex) ? "Yes" : "No"}`);
        }
        if (state.aboriginalSupportReviewed.has(featureIndex)) {
          notes.push(`aboriginal support: ${hasAboriginalSupport(featureIndex) ? "Yes" : "No"}`);
        }

        if (companion) {
          const ratio = similarityDice(clinic.name, companion.name);
          let distanceMeta = "";
          if (clinic.lon != null && clinic.lat != null && companion.lon != null && companion.lat != null) {
            const distance = haversineKm(clinic.lon, clinic.lat, companion.lon, companion.lat);
            distanceMeta = `, distance ${distance.toFixed(3)} km`;
          }
          notes.push(`paired with #${companion.featureIndex} (similarity ${ratio.toFixed(3)}${distanceMeta})`);
        }

        return {
          type: companion ? "edits-pair" : "edits",
          title: companion ? "Suggested duplicate decision review" : "Suggested edit review",
          clinics: companion ? [clinic, companion] : [clinic],
          meta: notes.length ? notes.join(" | ") : `Feature #${featureIndex}`,
          similarity: 1,
          pairKey: companion ? `edit-${featureIndex}-${companion.featureIndex}` : `edit-${featureIndex}`,
        };
      });

    const unseenItems = editItems.filter(item => !state.seenPairKeys.has(item.pairKey));
    const source = preferUnseen ? (unseenItems.length ? unseenItems : editItems) : editItems;
    return source.slice(0, DECK_SIZE);
  }

  if (state.missingFieldsMode) {
    const gapItems = clinics
      .map(clinic => {
        const missing = missingFieldsForClinic(clinic);
        return {
          type: "missing",
          title: "Missing fields review",
          clinics: [clinic],
          meta: `${missing.length} missing: ${missing.map(formatFieldLabel).join(", ")}`,
          similarity: 1,
          missingCount: missing.length,
          pairKey: `gap-${clinic.featureIndex}`,
        };
      })
      .filter(item => item.missingCount > 0)
      .sort((left, right) => right.missingCount - left.missingCount);

    const candidates = preferUnseen
      ? gapItems.filter(item => !state.seenPairKeys.has(item.pairKey))
      : gapItems;

    return candidates.slice(0, DECK_SIZE);
  }

  if (state.reviewAllMode) {
    const singles = clinics.map(clinic => ({
      type: "single",
      title: "Single clinic review",
      clinics: [clinic],
      meta: `Feature #${clinic.featureIndex}`,
      similarity: 1,
      pairKey: `single-${clinic.featureIndex}`,
    }));
    const unseenSingles = singles.filter(item => !state.seenPairKeys.has(item.pairKey));
    const source = preferUnseen ? (unseenSingles.length ? unseenSingles : singles) : singles;
    return shuffleArray(source).slice(0, DECK_SIZE);
  }

  const exactItems = [];
  const nearItems = [];
  const exactMap = new Map();
  for (const clinic of clinics) {
    if (!clinic.normalizedName) continue;
    const list = exactMap.get(clinic.normalizedName) || [];
    list.push(clinic);
    exactMap.set(clinic.normalizedName, list);
  }

  for (const [normalizedName, list] of exactMap.entries()) {
    if (list.length < 2) continue;
    exactItems.push({
      type: "exact",
      title: `Exact duplicate group: ${normalizedName}`,
      clinics: list,
      meta: `${list.length} matching records`,
      similarity: 1,
      pairKey: `exact-${pairKeyForClinics(list)}`,
    });
  }

  for (let i = 0; i < clinics.length; i += 1) {
    for (let j = i + 1; j < clinics.length; j += 1) {
      const a = clinics[i];
      const b = clinics[j];
      if (!a.normalizedName || !b.normalizedName) continue;
      if (a.normalizedName === b.normalizedName) continue;
      const ratio = similarityDice(a.name, b.name);
      if (ratio < MIN_SIMILARITY_FALLBACK) continue;

      let distance = null;
      if (a.lon != null && a.lat != null && b.lon != null && b.lat != null) {
        distance = haversineKm(a.lon, a.lat, b.lon, b.lat);
      }
      if (distance != null && distance > MAX_DUPLICATE_DISTANCE_KM) continue;

      nearItems.push({
        type: "near",
        title: "Similar name pair",
        clinics: [a, b],
        meta: `similarity ${ratio.toFixed(3)}${distance != null ? `, distance ${distance.toFixed(3)} km` : ""}`,
        similarity: ratio,
        pairKey: pairKeyForClinics([a, b]),
      });
    }
  }

  const urgentThreshold = URGENCY_THRESHOLDS[REVIEW_URGENCY.URGENT];
  const nonUrgentThreshold = URGENCY_THRESHOLDS[REVIEW_URGENCY.NON_URGENT];

  const urgentPairs = nearItems
    .filter(item => item.similarity >= urgentThreshold)
    .sort((left, right) => right.similarity - left.similarity);

  const nonUrgentPairs = nearItems
    .filter(item => item.similarity < urgentThreshold && item.similarity >= MIN_SIMILARITY_FALLBACK)
    .sort((left, right) => left.similarity - right.similarity);

  const allByUrgency = state.reviewUrgency === REVIEW_URGENCY.URGENT
    ? [...exactItems, ...urgentPairs, ...nonUrgentPairs]
    : [...nonUrgentPairs, ...urgentPairs, ...exactItems];

  const candidates = preferUnseen
    ? allByUrgency.filter(item => !state.seenPairKeys.has(item.pairKey))
    : allByUrgency;

  const deck = candidates.slice(0, DECK_SIZE);

  if (state.reviewUrgency === REVIEW_URGENCY.NON_URGENT && deck.length < DECK_SIZE) {
    const randomPairs = buildRandomVerificationPairs(clinics)
      .filter(item => !preferUnseen || !state.seenPairKeys.has(item.pairKey))
      .filter(item => !deck.some(existing => existing.pairKey === item.pairKey));

    for (const pair of randomPairs) {
      deck.push(pair);
      if (deck.length >= DECK_SIZE) break;
    }
  }

  return deck;
}

function clinicWithOverride(clinic) {
  const override = state.mergedOverrides.get(clinic.featureIndex);
  if (!override) return clinic;
  const lon = Number(override.lon);
  const lat = Number(override.lat);
  return {
    ...clinic,
    ...override,
    lon: Number.isFinite(lon) ? lon : clinic.lon,
    lat: Number.isFinite(lat) ? lat : clinic.lat,
  };
}

function updateClinicFromOverride(featureIndex, override) {
  const clinic = state.clinics.find(entry => entry.featureIndex === featureIndex);
  if (!clinic) return;
  clinic.name = override.name;
  clinic.address = override.address;
  clinic.state = override.state;
  clinic.phone = override.phone;
  clinic.website = override.website;
  clinic.service = override.service;
  clinic.source = override.source;
  clinic.lon = override.lon;
  clinic.lat = override.lat;
  clinic.completeness = COMPLETENESS_FIELDS.reduce(
    (acc, key) => acc + (String(override[key] || "").trim() ? 1 : 0),
    0,
  );
  clinic.normalizedName = normalizeName(override.name);
}

function saveClinicCardEdit(featureIndex, cardElement) {
  if (!cardElement) return;
  const readValue = key => String(cardElement.querySelector(`[data-edit="${key}"]`)?.value || "").trim();
  const latValue = readValue("lat");
  const lonValue = readValue("lon");
  const lat = latValue === "" ? null : Number(latValue);
  const lon = lonValue === "" ? null : Number(lonValue);
  if ((latValue !== "" && !Number.isFinite(lat)) || (lonValue !== "" && !Number.isFinite(lon))) {
    window.alert("Latitude and longitude must be numbers.");
    return;
  }

  const fallback = state.clinics.find(entry => entry.featureIndex === featureIndex);
  if (!fallback) return;

  const override = {
    name: readValue("name") || fallback.name,
    address: readValue("address") || "",
    state: readValue("state") || "",
    phone: readValue("phone") || "",
    website: readValue("website") || "",
    service: readValue("service") || "",
    source: readValue("source") || "",
    lon: Number.isFinite(lon) ? lon : fallback.lon,
    lat: Number.isFinite(lat) ? lat : fallback.lat,
  };

  state.mergedOverrides.set(featureIndex, override);
  updateClinicFromOverride(featureIndex, override);
  markClinicTouched(featureIndex);
  setUnsavedChanges(true);
  void saveClinicReview(featureIndex);
  updateSummary();
  updateReviewMap();
  renderCurrentItem();
}

function setDecision(featureIndex, decision) {
  state.decisions.set(featureIndex, decision);
  state.touchedClinics.add(featureIndex);
  const currentItem = state.queue[state.itemIndex];
  if (currentItem?.pairKey && currentItem.clinics.some(clinic => clinic.featureIndex === featureIndex)) {
    state.seenPairKeys.add(currentItem.pairKey);
    saveReviewerPairHistory();
  }
  markClinicTouched(featureIndex);
  setUnsavedChanges(true);
  void saveClinicReview(featureIndex);
  updateSummary();
  updateReviewMap();
  renderCurrentItem();
}

async function saveClinicReview(featureIndex) {
  if (!hasSupabase() || !state.reviewerName) return;

  const label = getLabel(featureIndex);
  const decision = clinicDecision(featureIndex);

  if (!isMeaningfulClinicState(featureIndex, decision, label)) {
    const { error } = await supabaseClient
      .from(SUPABASE_TABLES.clinicReviews)
      .delete()
      .eq("clinic_id", featureIndex)
      .eq("reviewer_name", state.reviewerName);

    if (error) {
      console.error(`Could not clear default clinic review for #${featureIndex}`, error);
    }
    return;
  }

  const { error } = await supabaseClient
    .from(SUPABASE_TABLES.clinicReviews)
    .upsert(
      {
        clinic_id: featureIndex,
        reviewer_name: state.reviewerName,
        decision,
        label,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "clinic_id,reviewer_name" },
    );

  if (error) {
    console.error(`Could not save clinic review for #${featureIndex}`, error);
  }
}

function getDecision(featureIndex) {
  return clinicDecision(featureIndex);
}

async function saveClinicMetaReview(featureIndex) {
  if (!hasSupabase() || !state.reviewerName) return;

  const customTag = getCustomTag(featureIndex);
  const homeDialysisProgram = hasHomeDialysisProgram(featureIndex);
  const aboriginalSupport = hasAboriginalSupport(featureIndex);
  const homeDialysisReviewed = state.homeDialysisReviewed.has(featureIndex);
  const aboriginalSupportReviewed = state.aboriginalSupportReviewed.has(featureIndex);
  const shouldPersist = Boolean(
    customTag
    || homeDialysisReviewed
    || aboriginalSupportReviewed
    || homeDialysisProgram
    || aboriginalSupport,
  );

  if (!shouldPersist) {
    const { error } = await supabaseClient
      .from(SUPABASE_TABLES.mergeReviews)
      .delete()
      .eq("reviewer_name", state.reviewerName)
      .eq("group_key", `meta-${featureIndex}`);

    if (error) {
      console.error(`Could not clear meta review for #${featureIndex}`, error);
    }
    return;
  }

  const payload = {
    group_key: `meta-${featureIndex}`,
    reviewer_name: state.reviewerName,
    keep_clinic_id: featureIndex,
    field_sources: {
      meta: featureIndex,
    },
    merged_values: {
      customTag,
      homeDialysisProgram,
      aboriginalSupport,
      homeDialysisReviewed,
      aboriginalSupportReviewed,
    },
    home_dialysis_program: homeDialysisProgram,
    aboriginal_support: aboriginalSupport,
    updated_at: new Date().toISOString(),
  };

  let { error } = await supabaseClient
    .from(SUPABASE_TABLES.mergeReviews)
    .upsert(payload, { onConflict: "group_key,reviewer_name" });

  if (error && (isMissingColumnError(error, "home_dialysis_program") || isMissingColumnError(error, "aboriginal_support"))) {
    ({ error } = await supabaseClient
      .from(SUPABASE_TABLES.mergeReviews)
      .upsert(withoutMetaColumns(payload), { onConflict: "group_key,reviewer_name" }));
  }

  if (error) {
    console.error(`Could not save meta review for #${featureIndex}`, error);
  }
}

function buildSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function compactAddressQuery(address) {
  const segments = String(address || "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);

  if (!segments.length) return "";
  return segments.slice(0, 2).join(", ");
}

function openClinicSearch(featureIndex, searchType) {
  const clinic = state.clinics.find(entry => entry.featureIndex === featureIndex);
  if (!clinic) return;

  const visibleClinic = clinicWithOverride(clinic);
  const nameQuery = visibleClinic.name || "";
  const addressQuery = compactAddressQuery(visibleClinic.address);

  let query = "";
  if (searchType === "dialysis-address") {
    query = `is there a haemodialysis clinic at ${addressQuery}`;
  } else if (searchType === "home-haemodialysis-program") {
    query = `does ${nameQuery} have a home haemodialysis program`;
  } else if (searchType === "aboriginal-support") {
    query = `Aboriginal support? at ${nameQuery}`;
  } else if (searchType === "address") {
    query = addressQuery;
  } else {
    query = nameQuery;
  }

  if (!String(query).trim()) return;
  window.open(buildSearchUrl(query), "_blank", "noopener,noreferrer");
}

function clinicCard(clinic) {
  const visibleClinic = clinicWithOverride(clinic);
  const missingFields = missingFieldsForClinic(visibleClinic);
  const decision = getDecision(clinic.featureIndex);
  const label = getLabel(clinic.featureIndex);
  const customTag = getCustomTag(clinic.featureIndex);
  const homeDialysis = hasHomeDialysisProgram(clinic.featureIndex);
  const aboriginalSupport = hasAboriginalSupport(clinic.featureIndex);
  const homeProgramClass = hasHomeDialysisProgram(clinic.featureIndex) ? "is-selected" : "";
  const aboriginalSupportClass = hasAboriginalSupport(clinic.featureIndex) ? "is-selected" : "";
  const status = decisionPresentation(decision);
  const keepClass = decision === DECISIONS.KEEP ? "is-selected" : "";
  const removeClass = decision === DECISIONS.REMOVE ? "is-selected" : "";
  const researchClass = decision === DECISIONS.RESEARCH ? "is-selected" : "";
  const researchText = decision === DECISIONS.RESEARCH ? "Needs Research On" : "Mark Needs Research";
  return `
      <article class="clinic-card">
      <div class="card-corner-actions">
        <button type="button" class="research-flair ${researchClass}" data-action="research-toggle" data-index="${clinic.featureIndex}" aria-label="${escapeHtml(researchText)}" title="${escapeHtml(researchText)}">?</button>
        <button type="button" class="home-program-toggle ${homeProgramClass}" data-action="toggle-home-program" data-index="${clinic.featureIndex}" aria-label="Toggle home dialysis program" title="Toggle home dialysis program">&#8962;</button>
        <button type="button" class="aboriginal-support-toggle ${aboriginalSupportClass}" data-action="toggle-aboriginal-support" data-index="${clinic.featureIndex}" aria-label="Toggle Aboriginal support" title="Toggle Aboriginal support">&#128099;</button>
      </div>
      <div class="clinic-status-row">
        <span class="status-pill ${status.className}">${status.text}</span>
        ${missingFields.length ? `<span class="data-gap-badge" title="${escapeHtml(missingFields.map(formatFieldLabel).join(", "))}">Data gap: ${missingFields.length}</span>` : ""}
        ${customTag ? `<span class="custom-tag-badge">Tag: ${escapeHtml(customTag)}</span>` : ""}
        ${homeDialysis ? '<span class="home-program-badge">Home dialysis program</span>' : ''}
        ${aboriginalSupport ? '<span class="aboriginal-support-badge">Aboriginal support</span>' : ''}
      </div>
      <div class="clinic-title-row">
        <h3>#${clinic.featureIndex} ${escapeHtml(visibleClinic.name || "(missing name)")}</h3>
      </div>
      <p><strong>Address:</strong> ${escapeHtml(visibleClinic.address || "(missing)")}</p>
      <p><strong>State:</strong> ${escapeHtml(visibleClinic.state || "(blank)")}</p>
      <p><strong>Phone:</strong> ${escapeHtml(visibleClinic.phone || "(blank)")}</p>
      <p><strong>Website:</strong> ${escapeHtml(visibleClinic.website || "(blank)")}</p>
      <p><strong>Service:</strong> ${escapeHtml(visibleClinic.service || "(blank)")}</p>
      <p><strong>Source:</strong> ${escapeHtml(visibleClinic.source || "(blank)")}</p>
      <p><strong>Home Dialysis program:</strong> ${homeDialysis ? "Yes" : "No"}</p>
      <p><strong>Aboriginal support:</strong> ${aboriginalSupport ? "Yes" : "No"}</p>
      <p><strong>Location:</strong> ${clinicHasCoordinates(visibleClinic) ? `${visibleClinic.lat}, ${visibleClinic.lon}` : "(missing)"}</p>
      <div class="clinic-utility-row">
        <button type="button" class="label-cycle-btn" data-action="cycle-label" data-index="${clinic.featureIndex}">
          <span class="label-cycle-caption">Category</span>
          <span class="label-cycle-value">${escapeHtml(label.toUpperCase())}</span>
        </button>
        <div class="decision-row">
          <button type="button" class="decision-btn ${keepClass}" data-action="keep" data-index="${clinic.featureIndex}">Keep</button>
          <button type="button" class="decision-btn ${removeClass}" data-action="remove" data-index="${clinic.featureIndex}">Remove</button>
        </div>
      </div>
      <div class="clinic-actions">
        <div class="support-row">
          <button type="button" class="support-btn" data-action="toggle-edit" data-index="${clinic.featureIndex}">Edit Details</button>
        </div>
        <div class="clinic-edit-panel" id="clinic-edit-${clinic.featureIndex}">
          <div class="edit-panel-actions edit-panel-actions-top">
            <button type="button" class="support-btn" data-action="save-edit" data-index="${clinic.featureIndex}">Save Edits</button>
            <button type="button" class="support-btn" data-action="add-custom-label" data-index="${clinic.featureIndex}">${customTag ? "Edit Custom Tag" : "Add Custom Tag"}</button>
          </div>
          <label>Name <input type="text" data-edit="name" value="${escapeHtml(visibleClinic.name || "")}" /></label>
          <label>Address <input type="text" data-edit="address" value="${escapeHtml(visibleClinic.address || "")}" /></label>
          <label>State <input type="text" data-edit="state" value="${escapeHtml(visibleClinic.state || "")}" /></label>
          <label>Phone <input type="text" data-edit="phone" value="${escapeHtml(visibleClinic.phone || "")}" /></label>
          <label>Website <input type="text" data-edit="website" value="${escapeHtml(visibleClinic.website || "")}" /></label>
          <label>Service <input type="text" data-edit="service" value="${escapeHtml(visibleClinic.service || "")}" /></label>
          <label>Source <input type="text" data-edit="source" value="${escapeHtml(visibleClinic.source || "")}" /></label>
          <div class="clinic-edit-location">
            <label>Lat <input type="text" data-edit="lat" value="${visibleClinic.lat ?? ""}" /></label>
            <label>Lon <input type="text" data-edit="lon" value="${visibleClinic.lon ?? ""}" /></label>
          </div>
        </div>
      </div>
      </article>
  `;
}

function quickSearchDeck(item) {
  return `
    <div class="quick-search-deck">
      ${item.clinics.map((clinic, index, clinics) => {
        const searchSideClass = clinics.length > 1 && index === 0 ? "is-left" : "is-right";
        return `
        <details class="quick-search-inline ${searchSideClass}">
          <summary>Quick Search #${clinic.featureIndex}</summary>
          <div class="quick-search-inline-body">
            <button type="button" class="quick-search-action" data-action="search-name" data-index="${clinic.featureIndex}">Search name</button>
            <button type="button" class="quick-search-action" data-action="search-address" data-index="${clinic.featureIndex}">Search address</button>
            <button type="button" class="quick-search-action" data-action="search-dialysis-address" data-index="${clinic.featureIndex}">Haemodialysis clinic here?</button>
            <button type="button" class="quick-search-action" data-action="search-home-haemodialysis-program" data-index="${clinic.featureIndex}">Home Dialysis program?</button>
            <button type="button" class="quick-search-action" data-action="search-aboriginal-support" data-index="${clinic.featureIndex}">Aboriginal support?</button>
          </div>
        </details>
      `;
      }).join("\n")}
    </div>
  `;
}

// Merge helpers

function mergePanel(item) {
  if (item.clinics.length < 2 || item.type === "single") return "";
  const key = itemKey(item);
  const defaultKeep = item.clinics[0].featureIndex;
  const plan = state.mergePlans.get(key) || {
    keepIndex: defaultKeep,
    fields: {
      name: defaultKeep,
      address: defaultKeep,
      state: defaultKeep,
      phone: defaultKeep,
      website: defaultKeep,
      service: defaultKeep,
      source: defaultKeep,
      location: defaultKeep,
    },
  };

  const row = (fieldLabel, fieldKey) => `
    <label>${fieldLabel}</label>
    <select data-merge-field="${fieldKey}">
      ${item.clinics.map(clinic => `<option value="${clinic.featureIndex}" ${Number(plan.fields[fieldKey]) === clinic.featureIndex ? "selected" : ""}>Use #${clinic.featureIndex}</option>`).join("")}
    </select>
  `;

  return `
    <details class="merge-panel">
      <summary>Optional: merge these into one combined clinic entry</summary>
      <div class="merge-panel-body">
        <div class="merge-grid">
          <label>Keep target</label>
          <select data-merge-keep>
            ${item.clinics.map(clinic => `<option value="${clinic.featureIndex}" ${Number(plan.keepIndex) === clinic.featureIndex ? "selected" : ""}>Keep #${clinic.featureIndex} ${escapeHtml(clinic.name || "")}</option>`).join("")}
          </select>
          ${row("Name", "name")}
          ${row("Address", "address")}
          ${row("State", "state")}
          ${row("Phone", "phone")}
          ${row("Website", "website")}
          ${row("Service", "service")}
          ${row("Source", "source")}
          ${row("Location (lat/lng)", "location")}
        </div>
        <div class="actions" style="margin-top:10px;">
          <button type="button" data-action="apply-merge">Merge These Into One</button>
        </div>
      </div>
    </details>
  `;
}

function saveMergePlanFromDom(item) {
  const key = itemKey(item);
  const keepSelect = reviewItem.querySelector("select[data-merge-keep]");
  const fieldSelects = reviewItem.querySelectorAll("select[data-merge-field]");
  if (!keepSelect) return;
  const fields = {};
  fieldSelects.forEach(sel => {
    fields[sel.dataset.mergeField] = Number(sel.value);
  });
  state.mergePlans.set(key, {
    keepIndex: Number(keepSelect.value),
    fields,
  });
}

function applyMergeForCurrent() {
  const item = state.queue[state.itemIndex];
  if (!item || item.clinics.length < 2) return;
  saveMergePlanFromDom(item);
  const key = itemKey(item);
  const plan = state.mergePlans.get(key);
  const byIndex = new Map(item.clinics.map(c => [c.featureIndex, c]));
  const sourceFor = pick => byIndex.get(Number(pick)) || item.clinics[0];
  const keepIndex = plan.keepIndex;

  const merged = {
    name: sourceFor(plan.fields.name).name,
    address: sourceFor(plan.fields.address).address,
    state: sourceFor(plan.fields.state).state,
    phone: sourceFor(plan.fields.phone).phone,
    website: sourceFor(plan.fields.website).website,
    service: sourceFor(plan.fields.service).service,
    source: sourceFor(plan.fields.source).source,
  };

  const locSrc = sourceFor(plan.fields.location);
  merged.lon = locSrc.lon;
  merged.lat = locSrc.lat;
  state.mergedOverrides.set(keepIndex, merged);

  for (const clinic of item.clinics) {
    setDecision(clinic.featureIndex, clinic.featureIndex === keepIndex ? "keep" : "remove");
  }

  void saveMergeReview(item, keepIndex, plan.fields, merged);
}

async function saveMergeReview(item, keepIndex, fieldSources, mergedValues) {
  if (!hasSupabase() || !state.reviewerName) return;

  const { error } = await supabaseClient
    .from(SUPABASE_TABLES.mergeReviews)
    .upsert(
      {
        group_key: itemKey(item),
        reviewer_name: state.reviewerName,
        keep_clinic_id: keepIndex,
        field_sources: fieldSources,
        merged_values: mergedValues,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "group_key,reviewer_name" },
    );

  if (error) {
    console.error(`Could not save merge review for group ${itemKey(item)}`, error);
  }
}

function renderCurrentItem() {
  if (!state.queue.length) {
    reviewItem.hidden = false;
    reviewItem.innerHTML = "<p>No review items found for these settings.</p>";
    queueStatus.textContent = "Queue is empty.";
    return;
  }

  if (state.itemIndex < 0) state.itemIndex = 0;
  if (state.itemIndex >= state.queue.length) state.itemIndex = state.queue.length - 1;

  const item = state.queue[state.itemIndex];
  const typeLabel = item.type === "exact"
    ? "Exact duplicate"
    : item.type === "near"
      ? "Near duplicate"
      : item.type === "missing"
        ? "Missing fields"
        : item.type === "edits-pair"
          ? "Suggested duplicate check"
        : item.type === "edits"
          ? "Suggested edit"
        : "Single clinic";

  reviewItem.hidden = false;
  reviewItem.innerHTML = `
    <div class="item-header">
      <div>
        <span class="item-type">${typeLabel}</span>
        <h2>${escapeHtml(item.title)}</h2>
      </div>
      <div class="item-header-actions">
        <button type="button" data-nav="prev">Previous</button>
        <button type="button" data-nav="next">Next</button>
        <p class="item-meta">Item ${state.itemIndex + 1} of ${state.queue.length} | ${escapeHtml(item.meta)}</p>
      </div>
    </div>
    ${quickSearchDeck(item)}
    <div class="clinic-grid">
      ${item.clinics.map(clinicCard).join("\n")}
    </div>
    ${mergePanel(item)}
  `;

  reviewItem.querySelectorAll("button[data-nav]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.nav === "prev") state.itemIndex -= 1;
      if (btn.dataset.nav === "next") state.itemIndex += 1;
      renderCurrentItem();
    });
  });

  reviewItem.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      const featureIndex = Number(btn.dataset.index);
      const action = btn.dataset.action;
      if (action === "apply-merge") {
        applyMergeForCurrent();
        return;
      }
      if (action === "add-custom-label") {
        addCustomLabel(featureIndex);
        return;
      }
      if (action === "toggle-edit") {
        const panel = reviewItem.querySelector(`#clinic-edit-${featureIndex}`);
        panel?.classList.toggle("is-open");
        return;
      }
      if (action === "search-name") {
        openClinicSearch(featureIndex, "name");
        return;
      }
      if (action === "search-address") {
        openClinicSearch(featureIndex, "address");
        return;
      }
      if (action === "search-dialysis-address") {
        openClinicSearch(featureIndex, "dialysis-address");
        return;
      }
      if (action === "search-home-haemodialysis-program") {
        openClinicSearch(featureIndex, "home-haemodialysis-program");
        return;
      }
      if (action === "search-aboriginal-support") {
        openClinicSearch(featureIndex, "aboriginal-support");
        return;
      }
      if (action === "save-edit") {
        saveClinicCardEdit(featureIndex, btn.closest(".clinic-card"));
        return;
      }
      if (action === "cycle-label") {
        cycleLabel(featureIndex);
        return;
      }
      if (action === "toggle-home-program") {
        toggleHomeDialysisProgram(featureIndex);
        return;
      }
      if (action === "toggle-aboriginal-support") {
        setAboriginalSupport(featureIndex, !hasAboriginalSupport(featureIndex));
        void saveClinicMetaReview(featureIndex);
        updateReviewMap();
        renderCurrentItem();
        return;
      }
      if (action === "research-toggle") {
        setDecision(featureIndex, clinicDecision(featureIndex) === DECISIONS.RESEARCH ? DECISIONS.KEEP : DECISIONS.RESEARCH);
        return;
      }
      if (action === "research") {
        setDecision(featureIndex, "research");
        return;
      }
      setDecision(featureIndex, action === "remove" ? "remove" : "keep");
    });
  });

  queueStatus.textContent = `Viewing item ${state.itemIndex + 1} / ${state.queue.length}`;
}

function updateSummary() {
  const total = state.clinics.length;
  let remove = 0;
  let research = 0;
  for (const clinic of state.clinics) {
    const decision = clinicDecision(clinic.featureIndex);
    if (decision === DECISIONS.REMOVE) remove += 1;
    if (decision === DECISIONS.RESEARCH) research += 1;
  }

  sumTotal.textContent = String(total);
  sumRemove.textContent = String(remove);
  sumResearch.textContent = String(research);
  sumKeep.textContent = String(total - remove - research);
  sumItems.textContent = String(state.queue.length);
  sumProcessed.textContent = String(state.touchedClinics.size);
}

// Export helpers

function rebuildQueue() {
  const threshold = thresholdForUrgency();
  state.queue = buildQueue(state.clinics, threshold, !state.redoMode);
  state.itemIndex = 0;
  updateSummary();
  updateReviewMap();
  renderCurrentItem();
}

function buildFreshQueue() {
  state.redoMode = false;
  if (redoListBtn) {
    redoListBtn.classList.remove("is-selected");
  }
  markQueueItemsSeen();
  rebuildQueue();
}

function rebuildRedoQueue() {
  state.redoMode = true;
  if (redoListBtn) {
    redoListBtn.classList.add("is-selected");
  }
  rebuildQueue();
}

function thresholdForUrgency() {
  return URGENCY_THRESHOLDS[state.reviewUrgency] || URGENCY_THRESHOLDS[REVIEW_URGENCY.NON_URGENT];
}

function setReviewUrgency(urgency) {
  state.reviewUrgency = urgency === REVIEW_URGENCY.URGENT ? REVIEW_URGENCY.URGENT : REVIEW_URGENCY.NON_URGENT;
  state.redoMode = false;
  if (redoListBtn) {
    redoListBtn.classList.remove("is-selected");
  }
  if (urgencyNormalBtn) {
    const normalSelected = state.reviewUrgency === REVIEW_URGENCY.NON_URGENT;
    urgencyNormalBtn.classList.toggle("is-selected", normalSelected);
    urgencyNormalBtn.setAttribute("aria-pressed", String(normalSelected));
  }
  if (urgencyUrgentBtn) {
    const urgentSelected = state.reviewUrgency === REVIEW_URGENCY.URGENT;
    urgencyUrgentBtn.classList.toggle("is-selected", urgentSelected);
    urgencyUrgentBtn.setAttribute("aria-pressed", String(urgentSelected));
  }
  if (state.clinics.length) {
    rebuildQueue();
  }
}

function toggleReviewAllMode() {
  state.reviewAllMode = !state.reviewAllMode;
  if (state.reviewAllMode) {
    state.missingFieldsMode = false;
    state.editsMode = false;
  }
  state.redoMode = false;
  if (redoListBtn) {
    redoListBtn.classList.remove("is-selected");
  }
  if (missingFieldsModeBtn) {
    missingFieldsModeBtn.classList.toggle("is-selected", state.missingFieldsMode);
  }
  if (editsModeBtn) {
    editsModeBtn.classList.toggle("is-selected", state.editsMode);
  }
  reviewAllBtn.textContent = state.reviewAllMode ? "Back To Duplicate Review" : "Review All Clinics";
  rebuildQueue();
}

function toggleMissingFieldsMode() {
  state.missingFieldsMode = !state.missingFieldsMode;
  if (state.missingFieldsMode) {
    state.reviewAllMode = false;
    state.editsMode = false;
  }
  state.redoMode = false;
  if (redoListBtn) {
    redoListBtn.classList.remove("is-selected");
  }
  if (missingFieldsModeBtn) {
    missingFieldsModeBtn.classList.toggle("is-selected", state.missingFieldsMode);
  }
  if (editsModeBtn) {
    editsModeBtn.classList.toggle("is-selected", state.editsMode);
  }
  reviewAllBtn.textContent = state.reviewAllMode ? "Back To Duplicate Review" : "Review All Clinics";
  rebuildQueue();
}

function toggleEditsMode() {
  state.editsMode = !state.editsMode;
  if (state.editsMode) {
    state.reviewAllMode = false;
    state.missingFieldsMode = false;
  }
  state.redoMode = false;
  if (redoListBtn) {
    redoListBtn.classList.remove("is-selected");
  }
  if (missingFieldsModeBtn) {
    missingFieldsModeBtn.classList.toggle("is-selected", state.missingFieldsMode);
  }
  if (editsModeBtn) {
    editsModeBtn.classList.toggle("is-selected", state.editsMode);
  }
  reviewAllBtn.textContent = state.reviewAllMode ? "Back To Duplicate Review" : "Review All Clinics";
  rebuildQueue();
}

function resetCurrentItem() {
  const item = state.queue[state.itemIndex];
  if (!item) return;
  for (const clinic of item.clinics) {
    state.decisions.set(clinic.featureIndex, "keep");
    state.labels.set(clinic.featureIndex, inferLabel(clinic));
    state.customTags.delete(clinic.featureIndex);
    state.homeDialysisPrograms.delete(clinic.featureIndex);
    state.aboriginalSupport.delete(clinic.featureIndex);
    state.homeDialysisReviewed.delete(clinic.featureIndex);
    state.aboriginalSupportReviewed.delete(clinic.featureIndex);
    state.mergedOverrides.delete(clinic.featureIndex);
    state.touchedClinics.delete(clinic.featureIndex);
  }
  state.mergePlans.delete(itemKey(item));
  void clearSupabaseStateForItem(item);
  updateSummary();
  setUnsavedChanges(true);
  persistReviewerProgress();
  updateReviewMap();
  renderCurrentItem();
}

async function clearSupabaseStateForItem(item) {
  if (!hasSupabase() || !state.reviewerName) return;

  const clinicIds = item.clinics.map(clinic => clinic.featureIndex);

  const { error: reviewError } = await supabaseClient
    .from(SUPABASE_TABLES.clinicReviews)
    .delete()
    .eq("reviewer_name", state.reviewerName)
    .in("clinic_id", clinicIds);

  if (reviewError) {
    console.error("Could not clear clinic review rows", reviewError);
  }

  const { error: mergeError } = await supabaseClient
    .from(SUPABASE_TABLES.mergeReviews)
    .delete()
    .eq("reviewer_name", state.reviewerName)
    .in("group_key", [itemKey(item), ...clinicIds.map(id => `manual-${id}`), ...clinicIds.map(id => `meta-${id}`)]);

  if (mergeError) {
    console.error("Could not clear merge review row", mergeError);
  }
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildExportAuditSnapshot() {
  const triStateFlag = (isEnabled, wasReviewed) => {
    if (!wasReviewed) return "N/A";
    return Boolean(isEnabled);
  };

  const perClinic = {};
  for (const clinic of state.clinics) {
    const featureIndex = clinic.featureIndex;
    const decision = clinicDecision(featureIndex);
    const needsResearch = decision === DECISIONS.RESEARCH;
    const customTag = getCustomTag(featureIndex);
    const homeDialysisReviewed = state.homeDialysisReviewed.has(featureIndex);
    const aboriginalSupportReviewed = state.aboriginalSupportReviewed.has(featureIndex);
    const homeDialysisProgram = hasHomeDialysisProgram(featureIndex);
    const aboriginalSupport = hasAboriginalSupport(featureIndex);
    const reviewVerified = state.touchedClinics.has(featureIndex)
      || needsResearch
      || homeDialysisReviewed
      || aboriginalSupportReviewed
      || Boolean(customTag)
      || state.mergedOverrides.has(featureIndex);

    perClinic[String(featureIndex)] = {
      decision,
      review_verified: reviewVerified,
      needs_research: reviewVerified ? needsResearch : "N/A",
      home_dialysis_program: triStateFlag(homeDialysisProgram, homeDialysisReviewed),
      aboriginal_support: triStateFlag(aboriginalSupport, aboriginalSupportReviewed),
      custom_tag: customTag || "",
      has_override: state.mergedOverrides.has(featureIndex),
    };
  }

  return {
    homeDialysisReviewed: Array.from(state.homeDialysisReviewed),
    aboriginalSupportReviewed: Array.from(state.aboriginalSupportReviewed),
    perClinic,
  };
}

function exportDecisions() {
  const auditSnapshot = buildExportAuditSnapshot();
  const removed = [];
  const kept = [];
  const research = [];
  for (const clinic of state.clinics) {
    const decision = clinicDecision(clinic.featureIndex);
    if (decision === DECISIONS.REMOVE) removed.push(clinic.featureIndex);
    else if (decision === DECISIONS.RESEARCH) research.push(clinic.featureIndex);
    else kept.push(clinic.featureIndex);
  }
  downloadJson("my_clinic_review_decisions.json", {
    generatedAt: new Date().toISOString(),
    sourceFile: "clinics.geojson",
    reviewerName: state.reviewerName,
    totalClinics: state.clinics.length,
    keepCount: kept.length,
    removeCount: removed.length,
    researchCount: research.length,
    keepFeatureIndexes: kept,
    removeFeatureIndexes: removed,
    researchFeatureIndexes: research,
    labels: Object.fromEntries(state.labels.entries()),
    customTags: Object.fromEntries(state.customTags.entries()),
    homeDialysisPrograms: Array.from(state.homeDialysisPrograms),
    aboriginalSupport: Array.from(state.aboriginalSupport),
    homeDialysisReviewed: auditSnapshot.homeDialysisReviewed,
    aboriginalSupportReviewed: auditSnapshot.aboriginalSupportReviewed,
    mergedOverrides: Object.fromEntries(state.mergedOverrides.entries()),
    exportAudit: {
      exportedAt: new Date().toISOString(),
      reviewerName: state.reviewerName || null,
      perClinic: auditSnapshot.perClinic,
    },
  });
}

async function submitSharedReview() {
  if (!state.reviewerName) {
    reviewerStatus.textContent = "Enter your name before saving your review.";
    return;
  }

  if (!hasSupabase()) {
    const auditSnapshot = buildExportAuditSnapshot();
    const decisions = {};
    for (const clinic of state.clinics) {
      decisions[clinic.featureIndex] = getDecision(clinic.featureIndex);
    }

    downloadJson("clinic_review_backup.json", {
      generatedAt: new Date().toISOString(),
      sourceFile: "clinics.geojson",
      reviewerName: state.reviewerName,
      reviewUrgency: state.reviewUrgency,
      thresholdUsed: thresholdForUrgency(),
      reviewAllMode: state.reviewAllMode,
      itemIndex: state.itemIndex,
      decisions,
      labels: Object.fromEntries(state.labels.entries()),
      customTags: Object.fromEntries(state.customTags.entries()),
      homeDialysisPrograms: Array.from(state.homeDialysisPrograms),
      aboriginalSupport: Array.from(state.aboriginalSupport),
      homeDialysisReviewed: auditSnapshot.homeDialysisReviewed,
      aboriginalSupportReviewed: auditSnapshot.aboriginalSupportReviewed,
      mergedOverrides: Object.fromEntries(state.mergedOverrides.entries()),
      mergePlans: Object.fromEntries(state.mergePlans.entries()),
      exportAudit: {
        exportedAt: new Date().toISOString(),
        reviewerName: state.reviewerName || null,
        perClinic: auditSnapshot.perClinic,
      },
    });

    reviewerStatus.textContent = `${state.reviewerName} | Supabase unavailable, downloaded local backup | clinics processed: ${state.touchedClinics.size}`;
    setUnsavedChanges(false);
    return;
  }

  await syncWholeReviewToSupabase();
  reviewerStatus.textContent = `${state.reviewerName} | saved to shared review | saved edits suggested: ${currentEditCount()} | clinics processed: ${state.touchedClinics.size}`;
  setUnsavedChanges(false);
}

async function syncWholeReviewToSupabase() {
  await ensureReviewerInSupabase(state.reviewerName);

  const clinicRows = buildTouchedClinicRows();

  const mergeRows = Array.from(state.mergePlans.entries()).map(([groupKey, plan]) => ({
    group_key: groupKey,
    reviewer_name: state.reviewerName,
    keep_clinic_id: plan.keepIndex,
    field_sources: plan.fields,
    merged_values: state.mergedOverrides.get(plan.keepIndex) || {},
    updated_at: new Date().toISOString(),
  }));

  const mergeKeepIndexes = new Set(Array.from(state.mergePlans.values()).map(plan => Number(plan.keepIndex)));
  for (const [featureIndex, override] of state.mergedOverrides.entries()) {
    if (mergeKeepIndexes.has(Number(featureIndex))) continue;
    mergeRows.push({
      group_key: `manual-${featureIndex}`,
      reviewer_name: state.reviewerName,
      keep_clinic_id: featureIndex,
      field_sources: {
        name: featureIndex,
        address: featureIndex,
        state: featureIndex,
        phone: featureIndex,
        website: featureIndex,
        service: featureIndex,
        source: featureIndex,
        location: featureIndex,
      },
      merged_values: override,
      updated_at: new Date().toISOString(),
    });
  }

  for (const clinic of state.clinics) {
    const customTag = getCustomTag(clinic.featureIndex);
    const homeDialysisProgram = hasHomeDialysisProgram(clinic.featureIndex);
    const aboriginalSupport = hasAboriginalSupport(clinic.featureIndex);
    const homeDialysisReviewed = state.homeDialysisReviewed.has(clinic.featureIndex);
    const aboriginalSupportReviewed = state.aboriginalSupportReviewed.has(clinic.featureIndex);
    if (!customTag && !homeDialysisReviewed && !aboriginalSupportReviewed && !homeDialysisProgram && !aboriginalSupport) continue;

    mergeRows.push({
      group_key: `meta-${clinic.featureIndex}`,
      reviewer_name: state.reviewerName,
      keep_clinic_id: clinic.featureIndex,
      field_sources: {
        meta: clinic.featureIndex,
      },
      merged_values: {
        customTag,
        homeDialysisProgram,
        aboriginalSupport,
        homeDialysisReviewed,
        aboriginalSupportReviewed,
      },
      home_dialysis_program: homeDialysisProgram,
      aboriginal_support: aboriginalSupport,
      updated_at: new Date().toISOString(),
    });
  }

  if (clinicRows.length > 0) {
    const { error: reviewsError } = await supabaseClient
      .from(SUPABASE_TABLES.clinicReviews)
      .upsert(clinicRows, { onConflict: "clinic_id,reviewer_name" });

    if (reviewsError) {
      console.error("Could not sync clinic reviews to Supabase", reviewsError);
    }
  }

  const { error: clearMetaError } = await supabaseClient
    .from(SUPABASE_TABLES.mergeReviews)
    .delete()
    .eq("reviewer_name", state.reviewerName)
    .like("group_key", "meta-%");

  if (clearMetaError) {
    console.error("Could not clear old meta review rows", clearMetaError);
  }

  if (mergeRows.length > 0) {
    let { error: mergeError } = await supabaseClient
      .from(SUPABASE_TABLES.mergeReviews)
      .upsert(mergeRows, { onConflict: "group_key,reviewer_name" });

    if (mergeError && (isMissingColumnError(mergeError, "home_dialysis_program") || isMissingColumnError(mergeError, "aboriginal_support"))) {
      const fallbackRows = mergeRows.map(withoutMetaColumns);
      ({ error: mergeError } = await supabaseClient
        .from(SUPABASE_TABLES.mergeReviews)
        .upsert(fallbackRows, { onConflict: "group_key,reviewer_name" }));
    }

    if (mergeError) {
      console.error("Could not sync merge reviews to Supabase", mergeError);
    }
  }

  updateReviewerStatus();
}

function exportCleanedGeojson() {
  const triStateFlag = (isEnabled, wasReviewed) => {
    if (!wasReviewed) return "N/A";
    return Boolean(isEnabled);
  };

  const removeSet = new Set();
  for (const clinic of state.clinics) {
    if (clinicDecision(clinic.featureIndex) === DECISIONS.REMOVE) {
      removeSet.add(clinic.featureIndex);
    }
  }
  const patchedFeatures = state.geojson.features
    .map((feature, i) => ({ feature, featureIndex: i + 1 }))
    .filter(({ featureIndex }) => !removeSet.has(featureIndex))
    .map(({ feature, featureIndex }) => {
    const out = structuredClone(feature);
    const label = getLabel(featureIndex);
    const customTag = getCustomTag(featureIndex);
    const decision = clinicDecision(featureIndex);
    const needsResearch = decision === DECISIONS.RESEARCH;
    const homeDialysisReviewed = state.homeDialysisReviewed.has(featureIndex);
    const aboriginalSupportReviewed = state.aboriginalSupportReviewed.has(featureIndex);
    const homeDialysisProgram = hasHomeDialysisProgram(featureIndex);
    const aboriginalSupport = hasAboriginalSupport(featureIndex);
    const hasBeenReviewed = state.touchedClinics.has(featureIndex)
      || needsResearch
      || homeDialysisReviewed
      || aboriginalSupportReviewed
      || Boolean(customTag)
      || state.mergedOverrides.has(featureIndex);

    if (!out.properties) out.properties = {};
    out.properties.category = label;
    if (customTag) {
      out.properties.custom_tag = customTag;
    }
    out.properties.home_dialysis_program = triStateFlag(homeDialysisProgram, homeDialysisReviewed);
    out.properties.aboriginal_support = triStateFlag(aboriginalSupport, aboriginalSupportReviewed);
    out.properties.needs_research = hasBeenReviewed ? needsResearch : "N/A";
    out.properties.review_verified = hasBeenReviewed;
    out.properties.export_audit = {
      exported_at: new Date().toISOString(),
      reviewer_name: state.reviewerName || null,
      decision,
      reviewed: hasBeenReviewed,
      needs_research: hasBeenReviewed ? needsResearch : "N/A",
      home_dialysis_program: triStateFlag(homeDialysisProgram, homeDialysisReviewed),
      aboriginal_support: triStateFlag(aboriginalSupport, aboriginalSupportReviewed),
      has_custom_tag: Boolean(customTag),
      has_override: state.mergedOverrides.has(featureIndex),
    };

    const override = state.mergedOverrides.get(featureIndex);
    if (override) {
      // Preserve all reviewer-entered override fields, not just a fixed subset.
      for (const [key, value] of Object.entries(override)) {
        if (value === undefined || value === null || value === "") continue;
        if (key === "lat" || key === "lon") continue;
        out.properties[key] = value;
      }

      if (override.homeDialysisProgram === true) {
        out.properties.home_dialysis_program = true;
      }
      if (override.homeDialysisProgram === false) {
        out.properties.home_dialysis_program = false;
      }
      if (override.aboriginalSupport === true) {
        out.properties.aboriginal_support = true;
      }
      if (override.aboriginalSupport === false) {
        out.properties.aboriginal_support = false;
      }
      if (override.customTag) {
        out.properties.custom_tag = String(override.customTag).trim().toLowerCase();
      }

      if (!out.geometry) out.geometry = { type: "Point", coordinates: [null, null] };
      if (typeof override.lon === "number" && typeof override.lat === "number") {
        out.geometry.coordinates = [override.lon, override.lat];
      }
    }
    return out;
  });

  downloadJson("updated_clinic_file.geojson", {
    ...state.geojson,
    features: patchedFeatures,
  });
}

function afterLoaded() {
  controls.hidden = false;
  summary.hidden = false;
  if (saveBar) saveBar.hidden = false;
  if (guide) guide.hidden = false;
  rebuildQueue();
  updateReviewerStatus();
  initReviewMap();
}

async function loadReviewerState(name) {
  if (!name) {
    resetAllReviewState();
    rebuildQueue();
    updateReviewerStatus();
    return;
  }

  resetAllReviewState();

  if (!hasSupabase()) {
    rebuildQueue();
    updateReviewerStatus();
    return;
  }

  const { data: reviewRows, error: reviewError } = await supabaseClient
    .from(SUPABASE_TABLES.clinicReviews)
    .select("clinic_id, decision, label")
    .eq("reviewer_name", name);

  if (reviewError) {
    console.error("Could not load clinic reviews from Supabase", reviewError);
  }

  const { data: mergeRows, error: mergeError } = await supabaseClient
    .from(SUPABASE_TABLES.mergeReviews)
    .select("group_key, keep_clinic_id, field_sources, merged_values, home_dialysis_program, aboriginal_support")
    .eq("reviewer_name", name);

  if (mergeError) {
    console.error("Could not load merge reviews from Supabase", mergeError);
  }

  for (const row of reviewRows || []) {
    if (row.decision) {
      state.decisions.set(row.clinic_id, row.decision);
    }
    if (row.label) {
      if (DEFAULT_LABEL_SET.has(row.label)) {
        state.labels.set(row.clinic_id, row.label);
      } else {
        state.customTags.set(row.clinic_id, row.label);
        if (!state.customLabels.includes(row.label)) {
          state.customLabels.push(row.label);
        }
      }
    }
    if (isMeaningfulClinicState(row.clinic_id)) {
      state.touchedClinics.add(row.clinic_id);
    }
  }

  for (const row of mergeRows || []) {
    const isManual = String(row.group_key || "").startsWith("manual-");
    const isMeta = String(row.group_key || "").startsWith("meta-");
    if (isMeta) {
      const customTag = row.merged_values?.customTag;
      const hasHomeDialysisReviewedFlag = Object.prototype.hasOwnProperty.call(row.merged_values || {}, "homeDialysisReviewed");
      const hasAboriginalSupportReviewedFlag = Object.prototype.hasOwnProperty.call(row.merged_values || {}, "aboriginalSupportReviewed");
      const homeDialysisReviewed = hasHomeDialysisReviewedFlag
        ? Boolean(row.merged_values?.homeDialysisReviewed)
        : Boolean(row.home_dialysis_program ?? row.merged_values?.homeDialysisProgram);
      const aboriginalSupportReviewed = hasAboriginalSupportReviewedFlag
        ? Boolean(row.merged_values?.aboriginalSupportReviewed)
        : Boolean(row.aboriginal_support ?? row.merged_values?.aboriginalSupport);
      const homeDialysisProgram = row.home_dialysis_program ?? row.merged_values?.homeDialysisProgram;
      const aboriginalSupport = row.aboriginal_support ?? row.merged_values?.aboriginalSupport;
      if (customTag) {
        state.customTags.set(row.keep_clinic_id, String(customTag).trim().toLowerCase());
      }
      if (homeDialysisReviewed) {
        state.homeDialysisReviewed.add(row.keep_clinic_id);
      }
      if (aboriginalSupportReviewed) {
        state.aboriginalSupportReviewed.add(row.keep_clinic_id);
      }
      if (homeDialysisProgram) {
        state.homeDialysisPrograms.add(row.keep_clinic_id);
      }
      if (aboriginalSupport) {
        state.aboriginalSupport.add(row.keep_clinic_id);
      }
      continue;
    }
    if (!isManual) {
      state.mergePlans.set(row.group_key, {
        keepIndex: row.keep_clinic_id,
        fields: row.field_sources || {},
      });
    }
    if (row.merged_values && row.keep_clinic_id) {
      state.mergedOverrides.set(row.keep_clinic_id, row.merged_values);
      updateClinicFromOverride(row.keep_clinic_id, row.merged_values);
    }
  }

  state.touchedClinics.clear();
  for (const clinic of state.clinics) {
    if (isMeaningfulClinicState(clinic.featureIndex)) {
      state.touchedClinics.add(clinic.featureIndex);
    }
  }

  rebuildQueue();
  updateReviewerStatus();
}

async function loadDefaultGeojson() {
  try {
    loadStatus.textContent = "Loading ../clinics.geojson...";
    const res = await fetch("../clinics.geojson", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geojson = await res.json();
    state.geojson = geojson;
    state.clinics = parseClinics(geojson);
    resetAllReviewState();
    loadStatus.textContent = `Loaded ${state.clinics.length} clinics from ../clinics.geojson`;
    afterLoaded();
    if (state.reviewerName) {
      await loadReviewerState(state.reviewerName);
    }
  } catch (error) {
    loadStatus.textContent = `Could not load ../clinics.geojson automatically (${error.message}). Use the file picker.`;
  }
}

async function loadFromFile(file) {
  if (!file) return;
  const text = await file.text();
  const geojson = JSON.parse(text);
  state.geojson = geojson;
  state.clinics = parseClinics(geojson);
  resetAllReviewState();
  loadStatus.textContent = `Loaded ${state.clinics.length} clinics from ${file.name}`;
  afterLoaded();
  if (state.reviewerName) {
    await loadReviewerState(state.reviewerName);
  }
}

loadDefaultBtn.addEventListener("click", loadDefaultGeojson);
geojsonInput.addEventListener("change", event => loadFromFile(event.target.files[0]));
reviewerNameInput.addEventListener("change", async () => setReviewerName(reviewerNameInput.value));
reviewerSelect.addEventListener("change", async () => setReviewerName(reviewerSelect.value));

rebuildBtn.addEventListener("click", buildFreshQueue);
if (redoListBtn) {
  redoListBtn.addEventListener("click", rebuildRedoQueue);
}
reviewAllBtn.addEventListener("click", toggleReviewAllMode);
if (missingFieldsModeBtn) {
  missingFieldsModeBtn.addEventListener("click", toggleMissingFieldsMode);
}
if (editsModeBtn) {
  editsModeBtn.addEventListener("click", toggleEditsMode);
}
resetItemBtn.addEventListener("click", resetCurrentItem);

if (urgencyNormalBtn) {
  urgencyNormalBtn.addEventListener("click", () => setReviewUrgency(REVIEW_URGENCY.NON_URGENT));
}
if (urgencyUrgentBtn) {
  urgencyUrgentBtn.addEventListener("click", () => setReviewUrgency(REVIEW_URGENCY.URGENT));
}

exportDecisionsBtn.addEventListener("click", () => {
  void submitSharedReview();
});
exportCleanedBtn.addEventListener("click", exportCleanedGeojson);
themeToggleBtn.addEventListener("click", toggleTheme);

loadCustomLabels();
state.reviewUrgency = REVIEW_URGENCY.NON_URGENT;
setReviewUrgency(REVIEW_URGENCY.NON_URGENT);
updateSaveCtaState();
refreshReviewerSelect();
applyTheme(getTheme());
loadDefaultGeojson();
