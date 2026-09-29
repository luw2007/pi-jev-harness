// Check: the OMP entry loads with @earendil-works/* unresolvable and pulls nothing from node_modules.
import { registerHooks } from "node:module";
const seen = [];
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@earendil-works/")) throw new Error("BLOCKED " + spec);
    const r = next(spec, ctx);
    if (r.url.includes("node_modules")) seen.push(r.url);
    return r;
  },
});
const m = await import(new URL("../../src/adapters/omp/index.ts", import.meta.url).href);
const pkgs = [...new Set(seen.map((u) => u.split("/node_modules/").at(-1).split("/").slice(0, u.includes("/node_modules/@") ? 2 : 1).join("/")))];
console.log("loaded; default export:", typeof m.default, "; packages from node_modules:", pkgs.join(", ") || "none");
