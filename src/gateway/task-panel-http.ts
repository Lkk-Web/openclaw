import type { IncomingMessage, ServerResponse } from "node:http";
import { getAgentActivities, type AgentActivity, type SubagentInfo } from "./agent-activity-http.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

// Task Panel Types
export type TaskStatus = "running" | "completed" | "pending" | "failed";

export interface TaskEvent {
  key: string;
  text: string;
  at: number;
}

export interface TaskInfo {
  taskId: string;
  taskName: string;
  status: TaskStatus;
  agentId: string;
  agentName: string;
  agentEmoji: string;
  startTime: number;
  duration: number; // milliseconds
  events: TaskEvent[];
  isSubagent: boolean;
}

export interface TaskPanelResponse {
  tasks: TaskInfo[];
  stats: {
    total: number;
    running: number;
    completed: number;
    pending: number;
    failed: number;
  };
}

// Map agent state to task status
function mapStateToStatus(state: AgentActivity["state"]): TaskStatus {
  switch (state) {
    case "working":
      return "running";
    case "idle":
      return "completed";
    case "waiting":
      return "pending";
    case "offline":
      return "completed";
    default:
      return "completed";
  }
}



// Extract task name from subagent label or events
function extractTaskName(subagent: SubagentInfo, agent: AgentActivity): string {
  let taskName = "";
  
  // Use label if available
  if (subagent.label && subagent.label !== "Subtask") {
    // 返回完整的 label，不只是第一行
    taskName = subagent.label;
  } else if (subagent.activityEvents && subagent.activityEvents.length > 0) {
    // Try to extract from activity events
    const firstEvent = subagent.activityEvents[0];
    if (firstEvent.text.startsWith("task:")) {
      taskName = firstEvent.text.substring(5).trim();
    }
  }

  // Fallback
  if (!taskName) {
    return `${agent.name} 的临时工`;
  }

  return taskName;
}

// Calculate duration from events
function calculateDuration(events: TaskEvent[]): number {
  if (!events || events.length === 0) {
    return 0;
  }

  const timestamps = events.map(e => e.at).filter(t => t > 0);
  if (timestamps.length === 0) {
    return 0;
  }

  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  return max - min;
}

// Get start time from events
function getStartTime(events: TaskEvent[]): number {
  if (!events || events.length === 0) {
    return Date.now();
  }

  const timestamps = events.map(e => e.at).filter(t => t > 0);
  if (timestamps.length === 0) {
    return Date.now();
  }

  return Math.min(...timestamps);
}

// Transform subagents into tasks
function transformSubagentToTasks(agent: AgentActivity, allAgents: AgentActivity[]): TaskInfo[] {
  if (!agent.subagents || agent.subagents.length === 0) {
    return [];
  }

  const now = Date.now();
  const SUBAGENT_IDLE_THRESHOLD = 30 * 1000; // 30 seconds

  return agent.subagents.map(sub => {
    const taskId = sub.childSessionKey
      ? sub.childSessionKey.replace(/^agent:[^:]+:subagent:/, "task-")
      : `task-${sub.toolId}`;

    // Use activityEvents directly from agent-activity API
    const events = sub.activityEvents || [];

    let status: TaskStatus = "running";
    if (events.length > 0) {
      const lastEventTime = Math.max(...events.map(e => e.at));
      if (now - lastEventTime > SUBAGENT_IDLE_THRESHOLD) {
        status = "completed";
      }
    }

    // Extract real agentId from childSessionKey
    let realAgentId = agent.agentId;
    let realAgentName = agent.name;
    let realAgentEmoji = agent.emoji;
    
    if (sub.childSessionKey) {
      const parts = sub.childSessionKey.split(':');
      if (parts.length >= 2 && parts[0] === 'agent') {
        realAgentId = parts[1];
        const realAgent = allAgents.find(a => a.agentId === realAgentId);
        if (realAgent) {
          realAgentName = realAgent.name;
          realAgentEmoji = realAgent.emoji;
        }
      }
    }

    const filteredEvents = events.filter(e => !e.text.startsWith('task:'));
    
    return {
      taskId,
      taskName: extractTaskName(sub, agent),
      status,
      agentId: realAgentId,
      agentName: realAgentName,
      agentEmoji: realAgentEmoji,
      startTime: getStartTime(events),
      duration: calculateDuration(events),
      events: filteredEvents,
      isSubagent: true,
    };
  });
}

// Transform main agent activity to task (if active)
function transformAgentToTask(agent: AgentActivity): TaskInfo | null {
  // Skip offline agents
  if (agent.state === "offline") {
    return null;
  }

  // Skip idle agents (no active task)
  if (agent.state === "idle") {
    return null;
  }

  // Extract task name from currentTask field
  const taskName = agent.currentTask?.trim();
  
  // Return null if no valid task name
  if (!taskName) {
    return null;
  }

  return {
    taskId: `agent-${agent.agentId}`,
    taskName,
    status: mapStateToStatus(agent.state),
    agentId: agent.agentId,
    agentName: agent.name,
    agentEmoji: agent.emoji,
    startTime: agent.lastActive,
    duration: Date.now() - agent.lastActive,
    events: [],
    isSubagent: false,
  };
}

// HTTP handler
export async function handleTaskPanelHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/task-panel") {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  try {
    const agents = await getAgentActivities();
    const tasks: TaskInfo[] = [];
    
    for (const agent of agents) {
      const mainTask = transformAgentToTask(agent);
      if (mainTask) {
        tasks.push(mainTask);
      }

      const subagentTasks = await transformSubagentToTasks(agent, agents);
      tasks.push(...subagentTasks);
    }

    // Calculate stats
    const stats = {
      total: tasks.length,
      running: tasks.filter(t => t.status === "running").length,
      completed: tasks.filter(t => t.status === "completed").length,
      pending: tasks.filter(t => t.status === "pending").length,
      failed: tasks.filter(t => t.status === "failed").length,
    };

    // Send response
    sendJson(res, 200, { tasks, stats });
    return true;
  } catch (error) {
    console.error("[task-panel] Error:", error);
    sendJson(res, 500, { error: "Internal server error" });
    return true;
  }
}
