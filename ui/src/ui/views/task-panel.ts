import { html, nothing, render } from "lit";
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

interface TaskPanelData {
  tasks: TaskInfo[];
  stats: { total: number; running: number; completed: number; pending: number; failed: number };
}

// ── 状态 ──────────────────────────────────────────────────────────────
let currentData: TaskPanelData | null = null;
let filter: "all" | "running" | "completed" | "failed" = "all";
let searchQuery = "";
let currentPage = 1;
const PAGE_SIZE = 10;
let refreshInterval: ReturnType<typeof setInterval> | null = null;
let isActive = false;
// 内部渲染容器（task-panel-view 内部），只用于内容更新
let innerContainer: HTMLElement | null = null;

// ── localStorage（仅存 id+时间，精简） ────────────────────────────────
const STORAGE_KEY = "openclaw-completed-tasks";
const THREE_DAYS_MS = 259200000;
const MAX_STORED = 50;

interface StoredTask { id: string; at: number; }

function getStoredIds(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr: StoredTask[] = JSON.parse(raw);
    return new Set(arr.map(t => t.id));
  } catch { return new Set(); }
}

function saveTaskId(taskId: string) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    let arr: StoredTask[] = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    // 清理 3 天前的
    arr = arr.filter(t => now - t.at < THREE_DAYS_MS);
    if (!arr.find(t => t.id === taskId)) {
      arr.push({ id: taskId, at: now });
    }
    // 只保留最近 MAX_STORED 个
    if (arr.length > MAX_STORED) arr = arr.slice(-MAX_STORED);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    } catch {
      // 配额超限：清空后重试
      localStorage.removeItem(STORAGE_KEY);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: taskId, at: now }])); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ── 数据获取 ───────────────────────────────────────────────────────────
async function fetchTasks(): Promise<TaskPanelData> {
  const res = await fetch("/api/task-panel");
  const data: TaskPanelData = await res.json();

  // 记录新完成的任务 id
  const prevIds = new Set((currentData?.tasks || []).filter(t => t.status === "completed").map(t => t.taskId));
  data.tasks.forEach(task => {
    if (task.status === "completed" && !prevIds.has(task.taskId)) {
      saveTaskId(task.taskId);
    }
  });

  return data;
}

// ── 辅助 ──────────────────────────────────────────────────────────────
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function getStatusChipClass(status: string): string {
  switch (status) {
    case "running":   return "chip-warning";
    case "completed": return "chip-ok";
    case "pending":   return "chip";
    case "failed":    return "chip-danger";
    default:          return "chip";
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "running":   return "运行中";
    case "completed": return "已完成";
    case "pending":   return "等待中";
    case "failed":    return "失败";
    default:          return "未知";
  }
}

function parseSteps(text: string): string {
  return text.replace(/^(\s*)([-*]|\d+\.)\s+(.+)$/gm, (_match, indent, marker, content) => {
    const trimmed = content.trim();
    if (/^[✅⏳⭕]/.test(trimmed)) return `${indent}${marker} ${trimmed}`;
    let icon = "⭕";
    if (/已完成|完成|✅/.test(trimmed)) icon = "✅";
    else if (/进行中|正在/.test(trimmed)) icon = "⏳";
    return `${indent}${marker} ${icon} ${trimmed}`;
  });
}

