import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AIHILConfig } from "./types.js";
import { handleMcpMessage, parseErrorResponse } from "./mcp.js";
import { AIHILToolService } from "./tools.js";

export async function runStdioServer(
  config: AIHILConfig,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<number> {
  const tools = new AIHILToolService(config);
  const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const rawLine of lines) {
      const line = String(rawLine).trim();
      if (!line) {
        continue;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        writeMessage(output, parseErrorResponse());
        continue;
      }
      const response = await handleMcpMessage(message, tools);
      if (response !== null) {
        writeMessage(output, response);
      }
    }
  } finally {
    await tools.close();
  }
  return 0;
}

function writeMessage(output: Writable, message: unknown): void {
  output.write(`${JSON.stringify(message)}\n`);
}
