import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../markdown.js";

interface TaskEvent {
  key: string;
  text: string;
  at: number;
}

interface TaskInfo {
  taskId: string;
  taskName: string;
  status: "running" | "completed" | "pending" | "failed";
  agentId: string;
  agentName: string;
  agentEmoji: string;
  startTime: number;
  duration: number;
  events: TaskEvent[];
  isSubagent: boolean;
}

interface CompletedTask {
  taskId: string;
  taskName: string;
  agentId: string;
  agentName: string;
  agentEmoji: string;
  completedAt: number;
  duration: number;
}

interface TaskPanelData {
  tasks: TaskInfo[];
  stats: { total: number; running: number; completed: number; pending: number; failed: number };
}

let currentData: TaskPanelData | null = null;
let filter: "all" | "running" | "completed" | "failed" = "running";
let searchQuery = "";
let currentPage = 1;
const PAGE_SIZE = 10;
let refreshInterval: number | null = null;
let eventSource: EventSource | null = null;

const STORAGE_KEY = "openclaw-completed-tasks";
const THREE_DAYS_MS = 259200000;

function getCompletedTasks(): CompletedTask[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveCompletedTask(task: TaskInfo) {
  const tasks = getCompletedTasks();
  const completed: CompletedTask = {
    taskId: task.taskId,
    taskName: task.taskName,
    agentId: task.agentId,
    agentName: task.agentName,
    agentEmoji: task.agentEmoji,
    completedAt: Date.now(),
    duration: task.duration
  };
  tasks.push(completed);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function cleanOldTasks() {
  const tasks = getCompletedTasks();
  const now = Date.now();
  const filtered = tasks.filter(t => now - t.completedAt < THREE_DAYS_MS);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

async function fetchTasks(): Promise<TaskPanelData> {
  cleanOldTasks();
  const res = await fetch("/api/task-panel");
  const data: TaskPanelData = await res.json();
  
  // 保存新完成的任务
  const prevTasks = currentData?.tasks || [];
  data.tasks.forEach(task => {
    if (task.status === "completed") {
      const prev = prevTasks.find(t => t.taskId === task.taskId);
      if (!prev || prev.status !== "completed") {
        saveCompletedTask(task);
      }
    }
  });
  
  // 合并 localStorage 中的已完成任务
  const stored = getCompletedTasks();
  const storedTaskIds = new Set(data.tasks.map(t => t.taskId));
  const storedTasks: TaskInfo[] = stored
    .filter(t => !storedTaskIds.has(t.taskId))
    .map(t => ({
      ...t,
      status: "completed" as const,
      startTime: t.completedAt - t.duration,
      events: [],
      isSubagent: false
    }));
  
  data.tasks = [...data.tasks, ...storedTasks];
  data.stats.total = data.tasks.length;
  data.stats.completed = data.tasks.filter(t => t.status === "completed").length;
  
  return data;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) {return `${minutes}m ${seconds % 60}s`;}
  return `${seconds}s`;
}

function getStatusChipClass(status: string): string {
  switch (status) {
    case "running": return "chip-warning";
    case "completed": return "chip-ok";
    case "pending": return "chip";
    case "failed": return "chip-danger";
    default: return "chip";
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "running": return "运行中";
    case "completed": return "已完成";
    case "pending": return "等待中";
    case "failed": return "失败";
    default: return "未知";
  }
}

function truncateTaskName(name: string): string {
  const lines = name.split('\n');
  if (lines.length <= 3) {return name;}
  return lines.slice(0, 3).join('\n') + '\n...';
}

function parseSteps(text: string): string {
  return text.replace(/^(\s*)([-*]|\d+\.)\s+(.+)$/gm, (match, indent, marker, content) => {
    const trimmed = content.trim();
    
    // 如果已经有图标，保持原样
    if (/^[✅⏳⭕]/.test(trimmed)) {
      return match;
    }
    
    // 根据关键词添加图标
    let icon = '⭕';
    if (/已完成|完成|✅/.test(trimmed)) {
      icon = '✅';
    } else if (/进行中|正在/.test(trimmed)) {
      icon = '⏳';
    }
    
    // 保留原有的缩进和标记，只在内容前添加图标
    return `${indent}${marker} ${icon} ${trimmed}`;
  });
}

function renderTask(task: TaskInfo) {
  const filteredEvents = task.events.slice(-2);
  const parsedTaskName = parseSteps(task.taskName);
  const lines = parsedTaskName.split('\n');
  const isLong = lines.length > 3;
  const preview = lines.slice(0, 3).join('\n');
  
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${task.agentEmoji} ${task.agentName}</div>
        ${isLong ? html`
          <details class="task-details">
            <summary class="task-summary">
              <div class="list-sub">${unsafeHTML(toSanitizedMarkdownHtml(preview))}</div>
            </summary>
            <div class="task-full list-sub">${unsafeHTML(toSanitizedMarkdownHtml(lines.slice(3).join('\n')))}</div>
          </details>
        ` : html`
          <div class="list-sub">${unsafeHTML(toSanitizedMarkdownHtml(parsedTaskName))}</div>
        `}
        ${filteredEvents.length > 0 ? html`
          <div class="chip-row" style="margin-top: 6px;">
            ${filteredEvents.map(e => html`<span class="chip muted">${unsafeHTML(toSanitizedMarkdownHtml(e.text))}</span>`)}
          </div>
        ` : nothing}
      </div>
      <div class="list-meta">
        <div class="chip-row">
          <span class=${`chip ${getStatusChipClass(task.status)}`}>${getStatusLabel(task.status)}</span>
          ${task.isSubagent ? html`<span class="chip">子任务</span>` : nothing}
        </div>
        <div class="muted">${formatDuration(task.duration)}</div>
      </div>
    </div>
  `;
}

export function renderTaskPanel() {
  const tasks = currentData?.tasks || [];
  const filteredTasks = tasks
    .filter(t => filter === "all" || t.status === filter)
    .filter(t => !searchQuery || t.taskName.toLowerCase().includes(searchQuery.toLowerCase()));
  const totalPages = Math.ceil(filteredTasks.length / PAGE_SIZE);
  const paginatedTasks = filteredTasks.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const stats = currentData?.stats || { total: 0, running: 0, completed: 0, pending: 0, failed: 0 };

  return html`
    <div class="task-panel-view" ${ref(async (el) => {
      if (el instanceof HTMLElement) {
        // Initial fetch
        currentData = await fetchTasks();
        el.querySelector(".task-list")?.requestUpdate?.();
        
        // Start polling
        if (!refreshInterval) {
          refreshInterval = window.setInterval(async () => {
            currentData = await fetchTasks();
            el.querySelector(".task-list")?.requestUpdate?.();
          }, 3000);
        }
      }
    })}>
      <section class="card task-summary-strip">
        <div class="task-summary-strip__left">
          <div class="task-summary-item">
            <div class="task-summary-label">总任务</div>
            <div class="task-summary-value">${stats.total}</div>
          </div>
          <div class="task-summary-item">
            <div class="task-summary-label">运行中</div>
            <div class="task-summary-value">
              <span class="chip chip-warning">${stats.running}</span>
            </div>
          </div>
          <div class="task-summary-item">
            <div class="task-summary-label">已完成</div>
            <div class="task-summary-value">
              <span class="chip chip-ok">${stats.completed}</span>
            </div>
          </div>
          <div class="task-summary-item">
            <div class="task-summary-label">失败</div>
            <div class="task-summary-value">
              <span class="chip chip-danger">${stats.failed}</span>
            </div>
          </div>
        </div>
        <div class="task-summary-strip__actions">
          <button class="btn" @click=${async () => { currentData = await fetchTasks(); }}>刷新</button>
        </div>
      </section>

      <section class="card">
        <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 12px;">
          <div>
            <div class="card-title">任务列表</div>
            <div class="card-sub">查看和管理所有任务</div>
          </div>
          <div class="muted">显示 ${filteredTasks.length} / ${stats.total} 个任务</div>
        </div>
        <div class="filters" style="margin-top: 12px; display: flex; gap: 12px; align-items: flex-end;">
          <label class="field">
            <span>状态筛选</span>
            <select .value=${filter} @change=${(e: Event) => { filter = (e.target as HTMLSelectElement).value as typeof filter; currentPage = 1; }}>
              <option value="all">全部 (${stats.total})</option>
              <option value="running">运行中 (${stats.running})</option>
              <option value="completed">已完成 (${stats.completed})</option>
              <option value="failed">失败 (${stats.failed})</option>
            </select>
          </label>
          <label class="field" style="flex: 1;">
            <span>搜索任务</span>
            <input 
              type="text" 
              placeholder="搜索任务名称..." 
              .value=${searchQuery}
              @input=${(e: Event) => {
                searchQuery = (e.target as HTMLInputElement).value;
                currentPage = 1;
              }}
            />
          </label>
        </div>
        ${filteredTasks.length > 0 
          ? html`
            <div class="list" style="margin-top: 12px;">${paginatedTasks.map(renderTask)}</div>
            ${totalPages > 1 ? html`
              <div style="display: flex; justify-content: center; align-items: center; gap: 12px; margin-top: 12px;">
                <button 
                  class="btn" 
                  ?disabled=${currentPage === 1}
                  @click=${() => { currentPage--; }}
                >上一页</button>
                <span class="muted">第 ${currentPage} / ${totalPages} 页</span>
                <button 
                  class="btn" 
                  ?disabled=${currentPage === totalPages}
                  @click=${() => { currentPage++; }}
                >下一页</button>
              </div>
            ` : nothing}
          `
          : html`<div class="muted" style="margin-top: 12px;">暂无任务</div>`
        }
      </section>
    </div>
  `;
}
