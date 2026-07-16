// main map setup
mapboxgl.accessToken = "pk.eyJ1IjoicGI4IiwiYSI6ImNtcmRvc3B1ZzBobDYzMW9kODloMXgza2cifQ.IR7p4ByuDed_uz4pA4KIkw"

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [134.5, -25.5],
    zoom: 3.5
});

map.addControl(new mapboxgl.NavigationControl({ showCompass: true, visualizePitch: true }));


// bits of the page we keep updating its all simple except the map directions lol

const locateBtn = document.getElementById("locate-btn");
const searchInput = document.getElementById("search");
const serviceFilter = document.getElementById("service-filter");
const stateFilter = document.getElementById("state-filter");
const app = document.getElementById("app");
const sidebar = document.getElementById("sidebar");
const mapContainer = document.getElementById("map");
const nearestPanel = document.getElementById("nearest-clinic");
const nearestTitle = document.getElementById("nearest-title");
const nearestName = document.getElementById("nearest-name");
const nearestDistance = document.getElementById("nearest-distance");
const routeSummary = document.getElementById("route-summary");
const routeTimes = document.getElementById("route-times");
const mobileSheetToggle = document.getElementById("mobile-sheet-toggle");

const MOBILE_LAYOUT_QUERY = window.matchMedia("(max-width: 900px)");
const TOUCH_LAYOUT_QUERY = window.matchMedia("(hover: none) and (pointer: coarse)");
let sheetExpanded = false;

function isMobileLayout() {
    return MOBILE_LAYOUT_QUERY.matches || TOUCH_LAYOUT_QUERY.matches;
}

function enforceMobileLayoutStyles() {
    if (!app || !sidebar || !mapContainer) return;

    if (!isMobileLayout()) {
        sidebar.style.height = "";
        sidebar.style.minHeight = "";
        sidebar.style.maxHeight = "";
        mapContainer.style.height = "";
        mapContainer.style.minHeight = "";
        mapContainer.style.maxHeight = "";
        sidebar.style.order = "";
        mapContainer.style.order = "";
        return;
    }

    const viewportHeight = Math.max(window.innerHeight || 0, 320);
    const collapsedRatio = viewportHeight <= 700 ? 0.5 : 0.46;
    const expandedRatio = viewportHeight <= 700 ? 0.82 : 0.78;

    const sheetHeight = Math.round(viewportHeight * (sheetExpanded ? expandedRatio : collapsedRatio));
    const mapHeight = Math.max(160, viewportHeight - sheetHeight);

    sidebar.style.order = "2";
    mapContainer.style.order = "1";
    sidebar.style.height = `${sheetHeight}px`;
    sidebar.style.minHeight = `${sheetHeight}px`;
    sidebar.style.maxHeight = `${sheetHeight}px`;
    mapContainer.style.height = `${mapHeight}px`;
    mapContainer.style.minHeight = "160px";
    mapContainer.style.maxHeight = `${mapHeight}px`;
}

function updateSheetLabel() {
    if (!mobileSheetToggle) return;
    const label = mobileSheetToggle.querySelector('.sheet-label');
    mobileSheetToggle.setAttribute('aria-expanded', sheetExpanded ? 'true' : 'false');
    if (label) {
        label.textContent = sheetExpanded ? 'Collapse dashboard' : 'Expand dashboard';
    }
}

function syncMapAfterSheetChange() {
    enforceMobileLayoutStyles();
    requestAnimationFrame(() => map.resize());
    window.setTimeout(() => map.resize(), 260);
}

function applySheetState(expanded) {
    sheetExpanded = Boolean(expanded);
    document.body.classList.toggle('sheet-expanded', sheetExpanded);
    updateSheetLabel();
    syncMapAfterSheetChange();
}

function handleLayoutBreakpoint() {
    if (!MOBILE_LAYOUT_QUERY.matches) {
        sheetExpanded = false;
        document.body.classList.remove('sheet-expanded');
    }
    updateSheetLabel();
    syncMapAfterSheetChange();
}

if (mobileSheetToggle) {
    updateSheetLabel();
    mobileSheetToggle.addEventListener('click', () => {
        applySheetState(!sheetExpanded);
    });
}

if (typeof MOBILE_LAYOUT_QUERY.addEventListener === 'function') {
    MOBILE_LAYOUT_QUERY.addEventListener('change', handleLayoutBreakpoint);
} else if (typeof MOBILE_LAYOUT_QUERY.addListener === 'function') {
    MOBILE_LAYOUT_QUERY.addListener(handleLayoutBreakpoint);
}

