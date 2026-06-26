import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AIHILConfig, JsonObject } from "./types.js";
import { displayPath, resolveWorkPath } from "./config.js";

export class ArtifactManager {
  constructor(private readonly config: AIHILConfig) {}

  validateLocalPath(imagePath: string): JsonObject {
    const resolved = resolveWorkPath(this.config, imagePath);
    const validation: JsonObject = {
      path_traversal_safe: !hasTraversalSegment(imagePath),
      exists: existsSync(resolved),
      allowed_root: this.isUnderAllowedRoots(resolved),
      allowed_extension: this.config.artifacts.allowed_extensions.includes(path.extname(resolved).toLowerCase()),
      sha256_computed: false,
    };
    validation.require_allowed_root = validation.allowed_root;

    if (!validation.path_traversal_safe) {
      return this.validationError("Firmware artifact path contains traversal segments.", validation);
    }
    if (this.config.validation.require_existing_file && !validation.exists) {
      return this.validationError("Firmware artifact does not exist.", validation, "artifact_not_found");
    }
    if (this.config.validation.require_allowed_root && !validation.allowed_root) {
      return this.validationError("Firmware artifact is outside allowed artifact roots.", validation);
    }
    if (this.config.validation.require_allowed_extension && !validation.allowed_extension) {
      return this.validationError("Firmware artifact extension is not allowed.", validation);
    }

    let sha256: string | null = null;
    let sizeBytes: number | null = null;
    if (validation.exists) {
      sizeBytes = statSync(resolved).size;
      if (this.config.validation.compute_sha256) {
        sha256 = sha256File(resolved);
        validation.sha256_computed = true;
      }
      if (this.config.validation.inspect_known_formats) {
        Object.assign(validation, this.inspectFormat(resolved));
      }
    }

    const failedPlausibility = ["elf_header", "hex_parseable", "bin_size_plausible"].filter(
      (key) => validation[key] === false,
    );
    if (failedPlausibility.length > 0) {
      return this.validationError("Firmware artifact failed basic format plausibility checks.", validation);
    }

    return {
      ok: true,
      artifact: {
        source: "path",
        path: displayPath(this.config, imagePath),
        resolved_path: resolved,
        sha256,
        size_bytes: sizeBytes,
        validation,
      },
      validation,
    };
  }

  resolveArtifactId(artifactId: string): JsonObject {
    return {
      ok: false,
      tool: "aihil_flash_firmware",
      error_type: "artifact_not_found",
      summary: "Uploaded artifact could not be found.",
      artifact_id: artifactId,
    };
  }

  private validationError(summary: string, validation: JsonObject, errorType = "artifact_validation_failed"): JsonObject {
    return {
      ok: false,
      tool: "aihil_flash_firmware",
      error_type: errorType,
      summary,
      validation,
    };
  }

  private isUnderAllowedRoots(resolvedPath: string): boolean {
    return this.config.artifacts.allowed_roots.some((root) => isRelativeTo(resolvedPath, resolveWorkPath(this.config, root)));
  }

  private inspectFormat(filePath: string): JsonObject {
    const suffix = path.extname(filePath).toLowerCase();
    if (suffix === ".elf") {
      try {
        return { elf_header: readFileSync(filePath).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) };
      } catch {
        return { elf_header: false };
      }
    }
    if (suffix === ".hex") {
      return { hex_parseable: looksLikeIntelHex(filePath) };
    }
    if (suffix === ".bin") {
      try {
        return { bin_size_plausible: statSync(filePath).size > 0 };
      } catch {
        return { bin_size_plausible: false };
      }
    }
    return {};
  }
}

function sha256File(filePath: string): string {
  const digest = createHash("sha256");
  digest.update(readFileSync(filePath));
  return digest.digest("hex");
}

function looksLikeIntelHex(filePath: string): boolean {
  let lines: string[];
  try {
    lines = readFileSync(filePath, "ascii")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return false;
  }
  if (lines.length === 0) {
    return false;
  }
  for (const line of lines) {
    if (!line.startsWith(":")) {
      return false;
    }
    const payload = line.slice(1);
    if (payload.length < 10 || payload.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(payload)) {
      return false;
    }
    const data = Buffer.from(payload, "hex");
    const byteCount = data[0];
    if (data.length !== byteCount + 5) {
      return false;
    }
    const sum = data.reduce((total, byte) => total + byte, 0);
    if ((sum & 0xff) !== 0) {
      return false;
    }
  }
  return true;
}

function isRelativeTo(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes("..");
}
