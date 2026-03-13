import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { listAgentIds } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

// ── Constants (mirrors original route.ts) ───────────────────────────────────
const SESSION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PARENT_SESSIONS_TO_PARSE = 40;
const ORPHAN_FALLBACK_WINDOW_MS = 15 * 60 * 1000;
const SUBAGENT_MAX_ACTIVE_MS = 30 * 60 * 1000;
const SUBAGENT_ACTIVITY_TEXT_MAX_LEN = 80;
const SUBAGENT_ACTIVITY_EVENT_LIMIT = 6;

// ── Types (identical field names to original route.ts) ──────────────────────
type SessionsIndex = Record<string, { sessionId?: string; updatedAt?: number }>;

export type SubagentActivityEvent = {
  key: string;
  text: string;
  at: number;
};

export type SubagentInfo = {
  toolId: string;
  label: string;
  sessionKey?: string;
  childSessionKey?: string;
  activityEvents?: SubagentActivityEvent[];
};

export type AgentActivity = {
  agentId: string;
  name: string;
  emoji: string;
  state: "idle" | "working" | "waiting" | "offline";
  currentTool?: string;
  toolStatus?: string;
  lastActive: number;
  subagents?: SubagentInfo[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function isSpawnTool(name: string): boolean {
  return name === "sessions_spawn" || name === "session_spawn";
}

function pickSubagentLabel(raw: unknown): string {
  if (!raw || typeof raw !== "object") {return "Subtask";}
  const args = raw as Record<string, unknown>;
  if (typeof args.label === "string" && args.label.trim()) {return args.label.trim();}
  if (typeof args.task === "string" && args.task.trim()) {return args.task.trim();}
  if (typeof args.description === "string" && args.description.trim()) {return args.description.trim();}
  return "Subtask";
}

function extractCompletedSubagentLabel(text: string): string | null {
  if (!text) {return null;}
  const patterns = [
    /A subagent task\s+"([^"]+)"\s+just completed/i,
    /subagent task\s+"([^"]+)"\s+.*completed/i,
    /子任务[""]([^""]+)[""].{0,12}完成/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]?.trim()) {return m[1].trim();}
  }
  return null;
}

function parseRecordTimestamp(record: unknown): number {
  if (!record || typeof record !== "object") {return 0;}
  const rec = record as Record<string, unknown>;
  if (typeof rec.timestamp === "string") {
    const t = Date.parse(rec.timestamp);
    if (Number.isFinite(t)) {return t;}
  }
  if (typeof rec.timestamp === "number" && Number.isFinite(rec.timestamp)) {return rec.timestamp;}
  const msg = rec.message;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    if (typeof m.timestamp === "string") {
      const t = Date.parse(m.timestamp);
      if (Number.isFinite(t)) {return t;}
    }
    if (typeof m.timestamp === "number" && Number.isFinite(m.timestamp)) {return m.timestamp;}
  }
  return 0;
}

function normalizeActivityText(raw: unknown): string | null {
  if (typeof raw !== "string") {return null;}
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) {return null;}
  return compact.length > SUBAGENT_ACTIVITY_TEXT_MAX_LEN
    ? `${compact.slice(0, SUBAGENT_ACTIVITY_TEXT_MAX_LEN - 1)}…`
    : compact;
}

function extractChildSessionKeyFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {return null;}
  const data = payload as Record<string, unknown>;
  const direct = data.childSessionKey;
  if (typeof direct === "string" && direct.includes(":subagent:")) {return direct;}
  const details = data.details;
  if (details && typeof details === "object") {
    const fromDetails = (details as Record<string, unknown>).childSessionKey;
    if (typeof fromDetails === "string" && fromDetails.includes(":subagent:")) {return fromDetails;}
  }
  return null;
}

function extractChildSessionKeyFromText(rawText: unknown): string | null {
  if (typeof rawText !== "string" || !rawText.trim()) {return null;}
  try {
    const parsed = JSON.parse(rawText);
    return extractChildSessionKeyFromPayload(parsed);
  } catch {
    const match = rawText.match(/agent:[^:\s]+:subagent:[a-f0-9-]+/i);
    return match ? match[0] : null;
  }
}

function extractChildSessionKeyFromToolResultMessage(message: unknown): string | null {
  if (!message || typeof message !== "object") {return null;}
  const msg = message as Record<string, unknown>;
  const fromPayload = extractChildSessionKeyFromPayload(msg);
  if (fromPayload) {return fromPayload;}
  const content = msg.content;
  if (!Array.isArray(content)) {return null;}
  for (const block of content) {
    if (!block || typeof block !== "object") {continue;}
    const text = (block as Record<string, unknown>).text;
    const fromText = extractChildSessionKeyFromText(text);
    if (fromText) {return fromText;}
  }
  return null;
}

