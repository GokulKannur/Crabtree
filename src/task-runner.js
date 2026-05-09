// ============================================
// CRAB TREE — Task Runner
// Terminal-like command execution panel model.
// ============================================

import { invoke } from '@tauri-apps/api/core';

const TASKS_KEY = 'crabtree-task-templates-v1';
const LAST_TASK_KEY = 'crabtree-last-task';

const DEFAULT_TASKS = [
  { id: 'task:test', label: 'Run Tests', command: 'npm', args: ['test'] },
  { id: 'task:benchmark', label: 'Run Benchmarks (Quick)', command: 'npm', args: ['run', 'benchmark:quick'] },
  { id: 'task:build', label: 'Build Frontend', command: 'npm', args: ['run', 'build'] },
];

function normalizeTask(task) {
  if (!task || !task.id || !task.label || !task.command) return null;
  return {
    id: String(task.id),
    label: String(task.label),
    command: String(task.command),
    args: Array.isArray(task.args) ? task.args.map((a) => String(a)) : [],
    cwd: task.cwd ? String(task.cwd) : null,
    env: task.env && typeof task.env === 'object' ? task.env : {},
  };
}

function loadTemplates() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TASKS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [...DEFAULT_TASKS];
    const valid = parsed.map(normalizeTask).filter(Boolean);
    return valid.length > 0 ? valid : [...DEFAULT_TASKS];
  } catch {
    return [...DEFAULT_TASKS];
  }
}

function saveTemplates(tasks) {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
}

export class TaskRunner {
  constructor() {
    this.tasks = loadTemplates();
    this.history = [];
    this.isRunning = false;
  }

  getTemplates() {
    return [...this.tasks];
  }

  upsertTask(task) {
    const normalized = normalizeTask(task);
    if (!normalized) throw new Error('Invalid task template');
    const idx = this.tasks.findIndex((t) => t.id === normalized.id);
    if (idx >= 0) this.tasks[idx] = normalized;
    else this.tasks.push(normalized);
    saveTemplates(this.tasks);
  }

  removeTask(id) {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    saveTemplates(this.tasks);
  }

  getLastTaskId() {
    return localStorage.getItem(LAST_TASK_KEY) || '';
  }

  async runTask(task, fallbackCwd = null) {
    if (this.isRunning) throw new Error('A task is already running');
    const normalized = normalizeTask(task);
    if (!normalized) throw new Error('Invalid task');

    this.isRunning = true;
    localStorage.setItem(LAST_TASK_KEY, normalized.id);
    try {
      const result = await invoke('run_task', {
        command: normalized.command,
        args: normalized.args,
        cwd: normalized.cwd || fallbackCwd,
        env: normalized.env,
      });
      const event = {
        ...result,
        task: normalized,
        timestamp: new Date().toISOString(),
      };
      this.history.unshift(event);
      if (this.history.length > 100) this.history.length = 100;
      return event;
    } finally {
      this.isRunning = false;
    }
  }
}
