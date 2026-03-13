import { html } from "lit";
import { ref } from "lit/directives/ref.js";
import type { AgentActivity } from "../../pixel-office/agentBridge.js";

export type PixelOfficeProps = {
  agents?: AgentActivity[];
  onRefresh?: () => void;
};

let _agents: AgentActivity[] = [];
let _forceRerender: (() => void) | null = null;

/** Called from controller when agents update */
export function setPixelOfficeAgents(agents: AgentActivity[]) {
  _agents = agents;
  if (_forceRerender) {
    _forceRerender();
  }
}

export function getPixelOfficeAgents(): AgentActivity[] {
  return _agents;
}

/**
 * Mirrors displayAgents from page.tsx:
 *   for each agent push agent + expand subagents as synthetic entries
 */
function buildDisplayAgents(rawAgents: AgentActivity[]): AgentActivity[] {
  const result: AgentActivity[] = [];
  for (const agent of rawAgents) {
    result.push(agent);
    if (!agent.subagents?.length) {continue;}
    for (const sub of agent.subagents) {
      const subKey = sub.sessionKey ? `${sub.sessionKey}::${sub.toolId}` : sub.toolId;
      result.push({
        agentId: `subagent:${agent.agentId}:${subKey}`,
        name: `临时工 ${agent.agentId}`,
        emoji: agent.emoji,
        state: "working",
        lastActive: agent.lastActive,
      });
    }
  }
  return result;
}

/**
 * renderAgentChip — exact copy from page.tsx renderAgentChip (desktop, non-grid).
 */
function renderAgentChip(agent: AgentActivity) {
  const isTempWorker = agent.agentId.startsWith("subagent:");
  const parentAgentIdFromKey = isTempWorker ? (agent.agentId.split(":")[1] || "") : "";
  const tempWorkerOwner = isTempWorker
    ? agent.name.replace(/^临时工\s*/, "") || parentAgentIdFromKey
    : "";
  const chipTooltip = isTempWorker
    ? `${tempWorkerOwner} 创建的临时工`
    : `agent id：${agent.agentId}`;

  const chipToneClass = isTempWorker
    ? "pixel-agent-chip-tempworker animate-pulse"
    : agent.state === "working"
    ? "pixel-agent-chip-working animate-pulse"
    : agent.state === "idle"
    ? "pixel-agent-chip-idle animate-pulse"
    : "pixel-agent-chip-neutral";

  const animStyle =
    agent.state === "working" || isTempWorker
      ? `animation-duration:${isTempWorker ? "0.9s" : "1.3s"}`
      : "";

  return html`
    <div class="group relative" style="overflow:visible">
      <div
        class="pixel-agent-chip ${chipToneClass}"
        title="${chipTooltip}"
        aria-label="${chipTooltip}"
        style="${animStyle}"
      >
        <span>${agent.emoji}</span>

        ${isTempWorker
          ? html`
              <span style="min-width:0;display:flex;flex-direction:column;justify-content:center;max-width:5.8rem;line-height:1">
                <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">临时工</span>
                <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${tempWorkerOwner}</span>
              </span>
            `
          : html`<span>${agent.name}</span>`}
        ${agent.state === "working"
          ? html`<span class="pixel-agent-chip-state ${isTempWorker ? "" : "text-green-200"}" style="text-transform:uppercase;letter-spacing:0.05em;font-size:10px">${isTempWorker ? "working" : "工作中"}</span>`
          : agent.state === "idle"
          ? html`<span class="pixel-agent-chip-state" style="text-transform:uppercase;letter-spacing:0.05em;font-size:10px">空闲</span>`
          : agent.state === "offline"
          ? html`<span class="pixel-agent-chip-state" style="text-transform:uppercase;letter-spacing:0.05em;font-size:10px">下班了</span>`
          : agent.state === "waiting"
          ? html`<span class="pixel-agent-chip-state" style="text-transform:uppercase;letter-spacing:0.05em;font-size:10px">等待中</span>`
          : ""}
      </div>
    </div>
  `;
}

export function renderPixelOffice(props: PixelOfficeProps) {
  const rawAgents = props.agents ?? _agents;

  // Track the refresh callback for later agent updates
  if (props.onRefresh) {
    _forceRerender = props.onRefresh;
  }

  const displayAgents = buildDisplayAgents(rawAgents);

  return html`
    <div class="pixel-office-view">
      <div class="pixel-office-header">
        <div class="pixel-office-header-row">
          <span class="pixel-office-title">OpenClaw Agents办公室</span>
        </div>
        <div class="pixel-office-agents">
          ${displayAgents.length > 0
            ? displayAgents.map(renderAgentChip)
            : html`<div class="pixel-office-no-agents">暂无 Agent</div>`}
        </div>
      </div>

      <div class="pixel-office-canvas-wrapper">
        <canvas
          ${ref((canvas) => {
            if (canvas instanceof HTMLCanvasElement) {
              import("../controllers/pixel-office.ts").then(({ initPixelOffice, onAgentsUpdate }) => {
                initPixelOffice(canvas);

                // Register callback to trigger re-render when agents update
                onAgentsUpdate((newAgents) => {
                  _agents = newAgents;
                  if (_forceRerender) {
                    _forceRerender();
                  }
                });
              });
            }
          })}
          id="pixel-office-canvas"
        ></canvas>
      </div>
    </div>
  `;
}
