import { appendFileSync } from "node:fs";
import type { AIHILConfig, ComPortConfig, JsonObject } from "./types.js";
import { displayPath } from "./config.js";
import { logsDirectory, timestampForFilename, utcNowIso, writeReport } from "./report.js";
import path from "node:path";

interface ComPortSession {
  portId: string;
  portConfig: ComPortConfig;
  serialHandle: any;
  logPath: string;
  startedAt: string;
  active: boolean;
  buffer: Buffer;
  overflowBytes: number;
  readerError: JsonObject | null;
}

export async function listAvailableComPorts(tool = "aihil_com_ports_available"): Promise<JsonObject> {
  let serialport: any;
  try {
    serialport = await import("serialport");
  } catch {
    return {
      ok: false,
      tool,
      error_type: "serial_backend_not_available",
      summary: "serialport is not installed or could not be imported.",
      likely_causes: ["install AI-HIL with its runtime dependencies", "serialport installation is broken"],
    };
  }

  try {
    const SerialPort = serialport.SerialPort ?? serialport.default;
    const portInfos = await SerialPort.list();
    const ports = portInfos.map((portInfo: unknown) => availablePortInfo(portInfo));
    return {
      ok: true,
      tool,
      ports,
      summary: `${ports.length} available COM port(s).`,
    };
  } catch (error) {
    return {
      ok: false,
      tool,
      error_type: "com_port_discovery_failed",
      summary: "Available COM ports could not be listed.",
      backend_error: error instanceof Error ? error.message : String(error),
      likely_causes: ["serial backend reported an OS error", "USB serial driver state changed during discovery"],
    };
  }
}

export class ComPortService {
  private readonly sessions = new Map<string, ComPortSession>();

  constructor(private readonly config: AIHILConfig) {}

  async listPorts(): Promise<JsonObject> {
    const ports: JsonObject = {};
    for (const [portId, portConfig] of Object.entries(this.config.com_ports)) {
      ports[portId] = this.portStatus(portConfig, this.sessions.get(portId) ?? null);
    }
    const available = await listAvailableComPorts();
    const availableCount = available.ok ? Number((available.ports as unknown[])?.length ?? 0) : 0;
    return {
      ok: true,
      tool: "aihil_com_ports_list",
      ports,
      available_com_ports: available,
      summary: `${Object.keys(ports).length} configured COM port(s), ${availableCount} available host COM port(s).`,
    };
  }

  async sessionStart(portId: string, clearBuffer = true): Promise<JsonObject> {
    const port = this.configuredPort(portId, "aihil_com_session_start");
    if (!port.ok) {
      return this.writeReport(port);
    }
    if (!this.config.permissions.allow_com_read) {
      return this.writeReport(
        this.permissionDenied("aihil_com_session_start", "COM port reading is disabled by .aihil/config.yaml.", portId),
      );
    }

    const existing = this.sessions.get(portId);
    if (existing && this.sessionIsActive(existing)) {
      if (clearBuffer) {
        existing.buffer = Buffer.alloc(0);
      }
      return this.writeReport({
        ok: true,
        tool: "aihil_com_session_start",
        port_id: portId,
        already_active: true,
        session: this.sessionStatus(existing),
        summary: "COM port session is already active.",
      });
    }
    if (existing) {
      this.sessions.delete(portId);
    }

    const opened = await this.openSerial(portId, port.port_config as ComPortConfig);
    if (!opened.ok) {
      return this.writeReport(opened);
    }
    const session = opened.session as ComPortSession;
    this.sessions.set(portId, session);
    this.attachSerialHandlers(session);
    this.writeSessionLog(session, { event: "start", port_id: portId, device: session.portConfig.device });

    return this.writeReport({
      ok: true,
      tool: "aihil_com_session_start",
      port_id: portId,
      already_active: false,
      session: this.sessionStatus(session),
      summary: "COM port session started.",
    });
  }

