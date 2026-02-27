const http = require("http");
const path = require("path");
const fs = require("fs/promises");
const dns = require("dns").promises;
const net = require("net");
const os = require("os");
const { exec, execFile } = require("child_process");
const { randomUUID } = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3210;
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_PORTS = [631, 9100, 80, 443];
const DEFAULT_JSON_BODY_LIMIT = 64 * 1024;
const MAX_PRINT_FILE_BYTES = 20 * 1024 * 1024;
const PAPER_STATUS_OID = "1.3.6.1.2.1.43.8.2.1.10";
const PAPER_LEVEL_OID = "1.3.6.1.2.1.43.8.2.1.9";
const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function isValidHost(input) {
  if (typeof input !== "string") {
    return false;
  }

  const host = input.trim();
  if (!host || host.length > 253) {
    return false;
  }

  // Basic allow-list for hostnames and IP-like strings.
  return /^[A-Za-z0-9.-]+$/.test(host);
}

async function readJsonBody(req, maxBytes = DEFAULT_JSON_BODY_LIMIT) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) {
      throw new Error("Body demasiado grande");
    }
  }
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("JSON inválido");
  }
}

function parsePorts(input) {
  const ports = Array.isArray(input) ? input : DEFAULT_PORTS;
  const parsed = ports
    .map((value) => Number(value))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
  return parsed.length > 0 ? [...new Set(parsed)] : DEFAULT_PORTS;
}

function parseHostFromDeviceUri(deviceUri) {
  if (typeof deviceUri !== "string" || !deviceUri.trim()) {
    return null;
  }
  const raw = deviceUri.trim();
  try {
    const parsed = new URL(raw);
    return parsed.hostname || null;
  } catch (error) {
    const ipv4 = raw.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    return ipv4 ? ipv4[0] : null;
  }
}

function normalizeQueueName(queueName) {
  if (typeof queueName !== "string") {
    return "";
  }
  const value = queueName.trim();
  return /^[\w.-]{1,120}$/.test(value) ? value : "";
}

function sanitizeOptionKey(key) {
  if (typeof key !== "string") {
    return null;
  }
  const value = key.trim();
  return /^[A-Za-z][A-Za-z0-9-]*$/.test(value) ? value : null;
}

function sanitizeOptionValue(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return /^[A-Za-z0-9_.:-]+$/.test(normalized) ? normalized : null;
}

function parseCupsOptionChoices(text) {
  const tokens = String(text || "").trim().split(/\s+/).filter(Boolean);
  const options = [];
  let defaultValue = null;
  tokens.forEach((token) => {
    const raw = token.startsWith("*") ? token.slice(1) : token;
    if (!raw) {
      return;
    }
    options.push(raw);
    if (token.startsWith("*")) {
      defaultValue = raw;
    }
  });
  return { options: [...new Set(options)], defaultValue };
}

function parseCapabilitiesOutput(output) {
  const raw = {};
  String(output || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .forEach((line) => {
      const match = line.match(/^([^\/:\s]+)(?:\/([^:]+))?:\s*(.+)$/);
      if (!match) {
        return;
      }
      const key = match[1];
      const label = match[2] ? match[2].trim() : key;
      const values = parseCupsOptionChoices(match[3]);
      raw[key.toLowerCase()] = {
        key,
        label,
        options: values.options,
        defaultValue: values.defaultValue
      };
    });

  const pickByKeys = (keys) => {
    for (const key of keys) {
      if (raw[key]) {
        return raw[key];
      }
    }
    return null;
  };

  return {
    orientation: pickByKeys(["orientation-requested"]),
    pageSize: pickByKeys(["pagesize", "media"]),
    color: pickByKeys(["print-color-mode", "colormodel", "outputmode"]),
    inputSlot: pickByKeys(["inputslot"]),
    sides: pickByKeys(["sides"]),
    rawOptions: raw
  };
}

async function listSystemPrinters() {
  const [statusResult, deviceResult] = await Promise.all([
    execFileResult("lpstat", ["-p", "-d"], 10_000),
    execFileResult("lpstat", ["-v"], 10_000)
  ]);
  const combinedText = [
    statusResult.stdout,
    statusResult.stderr,
    deviceResult.stdout,
    deviceResult.stderr
  ].join("\n");

  if (combinedText.toLowerCase().includes("scheduler is not running")) {
    throw new Error("CUPS scheduler no está activo. Inicia CUPS (`sudo service cups start`).");
  }
  if (!statusResult.ok && !statusResult.stdout.trim() && !deviceResult.stdout.trim()) {
    throw new Error(statusResult.stderr.trim() || "No fue posible consultar impresoras del sistema.");
  }

  const printers = new Map();
  const defaultMatch = combinedText.match(/system default destination:\s*(\S+)/i);
  const defaultPrinter = defaultMatch ? defaultMatch[1] : null;

  statusResult.stdout.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^printer\s+(\S+)\s+is\s+(.+)$/i);
    if (!match) {
      return;
    }
    const name = match[1];
    const statusText = match[2].trim();
    const existing = printers.get(name) || { name };
    existing.statusText = statusText;
    existing.isDefault = name === defaultPrinter;
    printers.set(name, existing);
  });

  deviceResult.stdout.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^device for\s+(\S+):\s*(.+)$/i);
    if (!match) {
      return;
    }
    const name = match[1];
    const deviceUri = match[2].trim();
    const existing = printers.get(name) || { name };
    existing.deviceUri = deviceUri;
    existing.host = parseHostFromDeviceUri(deviceUri);
    existing.isDefault = name === defaultPrinter;
    printers.set(name, existing);
  });

  const items = Array.from(printers.values()).sort((a, b) => {
    if (a.isDefault && !b.isDefault) {
      return -1;
    }
    if (!a.isDefault && b.isDefault) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    defaultPrinter,
    printers: items,
    source: "cups"
  };
}

