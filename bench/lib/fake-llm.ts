/**
 * Local scripted OpenAI-compatible streaming server for the offline smoke (no real model).
 * The script keys off the task prompt and how many tool results the conversation already has.
 * Only understands the two smoke tasks; anything else gets a plain text reply.
 */
import { createServer, type Server } from "node:http";

type Action = { tool: string; args: Record<string, unknown> } | { text: string };

function script(prompt: string, toolResults: number): Action {
  if (prompt.includes("math.js has a bug")) {
    // First call reads a missing file on purpose so a real tool error (isError) is recorded.
    if (toolResults === 0) return { tool: "read", args: { path: "does-not-exist.txt" } };
    if (toolResults === 1) return { tool: "write", args: { path: "math.js", content: "export function add(a, b) {\n  return a + b;\n}\n" } };
    return { text: "Fixed add." };
  }
  if (prompt.includes("magic word")) {
    if (toolResults === 0) return { tool: "write", args: { path: "ANSWER.txt", content: "PINEAPPLE\n" } };
    // Model text mentioning the progress marker must not be counted as a tool failure.
    return { text: "Wrote ANSWER.txt. [工具失败] is just text here." };
  }
  return { text: "OK" };
}

export async function startFakeLlm(): Promise<{ baseUrl: string; requests: () => number; close: () => Promise<void> }> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString("utf8")));
    req.on("end", () => {
      n++;
      let j: { model?: string; messages?: { role: string; content?: unknown }[] } = {};
      try {
        j = JSON.parse(body);
      } catch {
        j = {};
      }
      const msgs = j.messages ?? [];
      const action = script(JSON.stringify(msgs.filter((m) => m.role === "user")), msgs.filter((m) => m.role === "tool").length);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const base = { id: `c${n}`, object: "chat.completion.chunk", created: 1, model: j.model };
      if ("tool" in action) {
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: action.tool, arguments: JSON.stringify(action.args) } }] }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: action.text }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      send({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests: () => n, close: () => new Promise((ok) => server.close(() => ok())) };
}
