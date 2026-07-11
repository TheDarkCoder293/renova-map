const STORAGE_KEYS = {
  reviewers: "clinic-reviewer-profiles",
  customLabels: "clinic-reviewer-custom-labels",
};

const MAPBOX_TOKEN = "pk.eyJ1IjoicGI4IiwiYSI6ImNtcmRvc3B1ZzBobDYzMW9kODloMXgza2cifQ.IR7p4ByuDed_uz4pA4KIkw";
const MAP_SOURCE_ID = "review-clinics";
const COMPLETENESS_FIELDS = ["name", "address", "phone", "website", "state", "service"];
const DEFAULT_LABELS = ["hospital", "clinic", "other"];
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
  mergedOverrides: new Map(),
  mergePlans: new Map(),
  reviewAllMode: false,
  reviewUrgency: "non-urgent",
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
const reviewAllBtn = document.getElementById("review-all");
const resetItemBtn = document.getElementById("reset-item");

const saveSessionBtn = document.getElementById("save-session");
const exportDecisionsBtn = document.getElementById("export-decisions");
const exportCleanedBtn = document.getElementById("export-cleaned");
const themeToggleBtn = document.getElementById("theme-toggle");

const REVIEW_URGENCY = {
  NON_URGENT: "non-urgent",
  URGENT: "urgent",
};

const URGENCY_THRESHOLDS = {
  [REVIEW_URGENCY.NON_URGENT]: 0.92,
  [REVIEW_URGENCY.URGENT]: 0.84,
};

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

function currentEditCount() {
  let total = state.mergedOverrides.size;
  for (const decision of state.decisions.values()) {
    if (decision === DECISIONS.REMOVE || decision === DECISIONS.RESEARCH) {
      total += 1;
    }
  }
  return total;
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
  state.mergedOverrides.clear();
  state.mergePlans.clear();
  state.touchedClinics.clear();

  for (const clinic of state.clinics) {
    state.decisions.set(clinic.featureIndex, DECISIONS.KEEP);
    state.labels.set(clinic.featureIndex, inferLabel(clinic));
  }
}

function clinicHasCoordinates(clinic) {
  return clinic.lon != null && clinic.lat != null;
}

function clinicDecision(featureIndex) {
  return state.decisions.get(featureIndex) || DECISIONS.KEEP;
}

