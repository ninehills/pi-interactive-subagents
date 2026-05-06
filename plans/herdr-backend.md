# 计划：添加 herdr 多路复用器后端支持

## 背景

**问题：** pi-interactive-subagents 扩展目前支持四种终端多路复用器 — cmux、tmux、zellij 和 WezTerm — 作为生成和管理子代理窗格的后端。[herdr](https://github.com/ogulcancelik/herdr) 是一个新的、具备代理感知能力的终端多路复用器，提供了丰富的 CLI 和 Unix socket API，但尚未被支持。

**动机：** herdr 项目提供了 [SKILL.md](https://github.com/ogulcancelik/herdr/blob/master/SKILL.md)，供 AI 代理在 herdr 内部进行自主编排。将 herdr 添加为一级后端，可以让 pi 子代理在 herdr 会话中无缝运行。

**目标：** 使 herdr 成为与 cmux、tmux、zellij、wezterm 并列的完整 `MuxBackend`。用户在 herdr 中运行 `pi`（`HERDR_ENV=1`）时，无需额外配置即可自动获得子代理窗格管理功能。

## 方案

遵循 cmux/tmux/zellij/wezterm 后端已有的模式。每个后端使用其原生 CLI 实现相同的 surface 操作（创建、发送、读取、关闭、聚焦）。

### CLI vs Socket API 对比

herdr 提供两层集成接口：CLI 命令和 Unix socket API。以下是两者的优劣分析：

**CLI 方案：**
- ✅ 与现有后端模式一致 — cmux、tmux、zellij、wezterm 均通过 CLI 子进程调用实现
- ✅ 实现简单 — 直接 `execFileSync`/`execSync` 调用 `herdr` 命令
- ✅ 同步、无状态 — 每次调用独立，不需要管理长连接
- ✅ 错误处理简单 — 非零退出码即失败
- ⚠️ 缺少 `pane.focus` — CLI 无聚焦窗格命令（但 socket API 也没有）
- ⚠️ 每步操作产生一次进程启动开销

**Socket API 方案：**
- ✅ 更高效 — 避免进程启动开销，通过持久 Unix socket 连接通信
- ✅ 支持事件订阅 — `events.subscribe` 可实时监听 `pane.output_matched`、`pane.agent_status_changed` 等
- ✅ 更细粒度的控制 — 如 `pane.report_agent` 可上报代理状态
- ❌ 实现复杂 — 需要管理 Unix socket 连接生命周期、JSON 协议编解码、正确处理长连接和重连
- ❌ 与现有后端架构不一致 — 其他后端全部使用 CLI，引入 socket 会造成代码风格分裂
- ❌ 数据格式不同 — `pane.read` 返回 JSON（含 text 字段），CLI 版返回纯文本

**决策：选择 CLI 方案。** 理由：
1. 与已有四个后端完全一致的架构模式，降低维护负担
2. 子代理窗格生命周期操作（创建/发送命令/读屏/关闭）通过 CLI 已完全覆盖
3. `wait output` 和 `wait agent-status` 等轮询式等待可通过现有的 `pollForExit` 模式实现，无需事件驱动
4. 代理状态上报（`pane.report_agent`）属于独立关注点，可在后续单独规划

### pane.focus 确认

已检查 herdr socket API 完整方法表（见 `SOCKET_API.md`）。herdr 支持：
- `workspace.focus` — 聚焦工作区
- `tab.focus` — 聚焦标签页
- **没有 `pane.focus`** — 无论是 CLI 还是 socket API 都不支持聚焦单个窗格

这意味着 `harness.ts` 中的 `focusSurface()` 对于 herdr 无法实现。这与 wezterm 的情况一致（wezterm 也缺少聚焦辅助功能）。测试框架中，`focusSurface` 仅用于 `mux-surface.test.ts` 的焦点保持测试，可跳过 herdr 后端。

**herdr surface 标识符：** herdr 窗格 ID（如 `1-1`、`1-2`）作为 surface 标识符。

**herdr 运行时检测：** 检查 `HERDR_ENV=1` 环境变量（在 herdr 内部运行时自动设置）加上 `hasCommand("herdr")`。这类似于其他后端的检测方式。

## 需要修改的文件

| 文件 | 修改范围 |
|------|----------|
| `pi-extension/subagents/cmux.ts` | 在 `MuxBackend` 类型中添加 `"herdr"`，添加运行时检测以及所有 surface 操作的分支 |
| `test/integration/harness.ts` | 在 `getAvailableBackends()`、`focusSurface()`、`getFocusedSurface()`、`getSurfacePane()` 中添加 herdr 支持 |
| `README.md` | 在支持的多路复用器列表和使用示例中添加 herdr |
| `.pi/skills/run-integration-tests/SKILL.md` | 在预检步骤中提及 herdr 作为可测试环境 |

## 可复用的现有代码

所有现有模式位于 `pi-extension/subagents/cmux.ts`：

- **`MuxBackend` 类型**（第 9 行）：在联合类型中添加 `"herdr"`
- **`muxPreference()`**（第 44 行）：添加 `"herdr"` 分支
- **`is*RuntimeAvailable()` 模式**（第 50-63 行）：添加 `isHerDrRuntimeAvailable()` — 检查 `HERDR_ENV=1` 和 `hasCommand("herdr")`
- **`getMuxBackend()`**（第 82 行）：在自动检测链末尾添加 herdr（`HERDR_ENV` 是唯一的，不会与其他后端冲突）
- **`muxSetupHint()`**（第 101 行）：添加 herdr 的设置提示
- **`createSurface()`**（第 755 行）：添加 herdr 分支 — `herdr pane split <当前窗格> --direction right --no-focus`，从 JSON 中解析 `result.pane.pane_id`
- **`createSurfaceSplit()`**（第 815 行）：添加 herdr 分支 — `herdr pane split <pane_id> --direction right|down [--no-focus]`
- **`sendCommand()`**（第 1011 行）：添加 herdr 分支 — `herdr pane run <pane_id> <命令>`
- **`sendEscape()`**（第 1043 行）：添加 herdr 分支 — `herdr pane send-keys <pane_id> Escape`
- **`readScreen()`**（第 1107 行）：添加 herdr 分支 — `herdr pane read <pane_id> --source recent --lines N`
- **`readScreenAsync()`**（第 1150 行）：与 readScreen 相同，但使用 `execFileAsync`
- **`closeSurface()`**（第 1193 行）：添加 herdr 分支 — `herdr pane close <pane_id>`
- **`renameCurrentTab()`**（约第 845 行）：添加 herdr 分支 — `herdr tab rename <tab_id> <标题>`（可选）
- **`renameWorkspace()`**（约第 910 行）：添加 herdr 分支 — `herdr workspace rename <workspace_id> <标题>`（可选）
- **`pollForExit()`**（约第 1218 行）：通过 `readScreenAsync` 工作 — 无需针对 herdr 做特定修改

**测试辅助工具**（`test/integration/harness.ts`）：
- **`getAvailableBackends()`**（约第 60 行）：在探测列表中添加 `"herdr"`
- **`focusSurface()`**（约第 115 行）：添加 herdr 桩（herdr CLI 不暴露 focus-pane — 跳过或使用 socket API）
- **`getFocusedSurface()`**（约第 127 行）：添加 herdr 分支 — 解析 `herdr pane list` JSON 找到聚焦的窗格
- **`getSurfacePane()`**（约第 147 行）：对于 herdr，surface 就是 pane id — 直接返回 surface

## 实现步骤

- [ ] **步骤 1：在 `MuxBackend` 类型和运行时检测中添加 `"herdr"`** — 更新 `MuxBackend` 联合类型，添加 `isHerDrRuntimeAvailable()`，接入 `muxPreference()`、`getMuxBackend()`、`muxSetupHint()`、`isMuxAvailable()`，并导出一致的 `isHerDrAvailable()`。

- [ ] **步骤 2：为 herdr 实现 `createSurface` 和 `createSurfaceSplit`** — 使用 `herdr pane split <pane_id> --direction right|down [--no-focus]`。从 JSON 响应中解析新窗格 ID（`result.pane.pane_id`）。源窗格使用 `HERDR_ACTIVE_PANE_ID` 环境变量（已确认：herdr 为每个窗格进程设置此变量）。由于 herdr 原生仅支持 right 和 down 方向，"left"/"up" 映射为 right/down。对于 `createSurface`，从当前窗格进行分割（类似 cmux 首次调用的模式）。

- [ ] **步骤 3：为 herdr 实现 `sendCommand`、`sendEscape`、`readScreen`、`readScreenAsync`、`closeSurface`** — 如上所述的直接 CLI 映射。`sendCommand` 使用 `herdr pane run`。`readScreen` 使用 `herdr pane read --source recent --lines N`（输出为文本，非 JSON — 与其他后端相同）。

- [ ] **步骤 4：为 herdr 实现可选的 `renameCurrentTab` 和 `renameWorkspace`** — 映射到 `herdr tab rename` 和 `herdr workspace rename`。这些是外观功能（可选），如果 ID 不易获取可以跳过。

- [ ] **步骤 5：在测试辅助工具中添加 herdr** — 更新 `getAvailableBackends()` 以探测 herdr。通过 `herdr pane list` JSON 解析实现 `getFocusedSurface()`。实现 `focusSurface()`（尽力而为，或跳过 — herdr 没有聚焦窗格的 CLI 命令）。对于 `getSurfacePane()`，直接返回 surface，因为 herdr 的 surface ID 就是 pane ID。

- [ ] **步骤 6：更新 README.md** — 在支持的多路复用器列表和使用说明中添加 herdr。

- [ ] **步骤 7：更新集成测试 skill** — 在 `.pi/skills/run-integration-tests/SKILL.md` 的预检步骤中添加 herdr 检测。

## 验证

1. **单元测试：** `node --test test/test.ts` — 验证所有现有测试仍然通过（添加 herdr 不会破坏现有后端）
2. **在 herdr 内部运行集成测试：**
   ```bash
   herdr
   # 在 herdr 内部执行：
   PI_SUBAGENT_MUX=herdr node --test --test-concurrency=1 test/integration/mux-surface.test.ts
   ```
3. **手动冒烟测试：** 在 herdr 中运行 `pi`，触发子代理生成，验证其创建新窗格、正确运行，并在退出后清理窗格。

### herdr 环境变量（已从源码确认）

- `HERDR_ENV=1` — 在 herdr 内部运行时始终设置
- `HERDR_SOCKET_PATH` — 用于直接 API 访问的 Unix socket 路径
- `HERDR_ACTIVE_PANE_ID` — 公共窗格 ID（如 `1-1`），为每个窗格进程设置 — **用于标识当前窗格**
- `HERDR_ACTIVE_TAB_ID` — 公共标签页 ID（如 `1:1`）
- `HERDR_ACTIVE_WORKSPACE_ID` — 公共工作区 ID（如 `1`）
- `HERDR_PANE_ID` — 内部格式 `p_<raw>`（供集成钩子使用，不适用于 CLI）

### 关键设计决策

1. **当前窗格检测：** 使用 `HERDR_ACTIVE_PANE_ID` 环境变量（公共 `1-1` 格式）— 已在 herdr 源码中确认为每个窗格进程设置。这类似于 `CMUX_SURFACE_ID` / `TMUX_PANE` / `ZELLIJ_PANE_ID`。

2. **聚焦操作：** herdr CLI 和 socket API 都**不暴露 `pane.focus`**（已确认：socket API 仅支持 `workspace.focus` 和 `tab.focus`，无 `pane.focus` 方法）。测试辅助工具中的 `focusSurface()` 对于 herdr 无法实现，与 wezterm 一致（wezterm 同样缺少聚焦辅助）。`getFocusedSurface()` 可通过解析 `herdr pane list` 的 JSON 输出来找到聚焦窗格（`focused: true` 字段）。

3. **反向分割（left/up）：** herdr 的 `pane split` 仅支持 `right` 和 `down` 方向。当 `createSurfaceSplit` 以 "left" 或 "up" 调用时，创建为 right/down — 调用者表达的是偏好，但抽象契约并不保证绝对方向。

4. **herdr 代理状态上报集成：** herdr 通过 socket API 支持 `pane.report_agent` 用于基于钩子的代理状态上报。这是一个独立的关注点（子代理状态报告），不在本计划范围内 — 本计划仅聚焦窗格生命周期。
