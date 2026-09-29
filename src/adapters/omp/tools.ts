/**
 * Translation from OMP host objects to router inputs. OMP shapes are mapped field by field;
 * nothing is cast to a Pi type.
 */
import type { HostTool } from "../../router/index.ts";
import type { OmpToolInfo } from "./types.ts";

/**
 * JSON Schema of an OMP tool's `parameters`. OMP 18.3.5 built-in tools carry arktype types
 * (callable objects with `toJsonSchema()`); JSON.stringify on them yields nothing. Plain objects
 * (TypeBox / JSON Schema) pass through. Anything unconvertible becomes `null`, which the router
 * treats as an opaque schema instead of dropping the tool.
 */
export function ompToolSchema(parameters: unknown): unknown {
  const convert = (parameters as { toJsonSchema?: unknown } | null | undefined)?.toJsonSchema;
  if (typeof convert === "function") {
    let converted: unknown;
    try {
      converted = convert.call(parameters);
    } catch {
      return null;
    }
    return converted !== null && typeof converted === "object" && !Array.isArray(converted) ? converted : null;
  }
  return parameters !== null && typeof parameters === "object" ? parameters : null;
}

/** OMP tools as router host tools; availability is the host's current active set. */
export function hostToolsFromOmp(all: readonly OmpToolInfo[], active: readonly string[]): HostTool[] {
  const activeSet = new Set(active);
  return all.map((tool) => ({
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    schema: ompToolSchema(tool.parameters),
    source: tool.sourceInfo?.source ?? "unknown",
    available: activeSet.has(tool.name),
  }));
}
