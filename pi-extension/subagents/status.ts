import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_STATUS_CADENCE_MS = 60_000;
export const MIN_STATUS_CADENCE_MS = 10_000;
export const MIN_STALLED_MS = 30_000;
export const STALLED_MULTIPLIER = 3;
export const DEFAULT_STATUS_LINE_LIMIT = 4;
export const MAX_STATUS_NAME_LENGTH = 72;
export const MAX_STATUS_LINE_LENGTH = 120;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_STATUS_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const STATUS_CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

export type SubagentStatusKind = "starting" | "active" | "quiet" | "stalled" | "running";
export type SubagentStatusSource = "pi" | "claude";
export type SubagentStatusTransition = "stalled" | "recovered" | null;

export interface StatusConfig {
  enabled: boolean;
  defaultCadenceMs: number;
  lineLimit: number;
}

export interface StatusObservation {
  entries: number;
  bytes: number;
}

export interface SubagentStatusState {
  source: SubagentStatusSource;
  startTimeMs: number;
  cadenceMs: number;
  baselineEntries: number | null;
  baselineBytes: number | null;
  observedEntries: number | null;
  observedBytes: number | null;
  firstObservationAtMs: number | null;
  lastProgressAtMs: number | null;
  // Cadence tracks classification/progress windows for local widget status.
  // Routine status messages are intentionally not emitted.
  lastCadenceAtMs: number;
  lastCadenceEntries: number | null;
  currentKind: SubagentStatusKind;
}

export interface StatusSnapshot {
  kind: SubagentStatusKind;
  elapsedMs: number;
  elapsedText: string;
  idleMs: number | null;
  idleText: string | null;
  progressEvents: number | null;
}

export interface CappedStatusLines {
  visibleLines: string[];
  overflow: number;
}

function invalidStatusConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent status config in ${source}: ${message}`);
}

function requireObject(value: unknown, source: string, fieldName: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    invalidStatusConfig(source, `${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, source: string, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    invalidStatusConfig(source, `${fieldName} must be a boolean`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, source: string, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    invalidStatusConfig(source, `${fieldName} must be a positive integer`);
  }
  return value;
}

function clampCadenceMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_STATUS_CADENCE_MS;
  return Math.max(MIN_STATUS_CADENCE_MS, Math.floor(ms));
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

export function normalizeStatusName(name: string): string {
  const collapsed = name.replace(/\s+/g, " ").trim() || "subagent";
  return truncateText(collapsed, MAX_STATUS_NAME_LENGTH);
}

function boundStatusLine(line: string): string {
  return truncateText(line.replace(/\s+/g, " ").trim(), MAX_STATUS_LINE_LENGTH);
}

export function parseStatusConfig(rawConfig: unknown, source = "config.json"): StatusConfig {
  const config = requireObject(rawConfig, source, "root");
  const status = requireObject(config.status, source, "status");
  const enabled = requireBoolean(status.enabled, source, "status.enabled");
  const defaultCadenceSeconds = requirePositiveInteger(
    status.defaultCadenceSeconds,
    source,
    "status.defaultCadenceSeconds",
  );

  return {
    enabled,
    defaultCadenceMs: clampCadenceMs(defaultCadenceSeconds * 1000),
    lineLimit: DEFAULT_STATUS_LINE_LIMIT,
  };
}

