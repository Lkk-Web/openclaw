import type { IncomingMessage, ServerResponse } from "node:http";
import { getAgentActivities } from "./agent-activity-http.js";

const clients = new Set<ServerResponse>();

export function handleTaskPanelStream(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/task-panel/stream") return false;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
  });

  return true;
}

export async function broadcastTaskUpdate() {
  if (clients.size === 0) return;

  try {
    const agents = await getAgentActivities();
    const data = JSON.stringify({ agents, timestamp: Date.now() });
    
    for (const client of clients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  } catch (error) {
    console.error("[task-panel-stream] Broadcast error:", error);
  }
}

// 启动定时广播
setInterval(broadcastTaskUpdate, 2000);
