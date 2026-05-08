# /subagents_list Slash Command

## Context

The `subagents_list` tool already exists in the codebase (registered at line 1775 of `pi-extension/subagents/index.ts`). It scans project-local `.pi/agents/` and global `~/.pi/agent/agents/` and returns available subagent definitions. The user wants a `/subagents_list` slash command that invokes this tool from the chat input, following the same pattern as existing commands like `/subagent`, `/plan`, and `/iterate`.

## Approach

Register a new slash command with `pi.registerCommand("subagents_list", ...)` whose handler:
1. Directly calls `discoverAgentDefinitions()` (same module, line 257) — no AI round-trip
2. Formats the results as plain text
3. Sends a display-only message via `pi.sendMessage()` **without** `triggerTurn: true`, so no AI turn is triggered

This avoids AI interaction entirely — the command directly queries and displays agent definitions.

## Files to modify

- `pi-extension/subagents/index.ts` — Add the `registerCommand` call near the other slash commands (after `/plan` at line ~2290)

## Reuse

- `discoverAgentDefinitions()` (line 257) — scans `.pi/agents/` and `~/.pi/agent/agents/` for agent `.md` files and returns `ListedAgentDefinition[]`
- `pi.sendMessage()` (with `display: true`, without `triggerTurn`) — displays output in chat without triggering AI
- Filter `!agent.disableModelInvocation` — same filter used by the existing `subagents_list` tool

## Steps

- [ ] Add `pi.registerCommand("subagents_list", ...)` block in `pi-extension/subagents/index.ts`, inserted after the `/plan` command registration (around line 2290)

The command handler:
```typescript
pi.registerCommand("subagents_list", {
  description: "List all available subagent definitions",
  handler: async (_args, ctx) => {
    const list = discoverAgentDefinitions().filter((a) => !a.disableModelInvocation);
    if (list.length === 0) {
      ctx.ui.notify("No subagent definitions found.", "info");
      return;
    }
    const lines = list.map((a) => {
      const badge = a.source === "project" ? " (project)" : "";
      const desc = a.description ? ` — ${a.description}` : "";
      const model = a.model ? ` [${a.model}]` : "";
      return `• ${a.name}${badge}${model}${desc}`;
    });
    pi.sendMessage({
      content: lines.join("\n"),
      display: true,
      details: { agents: list },
    });
  },
});
```

## Verification

1. Run the existing tests to ensure nothing breaks:
   ```
   npm test
   ```
2. In a pi session, type `/subagents_list` and verify that:
   - Available subagent definitions are displayed in chat immediately
   - No AI turn is triggered
