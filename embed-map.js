// Legacy compatibility shim. Canonical script now lives in maps/embed/embed-map.js.
const legacyScript = document.createElement("script");
legacyScript.src = "./maps/embed/embed-map.js";
document.head.appendChild(legacyScript);