  async sessionStop(portId: string): Promise<JsonObject> {
    const port = this.configuredPort(portId, "aihil_com_session_stop");
    if (!port.ok) {
      return this.writeReport(port);
    }
    const session = this.sessions.get(portId) ?? null;
    this.sessions.delete(portId);
    if (session === null) {
      return this.writeReport({
        ok: true,
        tool: "aihil_com_session_stop",
        port_id: portId,
        was_active: false,
        summary: "COM port session was not active.",
      });
    }
    await this.stopSession(session, "requested");
    return this.writeReport({
      ok: true,
      tool: "aihil_com_session_stop",
      port_id: portId,
      was_active: true,
      session: this.sessionStatus(session),
      summary: "COM port session stopped.",
    });
  }

  async write(portId: string, payload: JsonObject): Promise<JsonObject> {
    const port = this.configuredPort(portId, "aihil_com_write");
    if (!port.ok) {
      return this.writeReport(port);
    }
    const encoded = this.payloadBytes(port.port_config as ComPortConfig, payload);
    if (!encoded.ok) {
      encoded.port_id = portId;
      return this.writeReport(encoded);
    }
    return this.writeReport(await this.writeBytes(portId, encoded.data as Buffer, "aihil_com_write"));
  }

  async writeBytes(portId: string, data: Buffer, tool = "aihil_com_write"): Promise<JsonObject> {
    if (!this.config.permissions.allow_com_write) {
      return this.permissionDenied(tool, "COM port writing is disabled by .aihil/config.yaml.", portId);
    }
    const sessionResult = this.activeSession(portId, tool);
    if (!sessionResult.ok) {
      return sessionResult;
    }
    const session = sessionResult.session as ComPortSession;
    if (data.length > session.portConfig.max_write_bytes) {
      return {
        ok: false,
        tool,
        port_id: portId,
        error_type: "invalid_argument",
        summary: "COM port write exceeds configured max_write_bytes.",
        bytes_requested: data.length,
        max_write_bytes: session.portConfig.max_write_bytes,
      };
    }

    try {
      await writeSerial(session.serialHandle, data);
    } catch (error) {
      const result = {
        ok: false,
        tool,
        port_id: portId,
        error_type: "serial_write_failed",
        summary: "COM port write failed.",
        backend_error: error instanceof Error ? error.message : String(error),
        likely_causes: this.likelyCauses("serial_write_failed"),
        log_path: displayPath(this.config, session.logPath),
      };
      this.writeSessionLog(session, { event: "error", ...result });
      return result;
    }

    this.writeSessionLog(session, {
      direction: "tx",
      bytes: data.length,
      hex: data.toString("hex"),
      text: decodeBuffer(data, session.portConfig.encoding),
    });
    return {
      ok: true,
      tool,
      port_id: portId,
      bytes_written: data.length,
      data: this.dataResult(data, session.portConfig.encoding),
      log_path: displayPath(this.config, session.logPath),
      summary: "Stimulus written to COM port.",
    };
  }

  async read(portId: string, maxBytes?: unknown, waitTimeoutS: unknown = 0.0): Promise<JsonObject> {
    return this.writeReport(await this.readBytes(portId, maxBytes, waitTimeoutS, "aihil_com_read"));
  }

