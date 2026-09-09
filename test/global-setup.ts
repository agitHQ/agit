import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * Build once, before any test file runs.
 *
 * Some tests drive the real CLI out of dist/, so dist must match src or they
 * silently test stale code — a broken change looks green. Doing that build
 * inside a test file's beforeAll works in isolation but not in the parallel
 * run: it is a multi-second, CPU-contended operation sitting under a hook
 * timeout, and it races other workers reading the same output. Here it
 * happens exactly once, before anything reads dist.
 */
export default function setup(): void {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, shell: true, stdio: "ignore" });
}
