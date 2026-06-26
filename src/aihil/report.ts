import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AIHILConfig, JsonObject } from "./types.js";
import { displayPath, resolveWorkPath } from "./config.js";

export function utcNowIso(): string {
  return new Date().toISOString();
}

export function timestampForFilename(): string {
  return new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "") + "Z";
}

export function reportsDirectory(config: AIHILConfig): string {
  const directory = resolveWorkPath(config, config.reports.directory);
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function logsDirectory(config: AIHILConfig): string {
  const directory = resolveWorkPath(config, config.logs.directory);
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function lastReportPath(config: AIHILConfig): string {
  return path.join(reportsDirectory(config), "last-report.json");
}

export function writeReport(config: AIHILConfig, report: JsonObject): JsonObject {
  const reportPath = lastReportPath(config);
  const enriched = { ...report };
  if (enriched.report_path === undefined) {
    enriched.report_path = displayPath(config, reportPath);
  }
  writeFileSync(reportPath, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");
  return enriched;
}

export function readLastReport(config: AIHILConfig): JsonObject {
  const reportPath = lastReportPath(config);
  if (!existsSync(reportPath)) {
    return {
      ok: false,
      tool: "aihil_get_last_report",
      error_type: "report_not_found",
      summary: "No AI-HIL report has been written yet.",
    };
  }
  try {
    return JSON.parse(readFileSync(reportPath, "utf8")) as JsonObject;
  } catch {
    return {
      ok: false,
      tool: "aihil_get_last_report",
      error_type: "config_invalid",
      summary: "Last AI-HIL report is not valid JSON.",
      report_path: displayPath(config, reportPath),
    };
  }
}