  async readBytes(portId: string, maxBytes?: unknown, waitTimeoutS: unknown = 0.0, tool = "aihil_com_read"): Promise<JsonObject> {
    if (!this.config.permissions.allow_com_read) {
      return this.permissionDenied(tool, "COM port reading is disabled by .aihil/config.yaml.", portId);
    }
    const sessionResult = this.activeSession(portId, tool);
    if (!sessionResult.ok) {
      return sessionResult;
    }
    const session = sessionResult.session as ComPortSession;

    const parsedMaxBytes = maxBytes === undefined || maxBytes === null ? session.portConfig.max_buffer_bytes : Number.parseInt(String(maxBytes), 10);
    let parsedWaitTimeoutS = Number(waitTimeoutS);
    if (!Number.isFinite(parsedMaxBytes) || !Number.isFinite(parsedWaitTimeoutS)) {
      return {
        ok: false,
        tool,
        port_id: portId,
        error_type: "invalid_argument",
        summary: "max_bytes must be an integer and wait_timeout_s must be a number.",
      };
    }
    if (parsedMaxBytes < 1) {
      return {
        ok: false,
        tool,
        port_id: portId,
        error_type: "invalid_argument",
        summary: "max_bytes must be at least 1.",
      };
    }
    parsedWaitTimeoutS = Math.max(0, Math.min(parsedWaitTimeoutS, 60));
    const deadline = Date.now() + parsedWaitTimeoutS * 1000;
    while (session.buffer.length === 0 && this.sessionIsActive(session) && Date.now() < deadline) {
      await delay(10);
    }

    const data = session.buffer.subarray(0, parsedMaxBytes);
    session.buffer = session.buffer.subarray(parsedMaxBytes);
    const result: JsonObject = {
      ok: true,
      tool,
      port_id: portId,
      bytes_read: data.length,
      buffer_remaining_bytes: session.buffer.length,
      overflow_bytes: session.overflowBytes,
      data: this.dataResult(data, session.portConfig.encoding),
      log_path: displayPath(this.config, session.logPath),
      summary: data.length ? "Feedback read from COM port." : "No COM port feedback was available.",
    };
    if (session.readerError) {
      result.reader_error = session.readerError;
    }
    return result;
  }

  async close(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(sessions.map((session) => this.stopSession(session, "shutdown")));
  }

  activeSessionStatus(portId: string, tool = "aihil_com_session_status"): JsonObject {
    const sessionResult = this.activeSession(portId, tool);
    if (!sessionResult.ok) {
      return sessionResult;
    }
    return {
      ok: true,
      tool,
      port_id: portId,
      session: this.sessionStatus(sessionResult.session as ComPortSession),
    };
  }

  private async openSerial(portId: string, portConfig: ComPortConfig): Promise<JsonObject> {
    let serialport: any;
    try {
      serialport = await import("serialport");
    } catch {
      return {
        ok: false,
        tool: "aihil_com_session_start",
        port_id: portId,
        error_type: "serial_backend_not_available",
        summary: "serialport is not installed or could not be imported.",
        likely_causes: ["install AI-HIL with its runtime dependencies", "serialport installation is broken"],
      };
    }

    try {
      const SerialPort = serialport.SerialPort ?? serialport.default;
      const serialHandle = new SerialPort({
        path: portConfig.device,
        baudRate: portConfig.baudrate,
        autoOpen: false,
      });
      await openSerial(serialHandle);
      const logPath = path.join(logsDirectory(this.config), `com-${timestampForFilename()}-${safeFilename(portId)}.jsonl`);
      return {
        ok: true,
        session: {
          portId,
          portConfig,
          serialHandle,
          logPath,
          startedAt: utcNowIso(),
          active: true,
          buffer: Buffer.alloc(0),
          overflowBytes: 0,
          readerError: null,
        } satisfies ComPortSession,
      };
    } catch (error) {
      return {
        ok: false,
        tool: "aihil_com_session_start",
        port_id: portId,
        error_type: "com_port_open_failed",
        summary: "COM port could not be opened.",
        backend_error: error instanceof Error ? error.message : String(error),
        likely_causes: this.likelyCauses("com_port_open_failed"),
      };
    }
  }

  private attachSerialHandlers(session: ComPortSession): void {
    session.serialHandle.on?.("data", (data: Buffer) => {
      const chunk = Buffer.from(data);
      session.buffer = Buffer.concat([session.buffer, chunk]);
      const overflow = session.buffer.length - session.portConfig.max_buffer_bytes;
      if (overflow > 0) {
        session.buffer = session.buffer.subarray(overflow);
        session.overflowBytes += overflow;
      }
      this.writeSessionLog(session, {
        direction: "rx",
        bytes: chunk.length,
        hex: chunk.toString("hex"),
        text: decodeBuffer(chunk, session.portConfig.encoding),
      });
    });
    session.serialHandle.on?.("error", (error: Error) => {
      if (!session.active) {
        return;
      }
      session.readerError = {
        error_type: "serial_read_failed",
        summary: "COM port reader failed.",
        backend_error: error.message,
        likely_causes: this.likelyCauses("serial_read_failed"),
      };
      this.writeSessionLog(session, { event: "error", ...session.readerError });
    });
    session.serialHandle.on?.("close", () => {
      session.active = false;
    });
  }

