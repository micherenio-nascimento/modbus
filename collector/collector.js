import http from "node:http";
import mysql from "mysql2/promise";
import client from "prom-client";

const INVALID_READING = 2147483647;
const MISSING_SENSOR = 2147483645;

const config = {
  baseUrl: (process.env.DSE_BASE_URL ?? "http://187.51.141.58:8001").replace(/\/$/, ""),
  username: process.env.DSE_USER ?? "admin",
  password: process.env.DSE_PASSWORD ?? "",
  controlToken: process.env.CONTROL_TOKEN ?? "",
  collectIntervalMs: envInt("COLLECT_INTERVAL_SECONDS", 1) * 1000,
  mysqlSaveIntervalMs: envInt("MYSQL_SAVE_INTERVAL_SECONDS", 300) * 1000,
  sessionRefreshMs: envInt("SESSION_REFRESH_SECONDS", 0) * 1000,
  metricsPort: envInt("METRICS_PORT", 9108),
  mysql: {
    host: process.env.MYSQL_HOST ?? "mysql",
    port: envInt("MYSQL_PORT", 3306),
    database: process.env.MYSQL_DATABASE ?? "dse855",
    user: process.env.MYSQL_USER ?? "dse",
    password: process.env.MYSQL_PASSWORD ?? "dse_password"
  }
};

const DSE_COMMANDS = {
  stop: 35700,
  auto: 35701
};

const PROMETHEUS_CONTROL_QUERIES = {
  dse_control_stop: "stop",
  stop: "stop",
  dse_control_auto: "auto",
  auto: "auto"
};

function envInt(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return Number.parseInt(value, 10);
}

function isValidNumber(value) {
  return typeof value === "number" && value !== INVALID_READING && value !== MISSING_SENSOR;
}

function scaled(value, factor = 10) {
  return isValidNumber(value) ? value / factor : null;
}

function raw(value) {
  return isValidNumber(value) ? value : null;
}

function engineHours(seconds) {
  if (!isValidNumber(seconds)) {
    return { seconds: null, decimal: null, text: null };
  }
  const totalSeconds = Math.trunc(seconds);
  const hours = Math.trunc(totalSeconds / 3600);
  const minutes = Math.trunc((totalSeconds % 3600) / 60);
  return {
    seconds: totalSeconds,
    decimal: totalSeconds / 3600,
    text: `${hours}h ${minutes}m`
  };
}

class DseClient {
  constructor() {
    this.sid = null;
    this.loginAt = 0;
  }

  async login() {
    const data = await getJson(`${config.baseUrl}/login.cgi`, {
      user: config.username,
      password: config.password
    });

    if (!Number.isInteger(data.SID)) {
      throw new Error(`Login sem SID valido: ${JSON.stringify(data)}`);
    }

    this.sid = data.SID;
    this.loginAt = Date.now();
    console.log(`Login realizado; SID=${this.sid}`);
  }

  async realtime() {
    if (this.sid === null || this.mustRefreshSession()) {
      await this.login();
    }

    let data = await getJson(`${config.baseUrl}/realtime.cgi`, { SID: this.sid });
    if (this.sidInvalidPayload(data)) {
      console.warn("SID aparentemente expirado; refazendo login");
      await this.login();
      data = await getJson(`${config.baseUrl}/realtime.cgi`, { SID: this.sid });
    }

    return data;
  }

  async command(name) {
    if (this.sid === null || this.mustRefreshSession()) {
      await this.login();
    }

    const intButton = DSE_COMMANDS[name];
    if (intButton === undefined) {
      throw new Error(`Comando DSE desconhecido: ${name}`);
    }

    let data = await getAny(`${config.baseUrl}/save.cgi`, {
      SID: this.sid,
      action: 1,
      intButton
    });

    if (this.sidInvalidPayload(data)) {
      console.warn("SID aparentemente expirado durante comando; refazendo login");
      await this.login();
      data = await getAny(`${config.baseUrl}/save.cgi`, {
        SID: this.sid,
        action: 1,
        intButton
      });
    }

    return {
      command: name,
      intButton,
      sid: this.sid,
      response: data
    };
  }