function renderTask(task: TaskInfo) {
  const filteredEvents = task.events.slice(-2);
  const parsedTaskName = parseSteps(task.taskName);
  const lines = parsedTaskName.split("\n");
  const isLong = lines.length > 3;
  const preview = lines.slice(0, 3).join("\n");

  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${task.agentEmoji} ${task.agentName}</div>
        ${isLong ? html`
          <details class="task-details">
            <summary class="task-summary">
              <div class="list-sub">${unsafeHTML(toSanitizedMarkdownHtml(preview))}</div>
            </summary>
            <div class="task-full list-sub">${unsafeHTML(toSanitizedMarkdownHtml(lines.slice(3).join("\n")))}</div>
          </details>
        ` : html`
          <div class="list-sub">${unsafeHTML(toSanitizedMarkdownHtml(parsedTaskName))}</div>
        `}
        ${filteredEvents.length > 0 ? html`
          <div class="chip-row" style="margin-top:6px;">
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

// ── 只渲染内容（不含外层容器），注入到 innerContainer ─────────────────
function renderContent() {
  if (!innerContainer) return;
  const tasks = currentData?.tasks || [];
  const filteredTasks = tasks
    .filter(t => filter === "all" || t.status === filter)
    .filter(t => !searchQuery || t.taskName.toLowerCase().includes(searchQuery.toLowerCase()));
  const totalPages = Math.ceil(filteredTasks.length / PAGE_SIZE);
  const paginatedTasks = filteredTasks.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const stats = currentData?.stats || { total: 0, running: 0, completed: 0, pending: 0, failed: 0 };

  render(html`
    <section class="card task-summary-strip">
      <div class="task-summary-strip__left">
        <div class="task-summary-item">
          <div class="task-summary-label">总任务</div>
          <div class="task-summary-value">${stats.total}</div>
        </div>
        <div class="task-summary-item">
          <div class="task-summary-label">运行中</div>
          <div class="task-summary-value"><span class="chip chip-warning">${stats.running}</span></div>
        </div>
        <div class="task-summary-item">
          <div class="task-summary-label">已完成</div>
          <div class="task-summary-value"><span class="chip chip-ok">${stats.completed}</span></div>
        </div>
        <div class="task-summary-item">
          <div class="task-summary-label">失败</div>
          <div class="task-summary-value"><span class="chip chip-danger">${stats.failed}</span></div>
        </div>
      </div>
      <div class="task-summary-strip__actions">
        <button class="btn" @click=${async () => {
          currentData = await fetchTasks();
          renderContent();
        }}>刷新</button>
      </div>
    </section>

    <section class="card">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:12px;">
        <div>
          <div class="card-title">任务列表</div>
          <div class="card-sub">查看和管理所有任务</div>
        </div>
        <div class="muted">显示 ${filteredTasks.length} / ${stats.total} 个任务</div>
      </div>
      <div class="filters" style="margin-top:12px;display:flex;gap:12px;align-items:flex-end;">
        <label class="field">
          <span>状态筛选</span>
          <select .value=${filter} @change=${(e: Event) => {
            filter = (e.target as HTMLSelectElement).value as typeof filter;
            currentPage = 1;
            renderContent();
          }}>
            <option value="all">全部 (${stats.total})</option>
            <option value="running">运行中 (${stats.running})</option>
            <option value="completed">已完成 (${stats.completed})</option>
            <option value="failed">失败 (${stats.failed})</option>
          </select>
        </label>
        <label class="field" style="flex:1;">
          <span>搜索任务</span>
          <input
            type="text"
            placeholder="搜索任务名称..."
            .value=${searchQuery}
            @input=${(e: Event) => {
              searchQuery = (e.target as HTMLInputElement).value;
              currentPage = 1;
              renderContent();
            }}
          />
        </label>
      </div>
      ${filteredTasks.length > 0 ? html`
        <div class="list" style="margin-top:12px;">${paginatedTasks.map(renderTask)}</div>
        ${totalPages > 1 ? html`
          <div style="display:flex;justify-content:center;align-items:center;gap:12px;margin-top:12px;">
            <button class="btn" ?disabled=${currentPage === 1} @click=${() => { currentPage--; renderContent(); }}>上一页</button>
            <span class="muted">第 ${currentPage} / ${totalPages} 页</span>
            <button class="btn" ?disabled=${currentPage === totalPages} @click=${() => { currentPage++; renderContent(); }}>下一页</button>
          </div>
        ` : nothing}
      ` : html`<div class="muted" style="margin-top:12px;">暂无任务</div>`}
    </section>
  `, innerContainer);
}

// ── 启动 / 停止 ────────────────────────────────────────────────────────
function startTaskPanel(container: HTMLElement) {
  isActive = true;
  innerContainer = container;

  fetchTasks().then(data => {
    if (!isActive) return;
    currentData = data;
    renderContent();

    if (refreshInterval === null) {
      refreshInterval = setInterval(async () => {
        if (!isActive) { stopTaskPanel(); return; }
        try {
          currentData = await fetchTasks();
          renderContent();
        } catch { /* ignore */ }
      }, 30000);
    }
  }).catch(() => { /* ignore fetch error on start */ });
}

function stopTaskPanel() {
  isActive = false;
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  innerContainer = null;
  currentData = null;
  filter = "all";
  searchQuery = "";
  currentPage = 1;
}

export function cleanupTaskPanel() {
  stopTaskPanel();
}

// ── 外层容器（只渲染一次，不会因 renderContent 重建）──────────────────
export function renderTaskPanel() {
  // 停止旧实例
  stopTaskPanel();

  // 返回一个稳定的外层容器，内部通过 startTaskPanel 动态填充
  const wrapper = document.createElement("div");
  wrapper.className = "task-panel-view";

  // 用 setTimeout 等 wrapper 挂载到 DOM 后再启动
  setTimeout(() => {
    if (document.contains(wrapper)) {
      startTaskPanel(wrapper);
    }
  }, 0);

  // 监听卸载
  const observer = new MutationObserver(() => {
    if (!document.contains(wrapper)) {
      stopTaskPanel();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return wrapper;
}
