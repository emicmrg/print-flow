const form = document.querySelector("#printer-form");
const printForm = document.querySelector("#print-form");
const hostInput = document.querySelector("#host");
const intervalInput = document.querySelector("#interval");
const btnAuto = document.querySelector("#btn-auto");
const btnDiagnose = document.querySelector("#btn-diagnose");
const btnStart = document.querySelector("#btn-start");
const btnPaper = document.querySelector("#btn-paper");
const btnStop = document.querySelector("#btn-stop");
const btnPrint = document.querySelector("#btn-print");

const scoreEl = document.querySelector("#score");
const dnsEl = document.querySelector("#dns-ms");
const pingEl = document.querySelector("#ping-ms");
const fastestEl = document.querySelector("#fastest-port");
const paperStatusEl = document.querySelector("#paper-status");
const portsTable = document.querySelector("#ports-table");
const tipsList = document.querySelector("#tips-list");
const fastPathState = document.querySelector("#fast-path-state");
const logEl = document.querySelector("#log");
const chipConnection = document.querySelector("#chip-connection");
const chipPaper = document.querySelector("#chip-paper");
const chipQueue = document.querySelector("#chip-queue");

const printFileInput = document.querySelector("#print-file");
const copiesInput = document.querySelector("#copies");
const printerNameInput = document.querySelector("#printer-name");
const queueList = document.querySelector("#queue-list");
const hostList = document.querySelector("#host-list");

const optOrientation = document.querySelector("#opt-orientation");
const optPageSize = document.querySelector("#opt-page-size");
const optColor = document.querySelector("#opt-color");
const optInputSlot = document.querySelector("#opt-input-slot");
const optSides = document.querySelector("#opt-sides");

const DEFAULT_PORTS = [631, 9100, 80, 443];
const MAX_PRINT_FILE_BYTES = 20 * 1024 * 1024;
const actionButtons = [btnAuto, btnDiagnose, btnStart, btnPaper, btnStop, btnPrint];

let statusPoll = null;
let printersCache = [];

function stamp() {
  return new Date().toLocaleTimeString();
}

function log(message) {
  const entry = document.createElement("div");
  entry.className = "entry";
  entry.innerHTML = `<span class="time">[${stamp()}]</span> ${message}`;
  logEl.prepend(entry);
}

function setChip(chip, text, tone = "neutral") {
  if (!chip) {
    return;
  }
  chip.textContent = text;
  chip.dataset.tone = tone;
}

function setLoading(isLoading) {
  actionButtons.forEach((button) => {
    if (button) {
      button.disabled = isLoading;
    }
  });
}

function hostValue() {
  return hostInput.value.trim();
}

function queueValue() {
  return printerNameInput.value.trim();
}

