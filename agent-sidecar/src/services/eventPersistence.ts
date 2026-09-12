import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AGENT_PROTOCOL_VERSION, AgentEnvelope, AgentTerminalState, validateEnvelope } from "../../../shared/agent-protocol";

export interface EventQueryOptions {
  agentId?: string;
  type?: string;
  afterSequence?: number;
}

export interface EventPersistence {
  append(runId: string, event: AgentEnvelope): Promise<void>;
  query(runId: string, options?: EventQueryOptions): Promise<AgentEnvelope[]>;
  deleteRun(runId: string): Promise<void>;
}

export interface FileEventPersistenceOptions {
  maxPayloadStringLength?: number;
  retentionMs?: number;
}

function safeRunName(runId: string): string {
  const slug = runId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "run";
  const hash = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

function redact(value: unknown, maxStringLength: number, key = ""): unknown {
  if (/secret|password|token|api[-_]?key|authorization/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}\n[TRUNCATED ${value.length - maxStringLength} CHARACTERS]`
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, maxStringLength));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, maxStringLength, childKey)]));
  }
  return value;
}

export class FileEventPersistence implements EventPersistence {
  private readonly root: string;
  private readonly maxPayloadStringLength: number;
  private readonly retentionMs?: number;
  private readonly appendQueues = new Map<string, Promise<void>>();
  private readonly nextSequences = new Map<string, number>();

  constructor(workspaceRoot: string, options: FileEventPersistenceOptions = {}) {
    this.root = path.join(workspaceRoot, ".rusty", "runs");
    this.maxPayloadStringLength = options.maxPayloadStringLength ?? 20_000;
    this.retentionMs = options.retentionMs;
  }

  async append(runId: string, event: AgentEnvelope): Promise<void> {
    if (event.runId !== runId) throw new Error("Event runId does not match append target.");
    const previous = this.appendQueues.get(runId) || Promise.resolve();
    const queued = previous.then(async () => {
      const sequence = await this.allocateSequence(runId);
      const persisted = validateEnvelope({
        ...event,
        protocolVersion: AGENT_PROTOCOL_VERSION,
        sequence,
        payload: redact(event.payload, this.maxPayloadStringLength),
      });
      const directory = this.runDirectory(runId);
      await fs.mkdir(directory, { recursive: true });
      await fs.appendFile(path.join(directory, "events.jsonl"), `${JSON.stringify(persisted)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    this.appendQueues.set(runId, queued);
    try {
      await queued;
    } finally {
      if (this.appendQueues.get(runId) === queued) this.appendQueues.delete(runId);
    }
  }

  async query(runId: string, options: EventQueryOptions = {}): Promise<AgentEnvelope[]> {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(this.runDirectory(runId), "events.jsonl"), "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const lines = contents.split("\n");
    const events: AgentEnvelope[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const event = validateEnvelope(JSON.parse(line));
        if (event.runId !== runId) continue;
        if (options.agentId && event.agentId !== options.agentId) continue;
        if (options.type && event.type !== options.type) continue;
        if (options.afterSequence !== undefined && event.sequence <= options.afterSequence) continue;
        events.push(event);
      } catch (error) {
        const isTruncatedFinalLine = index === lines.length - 1 && !contents.endsWith("\n");
        if (!isTruncatedFinalLine) throw new Error(`Invalid persisted event at line ${index + 1}.`, { cause: error });
      }
    }
    return events.sort((left, right) => left.sequence - right.sequence);
  }

  async deleteRun(runId: string): Promise<void> {
    await fs.rm(this.runDirectory(runId), { recursive: true, force: true });
    this.nextSequences.delete(runId);
  }

  async enforceRetention(now = Date.now()): Promise<number> {
    if (!this.retentionMs) return 0;
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
    let deleted = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const eventPath = path.join(this.root, entry.name, "events.jsonl");
      try {
        const stat = await fs.stat(eventPath);
        if (now - stat.mtimeMs > this.retentionMs) {
          await fs.rm(path.join(this.root, entry.name), { recursive: true, force: true });
          deleted++;
        }
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return deleted;
  }

  private runDirectory(runId: string): string {
    return path.join(this.root, safeRunName(runId));
  }

  private async allocateSequence(runId: string): Promise<number> {
    const cached = this.nextSequences.get(runId);
    if (cached !== undefined) {
      this.nextSequences.set(runId, cached + 1);
      return cached;
    }
    const events = await this.query(runId);
    const next = (events.at(-1)?.sequence || 0) + 1;
    this.nextSequences.set(runId, next + 1);
    return next;
  }
}

/**
 * The 3 terminal outcomes below are the same values AgentTerminalState
 * names (Extract keeps this declaration tied to that shared vocabulary
 * instead of silently drifting from it), plus this recorder's own two
 * non-terminal-state concepts AgentTerminalState doesn't cover: a run
 * still in progress, and one whose process restarted mid-run. Not
 * renamed to AgentTerminalState's own "disconnected"/"timed_out" here --
 * that would change this API's real values (an existing test asserts
 * "interrupted" literally) with no capability behavior actually asking
 * for that rename yet.
 */
export type ReplayedRunStatus = Extract<AgentTerminalState, "completed" | "failed" | "cancelled"> | "running" | "interrupted";

export interface ReplayedRunState {
  runId: string;
  status: ReplayedRunStatus;
  lastSequence: number;
  messages: AgentEnvelope[];
  questions: AgentEnvelope[];
  tools: AgentEnvelope[];
  delegations: AgentEnvelope[];
}

export function replayRun(events: AgentEnvelope[], processRestarted = false): ReplayedRunState {
  const runId = events[0]?.runId || "";
  const state: ReplayedRunState = {
    runId,
    status: "running",
    lastSequence: 0,
    messages: [],
    questions: [],
    tools: [],
    delegations: [],
  };
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    state.lastSequence = event.sequence;
    if (event.type.startsWith("message.") || event.type === "token") state.messages.push(event);
    if (event.type.startsWith("agent.question_")) state.questions.push(event);
    if (event.type.startsWith("tool.")) state.tools.push(event);
    if (event.type.startsWith("delegation.") || event.type === "agent.spawned") state.delegations.push(event);
    if (event.type === "run.completed") state.status = "completed";
    else if (event.type === "run.failed") state.status = "failed";
    else if (event.type === "run.cancelled") state.status = "cancelled";
  }
  if (processRestarted && state.status === "running") state.status = "interrupted";
  return state;
}

export class RunEventRecorder {
  constructor(
    private readonly persistence: EventPersistence,
    private readonly identity: { conversationId: string; runId: string; agentId: string; parentAgentId?: string },
  ) {}

  record(type: string, payload: unknown, correlationId?: string): Promise<void> {
    return this.persistence.append(this.identity.runId, {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      ...this.identity,
      messageId: randomUUID(),
      correlationId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      type,
      payload,
    });
  }
}
