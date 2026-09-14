(() => {
  "use strict";

  const DATA_URLS = ["../data/tad_data.json", "data/tad_data.json", "./data/tad_data.json", "../data/tad_data.example.json", "data/tad_data.example.json"];
  const GEOCODER_URL = "https://nominatim.openstreetmap.org/search";
  const state = {
    data: null,
    map: null,
    markerLayer: null,
    shapesLayer: null,
    legacyLayer: null,
    queryLayer: null,
    markerByStopId: new Map(),
    stops: [],
    routes: [],
    routeById: new Map(),
    filters: { search: "", territory: "", route: "" },
    search: {
      selectedAddress: null,
      nearby: [],
      addressSuggestions: [],
      addressCache: new Map(),
      geocodeController: null,
      geocodeTimer: null,
      requestToken: 0,
      loading: false
    }
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    search: $("search-input"),
    searchState: $("search-state"),
    searchSuggestions: $("search-suggestions"),
    clearSearch: $("clear-search-button"),
    nearbyResults: $("nearby-results"),
    nearbyTitle: $("nearby-title"),
    nearbyNote: $("nearby-note"),
    nearbyList: $("nearby-list"),
    territory: $("territory-select"),
    route: $("route-select"),
    routes: $("route-list"),
    stops: $("stop-list"),
    routeCount: $("route-count"),
    stopCount: $("stop-count"),
    statsStops: $("stat-stops"),
    statsRoutes: $("stat-routes"),
    statsTerritories: $("stat-territories"),
    source: $("data-source"),
    status: $("map-status"),
    exportDialog: $("export-dialog"),
    detailDialog: $("detail-dialog"),
    detailContent: $("detail-content")
  };

  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;"
  }[char]));
  const normalize = (value) => String(value == null ? "" : value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const displayRoute = (route) => route && (route.short_name || route.name || route.id) || "TAD";
  const stopRoutes = (stop) => (stop.route_ids || []).map((id) => state.routeById.get(id)).filter(Boolean);
  const routeNames = (stop) => stopRoutes(stop).map(displayRoute).join(" · ");
  const showStatus = (message, timeout) => {
    els.status.textContent = message;
    els.status.classList.add("show");
    window.clearTimeout(showStatus.timer);
    showStatus.timer = window.setTimeout(() => els.status.classList.remove("show"), timeout || 3000);
  };

  async function loadData() {
    let lastError;
    for (const url of DATA_URLS) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(response.status + " " + response.statusText);
        return await response.json();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Données introuvables");
  }

  function setupMap() {
    state.map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([48.65, 2.35], 9);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors"
    }).addTo(state.map);
    state.markerLayer = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 42, spiderfyOnMaxZoom: true });
    state.shapesLayer = L.layerGroup().addTo(state.map);
    state.legacyLayer = L.layerGroup().addTo(state.map);
    state.queryLayer = L.layerGroup().addTo(state.map);
    state.map.addLayer(state.markerLayer);
  }

  function prepareData(data) {
    state.data = data || {};
    state.routes = Array.isArray(data.routes) ? data.routes : [];
    state.stops = Array.isArray(data.stops) ? data.stops : [];
    state.routeById = new Map(state.routes.map((route) => [route.id, route]));
  }

  function populateFilters() {
    const territories = [...new Set(state.routes.map((route) => route.territory).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
    els.territory.innerHTML = "<option value=\"\">Tous les territoires</option>" + territories.map((territory) => "<option value=\"" + escapeHtml(territory) + "\">" + escapeHtml(territory) + "</option>").join("");
    els.route.innerHTML = "<option value=\"\">Toutes les lignes</option>" + state.routes.slice().sort((a, b) => displayRoute(a).localeCompare(displayRoute(b), "fr", { numeric: true })).map((route) => "<option value=\"" + escapeHtml(route.id) + "\">" + escapeHtml(displayRoute(route)) + " — " + escapeHtml(route.territory || "TAD") + "</option>").join("");
  }

  function stopHaystack(stop) {
    return normalize([stop.name, stop.code].concat(stopRoutes(stop).flatMap((route) => [route.short_name, route.name, route.territory])).join(" "));
  }

  function localStopSuggestions(query) {
    const needle = normalize(query);
    if (!needle) return [];
    return state.stops.map((stop) => {
      const haystack = stopHaystack(stop);
      const name = normalize(stop.name);
      let score = haystack.includes(needle) ? 40 : 0;
      if (name.startsWith(needle)) score += 60;
      if (name === needle) score += 100;
      return { stop, score };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.stop.name.localeCompare(b.stop.name, "fr")).slice(0, 8).map((item) => item.stop);
  }

  function filteredStops() {
    const query = normalize(state.filters.search);
    const nearbyIds = new Set(state.search.nearby.map((item) => item.stop.id));
    return state.stops.filter((stop) => {
      const routes = stopRoutes(stop);
      if (state.filters.territory && !routes.some((route) => route.territory === state.filters.territory)) return false;
      if (state.filters.route && !routes.some((route) => route.id === state.filters.route)) return false;
      if (state.search.selectedAddress) return nearbyIds.has(stop.id);
      if (!query) return true;
      return stopHaystack(stop).includes(query);
    });
  }

  function filteredRoutes(stops) {
    const ids = new Set(stops.flatMap((stop) => stop.route_ids || []));
    return state.routes.filter((route) => ids.has(route.id)).sort((a, b) => displayRoute(a).localeCompare(displayRoute(b), "fr", { numeric: true }));
  }

  function distanceKm(lat1, lng1, lat2, lng2) {
    const toRad = (value) => value * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatDistance(distance) {
    return distance < 1 ? Math.round(distance * 1000) + " m" : distance.toFixed(1).replace(".", ",") + " km";
  }

  function nearestStops(lat, lng, limit) {
    return state.stops.map((stop) => ({
      stop,
      distance: distanceKm(lat, lng, Number(stop.lat), Number(stop.lng))
    })).sort((a, b) => a.distance - b.distance).slice(0, limit || 8);
  }

  function popupFor(stop) {
    const routes = stopRoutes(stop);
    const pills = routes.map((route) => "<span class=\"popup-route\" style=\"background:" + escapeHtml(route.color || "#0b7285") + "\">" + escapeHtml(displayRoute(route)) + "</span>").join("");
    return "<div class=\"popup-title\">" + escapeHtml(stop.name) + "</div><div>" + pills + "</div><div class=\"popup-meta\">" + escapeHtml(routes[0] && routes[0].territory || "TAD") + " · " + escapeHtml(stop.code || stop.id) + "</div><button class=\"popup-detail\" type=\"button\" data-stop-id=\"" + escapeHtml(stop.id) + "\">Voir la fiche</button>";
  }

  function renderMarkers(stops) {
    state.markerLayer.clearLayers();
    state.markerByStopId = new Map();
    stops.forEach((stop) => {
      const primaryRoute = state.routeById.get(stop.route_ids && stop.route_ids[0]);
      const color = primaryRoute && primaryRoute.color || "#0b7285";
      const marker = L.circleMarker([stop.lat, stop.lng], { radius: 6, fillColor: color, color: "#fff", weight: 2, fillOpacity: .95 });
      marker.bindPopup(popupFor(stop), { maxWidth: 270 });
      marker.on("popupopen", (event) => {
        const button = event.popup.getElement() && event.popup.getElement().querySelector("[data-stop-id]");
        if (button) button.addEventListener("click", () => showDetail(stop));
      });
      marker.on("click", () => showDetail(stop, false));
      state.markerByStopId.set(stop.id, marker);
      state.markerLayer.addLayer(marker);
    });
  }

  function renderShapes(stops) {
    state.shapesLayer.clearLayers();
    if (!$("shapes-toggle").checked) return;
    const visibleRoutes = new Set(stops.flatMap((stop) => stop.route_ids || []));
    state.routes.filter((route) => visibleRoutes.has(route.id)).forEach((route) => {
      (route.shapes || []).forEach((shapeId) => {
        const coordinates = state.data.shapes && state.data.shapes[shapeId];
        if (!coordinates || coordinates.length < 2) return;
        L.polyline(coordinates, { color: route.color || "#f08c00", weight: 3, opacity: .58, dashArray: "7 7" }).bindTooltip(displayRoute(route) + " · tracé théorique").addTo(state.shapesLayer);
      });
    });
  }

  function renderLegacy() {
    state.legacyLayer.clearLayers();
    if (!$("legacy-toggle").checked || !state.data.legacy_map) return;
    (state.data.legacy_map.points || []).forEach((point) => L.marker([point.lat, point.lng], { opacity: .8 }).bindPopup("<div class=\"popup-title\">" + escapeHtml(point.name) + "</div><div class=\"popup-meta\">Repère importé depuis la carte historique</div>").addTo(state.legacyLayer));
    (state.data.legacy_map.lines || []).forEach((line) => L.polyline(line.coordinates, { color: "#495057", weight: 4, opacity: .45 }).bindTooltip(escapeHtml(line.name || "Tracé importé")).addTo(state.legacyLayer));
  }

  function renderQueryMarker() {
    state.queryLayer.clearLayers();
    const place = state.search.selectedAddress;
    if (!place) return;
    L.circle([place.lat, place.lng], { radius: 500, color: "#f08c00", weight: 1, dashArray: "5 6", fillColor: "#f08c00", fillOpacity: .06 }).addTo(state.queryLayer);
    L.circleMarker([place.lat, place.lng], { radius: 8, color: "#fff", weight: 3, fillColor: "#f08c00", fillOpacity: 1 }).bindPopup("<strong>Adresse recherchée</strong><br>" + escapeHtml(place.label)).addTo(state.queryLayer);
  }

  function renderRoutes(routes) {
    const selected = state.filters.route;
    els.routes.innerHTML = routes.length ? routes.map((route) => "<button class=\"route-item " + (selected === route.id ? "active" : "") + "\" data-route-id=\"" + escapeHtml(route.id) + "\"><span class=\"route-color\" style=\"background:" + escapeHtml(route.color || "#0b7285") + "\"></span><span class=\"route-copy\"><span class=\"route-name\">" + escapeHtml(displayRoute(route)) + "</span><span class=\"route-meta\">" + escapeHtml(route.territory || "TAD") + " · " + (route.stop_ids && route.stop_ids.length || 0) + " arrêts</span></span><span class=\"route-arrow\">›</span></button>").join("") : "<p class=\"panel-footer\">Aucune ligne ne correspond aux filtres.</p>";
    els.routes.querySelectorAll("[data-route-id]").forEach((button) => button.addEventListener("click", () => {
      state.filters.route = state.filters.route === button.dataset.routeId ? "" : button.dataset.routeId;
      els.route.value = state.filters.route;
      render();
    }));
    els.routeCount.textContent = routes.length;
  }

  function renderStops(stops) {
    const ordered = state.search.selectedAddress ? state.search.nearby.map((item) => item.stop).filter((stop) => stops.some((item) => item.id === stop.id)) : stops;
    const visible = ordered.slice(0, 160);
    els.stops.innerHTML = visible.length ? visible.map((stop) => {
      const route = state.routeById.get(stop.route_ids && stop.route_ids[0]);
      const nearby = state.search.nearby.find((item) => item.stop.id === stop.id);
      const closest = nearby && state.search.nearby[0] && nearby.stop.id === state.search.nearby[0].stop.id;
      return "<button class=\"stop-item " + (closest ? "closest" : "") + "\" data-stop-id=\"" + escapeHtml(stop.id) + "\"><span class=\"stop-pin\" style=\"border-color:" + escapeHtml(route && route.color || "#0b7285") + "\"></span><span class=\"stop-copy\"><span class=\"stop-name\">" + escapeHtml(stop.name) + "</span><span class=\"stop-meta\">" + escapeHtml(routeNames(stop)) + (nearby ? " · " + formatDistance(nearby.distance) : "") + "</span></span></button>";
    }).join("") : "<p class=\"panel-footer\">Aucun arrêt ne correspond aux filtres.</p>";
    els.stops.querySelectorAll("[data-stop-id]").forEach((button) => button.addEventListener("click", () => {
      const stop = state.stops.find((item) => item.id === button.dataset.stopId);
      if (stop) focusStop(stop, true);
    }));
    els.stopCount.textContent = stops.length > visible.length ? visible.length + "+" : stops.length;
  }

  function renderNearby() {
    const place = state.search.selectedAddress;
    if (!place || !state.search.nearby.length) {
      els.nearbyResults.hidden = true;
      return;
    }
    els.nearbyResults.hidden = false;
    els.nearbyTitle.textContent = "Arrêts TAD proches";
    els.nearbyNote.textContent = "Depuis « " + place.label + " ». Le premier résultat est le point TAD le plus proche.";
    els.nearbyList.innerHTML = state.search.nearby.map((item, index) => "<button class=\"nearby-stop " + (index === 0 ? "closest" : "") + "\" type=\"button\" data-nearby-id=\"" + escapeHtml(item.stop.id) + "\"><span class=\"nearby-rank\">" + (index === 0 ? "★" : index + 1) + "</span><span class=\"nearby-copy\"><strong>" + escapeHtml(item.stop.name) + "</strong><small>" + escapeHtml(routeNames(item.stop)) + " · " + escapeHtml(stopRoutes(item.stop)[0] && stopRoutes(item.stop)[0].territory || "TAD") + "</small></span><span class=\"nearby-distance\">" + formatDistance(item.distance) + "</span></button>").join("");
    els.nearbyList.querySelectorAll("[data-nearby-id]").forEach((button) => button.addEventListener("click", () => {
      const item = state.search.nearby.find((candidate) => candidate.stop.id === button.dataset.nearbyId);
      if (item) focusStop(item.stop, true);
    }));
  }

  function renderSearchSuggestions() {
    const query = els.search.value.trim();
    const local = localStopSuggestions(query);
    const addresses = state.search.addressSuggestions;
    if (!query || (!local.length && !addresses.length && !state.search.loading)) {
      els.searchSuggestions.hidden = true;
      els.searchSuggestions.innerHTML = "";
      els.searchState.textContent = query ? "Aucune suggestion pour le moment." : "Les suggestions d’arrêts TAD apparaîtront ici.";
      return;
    }
    const localHtml = local.length ? "<div class=\"suggestion-group\"><p class=\"suggestion-heading\">Depuis la carte TAD</p>" + local.map((stop) => "<button class=\"suggestion-item\" type=\"button\" role=\"option\" data-stop-id=\"" + escapeHtml(stop.id) + "\"><span class=\"suggestion-icon\">●</span><span class=\"suggestion-copy\"><strong>" + escapeHtml(stop.name) + "</strong><small>" + escapeHtml(stopRoutes(stop)[0] && stopRoutes(stop)[0].territory || "TAD") + " · " + escapeHtml(routeNames(stop)) + "</small></span><span class=\"suggestion-arrow\">›</span></button>").join("") + "</div>" : "";
    const addressHtml = addresses.length ? "<div class=\"suggestion-group\"><p class=\"suggestion-heading\">Adresses et lieux</p>" + addresses.map((place, index) => "<button class=\"suggestion-item address-suggestion\" type=\"button\" role=\"option\" data-address-index=\"" + index + "\"><span class=\"suggestion-icon\">⌖</span><span class=\"suggestion-copy\"><strong>" + escapeHtml(place.name || place.display_name.split(",")[0]) + "</strong><small>" + escapeHtml(place.display_name) + "</small></span><span class=\"suggestion-arrow\">›</span></button>").join("") + "</div>" : "";
    const loadingHtml = state.search.loading ? "<p class=\"suggestion-loading\">Recherche d’adresses…</p>" : "";
    els.searchSuggestions.innerHTML = localHtml + addressHtml + loadingHtml;
    els.searchSuggestions.hidden = false;
    els.searchState.textContent = state.search.loading ? "Recherche d’arrêts et d’adresses…" : "Choisissez un arrêt TAD ou une adresse.";
  }

  function clearQueryMarker() {
    state.queryLayer.clearLayers();
  }

  function clearAddressSearch() {
    if (state.search.geocodeController) state.search.geocodeController.abort();
    state.search.selectedAddress = null;
    state.search.nearby = [];
    state.search.addressSuggestions = [];
    state.search.loading = false;
    clearQueryMarker();
    renderNearby();
  }

  function hideSuggestions() {
    els.searchSuggestions.hidden = true;
  }

  async function fetchAddressSuggestions(query) {
    const normalizedQuery = normalize(query);
    if (normalizedQuery.length < 3) {
      state.search.addressSuggestions = [];
      state.search.loading = false;
      renderSearchSuggestions();
      return;
    }
    if (state.search.addressCache.has(normalizedQuery)) {
      state.search.addressSuggestions = state.search.addressCache.get(normalizedQuery);
      state.search.loading = false;
      renderSearchSuggestions();
      return;
    }
    if (state.search.geocodeController) state.search.geocodeController.abort();
    const controller = new AbortController();
    state.search.geocodeController = controller;
    const token = ++state.search.requestToken;
    state.search.loading = true;
    renderSearchSuggestions();
    try {
      const params = new URLSearchParams({
        q: query,
        format: "jsonv2",
        addressdetails: "1",
        limit: "5",
        countrycodes: "fr",
        "accept-language": "fr"
      });
      const response = await fetch(GEOCODER_URL + "?" + params.toString(), { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Géocodage " + response.status);
      const results = await response.json();
      if (token !== state.search.requestToken) return;
      state.search.addressSuggestions = Array.isArray(results) ? results.filter((place) => Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon))).map((place) => ({
        name: place.name,
        display_name: place.display_name,
        label: place.display_name,
        lat: Number(place.lat),
        lng: Number(place.lon)
      })) : [];
      state.search.addressCache.set(normalizedQuery, state.search.addressSuggestions);
    } catch (error) {
      if (error.name !== "AbortError") state.search.addressSuggestions = [];
    } finally {
      if (token === state.search.requestToken) {
        state.search.loading = false;
        renderSearchSuggestions();
      }
    }
  }

  function scheduleAddressSuggestions(query) {
    window.clearTimeout(state.search.geocodeTimer);
    state.search.geocodeTimer = window.setTimeout(() => fetchAddressSuggestions(query), 550);
  }

  function selectStop(stop) {
    clearAddressSearch();
    state.filters.search = stop.name;
    els.search.value = stop.name;
    hideSuggestions();
    render();
    focusStop(stop, true);
  }

  function selectAddress(place) {
    const lat = Number(place.lat);
    const lng = Number(place.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    state.search.selectedAddress = { lat, lng, label: place.label || place.display_name || "Adresse recherchée" };
    state.search.nearby = nearestStops(lat, lng, 8);
    state.filters.search = state.search.selectedAddress.label;
    els.search.value = state.search.selectedAddress.label;
    state.search.addressSuggestions = [];
    state.search.loading = false;
    hideSuggestions();
    renderQueryMarker();
    render();
    renderNearby();
    if (!state.search.nearby.length) {
      showStatus("Aucun arrêt TAD trouvé autour de cette adresse", 4500);
      return;
    }
    const bounds = L.latLngBounds([[lat, lng]].concat(state.search.nearby.map((item) => [item.stop.lat, item.stop.lng])));
    state.map.fitBounds(bounds.pad(.2), { maxZoom: 15 });
    showStatus(state.search.nearby[0].stop.name + " est l’arrêt TAD le plus proche", 5000);
    showDetail(state.search.nearby[0].stop);
  }

  function focusStop(stop, openDialog) {
    if (!stop) return;
    state.map.flyTo([stop.lat, stop.lng], 15, { duration: .7 });
    const marker = state.markerByStopId.get(stop.id);
    if (marker) window.setTimeout(() => marker.openPopup(), 750);
    if (openDialog) showDetail(stop);
  }

  function render() {
    const stops = filteredStops();
    const routes = filteredRoutes(stops);
    renderMarkers(stops);
    renderShapes(stops);
    renderLegacy();
    renderRoutes(routes);
    renderStops(stops);
    renderNearby();
    els.statsStops.textContent = stops.length;
    els.statsRoutes.textContent = routes.length;
    els.statsTerritories.textContent = new Set(routes.map((route) => route.territory).filter(Boolean)).size;
    if (!stops.length && (state.filters.search || state.filters.territory || state.filters.route)) showStatus("Aucun arrêt ne correspond aux filtres", 2200);
  }

  function showDetail(stop, openDialog) {
    const routes = stopRoutes(stop);
    const nearby = state.search.nearby.find((item) => item.stop.id === stop.id);
    els.detailContent.innerHTML = "<p class=\"eyebrow\">Fiche arrêt</p><h2>" + escapeHtml(stop.name) + "</h2><p class=\"detail-territory\">" + escapeHtml(routes[0] && routes[0].territory || "Transport à la demande") + (nearby ? " · " + formatDistance(nearby.distance) + " de l’adresse recherchée" : "") + "</p><div>" + routes.map((route) => "<span class=\"detail-route\" style=\"background:" + escapeHtml(route.color || "#0b7285") + "\">" + escapeHtml(displayRoute(route)) + "</span>").join("") + "</div><table class=\"detail-table\"><tr><td>Identifiant GTFS</td><td>" + escapeHtml(stop.id) + "</td></tr><tr><td>Code arrêt</td><td>" + escapeHtml(stop.code || "—") + "</td></tr><tr><td>Coordonnées</td><td>" + Number(stop.lat).toFixed(5) + ", " + Number(stop.lng).toFixed(5) + "</td></tr><tr><td>Accessibilité GTFS</td><td>" + (stop.wheelchair_boarding === 1 ? "Oui" : stop.wheelchair_boarding === 2 ? "Non" : "Non renseignée") + "</td></tr></table>";
    if (openDialog !== false && typeof els.detailDialog.showModal === "function") els.detailDialog.showModal();
  }

  function fitResults() {
    const stops = filteredStops();
    if (!stops.length) return;
    const points = state.search.selectedAddress ? [[state.search.selectedAddress.lat, state.search.selectedAddress.lng]].concat(stops.map((stop) => [stop.lat, stop.lng])) : stops.map((stop) => [stop.lat, stop.lng]);
    state.map.fitBounds(L.latLngBounds(points).pad(.12), { maxZoom: 14 });
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function exportRows() {
    const routes = state.routeById;
    return filteredStops().flatMap((stop) => (stop.route_ids || []).map((id) => ({ stop, route: routes.get(id) })).filter((item) => item.route));
  }

  function exportCsv() {
    const rows = exportRows();
    const head = ["territoire", "ligne", "nom_ligne", "arret_id", "code", "arret", "latitude", "longitude"];
    const csv = [head].concat(rows.map(({ stop, route }) => [route.territory, displayRoute(route), route.name, stop.id, stop.code || "", stop.name, stop.lat, stop.lng])).map((row) => row.map((value) => "\"" + String(value == null ? "" : value).replace(/"/g, "\"\"") + "\"").join(",")).join("\n");
    download("tad-idfm-selection.csv", "\ufeff" + csv, "text/csv;charset=utf-8");
  }

  function exportKml() {
    const rows = exportRows();
    const placemarks = rows.map(({ stop, route }) => "<Placemark><name>" + escapeHtml(stop.name) + "</name><description><![CDATA[Territoire : " + escapeHtml(route.territory) + "<br/>Ligne : " + escapeHtml(displayRoute(route)) + "<br/>ID : " + escapeHtml(stop.id) + "]]></description><Point><coordinates>" + stop.lng + "," + stop.lat + ",0</coordinates></Point></Placemark>").join("");
    download("tad-idfm-selection.kml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><kml xmlns=\"http://www.opengis.net/kml/2.2\"><Document><name>TAD IDFM — sélection</name>" + placemarks + "</Document></kml>", "application/vnd.google-earth.kml+xml");
  }

  function exportJson() {
    const selected = filteredStops();
    download("tad-idfm-selection.json", JSON.stringify(Object.assign({}, state.data, { stops: selected, routes: filteredRoutes(selected), exported_at: new Date().toISOString() }), null, 2), "application/json;charset=utf-8");
  }

  function bindEvents() {
    els.search.addEventListener("input", (event) => {
      const query = event.target.value;
      clearAddressSearch();
      state.filters.search = query;
      render();
      renderSearchSuggestions();
      scheduleAddressSuggestions(query);
    });
    els.search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideSuggestions();
        return;
      }
      if (event.key !== "Enter") return;
      const first = els.searchSuggestions.querySelector("[data-stop-id], [data-address-index]");
      if (first) {
        event.preventDefault();
        first.click();
      }
    });
    els.searchSuggestions.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.stopId) {
        const stop = state.stops.find((item) => item.id === button.dataset.stopId);
        if (stop) selectStop(stop);
      } else if (button.dataset.addressIndex) {
        const place = state.search.addressSuggestions[Number(button.dataset.addressIndex)];
        if (place) selectAddress(place);
      }
    });
    els.clearSearch.addEventListener("click", () => {
      clearAddressSearch();
      state.filters.search = "";
      els.search.value = "";
      hideSuggestions();
      render();
      fitResults();
    });
    els.territory.addEventListener("change", (event) => {
      state.filters.territory = event.target.value;
      state.filters.route = "";
      els.route.value = "";
      render();
    });
    els.route.addEventListener("change", (event) => {
      state.filters.route = event.target.value;
      render();
    });
    $("shapes-toggle").addEventListener("change", () => render());
    $("legacy-toggle").addEventListener("change", () => renderLegacy());
    $("fit-button").addEventListener("click", fitResults);
    $("reset-button").addEventListener("click", () => {
      clearAddressSearch();
      state.filters = { search: "", territory: "", route: "" };
      els.search.value = "";
      els.territory.value = "";
      els.route.value = "";
      hideSuggestions();
      render();
      fitResults();
    });
    $("export-button").addEventListener("click", () => els.exportDialog.showModal());
    $("export-csv").addEventListener("click", exportCsv);
    $("export-kml").addEventListener("click", exportKml);
    $("export-json").addEventListener("click", exportJson);
    $("detail-close").addEventListener("click", () => els.detailDialog.close());
    $("locate-button").addEventListener("click", () => {
      if (!navigator.geolocation) return showStatus("Géolocalisation indisponible");
      showStatus("Recherche de votre position…", 5000);
      navigator.geolocation.getCurrentPosition((position) => {
        const latitude = position.coords.latitude;
        const longitude = position.coords.longitude;
        state.map.flyTo([latitude, longitude], 14);
        L.circleMarker([latitude, longitude], { radius: 7, color: "#fff", weight: 3, fillColor: "#e8590c", fillOpacity: 1 }).addTo(state.map).bindPopup("Votre position approximative").openPopup();
      }, () => showStatus("Position non disponible"));
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".search-area")) hideSuggestions();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "/" && document.activeElement !== els.search) {
        event.preventDefault();
        els.search.focus();
      }
    });
  }

  async function start() {
    setupMap();
    bindEvents();
    try {
      const data = await loadData();
      prepareData(data);
      populateFilters();
      const generated = data.generated_at ? new Date(data.generated_at).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }) : "date inconnue";
      els.source.innerHTML = "Source : <a href=\"" + escapeHtml(data.source && data.source.gtfs_url || "https://data.iledefrance-mobilites.fr/") + "\" target=\"_blank\" rel=\"noreferrer\">IDFM GTFS</a><br/>Mise à jour : " + escapeHtml(generated);
      render();
      fitResults();
      showStatus(state.stops.length + " arrêts chargés", 2400);
    } catch (error) {
      els.source.textContent = "Données absentes. Lance update_tad_data.py puis recharge la page.";
      showStatus("Impossible de charger tad_data.json", 10000);
      console.error(error);
    }
  }

  start();
})();