function renderPorts(rows) {
  portsTable.innerHTML = "";
  if (!rows || rows.length === 0) {
    const empty = document.createElement("tr");
    empty.innerHTML = `<td colspan="4">Sin datos.</td>`;
    portsTable.appendChild(empty);
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.port}</td>
      <td class="${row.ok ? "pill-ok" : "pill-bad"}">${row.ok ? "ABIERTO" : "CERRADO"}</td>
      <td>${row.elapsedMs}</td>
      <td>${row.error || "-"}</td>
    `;
    portsTable.appendChild(tr);
  });
}

function renderTips(tips) {
  tipsList.innerHTML = "";
  (tips || []).forEach((tip) => {
    const li = document.createElement("li");
    li.textContent = tip;
    tipsList.appendChild(li);
  });
}

function renderPaperStatus(data) {
  if (!data || !data.paper) {
    paperStatusEl.textContent = "n/a";
    setChip(chipPaper, "Papel: sin datos", "neutral");
    return;
  }
  const { paper } = data;
  if (paper.paperState === "paper_ok") {
    paperStatusEl.textContent = "Con papel";
    setChip(chipPaper, `Papel: OK (${paper.source || "n/a"})`, "good");
    return;
  }
  if (paper.paperState === "no_paper") {
    paperStatusEl.textContent = "Sin papel";
    setChip(chipPaper, `Papel: vacío (${paper.source || "n/a"})`, "bad");
    return;
  }
  paperStatusEl.textContent = "Desconocido";
  setChip(chipPaper, `Papel: desconocido (${paper.source || "n/a"})`, "warn");
}

function renderFastPath(session) {
  if (!session) {
    fastPathState.textContent = "Sin sesión activa.";
    return;
  }

  const successRate = session.probes
    ? Math.round((session.successes / session.probes) * 100)
    : 0;
  fastPathState.textContent = [
    `Host: ${session.host}`,
    `Activo: ${session.active ? "Sí" : "No"}`,
    `Intervalo: ${session.intervalMs} ms`,
    `Puertos: ${session.ports.join(", ")}`,
    `Probes: ${session.probes}`,
    `Éxitos: ${session.successes}`,
    `Fallos: ${session.failures}`,
    `Tasa de éxito: ${successRate}%`,
    `Último probe: ${session.lastProbe ? JSON.stringify(session.lastProbe, null, 2) : "n/a"}`
  ].join("\n");
}

async function callApi(path, payload, method = "POST") {
  const response = await fetch(path, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(payload || {})
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Error en API");
  }
  return data;
}

function renderDiagnostics(result) {
  scoreEl.textContent = result.score;
  dnsEl.textContent = result.dnsLookup ? result.dnsLookup.elapsedMs : "n/a";
  pingEl.textContent = result.ping && result.ping.avgMs !== null ? `${result.ping.avgMs} ms` : "n/a";

  const openPorts = (result.tcp || []).filter((row) => row.ok);
  if (openPorts.length) {
    const fastest = openPorts.sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
    fastestEl.textContent = `${fastest.port} (${fastest.elapsedMs} ms)`;
  } else {
    fastestEl.textContent = "ninguno";
  }

  renderPorts(result.tcp);
  renderTips(result.recommendations);

  if (typeof result.score === "number") {
    if (result.score >= 85) {
      setChip(chipConnection, `Conexión: estable (${result.score})`, "good");
    } else if (result.score >= 60) {
      setChip(chipConnection, `Conexión: media (${result.score})`, "warn");
    } else {
      setChip(chipConnection, `Conexión: degradada (${result.score})`, "bad");
    }
  } else {
    setChip(chipConnection, "Conexión: sin diagnóstico", "neutral");
  }
}

function clearAndSeedSelect(selectElement, autoLabel = "Auto") {
  selectElement.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = autoLabel;
  selectElement.appendChild(auto);
  delete selectElement.dataset.optionKey;
}

function fillSelectFromCapability(selectElement, capability, autoLabel) {
  clearAndSeedSelect(selectElement, autoLabel);
  if (!capability || !Array.isArray(capability.options) || capability.options.length === 0) {
    return;
  }
  selectElement.dataset.optionKey = capability.key;
  capability.options.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    selectElement.appendChild(option);
  });
  if (capability.defaultValue) {
    selectElement.value = capability.defaultValue;
  }
}

function seedFallbackPrintOptions() {
  clearAndSeedSelect(optPageSize, "Auto");
  ["A4", "Letter", "Legal"].forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    optPageSize.appendChild(option);
  });

  clearAndSeedSelect(optColor, "Auto");
  [
    { value: "color", label: "Color" },
    { value: "mono", label: "Blanco y negro" }
  ].forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    optColor.appendChild(option);
  });

  clearAndSeedSelect(optInputSlot, "Auto");
  clearAndSeedSelect(optSides, "Auto");
}

function selectBestPrinter(printers) {
  if (!Array.isArray(printers) || printers.length === 0) {
    return null;
  }
  const byDefault = printers.find((printer) => printer.isDefault);
  if (byDefault) {
    return byDefault;
  }
  const byHp = printers.find((printer) => /hp|deskjet/i.test(`${printer.name} ${printer.deviceUri || ""}`));
  if (byHp) {
    return byHp;
  }
  return printers[0];
}

function updatePrinterDatalists(printers) {
  queueList.innerHTML = "";
  hostList.innerHTML = "";
  const hosts = new Set();

  printers.forEach((printer) => {
    const queueOption = document.createElement("option");
    queueOption.value = printer.name;
    queueList.appendChild(queueOption);
    if (printer.host) {
      hosts.add(printer.host);
    }
  });

  Array.from(hosts).forEach((host) => {
    const hostOption = document.createElement("option");
    hostOption.value = host;
    hostList.appendChild(hostOption);
  });
}

async function loadPrinterCapabilities(printerName) {
  const queue = printerName.trim();
  seedFallbackPrintOptions();
  if (!queue) {
    return;
  }

  try {
    const data = await callApi(`/api/printer/capabilities?printerName=${encodeURIComponent(queue)}`, null, "GET");
    const caps = data.result.capabilities;
    fillSelectFromCapability(optPageSize, caps.pageSize, "Auto");
    fillSelectFromCapability(optColor, caps.color, "Auto");
    fillSelectFromCapability(optInputSlot, caps.inputSlot, "Auto");
    fillSelectFromCapability(optSides, caps.sides, "Auto");
    log(`Capacidades cargadas para cola <b>${queue}</b>.`);
  } catch (error) {
    seedFallbackPrintOptions();
    log(`No se pudieron cargar capacidades de <b>${queue}</b>: ${error.message}`);
  }
}

function applyPrinterSelection(printer, fromAutoDetect = false) {
  if (!printer) {
    return;
  }
  if (printer.host) {
    hostInput.value = printer.host;
  }
  printerNameInput.value = printer.name;
  setChip(chipQueue, `Cola: ${printer.name}`, "good");
  if (fromAutoDetect) {
    log(`Autodetectada cola <b>${printer.name}</b>${printer.host ? ` en host <b>${printer.host}</b>` : ""}.`);
  }
}

async function detectSystemPrinters(shouldAutofill = true) {
  const data = await callApi("/api/system/printers", null, "GET");
  printersCache = data.result.printers || [];
  updatePrinterDatalists(printersCache);

  if (printersCache.length === 0) {
    log("No se detectaron colas CUPS en el sistema.");
    setChip(chipQueue, "Cola: no detectada", "warn");
    return;
  }

  const best = selectBestPrinter(printersCache);
  if (shouldAutofill && best) {
    applyPrinterSelection(best, true);
    await loadPrinterCapabilities(best.name);
  }
}

async function refreshFastPath() {
  const host = hostValue();
  if (!host) {
    renderFastPath(null);
    return;
  }
  try {
    const data = await callApi(`/api/fast-path/status?host=${encodeURIComponent(host)}`, null, "GET");
    renderFastPath(data.session);
  } catch (error) {
    renderFastPath(null);
  }
}

async function refreshPaperStatus() {
  const host = hostValue();
  const printerName = queueValue();
  if (!host && !printerName) {
    log("Ingresa host o cola para consultar estado.");
    return { ok: false };
  }

  try {
    const data = await callApi("/api/printer/status", { host, printerName });
    renderPaperStatus(data.result);
    log(`Estado de papel (${data.result.paper.source || "n/a"}): <b>${data.result.paper.message}</b>`);
    return { ok: true, result: data.result };
  } catch (error) {
    paperStatusEl.textContent = "Desconocido";
    setChip(chipPaper, "Papel: error de consulta", "bad");
    if (String(error.message || "").includes("API route no encontrada")) {
      log("Estado de papel no disponible en el backend activo. Reinicia `npm start` y recarga con Ctrl+Shift+R.");
      return { ok: false, routeMissing: true };
    }
    log(`<span class="pill-bad">No se pudo consultar papel:</span> ${error.message}`);
    return { ok: false };
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsDataURL(file);
  });
}

function buildPrintOptionsPayload() {
  const options = {};

  if (optOrientation.value) {
    options.orientation = optOrientation.value;
  }
  if (optPageSize.value) {
    options.pageSize = optPageSize.value;
    if (optPageSize.dataset.optionKey) {
      options.pageSizeOptionKey = optPageSize.dataset.optionKey;
    }
  }
  if (optInputSlot.value) {
    options.inputSlot = optInputSlot.value;
    if (optInputSlot.dataset.optionKey) {
      options.inputSlotOptionKey = optInputSlot.dataset.optionKey;
    }
  }
  if (optSides.value) {
    options.sides = optSides.value;
    if (optSides.dataset.optionKey) {
      options.sidesOptionKey = optSides.dataset.optionKey;
    }
  }
  if (optColor.value) {
    if (optColor.dataset.optionKey) {
      options.colorOptionKey = optColor.dataset.optionKey;
      options.colorOptionValue = optColor.value;
    } else {
      options.colorMode = optColor.value;
    }
  }

  return options;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const host = hostValue();
  if (!host) {
    log("Ingresa host/IP para diagnóstico de red.");
    return;
  }

  setLoading(true);
  log(`Ejecutando diagnóstico para <b>${host}</b>...`);
  try {
    const data = await callApi("/api/diagnose", {
      host,
      ports: DEFAULT_PORTS,
      pingCount: 3
    });
    renderDiagnostics(data.result);
    log(`Diagnóstico completado. Score: <b>${data.result.score}</b>.`);
    await refreshPaperStatus();
  } catch (error) {
    log(`<span class="pill-bad">Error:</span> ${error.message}`);
  } finally {
    setLoading(false);
  }
});

btnAuto.addEventListener("click", async () => {
  setLoading(true);
  log("Buscando impresoras locales configuradas en CUPS...");
  try {
    await detectSystemPrinters(true);
  } catch (error) {
    log(`<span class="pill-bad">Autodetección falló:</span> ${error.message}`);
  } finally {
    setLoading(false);
  }
});

btnStart.addEventListener("click", async () => {
  const host = hostValue();
  if (!host) {
    log("Ingresa primero IP/host de la impresora.");
    return;
  }
  const intervalSeconds = Number(intervalInput.value) || 25;

  setLoading(true);
  log(`Activando Fast Path para <b>${host}</b> cada ${intervalSeconds}s...`);
  try {
    const data = await callApi("/api/fast-path/start", {
      host,
      intervalMs: intervalSeconds * 1000,
      ports: [631, 9100]
    });
    renderFastPath(data.session);
    log("Fast Path activo.");
    if (!statusPoll) {
      statusPoll = setInterval(refreshFastPath, 4000);
    }
  } catch (error) {
    log(`<span class="pill-bad">Error al iniciar Fast Path:</span> ${error.message}`);
  } finally {
    setLoading(false);
  }
});

btnPaper.addEventListener("click", async () => {
  setLoading(true);
  log("Consultando estado de papel...");
  try {
    await refreshPaperStatus();
  } finally {
    setLoading(false);
  }
});

btnStop.addEventListener("click", async () => {
  const host = hostValue();
  if (!host) {
    log("Ingresa primero IP/host de la impresora.");
    return;
  }

  setLoading(true);
  log(`Deteniendo Fast Path en <b>${host}</b>...`);
  try {
    await callApi("/api/fast-path/stop", { host });
    log("Fast Path detenido.");
    await refreshFastPath();
  } catch (error) {
    log(`<span class="pill-bad">Error al detener Fast Path:</span> ${error.message}`);
  } finally {
    setLoading(false);
  }
});

printerNameInput.addEventListener("change", async () => {
  await loadPrinterCapabilities(queueValue());
});

printForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const host = hostValue();
  const printerName = queueValue();
  if (!host && !printerName) {
    log("Ingresa host o cola de impresión.");
    return;
  }

  const file = printFileInput.files && printFileInput.files[0];
  if (!file) {
    log("Selecciona un archivo para imprimir.");
    return;
  }
  if (file.size > MAX_PRINT_FILE_BYTES) {
    log(`<span class="pill-bad">Archivo demasiado grande.</span> Máximo ${Math.round(MAX_PRINT_FILE_BYTES / (1024 * 1024))} MB.`);
    return;
  }

  const copies = Math.min(Math.max(Number(copiesInput.value) || 1, 1), 30);
  const printOptions = buildPrintOptionsPayload();

  setLoading(true);
  log(`Preparando archivo <b>${file.name}</b> para imprimir (${copies} copia(s))...`);
  try {
    const fileDataBase64 = await fileToBase64(file);
    const data = await callApi("/api/print", {
      host,
      fileName: file.name,
      fileDataBase64,
      copies,
      printerName,
      printOptions
    });
    const queueLabel = data.result.queue ? `cola <b>${data.result.queue}</b>` : "cola predeterminada";
    log(`Trabajo enviado por <b>${data.result.method}</b> a ${queueLabel}.`);
    setChip(chipQueue, `Cola: ${data.result.queue || "predeterminada"}`, "good");
    if (data.result.note) {
      log(`Nota: ${data.result.note}`);
    }
    if (data.result.stdout) {
      log(`Salida: ${data.result.stdout}`);
    }
    if (data.result.stderr) {
      log(`Detalle: ${data.result.stderr}`);
    }
    if (Array.isArray(data.result.appliedOptions) && data.result.appliedOptions.length > 0) {
      log(`Opciones aplicadas: <b>${data.result.appliedOptions.join(", ")}</b>`);
    }
  } catch (error) {
    log(`<span class="pill-bad">Error al imprimir:</span> ${error.message}`);
  } finally {
    setLoading(false);
  }
});

seedFallbackPrintOptions();
setChip(chipConnection, "Conexión: pendiente", "neutral");
setChip(chipPaper, "Papel: pendiente", "neutral");
setChip(chipQueue, "Cola: sin seleccionar", "neutral");
refreshFastPath();
detectSystemPrinters(true).catch((error) => {
  log(`Autodetección inicial no disponible: ${error.message}`);
  setChip(chipQueue, "Cola: autodetección no disponible", "warn");
});
