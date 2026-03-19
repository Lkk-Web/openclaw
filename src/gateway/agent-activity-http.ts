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
const SUBAGENT_ACTIVITY_TEXT_MAX_LEN = 10000;
const SUBAGENT_ACTIVITY_EVENT_LIMIT = 100;
const MAX_COMPLETED_TASKS = 15;

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
  status?: "running" | "completed" | "failed";
  completedAt?: number;
};

export type AgentActivity = {
  agentId: string;
  name: string;
  emoji: string;
  state: "idle" | "working" | "waiting" | "offline";
  currentTool?: string;
  toolStatus?: string;
  currentTask?: string;
  lastActive: number;
  subagents?: SubagentInfo[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function isSpawnTool(name: string): boolean {
  return name === "sessions_spawn" || name === "session_spawn" || name === "sessions_send";
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

// Extract a short, human-readable summary from tool call arguments.
// Returns a single-line string or null.
const TOOL_ARG_MAX_LEN = 300;

function extractToolArgSummary(toolName: string, args: unknown): string | null {
  if (!args || typeof args !== "object") {return null;}
  const a = args as Record<string, unknown>;

  // Per-tool primary key
  const primaryKeys: Record<string, string[]> = {
    exec: ["command"],
    read: ["file_path", "path"],
    write: ["file_path", "path"],
    edit: ["file_path", "path"],
    web_search: ["query"],
    web_fetch: ["url"],
    browser: ["url", "action", "element"],
  };

  const keys = primaryKeys[toolName] ?? [];
  for (const key of keys) {
    const val = a[key];
    if (typeof val === "string" && val.trim()) {
      const v = val.trim().replace(/\s+/g, " ");
      return v.length > TOOL_ARG_MAX_LEN ? `${v.slice(0, TOOL_ARG_MAX_LEN - 1)}…` : v;
    }
  }

  // Fallback: first string value found in args
  for (const val of Object.values(a)) {
    if (typeof val === "string" && val.trim()) {
      const v = val.trim().replace(/\s+/g, " ");
      return v.length > TOOL_ARG_MAX_LEN ? `${v.slice(0, TOOL_ARG_MAX_LEN - 1)}…` : v;
    }
  }

  return null;
}

// Extract build/test signals from exec tool result
function extractBuildTestEvent(
  msg: Record<string, unknown>,
  key: string,
  at: number,
): SubagentActivityEvent | null {
  // Look for output in message content blocks
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  let outputText = "";
  for (const block of blocks as Record<string, unknown>[]) {
    if (!block) {continue;}
    if (block.type === "text" && typeof block.text === "string") {
      outputText += block.text;
    } else if (block.type === "toolResult" && typeof block.content === "string") {
      outputText += block.content;
    }
  }
  // Also check direct output field
  if (!outputText && typeof msg.output === "string") {outputText = msg.output;}
  if (!outputText) {return null;}

  // Detect build/test signals
  const lower = outputText.toLowerCase();
  if (/error|failed|failure/.test(lower) && /(build|compile|tsc|test)/.test(lower)) {
    const snippet = outputText.replace(/\s+/g, " ").trim().slice(0, 200);
    return { key, text: `❌ 构建/测试失败: ${snippet}`, at };
  }
  if (/(build|compile|tsc)\s*(success|done|ok|finished|\d+ warning)/i.test(outputText) ||
      /successfully compiled/i.test(outputText)) {
    return { key, text: "✅ 构建成功", at };
  }
  if (/tests?\s+passed|all tests/i.test(outputText)) {
    return { key, text: "✅ 测试通过", at };
  }
  return null;
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
  return null;
}

// ── Subagent activity events ─────────────────────────────────────────────────

async function parseSubagentActivityEvents(
  agentSessionsDir: string,
  childSessionKey: string,
  sessionsIndex?: SessionsIndex,
): Promise<SubagentActivityEvent[]> {
  let sessionId: string | null = null;
  let transcriptPath = "";
  
  // First: try to resolve from the target agent's own sessions directory
  // (handles cross-agent subagents, e.g. main spawning dev-assistant subagents)
  const match = childSessionKey.match(/^agent:([^:]+):/);
  if (match?.[1]) {
    const targetAgentId = match[1];
    const targetSessionsDir = resolveSessionTranscriptsDirForAgent(targetAgentId);
    const targetIndexPath = path.join(targetSessionsDir, "sessions.json");
    if (existsSync(targetIndexPath)) {
      try {
        const raw = await fs.readFile(targetIndexPath, "utf8");
        const targetIndex = JSON.parse(raw) as SessionsIndex;
        sessionId = targetIndex[childSessionKey]?.sessionId || null;
        if (sessionId) {
          transcriptPath = path.join(targetSessionsDir, `${sessionId}.jsonl`);
        }
      } catch { /* ignore */ }
    }
  }
  
  // Fallback: try parent's sessionsIndex (for same-agent subagents)
  if (!sessionId || !existsSync(transcriptPath)) {
    sessionId = resolveSubagentSessionId(childSessionKey, sessionsIndex);
    transcriptPath = sessionId ? path.join(agentSessionsDir, `${sessionId}.jsonl`) : "";
  }
  
  if (!sessionId || !existsSync(transcriptPath)) {return [];}

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
          if (block.type === "text") {
            const normalized = normalizeActivityText(block.text);
            if (normalized) {events.push({ key: `${i}:msg:${bi}`, text: normalized, at });}
          } else if (block.type === "toolCall" || block.type === "tool_use") {
            const toolName = typeof block.name === "string" ? block.name : "";
            if (!toolName || isSpawnTool(toolName)) {continue;}
            const args = block.type === "toolCall" ? block.arguments : block.input;
            const summary = extractToolArgSummary(toolName, args);
            const toolEmoji = toolName === "read" ? "📖" : toolName === "exec" ? "🔧" : toolName === "edit" ? "✍️" : "🔧";
            if (summary) {
              events.push({ key: `${i}:tool:${bi}`, text: `${toolEmoji} ${toolName}: ${summary}`, at });
            } else {
              events.push({ key: `${i}:tool:${bi}`, text: `${toolEmoji} ${toolName}`, at });
            }
          }
        }
      } else if (role === "toolResult" || role === "tool") {
        // 从 exec 工具结果中提取构建/测试信号
        const toolName = typeof msg.toolName === "string" ? msg.toolName.trim() : "";
        if (toolName === "exec") {
          const buildTestEvent = extractBuildTestEvent(msg, `${i}:result:${msg.toolCallId || ""}`, at);
          if (buildTestEvent) {events.push(buildTestEvent);}
        }
        // 其他 tool 结果一律跳过
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

// ── Check subagent status ────────────────────────────────────────────────────

async function getSubagentStatus(
  agentSessionsDir: string,
  childSessionKey: string,
  sessionsIndex?: SessionsIndex,
): Promise<{ status: "running" | "completed" | "failed"; completedAt?: number }> {
  if (!childSessionKey) return { status: "completed" };
  
  // Resolve session ID and transcript path
  let sessionId: string | null = null;
  let transcriptPath = "";
  
  // Try target agent's sessions directory first
  const match = childSessionKey.match(/^agent:([^:]+):/);
  if (match?.[1]) {
    const targetAgentId = match[1];
    const targetSessionsDir = resolveSessionTranscriptsDirForAgent(targetAgentId);
    const targetIndexPath = path.join(targetSessionsDir, "sessions.json");
    if (existsSync(targetIndexPath)) {
      try {
        const raw = await fs.readFile(targetIndexPath, "utf8");
        const targetIndex = JSON.parse(raw) as SessionsIndex;
        sessionId = targetIndex[childSessionKey]?.sessionId || null;
        if (sessionId) {
          transcriptPath = path.join(targetSessionsDir, `${sessionId}.jsonl`);
        }
      } catch { /* ignore */ }
    }
  }
  
  // Fallback to parent's sessionsIndex
  if (!sessionId || !existsSync(transcriptPath)) {
    sessionId = resolveSubagentSessionId(childSessionKey, sessionsIndex);
    transcriptPath = sessionId ? path.join(agentSessionsDir, `${sessionId}.jsonl`) : "";
  }
  
  if (!sessionId || !existsSync(transcriptPath)) return { status: "completed" };
  
  try {
    // Check sessions.json for abortedLastRun marker
    const match = childSessionKey.match(/^agent:([^:]+):/);
    if (match?.[1]) {
      const targetAgentId = match[1];
      const targetSessionsDir = resolveSessionTranscriptsDirForAgent(targetAgentId);
      const targetIndexPath = path.join(targetSessionsDir, "sessions.json");
      if (existsSync(targetIndexPath)) {
        const raw = await fs.readFile(targetIndexPath, "utf8");
        const targetIndex = JSON.parse(raw) as Record<string, { abortedLastRun?: boolean }>;
        if (targetIndex[childSessionKey]?.abortedLastRun === true) {
          return { status: "failed" };
        }
      }
    }
    
    const content = await fs.readFile(transcriptPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    
    let lastActivityAt = 0;
    let completedAt: number | undefined;
    
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        
        // Check for completion markers
        if (record.endTime || record.completedAt || record.status === "completed" || record.status === "killed") {
          completedAt = typeof record.completedAt === "number" ? record.completedAt :
                       typeof record.endTime === "number" ? record.endTime :
                       parseRecordTimestamp(record);
          return { status: record.status === "killed" ? "failed" : "completed", completedAt };
        }
        
        // Track last activity time
        const timestamp = parseRecordTimestamp(record);
        if (timestamp > lastActivityAt) {
          lastActivityAt = timestamp;
        }
      } catch { /* skip */ }
    }
    
    // Check if last activity was within 30 minutes
    const now = Date.now();
    if (lastActivityAt > 0 && (now - lastActivityAt) > SUBAGENT_MAX_ACTIVE_MS) {
      return { status: "completed", completedAt: lastActivityAt };
    }
    
    return { status: "running" };
  } catch {
    return { status: "completed" };
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
            if (toolCallId && spawnToolIds.has(toolCallId)) {
              const childSessionKey = extractChildSessionKeyFromToolResultMessage(msg);
              if (childSessionKey && activeSubtasks.has(toolCallId)) {
                const prev = activeSubtasks.get(toolCallId)!;
                activeSubtasks.set(toolCallId, { ...prev, childSessionKey });
              }
            }
          }
        }
      } catch {
        // skip bad line
      }
    }

    // Filter and build subagent list
    for (const [toolId, state] of activeSubtasks.entries()) {
      if (!state.childSessionKey) continue;
      
      // Get subagent status
      const statusInfo = await getSubagentStatus(agentSessionsDir, state.childSessionKey, sessionsIndex);
      
      const activityEvents = await parseSubagentActivityEvents(agentSessionsDir, state.childSessionKey, sessionsIndex);
      
      subagents.push({
        toolId,
        label: state.label,
        sessionKey,
        childSessionKey: state.childSessionKey,
        activityEvents: activityEvents.length > 0 ? activityEvents : undefined,
        status: statusInfo.status,
        completedAt: statusInfo.completedAt,
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
        if (file.endsWith(".jsonl.deleted")) {continue;}
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
        // Use childSessionKey as unique identifier (if available), otherwise fallback to sessionKey::toolId
        const key = sub.childSessionKey || `${sub.sessionKey || ""}::${sub.toolId}`;
        if (dedupe.has(key)) {continue;}
        dedupe.add(key);
        allSubagents.push(sub);
      }
    }
    
    // Separate running and completed tasks
    const running = allSubagents.filter(s => s.status === "running");
    const completed = allSubagents.filter(s => s.status === "completed" || s.status === "failed");
    
    // Filter completed tasks from last 1 hour
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentCompleted = completed
      .filter(s => (s.completedAt || 0) > oneHourAgo)
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
      .slice(0, MAX_COMPLETED_TASKS);
    
    // Return all running + recent completed
    return [...running, ...recentCompleted];
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

// ── Extract current task from latest session ─────────────────────────────────

async function extractCurrentTask(agentId: string): Promise<string | undefined> {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    // Load sessions index
    const sessionsIndexPath = path.join(sessionsDir, "sessions.json");
    if (!existsSync(sessionsIndexPath)) {return undefined;}
    
    const raw = await fs.readFile(sessionsIndexPath, "utf8");
    const sessionsIndex = JSON.parse(raw) as SessionsIndex;
    
    // Find latest non-subagent session
    let latestSession: { sessionId: string; updatedAt: number } | null = null;
    for (const [sessionKey, meta] of Object.entries(sessionsIndex)) {
      if (!meta?.sessionId || sessionKey.includes(":subagent:")) {continue;}
      const updatedAt = meta.updatedAt || 0;
      if (!latestSession || updatedAt > latestSession.updatedAt) {
        latestSession = { sessionId: meta.sessionId, updatedAt };
      }
    }
    
    if (!latestSession) {return undefined;}
    
    // Read session transcript
    const transcriptPath = path.join(sessionsDir, `${latestSession.sessionId}.jsonl`);
    if (!existsSync(transcriptPath)) {return undefined;}
    
    const content = await fs.readFile(transcriptPath, "utf8");
    const line = content.split("\n").filter((l) => l.trim());
    
    // Find last user message
    let lastUserText = "";
    for (let i = line.length - 1; i >= 0; i--) {
      try {
        const record = JSON.parse(line[i]) as Record<string, unknown>;
        if (record.type !== "message") {continue;}
        const msg = record.message as Record<string, unknown>;
        if (msg?.role !== "user") {continue;}
        
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks as Record<string, unknown>[]) {
          if (block?.type === "text" && typeof block.text === "string") {
            lastUserText = block.text.trim();
            break;
          }
        }
        if (lastUserText) {break;}
      } catch { /* skip */ }
    }
    
    if (!lastUserText) {return undefined;}
    
    // Split by lines and take the last non-empty, non-metadata line
    const lines = lastUserText.split('\n').map(l => l.trim()).filter(l => l);
    let actualMessage = "";
    
    // Find the actual user message (skip metadata blocks)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      // Skip JSON blocks, metadata markers, and code fences
      if (line.startsWith('{') || line.startsWith('}') || 
          line.startsWith('```') || 
          line.includes('untrusted metadata') ||
          line.includes('message_id') ||
          line.includes('sender_id')) {
        continue;
      }
      actualMessage = line;
      break;
    }
    
    if (!actualMessage) {
      // Fallback: take last line
      actualMessage = lines[lines.length - 1] || lastUserText;
    }
    
    // Clean and limit to 200 chars
    const cleaned = actualMessage.replace(/\s+/g, " ").trim();
    return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
  } catch {
    return undefined;
  }
}