  mustRefreshSession() {
    return config.sessionRefreshMs > 0 && Date.now() - this.loginAt >= config.sessionRefreshMs;
  }

  sidInvalidPayload(data) {
    if (data && typeof data === "object" && "MODBUS" in data) return false;
    return Boolean(data?.ERROR || data?.ERR || data?.STATUS === "ERROR");
  }
}

async function getJson(url, params) {
  const { body } = await getBody(url, params);
  return JSON.parse(body);
}

async function getAny(url, params) {
  const { body, contentType } = await getBody(url, params);
  if (contentType.includes("application/json")) {
    return JSON.parse(body);
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

async function getBody(url, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }

  const response = await fetch(`${url}?${search.toString()}`, {
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} em ${url}`);
    error.status = response.status;
    throw error;
  }

  return {
    body: await response.text(),
    contentType: response.headers.get("content-type") ?? ""
  };
}

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const gauges = {
  batteryV: gauge("dse_engine_battery_volts", "Engine battery voltage"),
  frequencyHz: gauge("dse_mains_frequency_hz", "Mains frequency"),
  mainsL1V: gauge("dse_mains_l1_volts", "Mains L1-N voltage"),
  mainsL2V: gauge("dse_mains_l2_volts", "Mains L2-N voltage"),
  mainsL3V: gauge("dse_mains_l3_volts", "Mains L3-N voltage"),
  mainsL12V: gauge("dse_mains_l1_l2_volts", "Mains L1-L2 voltage"),
  mainsL23V: gauge("dse_mains_l2_l3_volts", "Mains L2-L3 voltage"),
  mainsL31V: gauge("dse_mains_l3_l1_volts", "Mains L3-L1 voltage"),
  accumulatedKwh: gauge("dse_accumulated_kwh", "Accumulated kWh"),
  accumulatedKvah: gauge("dse_accumulated_kvah", "Accumulated kVAh"),
  accumulatedKvarh: gauge("dse_accumulated_kvarh", "Accumulated kVArh"),
  engineStarts: gauge("dse_engine_starts_total", "Engine starts"),
  engineHours: gauge("dse_engine_hours", "Engine hours"),
  moduleLink: gauge("dse_module_link", "Module link status"),
  alarmLevel: gauge("dse_alarm_level", "Alarm level"),
  collectSuccess: gauge("dse_collect_success", "Last collect success, 1 or 0"),
  lastCollectTimestamp: gauge("dse_last_collect_timestamp_seconds", "Last successful collect timestamp"),
  controlSuccess: gauge("dse_control_success", "Last control command success, 1 or 0"),
  lastControlTimestamp: gauge("dse_last_control_timestamp_seconds", "Last successful control command timestamp")
};

const moduleInfo = new client.Gauge({
  name: "dse_module_info",
  help: "DSE module information",
  labelNames: ["model", "usbid", "version", "serial", "unit_version"],
  registers: [register]
});

function gauge(name, help) {
  return new client.Gauge({ name, help, registers: [register] });
}

function parsePayload(payload) {
  const modbus = payload.MODBUS ?? {};
  const module = payload.MODULE ?? {};
  const hours = engineHours(modbus["305"]);

  return {
    sid: payload.SID ?? null,
    moduleModel: module.MODEL ?? null,
    moduleUsbid: module.USBID ?? null,
    moduleLink: raw(module.LINK),
    alarmLevel: raw(module.ALARMLEVEL),
    batteryV: scaled(modbus["5"]),
    frequencyHz: scaled(modbus["22"]),
    mainsL1V: scaled(modbus["23"]),
    mainsL2V: scaled(modbus["24"]),
    mainsL3V: scaled(modbus["25"]),
    mainsL12V: scaled(modbus["26"]),
    mainsL23V: scaled(modbus["27"]),
    mainsL31V: scaled(modbus["28"]),
    accumulatedKwh: scaled(modbus["306"]),
    accumulatedKvah: scaled(modbus["308"]),
    accumulatedKvarh: scaled(modbus["309"]),
    engineStarts: raw(modbus["310"]),
    engineHoursSeconds: hours.seconds,
    engineHours: hours.decimal,
    engineHoursText: hours.text
  };
}

function publishMetrics(parsed, payload) {
  for (const [name, metric] of Object.entries(gauges)) {
    if (name in parsed && parsed[name] !== null) {
      metric.set(parsed[name]);
    }
  }

  const module = payload.MODULE ?? {};
  const info = payload.INFO ?? {};
  moduleInfo.reset();
  moduleInfo
    .labels(
      String(module.MODEL ?? ""),
      String(module.USBID ?? ""),
      String(module.VERSION ?? ""),
      String(info.SERIAL ?? ""),
      String(info.UNITVERSION ?? "")
    )
    .set(1);

  gauges.collectSuccess.set(1);
  gauges.lastCollectTimestamp.set(Date.now() / 1000);
}

class MysqlWriter {
  constructor() {
    this.pool = mysql.createPool({
      ...config.mysql,
      waitForConnections: true,
      connectionLimit: 5,
      namedPlaceholders: true
    });
  }

  async saveSnapshot(parsed, payload) {
    await this.pool.execute(
      `
      INSERT INTO dse_readings (
        sid, module_model, module_usbid, module_link, alarm_level,
        battery_v, frequency_hz,
        mains_l1_v, mains_l2_v, mains_l3_v,
        mains_l12_v, mains_l23_v, mains_l31_v,
        accumulated_kwh, accumulated_kvah, accumulated_kvarh,
        engine_starts, engine_hours_seconds, engine_hours_text,
        raw_payload
      ) VALUES (
        :sid, :moduleModel, :moduleUsbid, :moduleLink, :alarmLevel,
        :batteryV, :frequencyHz,
        :mainsL1V, :mainsL2V, :mainsL3V,
        :mainsL12V, :mainsL23V, :mainsL31V,
        :accumulatedKwh, :accumulatedKvah, :accumulatedKvarh,
        :engineStarts, :engineHoursSeconds, :engineHoursText,
        :rawPayload
      )
      `,
      {
        ...parsed,
        rawPayload: JSON.stringify(payload)
      }
    );
    console.log("Snapshot salvo no MySQL");
  }
}

function startMetricsServer(dse) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "OPTIONS") {
      writeCors(response, 204);
      response.end();
      return;
    }

    if (url.pathname === "/metrics") {
      response.writeHead(200, { "content-type": register.contentType });
      response.end(await register.metrics());
      return;
    }

    if (url.pathname === "/api/v1/status/buildinfo") {
      writeJson(response, 200, {
        status: "success",
        data: {
          version: "dse855-control",
          revision: "local",
          branch: "main",
          buildUser: "collector",
          buildDate: new Date().toISOString(),
          goVersion: "node"
        }
      });
      return;
    }

    if (url.pathname === "/api/v1/labels") {
      writeJson(response, 200, {
        status: "success",
        data: ["__name__", "command", "intButton"]
      });
      return;
    }

    if (url.pathname === "/api/v1/label/__name__/values") {
      writeJson(response, 200, {
        status: "success",
        data: ["dse_control_stop", "dse_control_auto", "dse_control_command"]
      });
      return;
    }

    if (url.pathname === "/api/v1/series") {
      writeJson(response, 200, {
        status: "success",
        data: []
      });
      return;
    }

    if (url.pathname === "/api/v1/metadata") {
      writeJson(response, 200, {
        status: "success",
        data: {}
      });
      return;
    }

    if (url.pathname === "/api/v1/query") {
      await handlePrometheusControlQuery(request, response, url, dse);
      return;
    }

    if (url.pathname === "/api/v1/query_range") {
      writeJson(response, 200, {
        status: "success",
        data: {
          resultType: "matrix",
          result: []
        }
      });
      return;
    }

    if (url.pathname === "/control/stop" || url.pathname === "/api/dse/stop") {
      await handleControlRequest(request, response, url, dse, "stop");
      return;
    }

    if (url.pathname === "/control/auto" || url.pathname === "/api/dse/auto") {
      await handleControlRequest(request, response, url, dse, "auto");
      return;
    }

    writeText(response, 404, "not found\n");
  });

  server.listen(config.metricsPort, "0.0.0.0", () => {
    console.log(`Metricas em :${config.metricsPort}/metrics`);
    console.log(`Controle DSE em :${config.metricsPort}/control/{stop,auto}`);
  });

  return server;
}

async function handlePrometheusControlQuery(request, response, url, dse) {
  if (request.method !== "GET" && request.method !== "POST") {
    writePrometheusError(response, 405, "bad_data", "method not allowed");
    return;
  }

  let query = url.searchParams.get("query") ?? "";
  if (request.method === "POST") {
    const body = await readRequestBody(request);
    const params = new URLSearchParams(body);
    query = params.get("query") ?? query;
  }

  const command = PROMETHEUS_CONTROL_QUERIES[query.trim()];
  if (!command) {
    writeJson(response, 200, {
      status: "success",
      data: {
        resultType: "vector",
        result: []
      }
    });
    return;
  }

  if (!isAuthorized(request, url)) {
    writePrometheusError(response, 401, "unauthorized", "unauthorized");
    return;
  }

  try {
    const result = await dse.command(command);
    gauges.controlSuccess.set(1);
    gauges.lastControlTimestamp.set(Date.now() / 1000);
    writeJson(response, 200, prometheusVectorResult(command, result.intButton, 1));
  } catch (error) {
    gauges.controlSuccess.set(0);
    console.error(`Falha ao executar comando ${command}`, error);
    writePrometheusError(response, 502, "execution", error instanceof Error ? error.message : String(error));
  }
}

async function handleControlRequest(request, response, url, dse, command) {
  if (request.method !== "GET" && request.method !== "POST") {
    writeJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  if (!isAuthorized(request, url)) {
    writeJson(response, 401, { ok: false, error: "unauthorized" });
    return;
  }

  try {
    const result = await dse.command(command);
    gauges.controlSuccess.set(1);
    gauges.lastControlTimestamp.set(Date.now() / 1000);
    writeJson(response, 200, { ok: true, ...result });
  } catch (error) {
    gauges.controlSuccess.set(0);
    console.error(`Falha ao executar comando ${command}`, error);
    writeJson(response, 502, {
      ok: false,
      command,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function prometheusVectorResult(command, intButton, value) {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result: [
        {
          metric: {
            __name__: "dse_control_command",
            command,
            intButton: String(intButton)
          },
          value: [Date.now() / 1000, String(value)]
        }
      ]
    }
  };
}

function writePrometheusError(response, statusCode, errorType, error) {
  writeJson(response, statusCode, {
    status: "error",
    errorType,
    error
  });
}

function isAuthorized(request, url) {
  if (!config.controlToken) return true;
  return request.headers["x-control-token"] === config.controlToken || url.searchParams.get("token") === config.controlToken;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function writeCors(response, statusCode, headers = {}) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-control-token",
    ...headers
  });
}

function writeJson(response, statusCode, payload) {
  writeCors(response, statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function writeText(response, statusCode, text) {
  writeCors(response, statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const dse = new DseClient();
  const writer = new MysqlWriter();
  const server = startMetricsServer(dse);
  let lastSave = 0;
  let stopping = false;

  const stop = async () => {
    stopping = true;
    server.close();
    await writer.pool.end();
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (!stopping) {
    const started = Date.now();
    try {
      const payload = await dse.realtime();
      const parsed = parsePayload(payload);
      publishMetrics(parsed, payload);

      if (started - lastSave >= config.mysqlSaveIntervalMs) {
        await writer.saveSnapshot(parsed, payload);
        lastSave = started;
      }
    } catch (error) {
      gauges.collectSuccess.set(0);
      console.error("Falha na coleta", error);
    }

    const elapsed = Date.now() - started;
    await sleep(Math.max(100, config.collectIntervalMs - elapsed));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