  private activeSession(portId: string, tool: string): JsonObject {
    const port = this.configuredPort(portId, tool);
    if (!port.ok) {
      return port;
    }
    const session = this.sessions.get(portId) ?? null;
    if (session === null || !this.sessionIsActive(session)) {
      return {
        ok: false,
        tool,
        port_id: portId,
        error_type: "session_not_active",
        summary: "COM port session is not active. Start it with aihil_com_session_start first.",
      };
    }
    return { ok: true, session };
  }

  private configuredPort(portId: string, tool: string): JsonObject {
    if (!portId) {
      return {
        ok: false,
        tool,
        error_type: "invalid_argument",
        summary: "port_id is required.",
      };
    }
    const portConfig = this.config.com_ports[portId];
    if (portConfig === undefined) {
      return {
        ok: false,
        tool,
        port_id: portId,
        error_type: "com_port_not_configured",
        summary: "COM port is not configured in .aihil/config.yaml.",
        configured_ports: Object.keys(this.config.com_ports).sort(),
      };
    }
    return { ok: true, port_config: portConfig };
  }

  private portStatus(portConfig: ComPortConfig, session: ComPortSession | null): JsonObject {
    const result: JsonObject = {
      device: portConfig.device,
      baudrate: portConfig.baudrate,
      encoding: portConfig.encoding,
      max_buffer_bytes: portConfig.max_buffer_bytes,
      max_write_bytes: portConfig.max_write_bytes,
      session_active: false,
    };
    if (session !== null) {
      Object.assign(result, this.sessionStatus(session));
    }
    return result;
  }

  private sessionStatus(session: ComPortSession): JsonObject {
    const result: JsonObject = {
      session_active: this.sessionIsActive(session),
      started_at: session.startedAt,
      rx_buffer_bytes: session.buffer.length,
      overflow_bytes: session.overflowBytes,
      log_path: displayPath(this.config, session.logPath),
    };
    if (session.readerError) {
      result.reader_error = session.readerError;
    }
    return result;
  }

  private sessionIsActive(session: ComPortSession): boolean {
    return session.active && Boolean(session.serialHandle?.isOpen ?? true);
  }

  private async stopSession(session: ComPortSession, reason: string): Promise<void> {
    session.active = false;
    try {
      await closeSerial(session.serialHandle);
    } catch {
      // Closing an already-closed serial port is harmless during shutdown.
    }
    this.writeSessionLog(session, { event: "stop", reason });
  }

  private payloadBytes(portConfig: ComPortConfig, payload: JsonObject): JsonObject {
    const hasText = payload.text !== undefined && payload.text !== null;
    const hasHex = payload.hex !== undefined && payload.hex !== null;
    if (hasText === hasHex) {
      return {
        ok: false,
        tool: "aihil_com_write",
        error_type: "invalid_argument",
        summary: "Provide exactly one of text or hex.",
      };
    }
    if (hasText) {
      if (typeof payload.text !== "string") {
        return {
          ok: false,
          tool: "aihil_com_write",
          error_type: "invalid_argument",
          summary: "text must be a string.",
        };
      }
      const encoding = nodeEncoding(portConfig.encoding);
      if (encoding === null) {
        return {
          ok: false,
          tool: "aihil_com_write",
          error_type: "config_invalid",
          summary: "COM port encoding is not supported by Node.js.",
          encoding: portConfig.encoding,
        };
      }
      return { ok: true, data: Buffer.from(payload.text, encoding) };
    }
    if (typeof payload.hex !== "string") {
      return {
        ok: false,
        tool: "aihil_com_write",
        error_type: "invalid_argument",
        summary: "hex must be a string.",
      };
    }
    const cleaned = payload.hex.replace(/\s+/g, "");
    if (cleaned.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(cleaned)) {
      return {
        ok: false,
        tool: "aihil_com_write",
        error_type: "invalid_argument",
        summary: "hex must contain valid hexadecimal bytes.",
      };
    }
    return { ok: true, data: Buffer.from(cleaned, "hex") };
  }

