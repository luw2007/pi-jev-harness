import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { fakeFetch, fakePi, harness, load, settled } from "./fake-host.ts";

test("/jev debug toggles only this session and writes compact summaries without a TUI", async () => {
  const h = await harness();
  try {
    await writeFile(h.configPath, JSON.stringify({ mode: "shadow", outbound: { taskIntent: true } }));
    const lines: string[] = [];
    const fake = fakePi();
    const jev = fakeFetch();
    const registry = load(fake, h.deps({ fetch: jev.fetch, writeDebug: (text) => lines.push(text) }));
    await fake.emit("session_start", { reason: "startup" });
    assert.match(await fake.command("debug status"), /debug.*off/i);
    fake.emitSync("before_agent_start", { prompt: "before enabling debug" });
    await settled(registry);
    assert.equal(lines.length, 0);

    assert.match(await fake.command("debug on"), /debug.*on/i);
    assert.match(await fake.command("debug status"), /debug.*on/i);
    fake.emitSync("before_agent_start", { prompt: "debug-visible task" });
    await settled(registry);
    assert.ok(lines.some((line: string) => line.includes("Jev REQ")), "request summary is emitted");
    assert.ok(lines.some((line: string) => line.includes("Jev RESP") && line.includes("HTTP 200") && line.includes("ms")), "response summary is emitted");
    assert.ok(lines.every((line: string) => !line.includes("\n") && !line.includes("debug-visible task") && !line.includes('"answers"')), "fallback contains no body or multiline output");

    assert.match(await fake.command("debug off"), /debug.*off/i);
    const prior = lines.length;
    fake.emitSync("before_agent_start", { prompt: "after disabling debug" });
    await settled(registry);
    assert.equal(lines.length, prior);
    await fake.emit("session_shutdown", { reason: "quit" });

    const next = fakePi();
    load(next, h.deps({ fetch: jev.fetch, writeDebug: (text) => lines.push(text) }));
    await next.emit("session_start", { reason: "startup" });
    assert.match(await next.command("debug status"), /debug.*off/i, "new session must start with debug disabled");
    await next.emit("session_shutdown", { reason: "quit" });
  } finally {
    await h.cleanup();
  }
});

test("Pi TUI renders context-free debug entries collapsed and expanded", async () => {
  const h = await harness();
  try {
    await writeFile(h.configPath, JSON.stringify({ mode: "shadow", outbound: { taskIntent: true } }));
    const fake = fakePi();
    const entries: Array<{ type: string; data: { summary: string; expanded: string } }> = [];
    let renderer: ((entry: { data: { summary: string; expanded: string } }, options: { expanded: boolean }) => { render(width: number): string[] } | undefined) | undefined;
    Object.assign(fake.pi, {
      appendEntry: (type: string, data: { summary: string; expanded: string }) => entries.push({ type, data }),
      registerEntryRenderer: (_type: string, fn: typeof renderer) => { renderer = fn; },
      sendMessage: () => { throw Error("debug must not enter model context"); },
    });
    Object.assign(fake.ctx, { hasUI: true, mode: "tui" });
    const fallback: string[] = [];
    const registry = load(fake, h.deps({ fetch: fakeFetch().fetch, writeDebug: (text) => fallback.push(text) }));
    await fake.emit("session_start", { reason: "startup" });
    await fake.command("debug on");
    fake.emitSync("before_agent_start", { prompt: "pi secret body" });
    await settled(registry);
    assert.equal(fallback.length, 0);
    assert.ok(entries.some((entry) => entry.data.summary.includes("Jev REQ")));
    assert.ok(entries.some((entry) => entry.data.summary.includes("Jev RESP")));
    const req = entries.find((entry) => entry.data.summary.includes("Jev REQ"))!;
    assert.equal(req.type, "jev-debug");
    assert.equal(req.data.summary.includes("pi secret body"), false);
    assert.equal(renderer!({ data: req.data }, { expanded: false })!.render(1000).length, 1);
    assert.match(renderer!({ data: req.data }, { expanded: true })!.render(1000).join("\n"), /pi secret body/);
    await fake.emit("session_shutdown", { reason: "quit" });
  } finally {
    await h.cleanup();
  }
});
