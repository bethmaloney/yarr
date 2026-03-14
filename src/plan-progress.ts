/**
 * Utilities for parsing plan markdown to extract task progress (checklist completion).
 */

export interface TaskProgress {
  number: number;
  title: string;
  total: number;
  completed: number;
}

export interface PlanProgress {
  tasks: TaskProgress[];
  totalItems: number;
  completedItems: number;
  currentTask: TaskProgress | null;
}

const TASK_HEADING_RE = /^#{2,3}\s+(?:Task\s+)?(\d+)[:\s\u2014\u2013-]*(.*)$/i;
const CHECKLIST_RE = /^[\s]*- \[([ xX])\]/;

export function parsePlanProgress(content: string): PlanProgress | null {
  if (!content || !content.trim()) return null;

  const lines = content.split("\n");

  const rawTasks: {
    number: number;
    title: string;
    total: number;
    completed: number;
  }[] = [];

  let currentTask: {
    number: number;
    title: string;
    total: number;
    completed: number;
  } | null = null;

  for (const line of lines) {
    const headingMatch = line.match(TASK_HEADING_RE);
    if (headingMatch) {
      // Save previous task
      if (currentTask) {
        rawTasks.push(currentTask);
      }
      currentTask = {
        number: parseInt(headingMatch[1], 10),
        title: headingMatch[2].trim(),
        total: 0,
        completed: 0,
      };
      continue;
    }

    if (currentTask) {
      const checkMatch = line.match(CHECKLIST_RE);
      if (checkMatch) {
        currentTask.total++;
        if (checkMatch[1] === "x" || checkMatch[1] === "X") {
          currentTask.completed++;
        }
      }
    }
  }

  // Push the last task
  if (currentTask) {
    rawTasks.push(currentTask);
  }

  // Filter out tasks with zero checklist items
  const tasks = rawTasks.filter((t) => t.total > 0);

  if (tasks.length === 0) return null;

  const totalItems = tasks.reduce((sum, t) => sum + t.total, 0);
  const completedItems = tasks.reduce((sum, t) => sum + t.completed, 0);
  const firstIncomplete = tasks.find((t) => t.completed < t.total) ?? null;

  return {
    tasks,
    totalItems,
    completedItems,
    currentTask: firstIncomplete,
  };
}
