// Acceptance for smoke-fix-add. Lives outside the agent's workspace; imports math.js from cwd.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { add } = await import(pathToFileURL(join(process.cwd(), "math.js")).href);
if (add(2, 3) !== 5) {
  console.error("add(2,3) =", add(2, 3));
  process.exit(1);
}
console.log("ok");
