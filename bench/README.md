# bench：M5 成对提效试验工具

按技术方案 §13.2 实现：在固定任务集上用真实入口 `pi-jev run` 成对运行各实验臂，由 bench 自己执行验收命令，按独立任务聚合成对差值。

## 用法

```sh
node bench/run.ts --tasks 'bench/tasks/smoke/*.json' --arms A,B --repeat 3 --concurrency 1 --out /tmp/bench-out \
  --provider <pi provider> --model <model id> --models-json ~/.pi/agent/models.json \
  [--thinking low] [--seed 1] [--jev fake|real] [--pi-retry on|off] [--arms-file bench/arms.json]
node bench/report.ts /tmp/bench-out

# 离线冒烟：本地脚本化 OpenAI 兼容服务 + 假 Jev，不调用真实模型
node bench/smoke-offline.ts /tmp/bench-smoke [--arms A,AA,B,D] [--repeat 1]
```

- 启动前检查（任何一项失败都在写 meta.json 之前退出 1）：模型名含 `deepseek` 拒绝；每个臂的配置都用产品的 `loadConfig`（`src/adapters/pi/config.ts`，只读导入）解析，被拒绝的配置（例如 `mode: "on"`、未知字段）直接报错，不会悄悄按 off 跑；臂配置或环境里出现 deepseek 也拒绝。
- `--models-json` 只读：bench 复制其中一个 provider 块（只保留指定模型）。`apiKey` 为 `!command` 时在启动时用真实环境执行一次，只通过 `BENCH_MODEL_API_KEY` 交给 `pi-jev run`；`$NAME` 形式只传这一个变量。
- 子进程环境只保留 `PATH/TMPDIR/LANG/LC_*/TERM/USER/LOGNAME/SHELL/TZ`，其余（各种 API key）一律不传。验收命令拿不到模型 key 和 Jev key。
- `--jev fake`（默认）：每次运行一个本地假 Jev（全部 503 并计数）。`--jev real` 才用真实 Jev。
- `--pi-retry off` 关掉 Pi 的 agent 级重试，只用于控制冒烟请求数；正式试验保持 `on`（§13.2 耗时包含重试）。

## 任务文件

`bench/tasks/**/*.json`：`id`、`category`（`read_explain|small_fix|feature|multi_file|long_context`）、`repo`（`{"fixture": "<bench/fixtures 下目录>"}` 或 `{"git": "<路径或 URL>", "commit": "<sha>"}`，相对的 git 路径按任务文件所在目录解析）、`prompt`、`acceptance`（argv）、`timeoutSec`。验收脚本放在任务目录（agent 工作区之外），argv 里用 `{taskDir}` 引用，例如 `["node", "{taskDir}/check-fix-add.mjs"]`。

## 隔离

每次运行：`mkdtemp` 下建 `home/`（`HOME`、`PI_CODING_AGENT_DIR=home/.pi/agent`，含 settings.json、models.json、`pi-jev-harness/config.json`）；工作区为 fixtures 拷贝后固定日期提交，或 `git clone --shared` 后 detach 到固定 commit；产物目录 `PI_JEV_RUNS_DIR=<out>/runs/<task>__<arm>__r<rep>/products`。无论成功与否，`finally` 里都会关闭假 Jev、删除临时目录。不写用户的 `~/.pi`。

## 成对与计时

- 成对组 = (任务, 重复)。组内各臂紧接着运行，臂顺序按种子随机；组顺序按同一种子随机；`--concurrency` 是同时运行的组数。
- 计时从启动 `pi-jev run` 到验收命令结束。完成 = 验收退出码 0 **且没有超时**（CLI `timedOut` 或状态 `timed_out` 一律记为 `timeout`，不算完成）。
- 结果类别原样保留：`completed/incomplete/blocked/cancelled/failed/verification_unavailable/native_off/artifacts_missing/timeout/session_error/spawn_error`。

## 数据来源

| 字段 | 来源 | A（mode off） |
| --- | --- | --- |
| 工具失败（无效工具调用） | Pi 会话日志中 `toolResult.isError` | 可用 |
| 输入/输出 token | Pi 会话日志中每次 assistant 尝试的 `usage`；任一次缺失即为 null | 可用 |
| 模型请求数（含报错） | Pi 会话日志中 assistant 消息数 | 可用 |
| 费用 | 会话日志 `usage.cost.total`；模型块没有单价时整体标为不可用，不参与比较 | 同左 |
| run.json 状态、“错误宣称完成”、用量交叉核对 | `run.json`（存在时才用） | **不可用**：mode off 不写 run.json，结果类别为 `native_off`（CLI 明确返回，T039），这些字段不参与与 A 的比较 |

会话日志中无法解析的行（如被 kill 截断）跳过并计入 `malformedLogLines`。

## 报告口径（`bench/lib/report-core.ts`）

- 基线臂取自 meta.json（即 arms.json 中 `baseline: true`），缺失时报错，不按记录顺序猜。
- 同一任务的重复先在任务内聚合，再按任务求 arm − 基线差值。
- **完成率**：比例之差，取各任务差值的**均值**，给出该均值的 bootstrap 95% 区间（固定种子，2000 次）。只有任务数 ≥ 30 且区间下界高于 −2 个百分点时才写“支持非劣”，否则写“样本不足以支持 2 个百分点非劣结论”。
- 耗时（只用通过验收的运行；失败另报 time-to-failure）、每完成任务费用、无效工具调用、每次运行 token：取任务差值的中位数与 bootstrap 区间。
- `AA` 臂与 A 相同，标为 A/A 噪声基线。

## 实验臂（`bench/arms.json`）

| 臂 | 配置 | 说明 |
| --- | --- | --- |
| A | `mode: off` | 基线 |
| AA | 同 A | A/A 噪声 |
| B | shadow + 工具路由 | 配置文件不接受 `mode: on`，只能观测 |
| C | shadow + 续跑开启 | 续跑只在 on 下改变行为，当前只记录 |
| D | shadow + `context.request: shadow` | 请求级 context shadow |
| E | shadow + 工具路由 + 续跑 + context | 组合 |

模型选择由 magpie 网关负责（T104），bench 不再有模型路由臂。

## 建议的 `bench:offline` 接线（package.json 归另一会话所有，本单不改）

```json
"bench:offline": "node --test \"bench/**/*.test.ts\" && node bench/smoke-offline.ts \"${TMPDIR:-/tmp}/pi-jev-bench-offline\""
```

需要真实模型的试验保持独立入口（`node bench/run.ts ...`），显式传模型和预算。
