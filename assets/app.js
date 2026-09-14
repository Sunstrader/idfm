(() => {
  "use strict";

  const DATA_URLS = ["../data/tad_data.json", "data/tad_data.json", "./data/tad_data.json", "../data/tad_data.example.json", "data/tad_data.example.json"];
  const state = { data: null, map: null, markerLayer: null, shapesLayer: null, legacyLayer: null, stops: [], routes: [], routeById: new Map(), filters: { search: "", territory: "", route: "" } };
  const $ = (id) => document.getElementById(id);
  const els = { search: $("search-input"), territory: $("territory-select"), route: $("route-select"), routes: $("route-list"), stops: $("stop-list"), routeCount: $("route-count"), stopCount: $("stop-count"), statsStops: $("stat-stops"), statsRoutes: $("stat-routes"), statsTerritories: $("stat-territories"), source: $("data-source"), status: $("map-status"), exportDialog: $("export-dialog"), detailDialog: $("detail-dialog"), detailContent: $("detail-content") };

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  const normalize = (value) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const displayRoute = (route) => route?.short_name || route?.name || route?.id || "TAD";
  const showStatus = (message, timeout = 3000) => { els.status.textContent = message; els.status.classList.add("show"); window.clearTimeout(showStatus.timer); showStatus.timer = window.setTimeout(() => els.status.classList.remove("show"), timeout); };

  async function loadData() {
    let lastError;
    for (const url of DATA_URLS) {
      try { const response = await fetch(url, { cache: "no-store" }); if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return await response.json(); } catch (error) { lastError = error; }
    }
    throw lastError || new Error("Données introuvables");
  }

  function setupMap() {
    state.map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([48.65, 2.35], 9);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(state.map);
    state.markerLayer = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 42, spiderfyOnMaxZoom: true });
    state.shapesLayer = L.layerGroup().addTo(state.map);
    state.legacyLayer = L.layerGroup().addTo(state.map);
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
    els.territory.innerHTML = `<option value="">Tous les territoires</option>${territories.map((territory) => `<option value="${escapeHtml(territory)}">${escapeHtml(territory)}</option>`).join("")}`;
    els.route.innerHTML = `<option value="">Toutes les lignes</option>${state.routes.slice().sort((a, b) => displayRoute(a).localeCompare(displayRoute(b), "fr", { numeric: true })).map((route) => `<option value="${escapeHtml(route.id)}">${escapeHtml(displayRoute(route))} — ${escapeHtml(route.territory || "TAD")}</option>`).join("")}`;
  }

  function filteredStops() {
    const query = normalize(state.filters.search);
    return state.stops.filter((stop) => {
      const routes = (stop.route_ids || []).map((id) => state.routeById.get(id)).filter(Boolean);
      if (state.filters.territory && !routes.some((route) => route.territory === state.filters.territory)) return false;
      if (state.filters.route && !routes.some((route) => route.id === state.filters.route)) return false;
      if (!query) return true;
      const haystack = normalize([stop.name, stop.code, ...routes.flatMap((route) => [route.short_name, route.name, route.territory])].join(" "));
      return haystack.includes(query);
    });
  }

  function filteredRoutes(stops) {
    const ids = new Set(stops.flatMap((stop) => stop.route_ids || []));
    return state.routes.filter((route) => ids.has(route.id)).sort((a, b) => displayRoute(a).localeCompare(displayRoute(b), "fr", { numeric: true }));
  }

  function popupFor(stop) {
    const routes = (stop.route_ids || []).map((id) => state.routeById.get(id)).filter(Boolean);
    const pills = routes.map((route) => `<span class="popup-route" style="background:${escapeHtml(route.color || "#0b7285")}">${escapeHtml(displayRoute(route))}</span>`).join("");
    return `<div class="popup-title">${escapeHtml(stop.name)}</div><div>${pills}</div><div class="popup-meta">${escapeHtml(routes[0]?.territory || "TAD")} · ${escapeHtml(stop.code || stop.id)}</div><button class="popup-detail" type="button" data-stop-id="${escapeHtml(stop.id)}">Voir la fiche</button>`;
  }

  function renderMarkers(stops) {
    state.markerLayer.clearLayers();
    stops.forEach((stop) => {
      const primaryRoute = state.routeById.get(stop.route_ids?.[0]);
      const color = primaryRoute?.color || "#0b7285";
      const marker = L.circleMarker([stop.lat, stop.lng], { radius: 6, fillColor: color, color: "#fff", weight: 2, fillOpacity: .95 });
      marker.bindPopup(popupFor(stop), { maxWidth: 270 });
      marker.on("popupopen", (event) => { const button = event.popup.getElement()?.querySelector("[data-stop-id]"); if (button) button.addEventListener("click", () => showDetail(stop)); });
      marker.on("click", () => showDetail(stop, false));
      state.markerLayer.addLayer(marker);
    });
  }

  function renderShapes(stops) {
    state.shapesLayer.clearLayers();
    if (!$('shapes-toggle').checked) return;
    const visibleRoutes = new Set(stops.flatMap((stop) => stop.route_ids || []));
    state.routes.filter((route) => visibleRoutes.has(route.id)).forEach((route) => {
      (route.shapes || []).forEach((shapeId) => {
        const coordinates = state.data.shapes?.[shapeId];
        if (!coordinates || coordinates.length < 2) return;
        L.polyline(coordinates, { color: route.color || "#f08c00", weight: 3, opacity: .58, dashArray: "7 7" }).bindTooltip(`${displayRoute(route)} · tracé théorique`).addTo(state.shapesLayer);
      });
    });
  }

  function renderLegacy() {
    state.legacyLayer.clearLayers();
    if (!$('legacy-toggle').checked || !state.data.legacy_map) return;
    (state.data.legacy_map.points || []).forEach((point) => L.marker([point.lat, point.lng], { opacity: .8 }).bindPopup(`<div class="popup-title">${escapeHtml(point.name)}</div><div class="popup-meta">Repère importé depuis la carte historique</div>`).addTo(state.legacyLayer));
    (state.data.legacy_map.lines || []).forEach((line) => L.polyline(line.coordinates, { color: "#495057", weight: 4, opacity: .45 }).bindTooltip(escapeHtml(line.name || "Tracé importé")).addTo(state.legacyLayer));
  }

  function renderRoutes(routes) {
    const selected = state.filters.route;
    els.routes.innerHTML = routes.length ? routes.map((route) => `<button class="route-item ${selected === route.id ? "active" : ""}" data-route-id="${escapeHtml(route.id)}"><span class="route-color" style="background:${escapeHtml(route.color || "#0b7285")}"></span><span class="route-name">${escapeHtml(displayRoute(route))}</span><span class="route-meta">${route.stop_ids?.length || 0}</span></button>`).join("") : `<p class="panel-footer">Aucune ligne ne correspond aux filtres.</p>`;
    els.routes.querySelectorAll("[data-route-id]").forEach((button) => button.addEventListener("click", () => { state.filters.route = state.filters.route === button.dataset.routeId ? "" : button.dataset.routeId; els.route.value = state.filters.route; render(); }));
    els.routeCount.textContent = routes.length;
  }

  function renderStops(stops) {
    const visible = stops.slice(0, 160);
    els.stops.innerHTML = visible.length ? visible.map((stop) => {
      const route = state.routeById.get(stop.route_ids?.[0]);
      return `<button class="stop-item" data-stop-id="${escapeHtml(stop.id)}"><span class="stop-pin" style="border-color:${escapeHtml(route?.color || "#0b7285")}"></span><span class="stop-copy"><span class="stop-name">${escapeHtml(stop.name)}</span><span class="stop-meta">${escapeHtml((stop.routes || []).map((item) => displayRoute(item)).join(" · "))}</span></span></button>`;
    }).join("") : `<p class="panel-footer">Aucun arrêt ne correspond aux filtres.</p>`;
    els.stops.querySelectorAll("[data-stop-id]").forEach((button) => button.addEventListener("click", () => { const stop = state.stops.find((item) => item.id === button.dataset.stopId); if (stop) { state.map.flyTo([stop.lat, stop.lng], 15, { duration: .7 }); showDetail(stop); } }));
    els.stopCount.textContent = stops.length > visible.length ? `${visible.length}+` : stops.length;
  }

  function render() {
    const stops = filteredStops();
    const routes = filteredRoutes(stops);
    renderMarkers(stops); renderShapes(stops); renderLegacy(); renderRoutes(routes); renderStops(stops);
    els.statsStops.textContent = stops.length; els.statsRoutes.textContent = routes.length; els.statsTerritories.textContent = new Set(routes.map((route) => route.territory)).size;
    if (!stops.length) showStatus("Aucun résultat", 2200);
  }

  function showDetail(stop, openDialog = true) {
    const routes = (stop.route_ids || []).map((id) => state.routeById.get(id)).filter(Boolean);
    els.detailContent.innerHTML = `<p class="eyebrow">Fiche arrêt</p><h2>${escapeHtml(stop.name)}</h2><p class="detail-territory">${escapeHtml(routes[0]?.territory || "Transport à la demande")}</p><div>${routes.map((route) => `<span class="detail-route" style="background:${escapeHtml(route.color || "#0b7285")}">${escapeHtml(displayRoute(route))}</span>`).join("")}</div><table class="detail-table"><tr><td>Identifiant GTFS</td><td>${escapeHtml(stop.id)}</td></tr><tr><td>Code arrêt</td><td>${escapeHtml(stop.code || "—")}</td></tr><tr><td>Coordonnées</td><td>${Number(stop.lat).toFixed(5)}, ${Number(stop.lng).toFixed(5)}</td></tr><tr><td>Accessibilité GTFS</td><td>${stop.wheelchair_boarding === 1 ? "Oui" : stop.wheelchair_boarding === 2 ? "Non" : "Non renseignée"}</td></tr></table>`;
    if (openDialog && typeof els.detailDialog.showModal === "function") els.detailDialog.showModal();
  }

  function fitResults() {
    const stops = filteredStops();
    if (!stops.length) return;
    const bounds = L.latLngBounds(stops.map((stop) => [stop.lat, stop.lng]));
    state.map.fitBounds(bounds.pad(.12), { maxZoom: 14 });
  }

  function download(filename, content, type) { const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 500); }
  function exportRows() {
    const routes = state.routeById; return filteredStops().flatMap((stop) => (stop.route_ids || []).map((id) => ({ stop, route: routes.get(id) })).filter((item) => item.route));
  }
  function exportCsv() { const rows = exportRows(); const head = ["territoire", "ligne", "nom_ligne", "arret_id", "code", "arret", "latitude", "longitude"]; const csv = [head, ...rows.map(({ stop, route }) => [route.territory, displayRoute(route), route.name, stop.id, stop.code || "", stop.name, stop.lat, stop.lng])].map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n"); download("tad-idfm-selection.csv", "\ufeff" + csv, "text/csv;charset=utf-8"); }
  function exportKml() { const rows = exportRows(); const placemarks = rows.map(({ stop, route }) => `<Placemark><name>${escapeHtml(stop.name)}</name><description><![CDATA[Territoire : ${escapeHtml(route.territory)}<br/>Ligne : ${escapeHtml(displayRoute(route))}<br/>ID : ${escapeHtml(stop.id)}]]></description><Point><coordinates>${stop.lng},${stop.lat},0</coordinates></Point></Placemark>`).join(""); download("tad-idfm-selection.kml", `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>TAD IDFM — sélection</name>${placemarks}</Document></kml>`, "application/vnd.google-earth.kml+xml"); }
  function exportJson() { const selected = filteredStops(); download("tad-idfm-selection.json", JSON.stringify({ ...state.data, stops: selected, routes: filteredRoutes(selected), exported_at: new Date().toISOString() }, null, 2), "application/json;charset=utf-8"); }

  function bindEvents() {
    els.search.addEventListener("input", (event) => { state.filters.search = event.target.value; render(); });
    els.territory.addEventListener("change", (event) => { state.filters.territory = event.target.value; state.filters.route = ""; els.route.value = ""; render(); });
    els.route.addEventListener("change", (event) => { state.filters.route = event.target.value; render(); });
    $("shapes-toggle").addEventListener("change", () => render()); $("legacy-toggle").addEventListener("change", () => renderLegacy()); $("fit-button").addEventListener("click", fitResults);
    $("reset-button").addEventListener("click", () => { state.filters = { search: "", territory: "", route: "" }; els.search.value = ""; els.territory.value = ""; els.route.value = ""; render(); fitResults(); });
    $("export-button").addEventListener("click", () => els.exportDialog.showModal()); $("export-csv").addEventListener("click", exportCsv); $("export-kml").addEventListener("click", exportKml); $("export-json").addEventListener("click", exportJson); $("detail-close").addEventListener("click", () => els.detailDialog.close());
    $("locate-button").addEventListener("click", () => { if (!navigator.geolocation) return showStatus("Géolocalisation indisponible"); showStatus("Recherche de votre position…", 5000); navigator.geolocation.getCurrentPosition((position) => { const { latitude, longitude } = position.coords; state.map.flyTo([latitude, longitude], 14); L.circleMarker([latitude, longitude], { radius: 7, color: "#fff", weight: 3, fillColor: "#e8590c", fillOpacity: 1 }).addTo(state.map).bindPopup("Votre position approximative").openPopup(); }, () => showStatus("Position non disponible")); });
    document.addEventListener("keydown", (event) => { if (event.key === "/" && document.activeElement !== els.search) { event.preventDefault(); els.search.focus(); } });
  }

  async function start() {
    setupMap(); bindEvents();
    try {
      const data = await loadData(); prepareData(data); populateFilters();
      const generated = data.generated_at ? new Date(data.generated_at).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }) : "date inconnue";
      els.source.innerHTML = `Source : <a href="${escapeHtml(data.source?.gtfs_url || "https://data.iledefrance-mobilites.fr/")}" target="_blank" rel="noreferrer">IDFM GTFS</a><br/>Mise à jour : ${escapeHtml(generated)}`;
      render(); fitResults(); showStatus(`${state.stops.length} arrêts chargés`, 2400);
    } catch (error) {
      els.source.textContent = "Données absentes. Lance update_tad_data.py puis recharge la page.";
      showStatus("Impossible de charger tad_data.json", 10000);
      console.error(error);
    }
  }
  start();
})();
