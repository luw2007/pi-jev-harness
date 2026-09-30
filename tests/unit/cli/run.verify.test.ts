// T030 verification: edge cases for `pi-jev run` (src/cli/run.ts, src/cli/main.ts) beyond the T026 builder tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, main } from "../../../src/cli/main.ts";
import type { CliDeps, RunSession, RunSessionOptions } from "../../../src/cli/context.ts";

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-run-v-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface FakeOptions {
  /** Raw run.json text the fake extension writes; null writes nothing. Defaults to a valid completed run. */
  runJson?: ((opts: RunSessionOptions) => string) | null;
  promptError?: Error;
  disposeError?: Error;
  unsubscribeError?: Error;
}

const validRun = (status: string, extra: Record<string, unknown> = {}) => (opts: RunSessionOptions) =>
  JSON.stringify({
    schemaVersion: 1,
    runId: opts.env.PI_JEV_RUN_ID,
    status,
    workspace: opts.cwd,
    changes: [],
    verification: [],
    reasons: [],
    remaining: [],
    usage: {},
    report: { dir: "", summary: "summary.md", receipts: "receipts.jsonl", artifacts: [] },
    ...extra,
  });

function fake(root: string, options: FakeOptions = {}, overrides: Partial<CliDeps> = {}) {
  let out = "";
  let err = "";
  let disposed = 0;
  const calls: RunSessionOptions[] = [];
  const prompts: string[] = [];
  const deps: CliDeps = {
    env: {},
    home: join(root, "home"),
    cwd: root,
    harnessRoot: join(root, "harness"),
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    execFile: () => {
      throw new Error("run must not spawn processes");
    },
    createSession: async (opts) => {
      calls.push(opts);
      const session: RunSession = {
        subscribe: () => () => {
          if (options.unsubscribeError) throw options.unsubscribeError;
        },
        prompt: async (text) => {
          prompts.push(text);
          const make = options.runJson === undefined ? validRun("completed") : options.runJson;
          if (make !== null) {
            const dir = join(opts.env.PI_JEV_RUNS_DIR!, opts.env.PI_JEV_RUN_ID!);
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, "run.json"), make(opts));
          }
          if (options.promptError) throw options.promptError;
        },
        waitForIdle: async () => {},
        abort: async () => {},
        dispose: () => {
          disposed++;
          if (options.disposeError) throw options.disposeError;
        },
      };
      return session;
    },
    ...overrides,
  };
  return { deps, out: () => out, err: () => err, calls, prompts, disposed: () => disposed };
}

// --- task text ------------------------------------------------------------------

test("verify run: task text with newlines, quotes and backslashes reaches the session byte-for-byte, once", async () => {
  await withTemp(async (root) => {
    const f = fake(root);
    const task = 'fix the "pager"\nsecond line with \'single\' quotes, a \\ backslash and a $VAR';
    assert.equal(await main(["run", "--json", task], f.deps), EXIT.ok);
    assert.deepEqual(f.prompts, [task]);
    assert.equal(JSON.parse(f.out()).status, "completed");
  });
});

test("verify run: several positionals are joined with single spaces; surrounding whitespace is trimmed", async () => {
  await withTemp(async (root) => {
    const f = fake(root);
    assert.equal(await main(["run", "  fix", "the\nthing  "], f.deps), EXIT.ok);
    assert.deepEqual(f.prompts, ["fix the\nthing"]);
  });
});

test("verify run: a task that looks like an option needs `--`; without it the command is a usage error and no session starts", async () => {
  await withTemp(async (root) => {
    const f = fake(root);
    assert.equal(await main(["run", "--", "--verbose flag is broken"], f.deps), EXIT.ok);
    assert.deepEqual(f.prompts, ["--verbose flag is broken"]);
    const g = fake(root);
    assert.equal(await main(["run", "--verbose flag is broken"], g.deps), EXIT.error);
    assert.equal(g.calls.length, 0);
    assert.match(g.err(), /用法/);
  });
});

test("verify run: whitespace-only task is a usage error without a session", async () => {
  await withTemp(async (root) => {
    const f = fake(root);
    assert.equal(await main(["run", " \n\t "], f.deps), EXIT.error);
    assert.equal(f.calls.length, 0);
  });
});

// --- --cwd -----------------------------------------------------------------------

test("verify run: relative --cwd resolves against the process cwd, including ..", async () => {
  await withTemp(async (root) => {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await mkdir(join(root, "sib"));
    const f = fake(root, {}, { cwd: join(root, "a") });
    assert.equal(await main(["run", "--json", "--cwd", "b", "t"], f.deps), EXIT.ok);
    assert.equal(f.calls[0]!.cwd, join(root, "a", "b"));
    assert.equal(JSON.parse(f.out()).workspace, join(root, "a", "b"));
    const g = fake(root, {}, { cwd: join(root, "a") });
    assert.equal(await main(["run", "--json", "--cwd=../sib", "t"], g.deps), EXIT.ok);
    assert.equal(g.calls[0]!.cwd, join(root, "sib"));
  });
});

