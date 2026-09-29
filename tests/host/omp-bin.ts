import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** The omp binary: `OMP_BIN` when set, else `omp` on PATH; "" when neither is found (callers skip). */
export function findOmp(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const candidates = env.OMP_BIN ? [env.OMP_BIN] : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "omp"));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return "";
}