if (typeof TOUCH_LAYOUT_QUERY.addEventListener === 'function') {
    TOUCH_LAYOUT_QUERY.addEventListener('change', handleLayoutBreakpoint);
} else if (typeof TOUCH_LAYOUT_QUERY.addListener === 'function') {
    TOUCH_LAYOUT_QUERY.addListener(handleLayoutBreakpoint);
}

window.addEventListener('orientationchange', () => {
    syncMapAfterSheetChange();
});

window.addEventListener('resize', () => {
    if (isMobileLayout()) {
        syncMapAfterSheetChange();
    }
});

syncMapAfterSheetChange();

const clinics = [];
let activePopup = null;
let currentLocation = null;

function toRadians(degrees) {
    return degrees * Math.PI / 180;
}

function parseSuburbState(address, state) {
    if (!address && !state) return '';
    const parts = (address || '').split(',').map(part => part.trim()).filter(Boolean);
    let suburb = '';
    if (parts.length >= 2) {
        suburb = parts[1];
    } else if (parts.length === 1) {
        suburb = parts[0];
    }
    const stateCode = parseStateCode(address, state);
    if (stateCode) {
        return suburb ? `${suburb}, ${stateCode}` : stateCode;
    }
    if (parts.length >= 3) {
        return `${suburb}, ${parts[2].split(' ')[0]}`;
    }
    return suburb;
}

