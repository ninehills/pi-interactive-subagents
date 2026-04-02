---
name: plan
description: >
  Planning workflow. Spawns a spec agent to clarify WHAT to build, then a
  planner agent to figure out HOW. Use when asked to "plan", "brainstorm",
  "I want to build X", or "let's design". Requires the subagents extension
  and a supported multiplexer (cmux/tmux/zellij).
---

# Plan

A planning workflow that separates WHAT (spec) from HOW (plan). First a spec agent clarifies intent and requirements with the user, then a planner figures out the technical approach and creates todos.

**Announce at start:** "Let me investigate first, then I'll open a spec session to nail down exactly what we're building."

---

## Tab Titles

Use `set_tab_title` to keep the user informed of progress in the multiplexer UI. Update the title at every phase transition.

| Phase         | Title example                                                  |
| ------------- | -------------------------------------------------------------- |
| Investigation | `🔍 Investigating: <short task>`                               |
| Spec          | `📝 Spec: <short task>`                                        |
| Planning      | `💬 Planning: <short task>`                                    |
| Review plan   | `📋 Review: <short task>`                                      |
| Executing     | `🔨 Executing: 1/3 — <short task>` (update counter per worker) |
| Reviewing     | `🔎 Reviewing: <short task>`                                   |
| Done          | `✅ Done: <short task>`                                        |

Name subagents with context too:

- Scout: `"🔍 Scout"` (default is fine)
- Spec: `"📝 Spec"`
- Planner: `"💬 Planner"`
- Workers: `"🔨 Worker 1/3"`, `"🔨 Worker 2/3"`, etc.
- Reviewer: `"🔎 Reviewer"`

---

## The Flow

```
Phase 1: Quick Investigation (main session)
    ↓
Phase 2: Spawn Spec Agent (interactive — clarifies WHAT to build)
    ↓
Phase 3: Spawn Planner Agent (interactive — figures out HOW to build it)
    ↓
Phase 4: Review Plan & Todos (main session)
    ↓
Phase 5: Execute Todos (workers)
    ↓
Phase 6: Review
```

---

## Phase 1: Quick Investigation

Before spawning the planner, orient yourself:

```bash
ls -la
find . -type f -name "*.ts" | head -20  # or relevant extension
cat package.json 2>/dev/null | head -30
```

Spend 30–60 seconds. The goal is to give the planner useful context — not to do a full scout.

**If deeper context is needed** (large codebase, unfamiliar architecture), spawn an autonomous scout subagent first:

```typescript
subagent({
  name: "Scout",
  agent: "scout",
  interactive: false,
  task: "Analyze the codebase. Map file structure, key modules, patterns, and conventions. Summarize findings concisely for a planning session.",
});
```

Read the scout's summary from the subagent result before proceeding.

---

## Phase 2: Spawn Spec Agent

Spawn the interactive spec agent. The `spec` agent clarifies intent, requirements, effort level, and success criteria (ISC) with the user.

```typescript
subagent({
  name: "📝 Spec",
  agent: "spec",
  interactive: true,
  task: `Define spec: [what the user wants to build]

Context from investigation:
[paste relevant findings from Phase 1 here]`,
});
```

**The user works with the spec agent.** When done, they press Ctrl+D and the spec artifact path is returned.

---

## Phase 3: Spawn Planner Agent

Read the spec artifact, then spawn the planner. The planner takes the spec as input and figures out the technical approach — explores options, validates design, runs a premortem, writes the plan, and creates todos with mandatory code examples/references.

```typescript
// Read the spec first
read_artifact({ name: "specs/YYYY-MM-DD-<name>.md" });

subagent({
  name: "💬 Planner",
  agent: "planner",
  interactive: true,
  task: `Plan implementation for spec: specs/YYYY-MM-DD-<name>.md

Context from investigation:
[paste relevant findings]`,
});
```

**The user works with the planner.** The planner will NOT re-clarify requirements — that's already done in the spec. It focuses on technical approach, design validation, premortem risk analysis, and creating well-scoped todos.

When done, the user presses Ctrl+D and the plan + todos are returned.

---

## Phase 4: Review Plan & Todos

Once the planner closes, read the plan and todos:

```typescript
todo({ action: "list" });
```

Review with the user:

> "Here's what the planner produced: [brief summary]. Ready to execute, or anything to adjust?"

---

## Phase 5: Execute Todos

Spawn a scout first for context, then workers sequentially:

```typescript
// 1. Scout gathers context
subagent({
  name: "Scout",
  agent: "scout",
  interactive: false,
  task: "Gather context for implementing [feature]. Read the plan at [plan path]. Identify all files that will be created/modified, map existing patterns and conventions.",
});

// 2. Workers execute todos sequentially — one at a time
subagent({
  name: "Worker",
  agent: "worker",
  interactive: false,
  task: "Implement TODO-xxxx. Mark the todo as done. Plan: [plan path]\n\nScout context: [paste scout summary]",
});

// Check result, then next todo
subagent({
  name: "Worker",
  agent: "worker",
  interactive: false,
  task: "Implement TODO-yyyy. Mark the todo as done. Plan: [plan path]\n\nScout context: [paste scout summary]",
});
```

**Always run workers sequentially in the same git repo** — parallel workers will conflict on commits.

---

## Phase 6: Review

After all todos are complete:

```typescript
subagent({
  name: "Reviewer",
  agent: "reviewer",
  interactive: false,
  task: "Review the recent changes. Plan: [plan path]",
});
```

Triage findings:

- **P0** — Real bugs, security issues → fix now
- **P1** — Genuine traps, maintenance dangers → fix before merging
- **P2** — Minor issues → fix if quick, note otherwise
- **P3** — Nits → skip

Create todos for P0/P1, run workers to fix, re-review only if fixes were substantial.

---

## ⚠️ Completion Checklist

Before reporting done:

1. ✅ All worker todos closed?
2. ✅ Every todo has a polished commit (using the `commit` skill)?
3. ✅ Reviewer has run?
4. ✅ Reviewer findings triaged and addressed?
