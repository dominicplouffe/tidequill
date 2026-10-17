/** Small global UI state. */
export const ui = $state<{ commandOpen: boolean; commandQuery: string }>({ commandOpen: false, commandQuery: "" });

export function openCommand(query = "") {
  ui.commandQuery = query;
  ui.commandOpen = true;
}

export function closeCommand() {
  ui.commandOpen = false;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? "⌘K" : "Ctrl K";
