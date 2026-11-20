// Every terminal measures character widths by Unicode 11 (the default is Unicode 6).
// With the old table, emoji such as the sparkle in Codex's update banner count as one cell
// while the program draws them as two, so later redraws land one column off and letters
// get overwritten ("UOdate"). Windows Terminal and the program agree on the newer widths.
(() => {
  const Base = window.Terminal;
  if (!Base || !window.Unicode11Addon) return;
  window.Terminal = class extends Base {
    constructor(opts) {
      super(Object.assign({ allowProposedApi: true }, opts));
      try { this.loadAddon(new Unicode11Addon.Unicode11Addon()); this.unicode.activeVersion = '11'; } catch {}
    }
  };
})();
