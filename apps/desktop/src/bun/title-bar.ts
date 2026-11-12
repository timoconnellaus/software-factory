// Double-clicking the title bar (spec 41): the toolbar is the window's title bar under
// `hiddenInset`, so the view reports a double-click on its empty space and this does what macOS
// would. System Settings › Desktop & Dock › "Double-click a window's title bar to" is the global
// default AppleActionOnDoubleClick: Maximize (zoom, the default when unset), Minimize, or None.
// Older systems kept AppleMiniaturizeOnDoubleClick instead.

export type DoubleClickAction = "zoom" | "minimize" | "none";

/** The action for the stored setting values (`defaults read -g …`; null when unset). */
export function doubleClickAction(
  action: string | null,
  miniaturizeLegacy: string | null,
): DoubleClickAction {
  const a = action?.trim().toLowerCase();
  if (a === "minimize") return "minimize";
  if (a === "none") return "none";
  if (a === "maximize" || a === "fill" || a === "zoom") return "zoom";
  return miniaturizeLegacy?.trim() === "1" ? "minimize" : "zoom";
}

async function readGlobal(key: string): Promise<string | null> {
  try {
    const p = Bun.spawn(["/usr/bin/defaults", "read", "-g", key], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(p.stdout).text()).trim();
    return (await p.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

export async function systemDoubleClickAction(): Promise<DoubleClickAction> {
  return doubleClickAction(
    await readGlobal("AppleActionOnDoubleClick"),
    await readGlobal("AppleMiniaturizeOnDoubleClick"),
  );
}

interface Zoomable {
  minimize(): unknown;
  maximize(): unknown;
  unmaximize(): unknown;
  isMaximized(): boolean;
}

/** Applies the system's double-click action to the window: zoom toggles. */
export async function titleBarDoubleClick(win: Zoomable | null): Promise<DoubleClickAction> {
  const action = await systemDoubleClickAction();
  if (!win || action === "none") return action;
  if (action === "minimize") win.minimize();
  else if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return action;
}
