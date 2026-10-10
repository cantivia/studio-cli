import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = path.join(os.homedir(), '.studio-cli');

export type Workflow = {
  id: string;
  name: string;
  description: string;
  /** Prompts sent to Claude in order. `{input}` is replaced by what the user types at launch. */
  steps: string[];
  needsInput?: string;
  color?: string;
};

export const DEFAULT_WORKFLOWS: Workflow[] = [
  {
    id: 'plan-build-verify',
    color: 'violet',
    name: 'Plan → Build → Verify',
    description: 'Plan first, implement, then prove it works.',
    needsInput: 'What should Claude build?',
    steps: [
      'I want to: {input}\n\nRead the relevant code and write a short, concrete plan. Do not write code yet.',
      'Implement the plan.',
      'Run the build and tests, fix anything failing, then summarise what changed and how you verified it.',
    ],
  },
  {
    id: 'fix-tests',
    color: 'green',
    name: 'Fix failing tests',
    description: 'Find the failing tests and fix the root cause.',
    steps: ['Run the test suite, find what is failing, and fix the root cause (not the test). Re-run to confirm.'],
  },
  {
    id: 'review',
    color: 'blue',
    name: 'Review my changes',
    description: 'Bug-focused review of the uncommitted diff.',
    steps: ['Review the uncommitted changes for correctness bugs, edge cases and security issues. Rank by severity.'],
  },
  {
    id: 'explain',
    color: 'teal',
    name: 'Explain this repo',
    description: 'Architecture tour for a codebase you just opened.',
    steps: ['Give me a tour of this codebase: what it does, the main modules, how data flows, and how to run it.'],
  },
  {
    id: 'debug',
    color: 'rose',
    name: 'Debug an issue',
    description: 'Reproduce, find root cause, fix, verify.',
    needsInput: 'Describe the bug',
    steps: [
      'Bug: {input}\n\nReproduce it first and find the root cause. Show me the evidence before changing anything.',
      'Fix the root cause and verify the fix.',
    ],
  },
  {
    id: 'ship',
    color: 'amber',
    name: 'Commit & open PR',
    description: 'Branch, commit with a clear message, open a PR.',
    steps: ['Create a branch if we are on the default branch, commit the changes with a clear message, push, and open a PR.'],
  },
];

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

export const loadWorkflows = () => readJson<Workflow[]>('workflows.json', DEFAULT_WORKFLOWS);
export const saveWorkflows = (w: Workflow[]) => writeJson('workflows.json', w);

/** cmux-compatible project commands: ./cmux.json → { commands: [{ name, command }] } */
export async function customCommands(cwd: string): Promise<{ name: string; command: string; description?: string }[]> {
  for (const f of ['cmux.json', '.cmux.json']) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(cwd, f), 'utf8'));
      if (Array.isArray(d.commands)) return d.commands.filter((c: any) => c?.name && c?.command);
    } catch {}
  }
  return [];
}

export async function listDirs(dir: string): Promise<{ path: string; dirs: string[]; parent: string | null }> {
  const abs = path.resolve(dir.replace(/^~/, os.homedir()));
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return {
    path: abs,
    parent: abs === '/' ? null : path.dirname(abs),
    dirs: entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b)),
  };
}
