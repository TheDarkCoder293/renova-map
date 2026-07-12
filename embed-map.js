mapboxgl.accessToken = "pk.eyJ1IjoicGI4IiwiYSI6ImNtcmRvc3B1ZzBobDYzMW9kODloMXgza2cifQ.IR7p4ByuDed_uz4pA4KIkw";

const query = new URLSearchParams(window.location.search);
const EMBED_OPTIONS = {
  view: query.get("view") || "default",
  ui: query.get("ui") || "default",
  showControls: query.get("controls") !== "0",
  showAttribution: query.get("attribution") !== "0",
  interactive: query.get("interactive") !== "0",
  hideLabels: query.get("labels") === "0" || query.get("ui") === "clean",
};

if (EMBED_OPTIONS.ui === "clean") {
  EMBED_OPTIONS.showControls = false;
}

document.body.dataset.view = EMBED_OPTIONS.view;
document.body.dataset.ui = EMBED_OPTIONS.ui;

const AU_BOUNDS = [
  [112.0, -44.8],
  [154.6, -9.0],
];

const map = new mapboxgl.Map({
  container: "embed-map",
  style: "mapbox://styles/mapbox/dark-v11",
  center: [134.5, -25.5],
  zoom: 3.2,
  attributionControl: EMBED_OPTIONS.showAttribution,
  cooperativeGestures: false,
  interactive: EMBED_OPTIONS.interactive,
});

window.renovaEmbedMap = map;

if (EMBED_OPTIONS.showControls) {
  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
}

function hideBaseLabels() {
  const style = map.getStyle();
  for (const layer of style.layers || []) {
    if (layer.type !== "symbol") continue;
    if (!map.getLayer(layer.id)) continue;
    map.setLayoutProperty(layer.id, "visibility", "none");
  }
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function haversineDistanceKm(a, b) {
  const R = 6371;
  const dLat = toRadians(b[1] - a[1]);
  const dLon = toRadians(b[0] - a[0]);
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function buildConnectionFeatures(points, nearestCount = 2, maxDistanceKm = 1400) {
  const features = [];
  const seen = new Set();

  for (let i = 0; i < points.length; i += 1) {
    const source = points[i];
    const distances = [];

    for (let j = 0; j < points.length; j += 1) {
      if (i === j) continue;
      const target = points[j];
      const distance = haversineDistanceKm(source.geometry.coordinates, target.geometry.coordinates);
      if (distance <= maxDistanceKm) {
        distances.push({ index: j, distance });
      }
    }

    distances.sort((a, b) => a.distance - b.distance);

    const localNeighbours = distances.filter(candidate => candidate.distance <= 360).length;
    const targetCount = localNeighbours >= 8 ? 6 : localNeighbours >= 4 ? 4 : nearestCount;
    const dynamicMaxDistance = localNeighbours >= 8 ? 560 : localNeighbours >= 4 ? 860 : maxDistanceKm;

    for (const candidate of distances.slice(0, targetCount)) {
      if (candidate.distance > dynamicMaxDistance) continue;
      const low = Math.min(i, candidate.index);
      const high = Math.max(i, candidate.index);
      const edgeKey = `${low}-${high}`;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);

      features.push({
        type: "Feature",
        properties: {
          distanceKm: Number(candidate.distance.toFixed(1)),
        },
        geometry: {
          type: "LineString",
          coordinates: [
            source.geometry.coordinates,
            points[candidate.index].geometry.coordinates,
          ],
        },
      });
    }
  }

  return features;
}

function addNetworkLayers(clinicFeatures) {
  const clinics = {
    type: "FeatureCollection",
    features: clinicFeatures,
  };

  const connections = {
    type: "FeatureCollection",
    features: buildConnectionFeatures(clinicFeatures),
  };

  map.addSource("clinic-network-lines", {
    type: "geojson",
    data: connections,
  });

  map.addLayer({
    id: "clinic-network-lines-shadow",
    type: "line",
    source: "clinic-network-lines",
    paint: {
      "line-color": "#211405",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 2.2, 8, 4.6],
      "line-opacity": 0.52,
      "line-blur": 1.15,
      "line-translate": [0.4, 1.8],
    },
  });

  map.addLayer({
    id: "clinic-network-lines-shadow-inner",
    type: "line",
    source: "clinic-network-lines",
    paint: {
      "line-color": "#5f4312",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.35, 8, 2.9],
      "line-opacity": 0.34,
      "line-blur": 0.6,
      "line-translate": [0.2, 0.9],
    },
  });

  map.addLayer({
    id: "clinic-network-lines-glow",
    type: "line",
    source: "clinic-network-lines",
    paint: {
      "line-color": "#ffe7a8",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 3, 8, 6.8],
      "line-opacity": 0.38,
      "line-blur": 2.05,
    },
  });

  map.addLayer({
    id: "clinic-network-lines-core",
    type: "line",
    source: "clinic-network-lines",
    paint: {
      "line-color": "#ffd05c",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.15, 8, 2.55],
      "line-opacity": 0.82,
    },
  });

  map.addLayer({
    id: "clinic-network-lines-highlight",
    type: "line",
    source: "clinic-network-lines",
    paint: {
      "line-color": "#fff2c9",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.55, 8, 1.2],
      "line-opacity": 0.74,
      "line-blur": 0.2,
      "line-translate": [-0.8, -0.9],
    },
  });

  map.addLayer({
    id: "clinic-network-lines-specular",
    type: "line",
    source: "clinic-network-lines",
    paint: {
      "line-color": "#fff9e9",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.18, 8, 0.55],
      "line-opacity": 0.48,
      "line-blur": 0,
      "line-translate": [-1.1, -1.1],
    },
  });

  map.addSource("clinic-lights", {
    type: "geojson",
    data: clinics,
  });

  map.addLayer({
    id: "clinic-lights-glow",
    type: "circle",
    source: "clinic-lights",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 9, 8, 19],
      "circle-color": "#ffd777",
      "circle-opacity": 0.48,
      "circle-blur": 1,
    },
  });

  map.addLayer({
    id: "clinic-lights-core",
    type: "circle",
    source: "clinic-lights",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2.8, 8, 6.2],
      "circle-color": "#ffe08f",
      "circle-stroke-color": "#fff5d6",
      "circle-stroke-width": 1.2,
      "circle-opacity": 0.98,
    },
  });
}