function isMeaningfulClinicState(featureIndex, decision = clinicDecision(featureIndex), label = getLabel(featureIndex)) {
  const clinic = state.clinics[featureIndex - 1];
  if (!clinic) return false;
  if (state.mergedOverrides.has(featureIndex)) return true;
  return decision !== DECISIONS.KEEP || label !== inferLabel(clinic);
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

function setLabel(featureIndex, label) {
  state.labels.set(featureIndex, label);
  markClinicTouched(featureIndex);
}

function applyLabel(featureIndex, label) {
  if (!label) return;
  setLabel(featureIndex, label);
  void saveClinicReview(featureIndex);
  updateReviewMap();
  renderCurrentItem();
}

function cycleLabel(featureIndex) {
  const labels = state.customLabels.length ? state.customLabels : DEFAULT_LABELS;
  const currentLabel = getLabel(featureIndex);
  const currentIndex = labels.indexOf(currentLabel);
  const nextLabel = labels[(currentIndex + 1 + labels.length) % labels.length] || labels[0] || "other";
  applyLabel(featureIndex, nextLabel);
}

function addCustomLabel(featureIndex) {
  const label = window.prompt("Enter a custom label for this clinic:");
  const normalized = String(label || "").trim().toLowerCase();
  if (!normalized) return;
  if (!state.customLabels.includes(normalized)) {
    state.customLabels.push(normalized);
    saveCustomLabels();
  }
  applyLabel(featureIndex, normalized);
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

function buildQueue(clinics, threshold) {
  if (state.reviewAllMode) {
    return clinics.map(clinic => ({
      type: "single",
      title: "Single clinic review",
      clinics: [clinic],
      meta: `Feature #${clinic.featureIndex}`,
    }));
  }

  const queue = [];
  const exactMap = new Map();
  for (const clinic of clinics) {
    if (!clinic.normalizedName) continue;
    const list = exactMap.get(clinic.normalizedName) || [];
    list.push(clinic);
    exactMap.set(clinic.normalizedName, list);
  }

  for (const [normalizedName, list] of exactMap.entries()) {
    if (list.length < 2) continue;
    queue.push({
      type: "exact",
      title: `Exact duplicate group: ${normalizedName}`,
      clinics: list,
      meta: `${list.length} matching records`,
    });
  }

  for (let i = 0; i < clinics.length; i += 1) {
    for (let j = i + 1; j < clinics.length; j += 1) {
      const a = clinics[i];
      const b = clinics[j];
      if (!a.normalizedName || !b.normalizedName) continue;
      if (a.normalizedName === b.normalizedName) continue;
      const ratio = similarityDice(a.name, b.name);
      if (ratio < threshold) continue;

      let distance = null;
      if (a.lon != null && a.lat != null && b.lon != null && b.lat != null) {
        distance = haversineKm(a.lon, a.lat, b.lon, b.lat);
      }
      if (distance != null && distance > MAX_DUPLICATE_DISTANCE_KM) continue;

      queue.push({
        type: "near",
        title: "Similar name pair",
        clinics: [a, b],
        meta: `similarity ${ratio.toFixed(3)}${distance != null ? `, distance ${distance.toFixed(3)} km` : ""}`,
      });
    }
  }

  return queue;
}

function setDecision(featureIndex, decision) {
  state.decisions.set(featureIndex, decision);
  markClinicTouched(featureIndex);
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

function clinicCard(clinic) {
  const decision = getDecision(clinic.featureIndex);
  const label = getLabel(clinic.featureIndex);
  const mapLink = clinicHasCoordinates(clinic) ? `https://www.openstreetmap.org/?mlat=${clinic.lat}&mlon=${clinic.lon}#map=16/${clinic.lat}/${clinic.lon}` : "";
  const status = decisionPresentation(decision);
  const keepClass = decision === DECISIONS.KEEP ? "is-selected" : "";
  const removeClass = decision === DECISIONS.REMOVE ? "is-selected" : "";
  const researchClass = decision === DECISIONS.RESEARCH ? "is-selected" : "";
  const researchText = decision === DECISIONS.RESEARCH ? "Needs Research On" : "Mark Needs Research";

  return `
    <article class="clinic-card">
      <button type="button" class="research-flair ${researchClass}" data-action="research-toggle" data-index="${clinic.featureIndex}" aria-label="${escapeHtml(researchText)}" title="${escapeHtml(researchText)}">?</button>
      <div class="clinic-status-row">
        <span class="status-pill ${status.className}">${status.text}</span>
      </div>
      <h3>#${clinic.featureIndex} ${escapeHtml(clinic.name || "(missing name)")}</h3>
      <p><strong>Address:</strong> ${escapeHtml(clinic.address || "(missing)")}</p>
      <p><strong>State:</strong> ${escapeHtml(clinic.state || "(blank)")}</p>
      <p><strong>Phone:</strong> ${escapeHtml(clinic.phone || "(blank)")}</p>
      <p><strong>Website:</strong> ${escapeHtml(clinic.website || "(blank)")}</p>
      <p><strong>Service:</strong> ${escapeHtml(clinic.service || "(blank)")}</p>
      <p><strong>Source:</strong> ${escapeHtml(clinic.source || "(blank)")}</p>
      <p><strong>Location:</strong> ${clinicHasCoordinates(clinic) ? `${clinic.lat}, ${clinic.lon}` : "(missing)"}</p>
      <div class="clinic-utility-row">
        ${mapLink ? `<a class="open-location-btn" href="${mapLink}" target="_blank" rel="noopener noreferrer">Open Location</a>` : "<span></span>"}
        <button type="button" class="label-cycle-btn" data-action="cycle-label" data-index="${clinic.featureIndex}">
          <span class="label-cycle-caption">Click to change category</span>
          <span class="label-cycle-value">${escapeHtml(label.toUpperCase())}</span>
        </button>
      </div>
      <div class="clinic-card-topline">
        <div class="decision-row">
          <button type="button" class="decision-btn ${keepClass}" data-action="keep" data-index="${clinic.featureIndex}">Keep</button>
          <button type="button" class="decision-btn ${removeClass}" data-action="remove" data-index="${clinic.featureIndex}">Remove</button>
        </div>
      </div>
      <div class="clinic-actions">
        <div class="support-row">
          <button type="button" class="support-btn" data-action="add-custom-label" data-index="${clinic.featureIndex}">Add Custom Label</button>
        </div>
      </div>
    </article>
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
  const typeLabel = item.type === "exact" ? "Exact duplicate" : item.type === "near" ? "Near duplicate" : "Single clinic";

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
      if (action === "cycle-label") {
        cycleLabel(featureIndex);
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
  state.queue = buildQueue(state.clinics, threshold);
  state.itemIndex = 0;
  updateSummary();
  updateReviewMap();
  renderCurrentItem();
}

function thresholdForUrgency() {
  return URGENCY_THRESHOLDS[state.reviewUrgency] || URGENCY_THRESHOLDS[REVIEW_URGENCY.NON_URGENT];
}

function setReviewUrgency(urgency) {
  state.reviewUrgency = urgency === REVIEW_URGENCY.URGENT ? REVIEW_URGENCY.URGENT : REVIEW_URGENCY.NON_URGENT;
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
  reviewAllBtn.textContent = state.reviewAllMode ? "Back To Duplicate Review" : "Review All Clinics";
  rebuildQueue();
}

function resetCurrentItem() {
  const item = state.queue[state.itemIndex];
  if (!item) return;
  for (const clinic of item.clinics) {
    state.decisions.set(clinic.featureIndex, "keep");
    state.labels.set(clinic.featureIndex, inferLabel(clinic));
    state.mergedOverrides.delete(clinic.featureIndex);
    state.touchedClinics.delete(clinic.featureIndex);
  }
  state.mergePlans.delete(itemKey(item));
  void clearSupabaseStateForItem(item);
  updateSummary();
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
    .eq("group_key", itemKey(item));

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

function exportDecisions() {
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
    mergedOverrides: Object.fromEntries(state.mergedOverrides.entries()),
  });
}

async function submitSharedReview() {
  if (!state.reviewerName) {
    reviewerStatus.textContent = "Enter your name before submitting your review.";
    return;
  }

  if (!hasSupabase()) {
    reviewerStatus.textContent = "Shared submit is not available until Supabase is connected.";
    return;
  }

  await syncWholeReviewToSupabase();
  reviewerStatus.textContent = `${state.reviewerName} | submitted to shared review | saved edits suggested: ${currentEditCount()} | clinics processed: ${state.touchedClinics.size}`;
}

function saveReviewSession() {
  if (hasSupabase() && state.reviewerName) {
    void syncWholeReviewToSupabase();
    return;
  }

  const decisions = {};
  for (const clinic of state.clinics) {
    decisions[clinic.featureIndex] = getDecision(clinic.featureIndex);
  }
  downloadJson("clinic_review_quicksave.json", {
    generatedAt: new Date().toISOString(),
    sourceFile: "clinics.geojson",
    reviewerName: state.reviewerName,
    reviewUrgency: state.reviewUrgency,
    thresholdUsed: thresholdForUrgency(),
    reviewAllMode: state.reviewAllMode,
    itemIndex: state.itemIndex,
    decisions,
    labels: Object.fromEntries(state.labels.entries()),
    mergedOverrides: Object.fromEntries(state.mergedOverrides.entries()),
    mergePlans: Object.fromEntries(state.mergePlans.entries()),
  });
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

  if (clinicRows.length > 0) {
    const { error: reviewsError } = await supabaseClient
      .from(SUPABASE_TABLES.clinicReviews)
      .upsert(clinicRows, { onConflict: "clinic_id,reviewer_name" });

    if (reviewsError) {
      console.error("Could not sync clinic reviews to Supabase", reviewsError);
    }
  }

  if (mergeRows.length > 0) {
    const { error: mergeError } = await supabaseClient
      .from(SUPABASE_TABLES.mergeReviews)
      .upsert(mergeRows, { onConflict: "group_key,reviewer_name" });

    if (mergeError) {
      console.error("Could not sync merge reviews to Supabase", mergeError);
    }
  }

  updateReviewerStatus();
}

function exportCleanedGeojson() {
  const removeSet = new Set();
  for (const clinic of state.clinics) {
    if (clinicDecision(clinic.featureIndex) === DECISIONS.REMOVE) {
      removeSet.add(clinic.featureIndex);
    }
  }
  const cleanedFeatures = state.geojson.features.filter((_, i) => !removeSet.has(i + 1));
  const patchedFeatures = cleanedFeatures.map(feature => {
    const featureIndex = state.geojson.features.indexOf(feature) + 1;
    const out = structuredClone(feature);
    const label = getLabel(featureIndex);
    if (!out.properties) out.properties = {};
    out.properties.category = label;
    const override = state.mergedOverrides.get(featureIndex);
    if (override) {
      out.properties.name = override.name;
      out.properties.address = override.address;
      out.properties.state = override.state;
      out.properties.phone = override.phone;
      out.properties.website = override.website;
      out.properties.service = override.service;
      out.properties.source = override.source;
      if (!out.geometry) out.geometry = { type: "Point", coordinates: [null, null] };
      out.geometry.coordinates = [override.lon, override.lat];
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
    .select("group_key, keep_clinic_id, field_sources, merged_values")
    .eq("reviewer_name", name);

  if (mergeError) {
    console.error("Could not load merge reviews from Supabase", mergeError);
  }

  for (const row of reviewRows || []) {
    if (row.decision) {
      state.decisions.set(row.clinic_id, row.decision);
    }
    if (row.label) {
      state.labels.set(row.clinic_id, row.label);
      if (!state.customLabels.includes(row.label)) {
        state.customLabels.push(row.label);
      }
    }
    if (isMeaningfulClinicState(row.clinic_id)) {
      state.touchedClinics.add(row.clinic_id);
    }
  }

  for (const row of mergeRows || []) {
    state.mergePlans.set(row.group_key, {
      keepIndex: row.keep_clinic_id,
      fields: row.field_sources || {},
    });
    if (row.merged_values && row.keep_clinic_id) {
      state.mergedOverrides.set(row.keep_clinic_id, row.merged_values);
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

rebuildBtn.addEventListener("click", rebuildQueue);
reviewAllBtn.addEventListener("click", toggleReviewAllMode);
resetItemBtn.addEventListener("click", resetCurrentItem);

if (urgencyNormalBtn) {
  urgencyNormalBtn.addEventListener("click", () => setReviewUrgency(REVIEW_URGENCY.NON_URGENT));
}
if (urgencyUrgentBtn) {
  urgencyUrgentBtn.addEventListener("click", () => setReviewUrgency(REVIEW_URGENCY.URGENT));
}

saveSessionBtn.addEventListener("click", saveReviewSession);
exportDecisionsBtn.addEventListener("click", () => {
  void submitSharedReview();
});
exportCleanedBtn.addEventListener("click", exportCleanedGeojson);
themeToggleBtn.addEventListener("click", toggleTheme);

loadCustomLabels();
state.reviewUrgency = REVIEW_URGENCY.NON_URGENT;
setReviewUrgency(REVIEW_URGENCY.NON_URGENT);
refreshReviewerSelect();
applyTheme(getTheme());
loadDefaultGeojson();
