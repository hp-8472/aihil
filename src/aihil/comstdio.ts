import type { Readable, Writable } from "node:stream";
import { ComPortService } from "./comports.js";
import type { AIHILConfig, JsonObject } from "./types.js";

export interface ComStdioOptions {
  maxReadBytes?: number | null;
  readWaitTimeoutS?: number;
  eofIdleTimeoutS?: number;
}

export async function runComStdio(
  config: AIHILConfig,
  portId: string,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  errorOutput: Writable = process.stderr,
  options: ComStdioOptions = {},
): Promise<number> {
  const service = new ComPortService(config);
  let failed = false;
  let stdinDone = false;
  let startedOk = false;
  try {
    const started = await service.sessionStart(portId, true);
    if (!started.ok) {
      writeError(errorOutput, started);
      return 1;
    }
    startedOk = true;
    const port = config.com_ports[portId];
    const readSize = options.maxReadBytes ?? port.max_buffer_bytes;
    const readWaitTimeoutS = options.readWaitTimeoutS ?? 0.05;
    const eofIdleTimeoutS = options.eofIdleTimeoutS ?? 0.5;

    input.on("data", async (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const result = await service.writeBytes(portId, data, "aihil_com_stdio_write");
      if (!result.ok) {
        failed = true;
        writeError(errorOutput, result);
      }
    });
    input.on("end", () => {
      stdinDone = true;
    });

    let lastDataAt = Date.now();
    while (!failed) {
      const result = await service.readBytes(portId, readSize, readWaitTimeoutS, "aihil_com_stdio_read");
      if (!result.ok) {
        failed = true;
        writeError(errorOutput, result);
        break;
      }
      if (Number(result.bytes_read ?? 0) > 0) {
        output.write(String((result.data as JsonObject).text ?? ""));
        lastDataAt = Date.now();
        continue;
      }
      if (stdinDone && Date.now() - lastDataAt >= eofIdleTimeoutS * 1000) {
        break;
      }
      await delay(10);
    }
    return failed ? 1 : 0;
  } finally {
    if (startedOk) {
      await service.sessionStop(portId);
    }
    await service.close();
  }
}

function writeError(output: Writable, result: JsonObject): void {
  output.write(`${JSON.stringify(result)}\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
