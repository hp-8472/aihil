import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "src", "aihil", "schemas");
const target = resolve(root, "dist", "schemas");

if (existsSync(source)) {
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
