export const state = {
  projects: [],
  activeProjectId: null,
  tabs: [],
  activeTabId: null,
  cliProvider: 'claude',
  fontSize: 14,
  // 'terminal' = PTY via xterm (default, works without /api/tabs/:id/history|queue).
  // 'block' = DOM rich-text renderer that requires the v1.3.0+ worker endpoints;
  // until the worker has been restarted to load that surface, 'block' shows
  // a blank pane on existing tabs because /history returns 404.
  renderMode: 'terminal',
  codexRenderMode: 'terminal',
}

// Expose state globally so tab-manager.js (which imports state separately)
// can read renderMode without an additional API call.
window.__nanocodeState = state
