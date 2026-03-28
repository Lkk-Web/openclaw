import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hashText } from "./internal.js";

const log = createSubsystemLogger("memory");

/** Fields to extract from message metadata for indexing */
const METADATA_FIELDS = [
  "replied_message",
  "context",
  "details",
  "parentId",
  "provenance",
];

export type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
  /** Maps each content line (0-indexed) to its 1-indexed JSONL source line. */
  lineMap: number[];
  /** Extracted metadata text for indexing */
  metadataText?: string;
};

export async function listSessionFilesForAgent(agentId: string): Promise<string[]> {
  const dir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function sessionPathForFile(absPath: string): string {
  return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
}

function normalizeSessionText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = normalizeSessionText(content);
    return normalized ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const normalized = normalizeSessionText(record.text);
    if (normalized) {
      parts.push(normalized);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

/**
 * Extract text from message metadata fields (replied_message, context, details, etc.)
 * This enables searching information that appears in message metadata but not in content.
 */
export function extractMessageMetadata(record: unknown): string | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  const message = (record as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    return null;
  }

  const msg = message as Record<string, unknown>;
  const metadataParts: string[] = [];

  // Extract from top-level record fields (e.g., parentId)
  for (const key of METADATA_FIELDS) {
    const value = (record as Record<string, unknown>)[key] ?? msg[key];
    if (value !== undefined && value !== null) {
      // Skip replied_message here as we handle it specially below
      if (key === "replied_message") {
        continue;
      }
      const extracted = extractValueAsText(key, value);
      if (extracted) {
        metadataParts.push(extracted);
      }
    }
  }

  // Handle replied_message.body specifically (common pattern)
  const repliedMessage = msg["replied_message"];
  if (repliedMessage && typeof repliedMessage === "object") {
    const replied = repliedMessage as Record<string, unknown>;
    if (typeof replied.body === "string" && replied.body.trim()) {
      const normalized = normalizeSessionText(replied.body);
      if (normalized) {
        metadataParts.push(`Reply: ${normalized}`);
      }
    }
  }

  if (metadataParts.length === 0) {
    return null;
  }
  return metadataParts.join(" ");
}

/**
 * Extract text from a metadata value, handling various types
 */
function extractValueAsText(key: string, value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  // String values
  if (typeof value === "string") {
    const normalized = normalizeSessionText(value);
    return normalized ? `${key}: ${normalized}` : null;
  }

  // Number values
  if (typeof value === "number" || typeof value === "boolean") {
    return `${key}: ${value}`;
  }

  // Object values (e.g., details, provenance)
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];

    // Common text fields in metadata objects
    const textFields = ["body", "text", "content", "message", "description", "path", "command"];
    for (const field of textFields) {
      if (typeof obj[field] === "string" && obj[field]) {
        parts.push(normalizeSessionText(obj[field] as string));
      }
    }

    // Also extract any string values that look like paths
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && (v.startsWith("/") || v.startsWith("~") || v.includes(":\\"))) {
        parts.push(`${k}: ${v}`);
      }
    }

    if (parts.length > 0) {
      return `${key}: ${parts.join(", ")}`;
    }

    // Fallback: stringify the object (truncated)
    const str = JSON.stringify(value);
    if (str && str.length < 500) {
      return `${key}: ${str}`;
    }
  }

  return null;
}

export async function buildSessionEntry(absPath: string): Promise<SessionFileEntry | null> {
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    const collected: string[] = [];
    const metadataCollected: string[] = [];
    const lineMap: number[] = [];
    for (let jsonlIdx = 0; jsonlIdx < lines.length; jsonlIdx++) {
      const line = lines[jsonlIdx];
      if (!line.trim()) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !record ||
        typeof record !== "object" ||
        (record as { type?: unknown }).type !== "message"
      ) {
        continue;
      }
      const message = (record as { message?: unknown }).message as
        | { role?: unknown; content?: unknown }
        | undefined;
      if (!message || typeof message.role !== "string") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text = extractSessionText(message.content);
      if (!text) {
        continue;
      }
      const safe = redactSensitiveText(text, { mode: "tools" });
      const label = message.role === "user" ? "User" : "Assistant";
      collected.push(`${label}: ${safe}`);

      // Extract metadata for indexing
      const metadataText = extractMessageMetadata(record);
      if (metadataText) {
        const safeMetadata = redactSensitiveText(metadataText, { mode: "tools" });
        metadataCollected.push(safeMetadata);
      }

      lineMap.push(jsonlIdx + 1);
    }
    const content = collected.join("\n");
    const metadataContent = metadataCollected.join("\n");

    // Combine content with metadata for indexing
    const fullContent = metadataContent
      ? `${content}\n\n[Metadata]\n${metadataContent}`
      : content;

    return {
      path: sessionPathForFile(absPath),
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(fullContent + "\n" + lineMap.join(",")),
      content: fullContent,
      lineMap,
      metadataText: metadataContent || undefined,
    };
  } catch (err) {
    log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
    return null;
  }
}