test("verify run: --cwd pointing at a file is rejected before a session", async () => {
  await withTemp(async (root) => {
    await writeFile(join(root, "file.txt"), "x");
    const f = fake(root);
    assert.equal(await main(["run", "--cwd", "file.txt", "t"], f.deps), EXIT.error);
    assert.equal(f.calls.length, 0);
    assert.match(f.err(), /工作区不存在或不是目录/);
  });
});

test("verify run: relative PI_JEV_RUNS_DIR is rejected before a session", async () => {
  await withTemp(async (root) => {
    const f = fake(root, {}, { env: { PI_JEV_RUNS_DIR: "rel/runs" } });
    assert.equal(await main(["run", "t"], f.deps), EXIT.error);
    assert.equal(f.calls.length, 0);
    assert.match(f.err(), /绝对路径/);
  });
});

// --- run.json present but unusable ----------------------------------------------

for (const [label, make] of [
  ["unknown status", validRun("done")],
  ["status completed but wrong schemaVersion", validRun("completed", { schemaVersion: 2 })],
  ["status completed but no schemaVersion", (o: RunSessionOptions) => { const j = JSON.parse(validRun("completed")(o)); delete j.schemaVersion; return JSON.stringify(j); }],
  ["status with different case", validRun("Completed")],
  ["status null", validRun(null as unknown as string)],
  ["not JSON", () => "{ status: completed"],
  ["JSON null", () => "null"],
  ["JSON array", () => '["completed"]'],
  ["empty file", () => ""],
] as const) {
  test(`verify run: run.json present but ${label} is artifacts_missing, exit 1, never completed`, async () => {
    await withTemp(async (root) => {
      const f = fake(root, { runJson: make as (o: RunSessionOptions) => string });
      assert.equal(await main(["run", "--json", "t"], f.deps), EXIT.error);
      const result = JSON.parse(f.out());
      assert.equal(result.status, "artifacts_missing");
      assert.ok(result.reasons.some((r: string) => r.includes("任务状态未知")), JSON.stringify(result.reasons));
      assert.equal(f.disposed(), 1);
    });
  });
}

test("verify run: unusable run.json in human output still says the task status is unknown", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { runJson: validRun("done") });
    assert.equal(await main(["run", "t"], f.deps), EXIT.error);
    assert.match(f.out(), /artifacts_missing/);
    assert.match(f.out(), /任务状态未知/);
  });
});

// --- dispose / unsubscribe failures ------------------------------------------------

test("verify run: dispose throwing after a completed run is not reported as a session start failure", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { disposeError: new Error("dispose exploded") });
    const code = await main(["run", "--json", "t"], f.deps);
    const result = JSON.parse(f.out());
    assert.equal(f.disposed(), 1);
    assert.equal(result.status, "completed", "run.json is still read and reported");
    assert.notEqual(code, EXIT.notCompleted);
    assert.ok(
      !String(result.sessionError).startsWith("启动 Pi 会话失败"),
      `the session started and ran; got sessionError=${JSON.stringify(result.sessionError)}`,
    );
  });
});

test("verify run: when prompt and dispose both throw, the prompt error is not lost", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { runJson: null, promptError: new Error("provider down"), disposeError: new Error("dispose exploded") });
    assert.equal(await main(["run", "--json", "t"], f.deps), EXIT.error);
    const result = JSON.parse(f.out());
    assert.match(String(result.sessionError), /provider down/, `sessionError=${JSON.stringify(result.sessionError)}`);
  });
});

test("verify run: unsubscribe throwing still disposes the session", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { unsubscribeError: new Error("unsubscribe exploded") });
    await main(["run", "--json", "t"], f.deps);
    assert.equal(f.disposed(), 1);
  });
});

test("verify run: each invocation gets a fresh run directory; nothing else is created in runsDir", async () => {
  await withTemp(async (root) => {
    const runs = join(root, "runs");
    const f = fake(root, {}, { env: { PI_JEV_RUNS_DIR: runs } });
    await main(["run", "--json", "a"], f.deps);
    await main(["run", "--json", "b"], f.deps);
    const ids = f.calls.map((c) => c.env.PI_JEV_RUN_ID);
    assert.notEqual(ids[0], ids[1]);
    assert.deepEqual((await readdir(runs)).sort(), [...ids].sort());
    for (const id of ids) assert.match(id!, /^run_[0-9a-f-]{36}$/);
  });
});

test("T035: dispose throwing after a completed run exits 0 and is listed as a cleanup warning", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { disposeError: new Error("dispose exploded") });
    assert.equal(await main(["run", "--json", "t"], f.deps), EXIT.ok);
    const result = JSON.parse(f.out());
    assert.equal(result.sessionError, null);
    assert.ok(result.reasons.some((r: string) => r.startsWith("清理警告") && r.includes("dispose exploded")), JSON.stringify(result.reasons));
  });
});

test("T035: when prompt and dispose both throw, the dispose error is kept as a cleanup warning", async () => {
  await withTemp(async (root) => {
    const f = fake(root, { runJson: null, promptError: new Error("provider down"), disposeError: new Error("dispose exploded") });
    assert.equal(await main(["run", "--json", "t"], f.deps), EXIT.error);
    const result = JSON.parse(f.out());
    assert.equal(result.sessionError, "provider down");
    assert.ok(result.reasons.some((r: string) => r.includes("dispose exploded")), JSON.stringify(result.reasons));
  });
});
