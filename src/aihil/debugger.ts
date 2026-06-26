import type { AIHILConfig, JsonObject } from "./types.js";
import { ConfigError } from "./config.js";
import { OpenOCDBackend } from "./debuggers/openocd.js";

export interface DebuggerBackend {
  info(): Promise<JsonObject>;
  probeTarget(): Promise<JsonObject>;
  flashFirmware(artifact: JsonObject): Promise<JsonObject>;
  resetTarget(mode?: string): Promise<JsonObject>;
  classifyLastError(): Promise<JsonObject>;
}

export function createDebuggerBackend(config: AIHILConfig): DebuggerBackend {
  if (config.debugger.type === "openocd") {
    return new OpenOCDBackend(config);
  }
  throw new ConfigError("config_invalid", "Unsupported debugger.type.", {
    field: "debugger.type",
    value: config.debugger.type,
    allowed_values: ["openocd"],
  });
}