function parseStateCode(address, state) {
    if (state && state.trim()) {
        return state.trim().toUpperCase();
    }
    if (!address) {
        return '';
    }
    const match = address.match(/\b(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\b/i);
    return match ? match[1].toUpperCase() : '';
}

function formatWebsiteUrl(url) {
    if (!url) return null;
    const value = url.trim();
    if (!value) return null;
    if (/^javascript:/i.test(value) || /^data:/i.test(value)) {
        return null;
    }
    const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    if (isMapUrl(normalized)) {
        return null;
    }
    return normalized;
}

function isMapUrl(url) {
    return /(google\.com\/maps|apple\.com\/maps|openstreetmap\.org|bing\.com\/maps|mapbox\.com)/i.test(url);
}

function haversineDistance([lon1, lat1], [lon2, lat2]) {
    const R = 6371;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function hideRouteSummary() {
    if (routeSummary) {
        routeSummary.style.display = "none";
    }
    if (routeTimes) {
        routeTimes.textContent = "";
    }
}

function removeRouteLayer() {
    if (map.getLayer("route")) {
        map.removeLayer("route");
    }
    if (map.getSource("route")) {
        map.removeSource("route");
    }
    hideRouteSummary();
}

function setRouteSummary(text) {
    if (routeSummary) {
        routeSummary.style.display = "block";
    }
    if (routeTimes) {
        routeTimes.textContent = text;
    }
}

function updateSelectedClinicDistance(clinic, title = "Nearest Clinic") {
    if (!nearestPanel || !nearestTitle || !nearestName || !nearestDistance) return;

    nearestPanel.style.display = "block";
    nearestTitle.textContent = title;
    nearestName.textContent = clinic.feature.properties.name;
    hideRouteSummary();

    if (!currentLocation) {
        nearestDistance.textContent = "Distance: tap Find My Location first.";
        return;
    }

    const distance = haversineDistance(currentLocation, clinic.coordinates);
    nearestDistance.textContent = `Distance: ${distance.toFixed(1)} km away`;
}

fetch("clinics.geojson", { cache: "reload" })
    .then(response => response.json())
    .then(data => {
        console.log('Loaded clinics.geojson', data.features?.length, 'features');
        console.log(data);

        data.features.forEach(feature => {
            console.log(feature.properties.name);

            const websiteUrl = formatWebsiteUrl(feature.properties.website);
            const suburbState = parseSuburbState(feature.properties.address, feature.properties.state);
            const popup = new mapboxgl.Popup({ offset: [0, -25], anchor: 'bottom', closeOnClick: true, maxWidth: '320px' }).setHTML(`
                <div class="clinic-card">

                <h2>${feature.properties.name}</h2>

                <p><strong>Service</strong><br>
                ${feature.properties.service}</p>

                <p><strong>Address</strong><br>
                ${feature.properties.address}</p>

                <p><strong>Location</strong><br>
                ${suburbState || 'Unknown'}</p>

                <p><strong>Phone</strong><br>
                ${feature.properties.phone ? `${feature.properties.phone}` : 'N/A'}</p>

                ${feature.properties.phone ? `<p><a class="call-button" href="tel:${feature.properties.phone}">📞 Call Clinic</a></p>` : ''}

                <div class="directions-row">
                    <button class="directions-toggle" type="button" aria-expanded="false">Directions up to you</button>
                    <div class="directions-menu">
                        <button class="route-button" type="button">🧭 Show Route</button>
                        <a class="directions-button google" href="https://www.google.com/maps/dir/?api=1&destination=${feature.geometry.coordinates[1]},${feature.geometry.coordinates[0]}" target="_blank" rel="noopener noreferrer">
                            Google Maps
                        </a>
                        <a class="directions-button apple" href="https://maps.apple.com/?daddr=${feature.geometry.coordinates[1]},${feature.geometry.coordinates[0]}" target="_blank" rel="noopener noreferrer">
                            Apple Maps
                        </a>
                    </div>
                </div>
${feature.properties.parking ? `<p><strong>Parking</strong><br>${feature.properties.parking}</p>` : ''}

                ${websiteUrl ? `<p><a class="website-link" href="${websiteUrl}" target="_blank" rel="noopener noreferrer">Visit website</a></p>` : ''}

                </div>
            `);

            const marker = new mapboxgl.Marker({ color: "#675196" })
                .setLngLat(feature.geometry.coordinates)
                .setPopup(popup)
                .addTo(map);

            marker.getElement().classList.add("clinic-marker-bob");
            marker.getElement().setAttribute("aria-label", `Open ${feature.properties.name}`);

            clinics.push({
                marker: marker,
                popup: popup,
                feature: feature,
                coordinates: feature.geometry.coordinates
            });

            popup.on('open', () => {
                if (activePopup && activePopup !== popup) {
                    activePopup.remove();
                }
                activePopup = popup;
                map.flyTo({ center: feature.geometry.coordinates, zoom: 14, offset: [0, 130], duration: 4000, speed: 0.3, curve: 1.5, essential: true });
                updateSelectedClinicDistance({ feature, coordinates: feature.geometry.coordinates }, "Selected Clinic");

                const routeButton = popup.getElement().querySelector('.route-button');
                const toggleButton = popup.getElement().querySelector('.directions-toggle');
                const directionsMenu = popup.getElement().querySelector('.directions-menu');

                if (toggleButton && directionsMenu) {
                    directionsMenu.classList.remove('show');
                    toggleButton.setAttribute('aria-expanded', 'false');

                    if (!toggleButton.dataset.bound) {
                        toggleButton.dataset.bound = 'true';
                        toggleButton.addEventListener('click', () => {
                            const expanded = toggleButton.getAttribute('aria-expanded') === 'true';
                            toggleButton.setAttribute('aria-expanded', String(!expanded));
                            directionsMenu.classList.toggle('show');
                        });
                    }
                }

                if (routeButton && !routeButton.dataset.bound) {
                    routeButton.dataset.bound = 'true';
                    routeButton.addEventListener('click', async (event) => {
                        event.preventDefault();
                        if (!currentLocation) {
                            alert('Please tap Find My Location first to calculate a route.');
                            return;
                        }

                        try {
                            const driveTrip = await getRoute(currentLocation, feature.geometry.coordinates, "driving");
                            const walkTrip = await getRoute(currentLocation, feature.geometry.coordinates, "walking");
                            setRouteSummary(`Drive: ${driveTrip.kilometres} km • 🚗 ${driveTrip.minutes} min — Walk: 🚶 ${walkTrip.minutes} min`);
                        } catch (error) {
                            console.error('Route fetch failed:', error);
                            alert('Could not load the route. Try again later.');
                        }
                    });
                }
            });
            popup.on('close', () => {
                if (activePopup === popup) {
                    activePopup = null;
                }
            });

            marker.getElement().addEventListener('click', () => {
                if (activePopup && activePopup !== popup) {
                    activePopup.remove();
                }
                map.flyTo({ center: feature.geometry.coordinates, zoom: 14, offset: [0, 120], duration: 4000, speed: 0.3, curve: 1.5, essential: true });
                popup.addTo(map);
                updateSelectedClinicDistance({ feature, coordinates: feature.geometry.coordinates });
            });

            const clinicList = document.getElementById("clinic-list");
            const clinicItem = document.createElement("div");
            clinicItem.className = "clinic-item";
            const stateCode = parseStateCode(feature.properties.address, feature.properties.state);
            // makes the sidebar search a bit easier
            clinicItem.dataset.name = feature.properties.name.toLowerCase();
            clinicItem.dataset.state = stateCode.toLowerCase();
            clinicItem.dataset.service = feature.properties.service.toLowerCase();
            clinicItem.dataset.address = feature.properties.address.toLowerCase();
            const locationLabel = parseSuburbState(feature.properties.address, feature.properties.state);
            clinicItem.innerHTML = `
                <strong>${feature.properties.name}</strong>
                <span>${locationLabel || feature.properties.state || ''}</span>
                <span>${feature.properties.service}</span>
            `;
            clinicItem.addEventListener("click", () => {
                if (activePopup && activePopup !== popup) {
                    activePopup.remove();
                }
                map.flyTo({
                    center: feature.geometry.coordinates,
                    zoom: 14,
                    offset: [0, 120],
                    duration: 4000,
                    speed: 0.3,
                    curve: 1.5,
                    essential: true
                });
                popup.addTo(map);
                updateSelectedClinicDistance({ feature, coordinates: feature.geometry.coordinates }, "Selected Clinic");
            });
            clinicList.appendChild(clinicItem);
        });

        // basic filtering for the sidebar cards
        searchInput.addEventListener("input", filterClinics);
        serviceFilter.addEventListener("change", filterClinics);
        stateFilter.addEventListener("change", filterClinics);

        document.addEventListener('click', event => {
            if (!event.target.closest('.mapboxgl-popup')) {
                removeRouteLayer();
                document.querySelectorAll('.directions-menu.show').forEach(menu => {
                    menu.classList.remove('show');
                    const toggle = menu.closest('.mapboxgl-popup')?.querySelector('.directions-toggle');
                    if (toggle) {
                        toggle.setAttribute('aria-expanded', 'false');
                    }
                });
            }
        });

        function filterClinics() {
            const search = searchInput.value.toLowerCase();
            const service = serviceFilter.value.toLowerCase();
            const state = stateFilter.value.toLowerCase();
            const cards = document.querySelectorAll(".clinic-item");

            cards.forEach(card => {
                const matchesSearch =
                    card.dataset.name.includes(search) ||
                    card.dataset.state.includes(search) ||
                    card.dataset.service.includes(search) ||
                    card.dataset.address.includes(search);

                const matchesService =
                    service === "" ||
                    card.dataset.service.toLowerCase() === service;

                const matchesState =
                    state === "" ||
                    card.dataset.state.toLowerCase() === state;

                card.style.display =
                    matchesSearch && matchesService && matchesState
                        ? ""
                        : "none";
            });
        }
    });
let userMarker = null;

async function getRoute(start, end, profile) {
    const url =
        `https://api.mapbox.com/directions/v5/mapbox/${profile}/` +
        `${start[0]},${start[1]};${end[0]},${end[1]}` +
        `?geometries=geojson&overview=full&access_token=${mapboxgl.accessToken}`;

    const response = await fetch(url);
    const data = await response.json();

    if (!data.routes || !data.routes[0]) {
        throw new Error('No route returned from Mapbox directions API');
    }

    const route = data.routes[0].geometry;

    if (map.getSource("route")) {
        map.getSource("route").setData({
            type: "Feature",
            geometry: route
        });
    } else {
        map.addLayer({
            id: "route",
            type: "line",
            source: {
                type: "geojson",
                data: {
                    type: "Feature",
                    geometry: route
                }
            },
            paint: {
                "line-color": "#eac247",
                "line-width": 6,
                "line-opacity": 0.95
            }
        });
    }

    const bounds = new mapboxgl.LngLatBounds();
    route.coordinates.forEach(coord => bounds.extend(coord));
    map.fitBounds(bounds, {
        padding: 80
    });

    return {
        minutes: Math.round(data.routes[0].duration / 60),
        kilometres: (data.routes[0].distance / 1000).toFixed(1)
    };
}

locateBtn.addEventListener("click", () => {

    if (!navigator.geolocation) {
        alert("Geolocation isn't supported.");
        return;
    }

    navigator.geolocation.getCurrentPosition(async position => {

        const lng = position.coords.longitude;
        const lat = position.coords.latitude;

        if (userMarker) userMarker.remove();

        userMarker = new mapboxgl.Marker({
            color: "#eac247"
        })
            .setLngLat([lng, lat])
            .addTo(map);

        map.flyTo({
            center: [lng, lat],
            zoom: 11,
            duration: 4000,
            speed: 0.3,
            curve: 1.5,
            essential: true
        });

        if (!clinics.length) {
            console.warn('No clinic data available to find nearest clinic.');
            return;
        }

        let nearest = null;
        let shortestDistance = Infinity;

        clinics.forEach(clinic => {
            const distance = haversineDistance([lng, lat], clinic.coordinates);
            if (distance < shortestDistance) {
                shortestDistance = distance;
                nearest = clinic;
            }
        });

        if (!nearest) {
            console.warn('Could not determine nearest clinic.');
            return;
        }

        console.log('Nearest clinic:', nearest.feature.properties.name, 'distance_km=', shortestDistance.toFixed(2));

        currentLocation = [lng, lat];

        updateSelectedClinicDistance(nearest, "Nearest Clinic");

        if (activePopup && activePopup !== nearest.popup) {
            activePopup.remove();
        }
        nearest.popup.addTo(map);
        activePopup = nearest.popup;

        currentLocation = [lng, lat];
        hideRouteSummary();
    });
});