async function getPrinterCapabilities(printerName) {
  const safeName = normalizeQueueName(printerName);
  if (!safeName) {
    throw new Error("Nombre de impresora/cola inválido.");
  }
  const result = await execFileResult("lpoptions", ["-p", safeName, "-l"], 12_000);
  if (!result.ok && !result.stdout.trim()) {
    throw new Error(result.stderr.trim() || `No fue posible leer capacidades de ${safeName}.`);
  }
  const capabilities = parseCapabilitiesOutput(result.stdout);
  return {
    printerName: safeName,
    capabilities
  };
}

function execFileResult(command, args, timeout = 12000) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout,
        maxBuffer: 4 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          error,
          stdout: stdout || "",
          stderr: stderr || "",
          command,
          args
        });
      }
    );
  });
}

function isMissingCommand(error) {
  return Boolean(error && (error.code === "ENOENT" || error.code === 127));
}

function extractIntegers(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/-?\d+/);
      return match ? Number(match[0]) : null;
    })
    .filter((value) => Number.isInteger(value));
}

function mapInputStatusCode(code) {
  const map = {
    "-3": "some",
    "-2": "unknownVendor",
    1: "other",
    2: "unknown",
    3: "available",
    4: "availableStandby",
    5: "notAvailable"
  };
  return map[code] || `code:${code}`;
}

function sanitizeFileName(fileName) {
  const normalized = path.basename(String(fileName || "documento"));
  const cleaned = normalized.replace(/[^\w.-]/g, "_");
  const safe = cleaned.length > 0 ? cleaned : "documento";
  return safe.slice(0, 120);
}

function resolveColorIntent(printOptions) {
  const options = printOptions && typeof printOptions === "object" ? printOptions : {};
  if (options.colorMode === "mono" || options.colorMode === "color") {
    return options.colorMode;
  }
  const candidate = String(options.colorOptionValue || "").toLowerCase();
  if (!candidate) {
    return null;
  }
  if (/(gray|grey|mono|black|bw|grayscale|greyscale|kgray|fastgray)/.test(candidate)) {
    return "mono";
  }
  if (/(color|colour|rgb|cmyk)/.test(candidate)) {
    return "color";
  }
  return null;
}

function isRawFriendlyExtension(fileName) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  const supported = new Set([".prn", ".pcl", ".pclm", ".ps", ".txt"]);
  return supported.has(ext);
}

function decodeBase64Payload(payload) {
  if (typeof payload !== "string" || !payload.trim()) {
    throw new Error("No se recibió contenido de archivo.");
  }
  const clean = payload.trim().replace(/\s/g, "");
  const buffer = Buffer.from(clean, "base64");
  if (!buffer.length) {
    throw new Error("Archivo vacío o base64 inválido.");
  }
  return buffer;
}

function escapePowershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function probePaperStatusSnmp(host) {
  const statusResult = await execFileResult("snmpwalk", ["-v1", "-c", "public", "-OQv", host, PAPER_STATUS_OID], 9000);
  if (statusResult.error && isMissingCommand(statusResult.error)) {
    return {
      supported: false,
      paperState: "unknown",
      message: "No fue posible validar papel: falta `snmpwalk` en el sistema."
    };
  }

  if (!statusResult.ok && !statusResult.stdout.trim()) {
    return {
      supported: true,
      paperState: "unknown",
      message: "SNMP no respondió. Habilita SNMP en la impresora o usa HP Smart para validar bandeja."
    };
  }

  const levelResult = await execFileResult("snmpwalk", ["-v1", "-c", "public", "-OQv", host, PAPER_LEVEL_OID], 9000);
  const statusCodes = extractIntegers(statusResult.stdout);
  const levels = extractIntegers(levelResult.stdout);
  const mappedStatus = statusCodes.map(mapInputStatusCode);
  const emptyByStatus = statusCodes.some((code) => code === 5);
  const emptyByLevel = levels.some((value) => value === 0);
  const hasAvailable = statusCodes.some((code) => code === 3 || code === 4);
  const hasPositiveLevel = levels.some((value) => value > 0);
  const hasVendorUnknown = statusCodes.some((code) => code < 0) || levels.some((value) => value < 0);

  if (emptyByStatus || emptyByLevel) {
    return {
      supported: true,
      paperState: "no_paper",
      message: "La bandeja principal parece sin papel o no disponible.",
      details: { trayStatus: mappedStatus, trayLevels: levels }
    };
  }

  if (hasAvailable) {
    return {
      supported: true,
      paperState: "paper_ok",
      message: "La impresora reporta bandeja disponible.",
      details: { trayStatus: mappedStatus, trayLevels: levels }
    };
  }

  if (hasPositiveLevel) {
    return {
      supported: true,
      paperState: "paper_ok",
      message: "La impresora reporta nivel de hojas mayor a 0.",
      details: { trayStatus: mappedStatus, trayLevels: levels }
    };
  }

  if (hasVendorUnknown) {
    return {
      supported: true,
      paperState: "unknown",
      message: "El modelo responde SNMP pero no expone estado de papel confiable (valor vendor como -2/-3).",
      details: { trayStatus: mappedStatus, trayLevels: levels }
    };
  }

  return {
    supported: true,
    paperState: "unknown",
    message: "No se pudo confirmar papel con precisión (estado SNMP ambiguo).",
    details: { trayStatus: mappedStatus, trayLevels: levels }
  };
}

async function probePaperStatusCups(printerName) {
  const safeName = normalizeQueueName(printerName);
  if (!safeName) {
    return {
      supported: false,
      paperState: "unknown",
      message: "Nombre de cola inválido para consultar estado en CUPS."
    };
  }
  const result = await execFileResult("lpstat", ["-l", "-p", safeName], 10_000);
  const text = `${result.stdout}\n${result.stderr}`;
  const lower = text.toLowerCase();

  if (lower.includes("scheduler is not running")) {
    return {
      supported: false,
      paperState: "unknown",
      message: "CUPS no está activo para consultar alertas de papel."
    };
  }
  if (lower.includes("unknown destination")) {
    return {
      supported: false,
      paperState: "unknown",
      message: `La cola ${safeName} no existe en CUPS.`
    };
  }

  const noPaperSignals = [
    "media-empty",
    "paper-out",
    "out of paper",
    "media needed",
    "input tray empty"
  ];
  if (noPaperSignals.some((signal) => lower.includes(signal))) {
    return {
      supported: true,
      paperState: "no_paper",
      message: "CUPS reporta alerta de papel vacío.",
      details: { printerName: safeName, raw: text.trim() }
    };
  }

  const alertsLine = text.split(/\r?\n/).find((line) => /^alerts:/i.test(line.trim())) || "";
  const isAlertsNone = /alerts:\s*(none|ninguna|sin alertas)/i.test(alertsLine);
  if (isAlertsNone) {
    return {
      supported: true,
      paperState: "paper_ok",
      message: "CUPS no reporta alerta de papel para la cola seleccionada.",
      details: { printerName: safeName, alerts: alertsLine.trim() }
    };
  }

  return {
    supported: true,
    paperState: "unknown",
    message: "CUPS no reporta un estado concluyente de papel.",
    details: { printerName: safeName, alerts: alertsLine.trim() || null }
  };
}

function mergePaperStatus(snmpPaper, cupsPaper) {
  if (!snmpPaper && !cupsPaper) {
    return {
      source: "none",
      supported: false,
      paperState: "unknown",
      message: "Sin fuente de estado de papel disponible."
    };
  }
  if (snmpPaper && snmpPaper.paperState !== "unknown") {
    return { ...snmpPaper, source: "snmp" };
  }
  if (cupsPaper && cupsPaper.paperState !== "unknown") {
    return { ...cupsPaper, source: "cups" };
  }
  if (snmpPaper) {
    return { ...snmpPaper, source: "snmp" };
  }
  return { ...cupsPaper, source: "cups" };
}

async function detectPrinterStatus({ host, printerName }) {
  const hasHost = Boolean(host);
  const hasPrinter = Boolean(printerName);
  const [dnsLookup, port631, port9100, snmpPaper, cupsPaper] = await Promise.all([
    hasHost ? lookupHost(host) : Promise.resolve(null),
    hasHost ? probeTcp(host, 631, 1800) : Promise.resolve(null),
    hasHost ? probeTcp(host, 9100, 1800) : Promise.resolve(null),
    hasHost ? probePaperStatusSnmp(host) : Promise.resolve(null),
    hasPrinter ? probePaperStatusCups(printerName) : Promise.resolve(null)
  ]);
  const paper = mergePaperStatus(snmpPaper, cupsPaper);

  return {
    host,
    printerName: printerName || null,
    timestamp: nowIso(),
    dnsLookup,
    connectivity: {
      ipp631: port631,
      raw9100: port9100
    },
    paper,
    paperSources: {
      snmp: snmpPaper,
      cups: cupsPaper
    }
  };
}

