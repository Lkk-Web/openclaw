import { OfficeState } from "../../pixel-office/engine/officeState.js";
import { renderFrame } from "../../pixel-office/engine/renderer.js";
import { loadCharacterPNGs, loadWallPNG } from "../../pixel-office/sprites/pngLoader.js";
import { syncAgentsToOffice, type AgentActivity } from "../../pixel-office/agentBridge.js";

const AGENT_POLL_INTERVAL_MS = 3000;
const ZOOM = 2.0;

export interface PixelOfficeController {
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  officeState: OfficeState | null;
  animationFrame: number | null;
  lastTime: number;
  assetsLoaded: boolean;
  agentIdMap: Map<string, number>;
  nextCharacterId: { current: number };
  pollInterval: ReturnType<typeof setInterval> | null;
  agents: AgentActivity[];
  onAgentsUpdate: ((agents: AgentActivity[]) => void) | null;
}

let controller: PixelOfficeController = {
  canvas: null,
  ctx: null,
  officeState: null,
  animationFrame: null,
  lastTime: 0,
  assetsLoaded: false,
  agentIdMap: new Map(),
  nextCharacterId: { current: 1 },
  pollInterval: null,
  agents: [],
  onAgentsUpdate: null,
};

/** Register a callback for when agent list updates (for UI rendering) */
export function onAgentsUpdate(cb: (agents: AgentActivity[]) => void) {
  controller.onAgentsUpdate = cb;
}

export function getAgents(): AgentActivity[] {
  return controller.agents;
}

async function fetchAgents(gatewayUrl?: string): Promise<AgentActivity[]> {
  try {
    // Try to build the API URL from gateway URL or use relative path
    let apiUrl = '/api/agent-activity';
    
    // If we have a gateway URL, extract port/host for our own server
    // The API is served from the same host as the UI
    const res = await fetch(apiUrl, { cache: 'no-store' });
    if (!res.ok) {return [];}
    const data = await res.json() as { agents?: AgentActivity[] };
    return data.agents || [];
  } catch {
    // In development/different deployment setups, try gateway data endpoint
    try {
      const res = await fetch('/gateway/agents/activity', { cache: 'no-store' });
      if (!res.ok) {return [];}
      const data = await res.json() as { agents?: AgentActivity[] };
      return data.agents || [];
    } catch {
      return [];
    }
  }
}

async function pollAgents() {
  const newAgents = await fetchAgents();
  if (newAgents.length > 0 || controller.agents.length > 0) {
    controller.agents = newAgents;
    
    // Sync to office state
    const office = controller.officeState;
    if (office) {
      syncAgentsToOffice(newAgents, office, controller.agentIdMap, controller.nextCharacterId);
    }
    
    // Notify UI
    if (controller.onAgentsUpdate) {
      controller.onAgentsUpdate(newAgents);
    }
  }
}

export async function initPixelOffice(canvas: HTMLCanvasElement) {
  console.log("[PixelOffice] Init started", { width: canvas.width, height: canvas.height });
  
  // Stop any existing render loop and polling
  if (controller.animationFrame) {
    cancelAnimationFrame(controller.animationFrame);
    controller.animationFrame = null;
  }
  if (controller.pollInterval) {
    clearInterval(controller.pollInterval);
    controller.pollInterval = null;
  }
  
  controller.canvas = canvas;
  controller.ctx = canvas.getContext("2d");
  
  if (!controller.ctx) {
    console.error("[PixelOffice] Failed to get 2D context from canvas");
    return;
  }
  
  console.log("[PixelOffice] Canvas context obtained");
  
  // Load sprites first
  if (!controller.assetsLoaded) {
    console.log("[PixelOffice] Loading assets...");
    try {
      await Promise.all([loadCharacterPNGs(), loadWallPNG()]);
      controller.assetsLoaded = true;
      console.log("[PixelOffice] Assets loaded");
    } catch (e) {
      console.error("[PixelOffice] Failed to load pixel office assets:", e);
      return;
    }
  } else {
    console.log("[PixelOffice] Assets already loaded");
  }
  
  // Create office state if not already created
  if (!controller.officeState) {
    console.log("[PixelOffice] Creating OfficeState...");
    controller.officeState = new OfficeState();
    console.log("[PixelOffice] OfficeState created", {
      characters: controller.officeState.getCharacters().length,
    });
  }
  
  controller.lastTime = performance.now();
  
  // Start render loop
  startRenderLoop();
  
  // Start agent polling
  await pollAgents();
  controller.pollInterval = setInterval(() => {
    void pollAgents();
  }, AGENT_POLL_INTERVAL_MS);
  
  console.log("[PixelOffice] Init complete");
}

function startRenderLoop() {
  function render(time: number) {
    if (!controller.ctx || !controller.canvas || !controller.officeState) {
      return;
    }
    
    const dt = controller.lastTime === 0 ? 0 : Math.min((time - controller.lastTime) / 1000, 0.1);
    controller.lastTime = time;
    
    const canvas = controller.canvas;
    const office = controller.officeState;
    
    // Make canvas fill its container
    const parent = canvas.parentElement;
    if (parent) {
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
    }
    
    office.update(dt);
    
    const ctx = controller.ctx;
    ctx.save();
    
    const dpr = window.devicePixelRatio || 1;
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = false;
    
    const displayW = canvas.width / dpr;
    const displayH = canvas.height / dpr;
    
    renderFrame(
      ctx,
      displayW,
      displayH,
      office.tileMap,
      office.furniture,
      office.getCharacters(),
      ZOOM,
      0, // panX
      0, // panY
      {
        selectedAgentId: office.selectedAgentId,
        hoveredAgentId: office.hoveredAgentId,
        hoveredTile: office.hoveredTile,
        seats: office.seats,
        characters: office.characters,
      },
      undefined, // editor
      office.layout.tileColors, // tileColors
      office.layout.cols,
      office.layout.rows,
      office.getBugs()
    );
    
    ctx.restore();
    controller.animationFrame = requestAnimationFrame(render);
  }
  
  controller.animationFrame = requestAnimationFrame(render);
  console.log("[PixelOffice] Render loop started");
}

export function cleanupPixelOffice() {
  if (controller.animationFrame) {
    cancelAnimationFrame(controller.animationFrame);
  }
  if (controller.pollInterval) {
    clearInterval(controller.pollInterval);
    controller.pollInterval = null;
  }
  controller.canvas = null;
  controller.ctx = null;
  controller.animationFrame = null;
  controller.lastTime = 0;
  // Keep officeState, agentIdMap, and assetsLoaded for hot-reloading
}