  private dataResult(data: Buffer, encoding: string): JsonObject {
    return {
      hex: data.toString("hex"),
      text: decodeBuffer(data, encoding),
      encoding,
    };
  }

  private writeSessionLog(session: ComPortSession, event: JsonObject): void {
    const entry = { ...event };
    entry.time ??= utcNowIso();
    appendFileSync(session.logPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private writeReport(result: JsonObject): JsonObject {
    return writeReport(this.config, result);
  }

  private permissionDenied(tool: string, summary: string, portId?: string): JsonObject {
    const result: JsonObject = {
      ok: false,
      tool,
      error_type: "permission_denied",
      summary,
    };
    if (portId) {
      result.port_id = portId;
    }
    return result;
  }

  private likelyCauses(errorType: string): string[] {
    const causes: Record<string, string[]> = {
      com_port_open_failed: [
        "configured COM port device does not exist",
        "COM port is already open in another program",
        "USB serial adapter is unplugged or driver is missing",
      ],
      serial_read_failed: [
        "COM port was disconnected",
        "serial driver reported an I/O error",
        "another process interfered with the port",
      ],
      serial_write_failed: [
        "COM port was disconnected",
        "serial driver write timed out",
        "target or USB serial adapter stopped responding",
      ],
    };
    return causes[errorType] ?? ["inspect the COM port log for details"];
  }
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_") || "port";
}

function availablePortInfo(portInfo: any): JsonObject {
  const result: JsonObject = { device: String(portInfo?.path ?? portInfo?.device ?? "") };
  for (const fieldName of ["name", "description", "hwid", "manufacturer", "product", "interface", "location", "serialNumber", "serial_number"]) {
    const value = portInfo?.[fieldName];
    if (value !== undefined && value !== null) {
      result[fieldName === "serialNumber" ? "serial_number" : fieldName] = String(value);
    }
  }
  for (const fieldName of ["vendorId", "productId", "vid", "pid"]) {
    const value = portInfo?.[fieldName];
    if (value !== undefined && value !== null) {
      const outputName = fieldName === "vendorId" ? "vid" : fieldName === "productId" ? "pid" : fieldName;
      const parsed = Number.parseInt(String(value), 16);
      result[outputName] = Number.isFinite(parsed) ? parsed : String(value);
    }
  }
  return result;
}

function nodeEncoding(encoding: string): BufferEncoding | null {
  const normalized = encoding.toLowerCase().replace(/_/g, "-");
  const aliases: Record<string, BufferEncoding> = {
    "utf-8": "utf8",
    utf8: "utf8",
    ascii: "ascii",
    "latin-1": "latin1",
    latin1: "latin1",
    binary: "binary",
    base64: "base64",
    hex: "hex",
    ucs2: "ucs2",
    "ucs-2": "ucs2",
    utf16le: "utf16le",
    "utf-16le": "utf16le",
  };
  const result = aliases[normalized];
  return result && Buffer.isEncoding(result) ? result : null;
}

function decodeBuffer(data: Buffer, encoding: string): string {
  const parsed = nodeEncoding(encoding) ?? "utf8";
  return data.toString(parsed);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openSerial(serialHandle: any): Promise<void> {
  return new Promise((resolve, reject) => {
    serialHandle.open((error: Error | null | undefined) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function closeSerial(serialHandle: any): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!serialHandle?.isOpen) {
      resolve();
      return;
    }
    serialHandle.close((error: Error | null | undefined) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function writeSerial(serialHandle: any, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    serialHandle.write(data, (writeError: Error | null | undefined) => {
      if (writeError) {
        reject(writeError);
        return;
      }
      if (typeof serialHandle.drain !== "function") {
        resolve();
        return;
      }
      serialHandle.drain((drainError: Error | null | undefined) => {
        if (drainError) {
          reject(drainError);
        } else {
          resolve();
        }
      });
    });
  });
}