function readStatusConfigFile(configPath: string, examplePath: string): { sourcePath: string; rawConfig: string } {
  try {
    return { sourcePath: configPath, rawConfig: readFileSync(configPath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw error;
  }

  try {
    return { sourcePath: examplePath, rawConfig: readFileSync(examplePath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        `Missing subagent status config. Expected ${configPath} or ${examplePath}.`,
      );
    }
    throw error;
  }
}

export function loadStatusConfig(
  configPath = DEFAULT_STATUS_CONFIG_PATH,
  examplePath = STATUS_CONFIG_EXAMPLE_PATH,
): StatusConfig {
  const { sourcePath, rawConfig } = readStatusConfigFile(configPath, examplePath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
  }

  return parseStatusConfig(parsed, sourcePath);
}

export function resolveStatusCadenceMs(
  config: StatusConfig,
  requestedSeconds?: number,
): number {
  if (requestedSeconds == null) return config.defaultCadenceMs;
  return clampCadenceMs(requestedSeconds * 1000);
}

export function getStalledAfterMs(cadenceMs: number): number {
  return Math.max(cadenceMs * STALLED_MULTIPLIER, MIN_STALLED_MS);
}

export function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;

  return `${minutes}m`;
}

function isProgressIncrease(
  previous: Pick<SubagentStatusState, "observedEntries" | "observedBytes">,
  next: StatusObservation,
): boolean {
  if (previous.observedEntries == null || previous.observedBytes == null) {
    return true;
  }
  return next.entries > previous.observedEntries || next.bytes > previous.observedBytes;
}

export function createStatusState(params: {
  source: SubagentStatusSource;
  startTimeMs: number;
  cadenceMs: number;
  baselineEntries?: number | null;
  baselineBytes?: number | null;
}): SubagentStatusState {
  const initialKind = params.source === "claude" ? "running" : "starting";
  return {
    source: params.source,
    startTimeMs: params.startTimeMs,
    cadenceMs: params.cadenceMs,
    baselineEntries: params.baselineEntries ?? null,
    baselineBytes: params.baselineBytes ?? null,
    observedEntries: params.baselineEntries ?? null,
    observedBytes: params.baselineBytes ?? null,
    firstObservationAtMs: params.baselineEntries != null ? params.startTimeMs : null,
    lastProgressAtMs: null,
    lastCadenceAtMs: params.startTimeMs,
    lastCadenceEntries: params.baselineEntries ?? null,
    currentKind: initialKind,
  };
}

export function observeStatus(
  state: SubagentStatusState,
  observation: StatusObservation,
  now: number,
): SubagentStatusState {
  const progressIncrease = isProgressIncrease(state, observation);
  const baselineEntries = state.baselineEntries ?? 0;
  const baselineBytes = state.baselineBytes ?? 0;
  const crossesBaseline = observation.entries > baselineEntries || observation.bytes > baselineBytes;
  const shouldMarkProgress = progressIncrease && crossesBaseline;

  return {
    ...state,
    observedEntries: observation.entries,
    observedBytes: observation.bytes,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastProgressAtMs: shouldMarkProgress ? now : state.lastProgressAtMs,
  };
}

export function forceStatusQuiet(state: SubagentStatusState, now: number): SubagentStatusState {
  // The interrupt path currently applies only to Pi-backed children.
  // Claude-backed states always classify as `running`, so accidental calls stay a no-op.
  if (state.source === "claude") return state;

  const quietIdleMs = state.cadenceMs + 1;
  const maxQuietIdleMs = getStalledAfterMs(state.cadenceMs) - 1;
  const forcedIdleMs = Math.min(quietIdleMs, maxQuietIdleMs);
  const forcedProgressAtMs = now - forcedIdleMs;
  const firstObservationAtMs =
    state.firstObservationAtMs == null || state.firstObservationAtMs > forcedProgressAtMs
      ? forcedProgressAtMs
      : state.firstObservationAtMs;

  return {
    ...state,
    firstObservationAtMs,
    lastProgressAtMs: forcedProgressAtMs,
    currentKind: "quiet",
  };
}

export function classifyStatus(state: SubagentStatusState, now: number): StatusSnapshot {
  const elapsedMs = Math.max(0, now - state.startTimeMs);
  const elapsedText = formatElapsedDuration(elapsedMs);

  if (state.source === "claude") {
    return {
      kind: "running",
      elapsedMs,
      elapsedText,
      idleMs: null,
      idleText: null,
      progressEvents: null,
    };
  }

  if (state.observedEntries == null || state.observedBytes == null) {
    const idleStartMs = state.lastProgressAtMs ?? state.firstObservationAtMs ?? state.startTimeMs;
    const idleMs = Math.max(0, now - idleStartMs);
    const stalled = idleMs >= getStalledAfterMs(state.cadenceMs);
    const hasLocalQuietMarker = state.lastProgressAtMs != null;
    return {
      kind: stalled ? "stalled" : hasLocalQuietMarker ? "quiet" : "starting",
      elapsedMs,
      elapsedText,
      idleMs,
      idleText: formatElapsedDuration(idleMs),
      progressEvents: null,
    };
  }

  const idleStartMs = state.lastProgressAtMs ?? state.firstObservationAtMs ?? state.startTimeMs;
  const idleMs = Math.max(0, now - idleStartMs);
  const kind = idleMs >= getStalledAfterMs(state.cadenceMs)
    ? "stalled"
    : state.lastProgressAtMs != null && idleMs < state.cadenceMs
      ? "active"
      : "quiet";
  const progressEvents =
    state.observedEntries != null && state.lastCadenceEntries != null
      ? Math.max(0, state.observedEntries - state.lastCadenceEntries)
      : null;

  return {
    kind,
    elapsedMs,
    elapsedText,
    idleMs,
    idleText: formatElapsedDuration(idleMs),
    progressEvents,
  };
}

export function advanceStatusState(
  state: SubagentStatusState,
  now: number,
): {
  nextState: SubagentStatusState;
  snapshot: StatusSnapshot;
  transition: SubagentStatusTransition;
  cadenceElapsed: boolean;
} {
  const snapshot = classifyStatus(state, now);
  const transition =
    state.currentKind !== "stalled" && snapshot.kind === "stalled"
      ? "stalled"
      : state.currentKind === "stalled" && snapshot.kind === "active"
        ? "recovered"
        : null;
  const cadenceElapsed = now - state.lastCadenceAtMs >= state.cadenceMs;

  return {
    snapshot,
    transition,
    cadenceElapsed,
    nextState: {
      ...state,
      currentKind: snapshot.kind,
      lastCadenceAtMs: cadenceElapsed ? now : state.lastCadenceAtMs,
      lastCadenceEntries: cadenceElapsed ? state.observedEntries : state.lastCadenceEntries,
    },
  };
}

export function formatStatusLine(name: string, snapshot: StatusSnapshot): string {
  const boundedName = normalizeStatusName(name);

  if (snapshot.kind === "starting") {
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, starting.`);
  }

  if (snapshot.kind === "running") {
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}.`);
  }

  if (snapshot.kind === "active") {
    const progress = snapshot.progressEvents && snapshot.progressEvents > 0
      ? ` (+${snapshot.progressEvents} events)`
      : "";
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, active${progress}.`);
  }

  return boundStatusLine(
    `${boundedName} running ${snapshot.elapsedText}, ${snapshot.kind} ${snapshot.idleText}.`,
  );
}

export function formatTransitionLine(
  name: string,
  snapshot: StatusSnapshot,
  transition: Exclude<SubagentStatusTransition, null>,
): string {
  const boundedName = normalizeStatusName(name);

  if (transition === "recovered") {
    const progress = snapshot.progressEvents && snapshot.progressEvents > 0
      ? ` (+${snapshot.progressEvents} events)`
      : "";
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, recovered; active${progress}.`);
  }

  return formatStatusLine(boundedName, snapshot);
}

export function capStatusLines(lines: string[], lineLimit: number): CappedStatusLines {
  const visibleLines = lines.slice(0, lineLimit);
  return {
    visibleLines,
    overflow: Math.max(0, lines.length - visibleLines.length),
  };
}

export function formatStatusAggregate(lines: string[], lineLimit: number): string {
  const { visibleLines, overflow } = capStatusLines(lines, lineLimit);
  const bulletLines = visibleLines.map((line) => `• ${line}`);
  if (overflow > 0) bulletLines.push(`• +${overflow} more running.`);
  return `Subagent status:\n${bulletLines.join("\n")}`;
}
