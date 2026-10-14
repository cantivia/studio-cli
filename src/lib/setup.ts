import { useStore } from './store';

/** Opens a "Set up Claude" workspace whose single terminal runs `command`, then stays at a normal prompt. */
function runInSetupWorkspace(command: string) {
  const s = useStore.getState();
  s.addWorkspace(s.home, 'shell', 'Set up Claude');
  const ws = useStore.getState().workspaces.at(-1)!;
  if (ws.root.type === 'pane') useStore.getState().updatePane(ws.root.pane.id, (p) => ({ ...p, command }));
}

/** Claude Code's own installer, run in a Studio terminal so the person can watch it. */
export const INSTALL_CLAUDE = 'curl -fsSL https://claude.ai/install.sh | bash';
export const installClaude = () =>
  runInSetupWorkspace(`${INSTALL_CLAUDE}; echo; echo "Claude Code is installed. Close this workspace and go back to Studio to sign in."`);

/** Opens Claude's sign-in (it opens a browser tab to approve). */
export const signInToClaude = () =>
  runInSetupWorkspace('claude auth login; echo; echo "Done. Close this workspace and go back to Studio."');