function getSubagentSessionIdFromKey(sessionKey: string): string | null {
  const idx = sessionKey.indexOf(":subagent:");
  if (idx < 0) {return null;}
  const sessionId = sessionKey.slice(idx + ":subagent:".length).trim();
  return sessionId || null;
}

function resolveSubagentSessionId(
  childSessionKey: string,
  sessionsIndex?: SessionsIndex,
): string | null {
  const fromIndex = sessionsIndex?.[childSessionKey]?.sessionId;
  if (typeof fromIndex === "string" && fromIndex.trim()) {return fromIndex.trim();}
  return getSubagentSessionIdFromKey(childSessionKey);
}

// ── Subagent activity events ─────────────────────────────────────────────────

async function parseSubagentActivityEvents(
  agentSessionsDir: string,
  childSessionKey: string,
  sessionsIndex?: SessionsIndex,
): Promise<SubagentActivityEvent[]> {
  const sessionId = resolveSubagentSessionId(childSessionKey, sessionsIndex);
  if (!sessionId) {return [];}
  const transcriptPath = path.join(agentSessionsDir, `${sessionId}.jsonl`);
  if (!existsSync(transcriptPath)) {return [];}

  try {
    const content = await fs.readFile(transcriptPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    const events: SubagentActivityEvent[] = [];

    for (let i = 0; i < lines.length; i++) {
      let record: unknown;
      try { record = JSON.parse(lines[i]); } catch { continue; }
      if ((record as Record<string, unknown>)?.type !== "message") {continue;}
      const msg = (record as Record<string, unknown>).message as Record<string, unknown>;
      if (!msg) {continue;}
      const at = parseRecordTimestamp(record);
      const role = typeof msg.role === "string" ? msg.role : "";
      const blocks = Array.isArray(msg.content) ? msg.content : [];

      if (role === "assistant") {
        for (let bi = 0; bi < blocks.length; bi++) {
          const block = blocks[bi] as Record<string, unknown>;
          if (!block) {continue;}
          if ((block.type === "toolCall" || block.type === "tool_use") && typeof block.name === "string") {
            events.push({ key: `${i}:tool:${block.id || bi}`, text: `tool: ${block.name}`, at });
            continue;
          }
          if (block.type === "text") {
            const normalized = normalizeActivityText(block.text);
            if (normalized) {events.push({ key: `${i}:msg:${bi}`, text: normalized, at });}
          }
        }
      } else if (role === "toolResult") {
        const toolName = typeof msg.toolName === "string" ? msg.toolName.trim() : "";
        const details = (msg.details && typeof msg.details === "object") ? msg.details as Record<string, unknown> : null;
        const status = typeof details?.status === "string" ? details.status : "";
        if (toolName) {
          events.push({ key: `${i}:result:${msg.toolCallId || ""}`, text: `result: ${toolName}${status ? ` (${status})` : ""}`, at });
        }
      } else if (role === "user") {
        for (let bi = 0; bi < blocks.length; bi++) {
          const normalized = normalizeActivityText((blocks[bi] as Record<string, unknown>)?.text);
          if (normalized) {events.push({ key: `${i}:user:${bi}`, text: `task: ${normalized}`, at });}
        }
      }
    }

    events.sort((a, b) => a.at - b.at);
    const deduped: SubagentActivityEvent[] = [];
    const recentTextAt = new Map<string, number>();
    for (const event of events) {
      const lastAt = recentTextAt.get(event.text);
      if (typeof lastAt === "number" && Math.abs(event.at - lastAt) <= 1500) {continue;}
      recentTextAt.set(event.text, event.at);
      deduped.push(event);
    }
    return deduped.slice(-SUBAGENT_ACTIVITY_EVENT_LIMIT);
  } catch {
    return [];
  }
}

// ── Parse subagents from one session file ────────────────────────────────────

async function parseSubagentsFromSessionFile(
  agentSessionsDir: string,
  filePath: string,
  sessionKey: string,
  sessionsIndex?: SessionsIndex,
): Promise<SubagentInfo[]> {
  const subagents: SubagentInfo[] = [];
  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    const activeSubtasks = new Map<string, { label: string; at: number; childSessionKey?: string }>();
    const spawnToolIds = new Set<string>();

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const eventAt = parseRecordTimestamp(record);

        // Legacy format
        if (record.type === "assistant" && record.message) {
          const msg = record.message as Record<string, unknown>;
          const blocks = Array.isArray(msg.content) ? msg.content : [];
          for (const block of blocks as Record<string, unknown>[]) {
            if (block.type !== "tool_use" || typeof block.id !== "string" || !block.id) {continue;}
            if (typeof block.name === "string" && isSpawnTool(block.name)) {
              activeSubtasks.set(block.id, { label: pickSubagentLabel(block.input), at: eventAt });
              spawnToolIds.add(block.id);
            }
          }
        }
        if (record.type === "user" && record.message) {
          const msg = record.message as Record<string, unknown>;
          const blocks = Array.isArray(msg.content) ? msg.content : [];
          for (const block of blocks as Record<string, unknown>[]) {
            if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
              if (spawnToolIds.has(block.tool_use_id)) {
                const childSessionKey = extractChildSessionKeyFromToolResultMessage(block);
                if (childSessionKey && activeSubtasks.has(block.tool_use_id)) {
                  const prev = activeSubtasks.get(block.tool_use_id)!;
                  activeSubtasks.set(block.tool_use_id, { ...prev, childSessionKey });
                }
                continue;
              }
              activeSubtasks.delete(block.tool_use_id);
            }
          }
        }

        // New format
        if (record.type === "message" && record.message) {
          const msg = record.message as Record<string, unknown>;
          const role = typeof msg.role === "string" ? msg.role : "";
          const blocks = Array.isArray(msg.content) ? msg.content : [];

          if (role === "assistant") {
            for (const block of blocks as Record<string, unknown>[]) {
              if (block?.type === "toolCall" && typeof block.id === "string" && block.id) {
                if (typeof block.name === "string" && isSpawnTool(block.name)) {
                  activeSubtasks.set(block.id, { label: pickSubagentLabel(block.arguments), at: eventAt });
                  spawnToolIds.add(block.id);
                }
              } else if (block?.type === "tool_use" && typeof block.id === "string") {
                if (typeof (block.input as Record<string, unknown>)?.description === "string" && isSpawnTool(String(block.name || ""))) {
                  activeSubtasks.set(block.id, { label: pickSubagentLabel(block.input), at: eventAt });
                  spawnToolIds.add(block.id);
                }
              }
            }
          } else if (role === "toolResult") {
            const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
            const toolName = typeof msg.toolName === "string" ? msg.toolName : "";
            if (toolCallId && spawnToolIds.has(toolCallId)) {
              const childSessionKey = extractChildSessionKeyFromToolResultMessage(msg);
              if (childSessionKey && activeSubtasks.has(toolCallId)) {
                const prev = activeSubtasks.get(toolCallId)!;
                activeSubtasks.set(toolCallId, { ...prev, childSessionKey });
              }
              continue;
            }
            if (toolCallId && !isSpawnTool(toolName) && !spawnToolIds.has(toolCallId)) {
              activeSubtasks.delete(toolCallId);
            }
          } else if (role === "user") {
            const text = (blocks as Record<string, unknown>[])
              .map((b) => (b?.type === "text" && typeof b.text === "string") ? b.text : "")
              .join("\n");
            const completedLabel = extractCompletedSubagentLabel(text);
            if (completedLabel) {
              for (const [id, state] of activeSubtasks.entries()) {
                if (state.label === completedLabel || state.label.includes(completedLabel) || completedLabel.includes(state.label)) {
                  activeSubtasks.delete(id);
                  break;
                }
              }
            }
          }
        }
      } catch {
        // skip bad line
      }
    }

    const now = Date.now();
    for (const [toolId, state] of activeSubtasks.entries()) {
      if (state.at > 0 && now - state.at > SUBAGENT_MAX_ACTIVE_MS) {continue;}
      let activityEvents: SubagentActivityEvent[] | undefined;
      if (state.childSessionKey) {
        activityEvents = await parseSubagentActivityEvents(agentSessionsDir, state.childSessionKey, sessionsIndex);
      }
      subagents.push({
        toolId,
        label: state.label,
        sessionKey,
        childSessionKey: state.childSessionKey,
        activityEvents: activityEvents && activityEvents.length > 0 ? activityEvents : undefined,
      });
    }
  } catch {
    // ignore
  }
  return subagents;
}

