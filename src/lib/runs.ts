import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from './api';
import { useStore } from './store';
import type { Workflow } from './types';

/** A workflow in progress on one Claude terminal. */
export type Run = { workflow: Workflow; steps: string[]; index: number; sawBusy: boolean; auto: boolean };

type Runs = {
  runs: Record<string, Run>;
  start: (termId: string, workflow: Workflow, input: string) => void;
  next: (termId: string) => void;
  stop: (termId: string) => void;
  patch: (termId: string, run: Run | null) => void;
};

export const useRuns = create<Runs>()((set, get) => ({
  runs: {},
  start: (termId, workflow, input) => {
    const steps = workflow.steps.map((s) => s.replaceAll('{input}', input));
    api.send(termId, steps[0]);
    get().patch(termId, { workflow, steps, index: 0, sawBusy: false, auto: true });
  },
  next: (termId) => {
    const run = get().runs[termId];
    if (!run) return;
    const index = run.index + 1;
    if (index >= run.steps.length) return get().stop(termId);
    api.send(termId, run.steps[index]);
    get().patch(termId, { ...run, index, sawBusy: false });
  },
  stop: (termId) => get().patch(termId, null),
  patch: (termId, run) =>
    set((s) => {
      const runs = { ...s.runs };
      if (run) runs[termId] = run;
      else delete runs[termId];
      return { runs };
    }),
}));

/**
 * Mounted once in App: when Claude goes busy for a workflow step and comes back idle,
 * send the next step. Works whichever pane or tab you're looking at.
 */
export function useWorkflowAutoAdvance() {
  const meta = useStore((s) => s.meta);
  useEffect(() => {
    const { runs, patch, next } = useRuns.getState();
    for (const [termId, run] of Object.entries(runs)) {
      const status = meta[termId]?.claude?.status;
      if (!status) continue;
      if (status === 'busy' && !run.sawBusy) patch(termId, { ...run, sawBusy: true });
      else if (status !== 'busy' && run.sawBusy) {
        if (run.auto && run.index + 1 < run.steps.length) next(termId);
        else patch(termId, run.index + 1 >= run.steps.length ? null : { ...run, sawBusy: false, auto: false });
      }
    }
  }, [meta]);
}