function appendUnixPrintOptions(lpArgs, printOptions) {
  const options = printOptions && typeof printOptions === "object" ? printOptions : {};
  const orientationMap = {
    portrait: "3",
    landscape: "4",
    "reverse-portrait": "5",
    "reverse-landscape": "6"
  };
  const appliedOptions = [];
  const seen = new Set();

  const normalizedColorIntent = resolveColorIntent(options);

  const pushOption = (keyInput, valueInput) => {
    const key = sanitizeOptionKey(keyInput);
    const value = sanitizeOptionValue(valueInput);
    if (!key || !value) {
      return;
    }
    const dedupeKey = `${key.toLowerCase()}=${value.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    lpArgs.push("-o", `${key}=${value}`);
    appliedOptions.push(`${key}=${value}`);
  };

  if (orientationMap[options.orientation]) {
    pushOption("orientation-requested", orientationMap[options.orientation]);
  }
  if (options.pageSize) {
    pushOption(options.pageSizeOptionKey || "media", options.pageSize);
  }
  if (options.inputSlot) {
    pushOption(options.inputSlotOptionKey || "InputSlot", options.inputSlot);
  }
  if (options.sides) {
    pushOption(options.sidesOptionKey || "sides", options.sides);
  }
  if (options.colorOptionKey && options.colorOptionValue) {
    pushOption(options.colorOptionKey, options.colorOptionValue);
  }

  if (normalizedColorIntent === "mono") {
    // Different HP/CUPS stacks honor different keys for monochrome.
    pushOption("print-color-mode", "monochrome");
    pushOption("ColorModel", "Gray");
    pushOption("ColorModel", "Grayscale");
    pushOption("OutputMode", "Monochrome");
    pushOption("HPColorMode", "grayscale");
    pushOption("cupsColorSpace", "17");
  } else if (normalizedColorIntent === "color") {
    pushOption("print-color-mode", "color");
    pushOption("ColorModel", "RGB");
    pushOption("OutputMode", "Color");
    pushOption("HPColorMode", "color");
  }

  return appliedOptions;
}

async function maybePrepareMonochromeFile(filePath, fileName, printOptions) {
  const colorIntent = resolveColorIntent(printOptions);
  if (colorIntent !== "mono") {
    return {
      filePath,
      extraFiles: [],
      note: null,
      applied: false
    };
  }

  const ext = path.extname(String(fileName || "")).toLowerCase();
  if (ext !== ".pdf") {
    return {
      filePath,
      extraFiles: [],
      note: "Modo B/N solicitado. La conversión forzada solo aplica automáticamente a PDF.",
      applied: false
    };
  }

  const grayPath = path.join(os.tmpdir(), `printer-ui-gray-${randomUUID()}.pdf`);
  const gsArgs = [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    "-dNOPAUSE",
    "-dBATCH",
    "-dSAFER",
    "-sColorConversionStrategy=Gray",
    "-dProcessColorModel=/DeviceGray",
    "-dAutoFilterColorImages=false",
    "-dAutoFilterGrayImages=false",
    "-sColorImageFilter=FlateEncode",
    "-sGrayImageFilter=FlateEncode",
    `-sOutputFile=${grayPath}`,
    filePath
  ];
  const gsResult = await execFileResult("gs", gsArgs, 120_000);
  if (gsResult.ok) {
    return {
      filePath: grayPath,
      extraFiles: [grayPath],
      note: "PDF convertido a escala de grises antes de enviar a la impresora.",
      applied: true
    };
  }

  await fs.unlink(grayPath).catch(() => {});
  if (isMissingCommand(gsResult.error)) {
    return {
      filePath,
      extraFiles: [],
      note: "No se pudo forzar escala de grises porque falta `ghostscript` (`gs`).",
      applied: false
    };
  }

  return {
    filePath,
    extraFiles: [],
    note: `Falló conversión a B/N previa (ghostscript): ${gsResult.stderr.trim() || gsResult.error.message}`,
    applied: false
  };
}

async function printWithUnix(filePath, copies, printerName, printOptions) {
  const lpArgs = [];
  if (printerName) {
    lpArgs.push("-d", printerName);
  }
  if (copies > 1) {
    lpArgs.push("-n", String(copies));
  }
  const appliedOptions = appendUnixPrintOptions(lpArgs, printOptions);
  lpArgs.push(filePath);

  const lpResult = await execFileResult("lp", lpArgs, 60_000);
  if (lpResult.ok) {
    return {
      method: "lp",
      stdout: lpResult.stdout.trim(),
      stderr: lpResult.stderr.trim(),
      appliedOptions
    };
  }

  if (!isMissingCommand(lpResult.error)) {
    throw new Error(lpResult.stderr.trim() || lpResult.error.message || "Falló comando lp.");
  }

  const lprArgs = [];
  if (printerName) {
    lprArgs.push("-P", printerName);
  }
  if (copies > 1) {
    lprArgs.push("-#", String(copies));
  }
  lprArgs.push(filePath);
  const lprResult = await execFileResult("lpr", lprArgs, 60_000);
  if (!lprResult.ok) {
    if (isMissingCommand(lprResult.error)) {
      throw new Error("No hay comandos de impresión disponibles (`lp`/`lpr`) en este sistema.");
    }
    throw new Error(lprResult.stderr.trim() || lprResult.error.message || "Falló comando lpr.");
  }

  return {
    method: "lpr",
    stdout: lprResult.stdout.trim(),
    stderr: lprResult.stderr.trim(),
    note: "Opciones avanzadas no se aplican con fallback `lpr`; usa `lp` para control fino.",
    appliedOptions: []
  };
}

async function printWithWindows(filePath, printerName, copies) {
  const printerLiteral = printerName ? escapePowershellLiteral(printerName) : null;
  const fileLiteral = escapePowershellLiteral(filePath);
  const safeCopies = Number.isInteger(copies) ? Math.min(Math.max(copies, 1), 30) : 1;
  const command = printerLiteral
    ? `$ErrorActionPreference='Stop'; for($i=0; $i -lt ${safeCopies}; $i++){ $p = Start-Process -FilePath ${fileLiteral} -Verb PrintTo -ArgumentList ${printerLiteral} -PassThru; Wait-Process -Id $p.Id -Timeout 45 }`
    : `$ErrorActionPreference='Stop'; for($i=0; $i -lt ${safeCopies}; $i++){ $p = Start-Process -FilePath ${fileLiteral} -Verb Print -PassThru; Wait-Process -Id $p.Id -Timeout 45 }`;
  const result = await execFileResult("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], 70_000);

  if (!result.ok) {
    if (isMissingCommand(result.error)) {
      throw new Error("No se encontró PowerShell para imprimir en Windows.");
    }
    throw new Error(result.stderr.trim() || result.error.message || "Falló impresión con PowerShell.");
  }

  return {
    method: "powershell",
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

async function submitPrintJob({ host, fileName, fileDataBase64, copies, printerName, printOptions }) {
  const safeFileName = sanitizeFileName(fileName);
  const fileBuffer = decodeBase64Payload(fileDataBase64);
  if (fileBuffer.length > MAX_PRINT_FILE_BYTES) {
    throw new Error(`El archivo excede el límite de ${Math.round(MAX_PRINT_FILE_BYTES / (1024 * 1024))} MB.`);
  }
  const safeCopies = Number.isInteger(copies) ? Math.min(Math.max(copies, 1), 30) : 1;
  const queue = typeof printerName === "string" ? printerName.trim() : "";
  const extension = path.extname(safeFileName) || ".bin";
  const tempPath = path.join(os.tmpdir(), `printer-ui-${randomUUID()}${extension}`);
  const tempFiles = [tempPath];
  const notes = [];
  let printFilePath = tempPath;

  await fs.writeFile(tempPath, fileBuffer);
  try {
    const monoPrep = await maybePrepareMonochromeFile(tempPath, safeFileName, printOptions);
    if (monoPrep.filePath !== tempPath) {
      printFilePath = monoPrep.filePath;
      tempFiles.push(...monoPrep.extraFiles);
    }
    if (monoPrep.note) {
      notes.push(monoPrep.note);
    }

    let printResult;
    try {
      printResult = os.platform() === "win32"
        ? await printWithWindows(printFilePath, queue, safeCopies)
        : await printWithUnix(printFilePath, safeCopies, queue, printOptions);
    } catch (error) {
      const isNoSystemPrinter =
        String(error && error.message ? error.message : "").includes("No hay comandos de impresión disponibles")
        || String(error && error.message ? error.message : "").includes("No se encontró PowerShell");

      if (!isNoSystemPrinter) {
        throw error;
      }

      if (!isRawFriendlyExtension(safeFileName)) {
        throw new Error(
          "No hay spooler local (`lp/lpr`) y el modo RAW 9100 no es confiable para este tipo de archivo. " +
          "Instala CUPS (`lp`/`lpr`) o imprime por HP Smart/controlador del sistema."
        );
      }
      if (!host) {
        throw new Error("No hay spooler local y falta host/IP para fallback RAW 9100.");
      }

      // Fallback when local spooler tools are unavailable:
      // send bytes directly to JetDirect/RAW port 9100 on the printer.
      printResult = await printWithRawSocket(host, fileBuffer, safeCopies);
    }

    return {
      fileName: safeFileName,
      sizeBytes: fileBuffer.length,
      copies: safeCopies,
      queue: queue || null,
      note: notes.length > 0 ? notes.join(" ") : null,
      ...printResult
    };
  } finally {
    const uniqueTempFiles = [...new Set(tempFiles)];
    await Promise.all(uniqueTempFiles.map((file) => fs.unlink(file).catch(() => {})));
  }
}

function writeBufferToRawSocket(host, port, buffer, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = new net.Socket();
    let done = false;

    const finish = (error) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      resolve({ elapsedMs: Date.now() - started });
    };

    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => finish(new Error("Timeout enviando datos al puerto 9100.")));
    socket.once("error", (error) => finish(error));
    socket.connect(port, host, () => {
      socket.write(buffer, (error) => {
        if (error) {
          finish(error);
          return;
        }
        socket.end(() => finish(null));
      });
    });
  });
}

async function printWithRawSocket(host, fileBuffer, copies) {
  const rawPort = await probeTcp(host, 9100, 2200);
  if (!rawPort.ok) {
    throw new Error("No hay spooler local y la impresora no aceptó conexión RAW (9100).");
  }

  let lastElapsed = 0;
  for (let i = 0; i < copies; i += 1) {
    const sent = await writeBufferToRawSocket(host, 9100, fileBuffer);
    lastElapsed = sent.elapsedMs;
  }

  return {
    method: "raw-9100",
    stdout: `Enviado por socket RAW a ${host}:9100`,
    stderr: "",
    elapsedMs: lastElapsed,
    note: "Este modo depende de que la impresora soporte el formato enviado (por ejemplo PDF)."
  };
}

function parsePingOutput(text) {
  const normalized = text.replace(/\r/g, "");
  const unixAvg = normalized.match(/(?:min\/avg\/max(?:\/(?:mdev|stddev))?)\s*=\s*[\d.]+\/([\d.]+)\//i);
  if (unixAvg) {
    return { avgMs: Number(unixAvg[1]), packetLoss: parsePacketLoss(normalized) };
  }

  const windowsAvg = normalized.match(/Average\s*=\s*(\d+)\s*ms/i);
  if (windowsAvg) {
    return { avgMs: Number(windowsAvg[1]), packetLoss: parsePacketLoss(normalized) };
  }

  return { avgMs: null, packetLoss: parsePacketLoss(normalized) };
}

function parsePacketLoss(text) {
  const unixLoss = text.match(/(\d+(?:\.\d+)?)%\s*packet loss/i);
  if (unixLoss) {
    return Number(unixLoss[1]);
  }

  const windowsLoss = text.match(/Lost\s*=\s*\d+\s*\((\d+)%\s*loss\)/i);
  if (windowsLoss) {
    return Number(windowsLoss[1]);
  }

  return null;
}

async function runPing(host, count = 3, timeoutMs = 1500) {
  const isWindows = os.platform() === "win32";
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const command = isWindows
    ? `ping -n ${count} -w ${timeoutMs} ${host}`
    : `ping -c ${count} -W ${timeoutSec} ${host}`;

  return new Promise((resolve) => {
    const started = Date.now();
    exec(command, { timeout: timeoutMs * count + 2500 }, (error, stdout, stderr) => {
      const elapsedMs = Date.now() - started;
      const parsed = parsePingOutput(`${stdout}\n${stderr}`);
      resolve({
        ok: !error,
        avgMs: parsed.avgMs,
        packetLoss: parsed.packetLoss,
        elapsedMs,
        command,
        error: error ? error.message : null
      });
    });
  });
}

async function lookupHost(host) {
  const started = Date.now();
  try {
    const result = await dns.lookup(host);
    return {
      ok: true,
      address: result.address,
      family: result.family,
      elapsedMs: Date.now() - started,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      address: null,
      family: null,
      elapsedMs: Date.now() - started,
      error: error.message
    };
  }
}

function probeTcp(host, port, timeoutMs = 2200) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok, errorMessage) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({
        port,
        ok,
        elapsedMs: Date.now() - started,
        error: errorMessage || null
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "Timeout"));
    socket.once("error", (error) => finish(false, error.code || error.message));
    socket.connect(port, host);
  });
}

function buildRecommendations(diagnostics) {
  const tips = [];
  const { dnsLookup, ping, tcp } = diagnostics;
  const openPorts = tcp.filter((entry) => entry.ok);
  const closedPorts = tcp.filter((entry) => !entry.ok);

  if (!dnsLookup.ok) {
    tips.push("No se resolvió el hostname. Prueba con la IP fija de la impresora para evitar búsquedas lentas.");
  } else if (dnsLookup.elapsedMs > 120) {
    tips.push("La resolución DNS tardó más de lo ideal. Configurar IP estática suele mejorar el primer intento de impresión.");
  }

  if (ping.ok && ping.avgMs !== null && ping.avgMs > 80) {
    tips.push("El ping promedio es alto. Acerca impresora y router o usa banda 2.4 GHz estable para menor latencia.");
  }

  if (ping.packetLoss !== null && ping.packetLoss > 0) {
    tips.push("Hay pérdida de paquetes. Revisa interferencia Wi-Fi o saturación de red para evitar colas lentas.");
  }

  if (openPorts.length === 0) {
    tips.push("No respondió ningún puerto común (631/9100/80/443). Verifica que la impresora esté en la misma red.");
  } else {
    const slowestOpen = openPorts.reduce((acc, item) => (item.elapsedMs > acc.elapsedMs ? item : acc), openPorts[0]);
    if (slowestOpen.elapsedMs > 700) {
      tips.push("La impresora parece entrar en suspensión profunda. Activa Fast Path para mantenerla despierta.");
    }
  }

  const has631 = openPorts.some((entry) => entry.port === 631);
  const has9100 = openPorts.some((entry) => entry.port === 9100);
  if (!has631 && has9100) {
    tips.push("IPP (631) no responde y RAW (9100) sí. En desktop, usar driver RAW/JetDirect puede reducir tiempos.");
  }

  if (closedPorts.some((entry) => entry.port === 443) && openPorts.some((entry) => entry.port === 80)) {
    tips.push("Solo HTTP responde (sin HTTPS). Si usas app de escritorio, prueba descubrimiento por IP manual.");
  }

  if (tips.length === 0) {
    tips.push("Conectividad estable. El retraso puede estar en el spooler o en el controlador de impresión del sistema.");
  }

  return tips;
}

function calcScore(diagnostics) {
  let score = 100;
  if (!diagnostics.dnsLookup.ok) {
    score -= 35;
  } else {
    score -= Math.min(20, Math.round(diagnostics.dnsLookup.elapsedMs / 15));
  }

  if (!diagnostics.ping.ok) {
    score -= 20;
  } else if (diagnostics.ping.avgMs !== null) {
    score -= Math.min(20, Math.round(diagnostics.ping.avgMs / 6));
  }

  if (diagnostics.ping.packetLoss !== null) {
    score -= Math.min(25, Math.round(diagnostics.ping.packetLoss * 2));
  }

  const openPorts = diagnostics.tcp.filter((entry) => entry.ok);
  if (openPorts.length === 0) {
    score -= 30;
  } else {
    const fastest = Math.min(...openPorts.map((entry) => entry.elapsedMs));
    score -= Math.min(15, Math.round(fastest / 80));
  }

  return Math.max(0, score);
}

async function runDiagnostics(host, ports, pingCount) {
  const [dnsLookup, ping, tcp] = await Promise.all([
    lookupHost(host),
    runPing(host, pingCount, 1400),
    Promise.all(ports.map((port) => probeTcp(host, port)))
  ]);

  const diagnostics = {
    host,
    timestamp: nowIso(),
    dnsLookup,
    ping,
    tcp
  };

  return {
    ...diagnostics,
    score: calcScore(diagnostics),
    recommendations: buildRecommendations(diagnostics)
  };
}

async function lightweightProbe(host, ports) {
  const dnsLookup = await lookupHost(host);
  let portResult = null;
  for (const port of ports) {
    const probe = await probeTcp(host, port, 1800);
    if (probe.ok) {
      portResult = probe;
      break;
    }
    if (!portResult) {
      portResult = probe;
    }
  }

  return {
    timestamp: nowIso(),
    dnsMs: dnsLookup.elapsedMs,
    dnsOk: dnsLookup.ok,
    port: portResult ? portResult.port : null,
    portMs: portResult ? portResult.elapsedMs : null,
    portOk: portResult ? portResult.ok : false
  };
}

function getSessionView(session) {
  return {
    host: session.host,
    intervalMs: session.intervalMs,
    ports: session.ports,
    startedAt: session.startedAt,
    active: Boolean(session.timer),
    probes: session.probes,
    successes: session.successes,
    failures: session.failures,
    lastProbe: session.lastProbe
  };
}

async function startFastPath(host, intervalMs, ports) {
  const current = sessions.get(host);
  if (current && current.timer) {
    clearInterval(current.timer);
  }

  const session = {
    host,
    intervalMs,
    ports,
    startedAt: nowIso(),
    probes: 0,
    successes: 0,
    failures: 0,
    lastProbe: null,
    timer: null
  };

  const runCycle = async () => {
    const result = await lightweightProbe(host, ports);
    session.probes += 1;
    session.lastProbe = result;
    if (result.dnsOk && result.portOk) {
      session.successes += 1;
    } else {
      session.failures += 1;
    }
  };

  await runCycle();
  session.timer = setInterval(() => {
    runCycle().catch(() => {
      session.failures += 1;
    });
  }, intervalMs);

  sessions.set(host, session);
  return getSessionView(session);
}

function stopFastPath(host) {
  const session = sessions.get(host);
  if (!session) {
    return { stopped: false, reason: "No hay sesión activa para ese host." };
  }
  if (session.timer) {
    clearInterval(session.timer);
    session.timer = null;
  }
  sessions.delete(host);
  return { stopped: true, session: getSessionView(session) };
}

async function serveStatic(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(parsedUrl.pathname);
  if (pathname === "/") {
    pathname = "/index.html";
  }

  const absolutePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (absolutePath !== PUBLIC_DIR && !absolutePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(absolutePath);
    const ext = path.extname(absolutePath);
    const contentType = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    }[ext] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch (error) {
    sendText(res, 404, "Not Found");
  }
}

async function handleApi(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;
  const normalizedPath = pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;

  if (req.method === "GET" && normalizedPath === "/api/health") {
    const activeFastPaths = Array.from(sessions.values()).filter((session) => Boolean(session.timer)).length;
    sendJson(res, 200, {
      ok: true,
      now: nowIso(),
      activeFastPaths
    });
    return;
  }

  if (req.method === "GET" && normalizedPath === "/api/system/printers") {
    const result = await listSystemPrinters();
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "POST" && normalizedPath === "/api/diagnose") {
    const body = await readJsonBody(req);
    const host = (body.host || "").trim();
    if (!isValidHost(host)) {
      sendJson(res, 400, { ok: false, error: "Host inválido. Usa IP o hostname." });
      return;
    }
    const ports = parsePorts(body.ports);
    const pingCount = Number.isInteger(body.pingCount) ? Math.min(Math.max(body.pingCount, 1), 6) : 3;
    const result = await runDiagnostics(host, ports, pingCount);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "POST" && normalizedPath === "/api/fast-path/start") {
    const body = await readJsonBody(req);
    const host = (body.host || "").trim();
    if (!isValidHost(host)) {
      sendJson(res, 400, { ok: false, error: "Host inválido." });
      return;
    }
    const ports = parsePorts(body.ports);
    const intervalMs = Number.isInteger(body.intervalMs)
      ? Math.min(Math.max(body.intervalMs, 8_000), 120_000)
      : 25_000;
    const session = await startFastPath(host, intervalMs, ports);
    sendJson(res, 200, { ok: true, session });
    return;
  }

  if (req.method === "POST" && normalizedPath === "/api/fast-path/stop") {
    const body = await readJsonBody(req);
    const host = (body.host || "").trim();
    if (!isValidHost(host)) {
      sendJson(res, 400, { ok: false, error: "Host inválido." });
      return;
    }
    const result = stopFastPath(host);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if ((req.method === "POST" || req.method === "GET") && normalizedPath === "/api/printer/status") {
    const body = req.method === "POST" ? await readJsonBody(req) : {};
    const hostParam = req.method === "GET" ? parsedUrl.searchParams.get("host") || "" : body.host || "";
    const printerParam = req.method === "GET"
      ? parsedUrl.searchParams.get("printerName") || ""
      : body.printerName || "";
    const host = hostParam.trim();
    const printerName = normalizeQueueName(printerParam);
    if (!host && !printerName) {
      sendJson(res, 400, { ok: false, error: "Debes enviar host o printerName." });
      return;
    }
    if (host && !isValidHost(host)) {
      sendJson(res, 400, { ok: false, error: "Host inválido." });
      return;
    }
    const result = await detectPrinterStatus({ host, printerName });
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if ((req.method === "POST" || req.method === "GET") && normalizedPath === "/api/printer/capabilities") {
    const body = req.method === "POST" ? await readJsonBody(req) : {};
    const printerParam = req.method === "GET"
      ? parsedUrl.searchParams.get("printerName") || ""
      : body.printerName || "";
    const printerName = normalizeQueueName(printerParam);
    if (!printerName) {
      sendJson(res, 400, { ok: false, error: "printerName inválido." });
      return;
    }
    const result = await getPrinterCapabilities(printerName);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "POST" && normalizedPath === "/api/print") {
    const body = await readJsonBody(req, 30 * 1024 * 1024);
    const host = (body.host || "").trim();
    if (host && !isValidHost(host)) {
      sendJson(res, 400, { ok: false, error: "Host inválido." });
      return;
    }
    const fileName = typeof body.fileName === "string" ? body.fileName : "";
    const fileDataBase64 = typeof body.fileDataBase64 === "string" ? body.fileDataBase64 : "";
    if (!fileName || !fileDataBase64) {
      sendJson(res, 400, { ok: false, error: "Debes enviar archivo y nombre de archivo." });
      return;
    }
    const copies = Number.isInteger(body.copies) ? body.copies : 1;
    const printerName = normalizeQueueName(typeof body.printerName === "string" ? body.printerName : "");
    if (!host && !printerName) {
      sendJson(res, 400, { ok: false, error: "Debes enviar host o printerName para imprimir." });
      return;
    }
    const printOptions = body.printOptions && typeof body.printOptions === "object" ? body.printOptions : {};
    const result = await submitPrintJob({ host, fileName, fileDataBase64, copies, printerName, printOptions });
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "GET" && normalizedPath === "/api/fast-path/status") {
    const host = (parsedUrl.searchParams.get("host") || "").trim();
    if (host) {
      const session = sessions.get(host);
      sendJson(res, 200, {
        ok: true,
        session: session ? getSessionView(session) : null
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      sessions: Array.from(sessions.values()).map(getSessionView)
    });
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: `API route no encontrada: ${req.method} ${normalizedPath}`
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      sendJson(res, 400, { ok: false, error: "URL inválida" });
      return;
    }

    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : "Error interno"
    });
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[printer-ui] running on http://${HOST}:${PORT}`);
});