// ── Parse subagents from all recent parent sessions ───────────────────────────

async function parseSubagents(agentSessionsDir: string, agentId: string): Promise<SubagentInfo[]> {
  const allSubagents: SubagentInfo[] = [];
  try {
    const cutoff = Date.now() - SESSION_LOOKBACK_MS;
    const sessionFiles: Array<{ sessionKey: string; filePath: string; updatedAt: number }> = [];
    const knownFilePaths = new Set<string>();
    const subagentSessionIds = new Set<string>();
    let sessionsIndex: SessionsIndex = {};

    const sessionsIndexPath = path.join(agentSessionsDir, "sessions.json");
    if (existsSync(sessionsIndexPath)) {
      try {
        const raw = await fs.readFile(sessionsIndexPath, "utf8");
        sessionsIndex = JSON.parse(raw) as SessionsIndex;
        for (const [sessionKey, meta] of Object.entries(sessionsIndex)) {
          if (!meta || typeof meta.sessionId !== "string" || !meta.sessionId) {continue;}
          if (sessionKey.includes(":subagent:")) {
            subagentSessionIds.add(meta.sessionId);
            continue;
          }
          const filePath = path.join(agentSessionsDir, `${meta.sessionId}.jsonl`);
          if (!existsSync(filePath)) {continue;}
          let updatedAt = typeof meta.updatedAt === "number" && meta.updatedAt > 0
            ? meta.updatedAt
            : 0;
          if (updatedAt === 0) {
            try { updatedAt = (await fs.stat(filePath)).mtimeMs; } catch { updatedAt = 0; }
          }
          if (updatedAt > 0 && updatedAt < cutoff) {continue;}
          sessionFiles.push({ sessionKey, filePath, updatedAt });
          knownFilePaths.add(filePath);
        }
      } catch { /* ignore */ }
    }

    // Fallback: recent orphan files not in sessions.json
    try {
      const orphanCutoff = Date.now() - ORPHAN_FALLBACK_WINDOW_MS;
      const files = await fs.readdir(agentSessionsDir);
      for (const file of files) {
        if (!file.endsWith(".jsonl") || file.startsWith("probe-")) {continue;}
        const filePath = path.join(agentSessionsDir, file);
        if (knownFilePaths.has(filePath)) {continue;}
        const sessionId = file.slice(0, -".jsonl".length);
        if (subagentSessionIds.has(sessionId)) {continue;}
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < orphanCutoff || stat.mtimeMs < cutoff) {continue;}
        sessionFiles.push({
          sessionKey: `agent:${agentId}:orphan:${sessionId}`,
          filePath,
          updatedAt: stat.mtimeMs,
        });
      }
    } catch { /* ignore */ }

    sessionFiles.sort((a, b) => b.updatedAt - a.updatedAt);
    const candidates = sessionFiles.slice(0, MAX_PARENT_SESSIONS_TO_PARSE);
    const nested = await Promise.all(
      candidates.map((s) => parseSubagentsFromSessionFile(agentSessionsDir, s.filePath, s.sessionKey, sessionsIndex))
    );

    const dedupe = new Set<string>();
    for (const list of nested) {
      for (const sub of list) {
        const key = `${sub.sessionKey || ""}::${sub.toolId}`;
        if (dedupe.has(key)) {continue;}
        dedupe.add(key);
        allSubagents.push(sub);
      }
    }
  } catch { /* ignore */ }
  return allSubagents;
}