function resolveAgentState(lastActive: number, now: number): "idle" | "working" | "waiting" | "offline" {
  if (lastActive === 0) {return "offline";}
  const timeDiff = now - lastActive;
  if (timeDiff > 10 * 60 * 1000) {return "offline";}
  if (timeDiff <= 2 * 60 * 1000) {return "working";}
  return "idle";
}

// ── Core logic (extracted for reuse) ─────────────────────────────────────────

export async function getAgentActivities(): Promise<AgentActivity[]> {
  const cfg = loadConfig();
  const agentIds = listAgentIds(cfg);
  const now = Date.now();

  const agents: AgentActivity[] = await Promise.all(
    agentIds.map(async (agentId) => {
      const agentEntry = cfg.agents?.list?.find((a) => a?.id === agentId);
      const lastActive = await getAgentLastActive(agentId);
      const state = resolveAgentState(lastActive, now);

      let subagents: SubagentInfo[] | undefined;
      let currentTask: string | undefined;
      if (state !== "offline") {
        const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
        if (existsSync(sessionsDir)) {
          const list = await parseSubagents(sessionsDir, agentId);
          if (list.length > 0) {subagents = list;}
        }
        currentTask = await extractCurrentTask(agentId);
      }

      return {
        agentId,
        name: agentEntry?.name || agentId,
        emoji: agentEntry?.identity?.emoji || "🤖",
        state,
        lastActive,
        currentTask,
        subagents,
      };
    })
  );

  return agents;
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
    const agents = await getAgentActivities();
    sendJson(res, 200, { agents });
    return true;
  } catch {
    sendJson(res, 500, { error: "Internal server error" });
    return true;
  }
}