function setPaintIfLayerExists(layerId, property, value) {
  if (!map.getLayer(layerId)) return;
  try {
    map.setPaintProperty(layerId, property, value);
  } catch {
    // Some mapbox layers may not support a paint property across style revisions.
  }
}

function addAustraliaContrastLayers() {
  setPaintIfLayerExists("water", "fill-color", "#090f1f");
  setPaintIfLayerExists("water", "fill-opacity", 0.96);
  setPaintIfLayerExists("land", "background-color", "#1b1a16");
  setPaintIfLayerExists("land", "background-opacity", 1);
  setPaintIfLayerExists("landuse", "fill-color", "#262219");
  setPaintIfLayerExists("landuse", "fill-opacity", 0.34);
  setPaintIfLayerExists("land-structure-polygon", "fill-color", "#2c271a");
  setPaintIfLayerExists("land-structure-polygon", "fill-opacity", 0.34);
  setPaintIfLayerExists("admin-1-boundary", "line-color", "#6a5d35");
  setPaintIfLayerExists("admin-1-boundary", "line-opacity", 0.26);
  setPaintIfLayerExists("admin-1-boundary-bg", "line-color", "#12100a");
  setPaintIfLayerExists("admin-1-boundary-bg", "line-opacity", 0.36);

  if (!map.getLayer("australia-outline-highlight")) {
    map.addLayer({
      id: "australia-outline-highlight",
      type: "line",
      source: "composite",
      "source-layer": "admin",
      filter: [
        "any",
        ["==", ["get", "name_en"], "Australia"],
        ["==", ["get", "name"], "Australia"],
      ],
      paint: {
        "line-color": "#f6dea0",
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.2, 8, 2.2],
        "line-opacity": 0.5,
        "line-blur": 0.25,
      },
    });
  }
}

function startShimmer() {
  const step = () => {
    if (!map.getLayer("clinic-lights-glow") || !map.getLayer("clinic-network-lines-glow")) {
      requestAnimationFrame(step);
      return;
    }

    const t = performance.now() * 0.001;
    const pulseA = (Math.sin((Math.PI * 2 * t) / 10) + 1) / 2;
    const pulseB = (Math.sin((Math.PI * 2 * t) / 16 + 1.2) + 1) / 2;

    map.setPaintProperty("clinic-lights-glow", "circle-opacity", 0.34 + pulseA * 0.26);
    map.setPaintProperty("clinic-lights-glow", "circle-blur", 0.85 + pulseB * 0.5);

    map.setPaintProperty("clinic-network-lines-shadow", "line-opacity", 0.42 + pulseB * 0.14);
    map.setPaintProperty("clinic-network-lines-shadow-inner", "line-opacity", 0.26 + pulseA * 0.12);
    map.setPaintProperty("clinic-network-lines-glow", "line-opacity", 0.24 + pulseB * 0.28);
    map.setPaintProperty("clinic-network-lines-core", "line-opacity", 0.58 + pulseA * 0.24);
    map.setPaintProperty("clinic-network-lines-highlight", "line-opacity", 0.56 + pulseA * 0.18);
    map.setPaintProperty("clinic-network-lines-specular", "line-opacity", 0.34 + pulseB * 0.2);

    if (map.getLayer("australia-outline-highlight")) {
      map.setPaintProperty("australia-outline-highlight", "line-opacity", 0.26 + pulseA * 0.24);
    }

    requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
}

function fitToAustralia() {
  map.fitBounds(AU_BOUNDS, {
    padding: {
      top: 18,
      right: 18,
      bottom: 18,
      left: 18,
    },
    duration: 0,
  });
}

map.on("load", async () => {
  fitToAustralia();

  if (EMBED_OPTIONS.hideLabels) {
    hideBaseLabels();
  }

  map.setFog({
    color: "#0f1220",
    "high-color": "#19223a",
    "horizon-blend": 0.12,
    "space-color": "#070914",
    "star-intensity": 0.15,
  });

  addAustraliaContrastLayers();

  try {
    const response = await fetch("clinics.geojson", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const geojson = await response.json();
    const clinicFeatures = (geojson.features || [])
      .filter(feature => feature?.geometry?.type === "Point")
      .filter(feature => {
        const [lon, lat] = feature.geometry.coordinates || [];
        return Number.isFinite(Number(lon)) && Number.isFinite(Number(lat));
      })
      .map(feature => ({
        type: "Feature",
        properties: {
          name: feature.properties?.name || "Clinic",
        },
        geometry: {
          type: "Point",
          coordinates: [
            Number(feature.geometry.coordinates[0]),
            Number(feature.geometry.coordinates[1]),
          ],
        },
      }));

    addNetworkLayers(clinicFeatures);
    startShimmer();
  } catch (error) {
    console.error("Could not load clinics.geojson for embed map", error);
  }
});

window.addEventListener("resize", () => {
  map.resize();
});