// ── Agent last-active helper ─────────────────────────────────────────────────

async function getAgentLastActive(agentId: string): Promise<number> {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const files = await fs.readdir(sessionsDir);
    let lastActive = 0;
    for (const file of files) {
      if (!file.endsWith(".jsonl")) {continue;}
      const filePath = path.join(sessionsDir, file);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs > lastActive) {lastActive = stat.mtimeMs;}
    }
    return lastActive;
  } catch {
    return 0;
  }
}

function resolveAgentState(lastActive: number, now: number): "idle" | "working" | "waiting" | "offline" {
  if (lastActive === 0) {return "offline";}
  const timeDiff = now - lastActive;
  if (timeDiff > 10 * 60 * 1000) {return "offline";}
  if (timeDiff <= 2 * 60 * 1000) {return "working";}
  return "idle";
}

// ── HTTP handler ─────────────────────────────────────────────────────────────

export async function handleAgentActivityHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/agent-activity") {return false;}

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  try {
    const cfg = loadConfig();
    const agentIds = listAgentIds(cfg);
    const now = Date.now();

    const agents: AgentActivity[] = await Promise.all(
      agentIds.map(async (agentId) => {
        const agentEntry = cfg.agents?.list?.find((a) => a?.id === agentId);
        const lastActive = await getAgentLastActive(agentId);
        const state = resolveAgentState(lastActive, now);

        let subagents: SubagentInfo[] | undefined;
        if (state !== "offline") {
          const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
          if (existsSync(sessionsDir)) {
            const list = await parseSubagents(sessionsDir, agentId);
            if (list.length > 0) {subagents = list;}
          }
        }

        return {
          agentId,
          name: agentEntry?.name || agentId,
          emoji: agentEntry?.identity?.emoji || agentEntry?.emoji || "🤖",
          state,
          lastActive,
          subagents,
        };
      })
    );

    sendJson(res, 200, { agents });
    return true;
  } catch {
    sendJson(res, 500, { error: "Internal server error" });
    return true;
  }
}
