export type DesktopPlatform = "macos" | "windows" | "linux" | "unknown";

interface PlatformSource {
  readonly userAgentData?: { readonly platform?: string };
  readonly platform?: string;
  readonly userAgent?: string;
}

/** WebKit (Tauri on macOS/Linux) needs the legacy platform fallback. */
export function desktopPlatform(
  source: PlatformSource | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator,
): DesktopPlatform {
  for (const value of [
    source?.userAgentData?.platform,
    source?.platform,
    source?.userAgent,
  ]) {
    if (!value) continue;
    if (/mac|darwin/i.test(value)) return "macos";
    if (/win/i.test(value)) return "windows";
    if (/linux/i.test(value)) return "linux";
  }
  return "unknown";
}

export function modifierLabel(platform = desktopPlatform()): string {
  return platform === "macos" ? "⌘" : "Ctrl";
}

export function shortcutLabel(
  key: string,
  platform = desktopPlatform(),
): string {
  return `${modifierLabel(platform)}+${key}`;
}

export function primaryModifier(
  event: { metaKey: boolean; ctrlKey: boolean; altKey?: boolean },
  platform = desktopPlatform(),
): boolean {
  return (
    !event.altKey && (platform === "macos" ? event.metaKey : event.ctrlKey)
  );
}

/** Preserve Ctrl+C as a terminal interrupt; macOS copies with Command+C. */
export function terminalCopyShortcut(
  event: {
    code: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  platform = desktopPlatform(),
): boolean {
  return (
    event.code === "KeyC" &&
    primaryModifier(event, platform) &&
    (platform === "macos" || event.shiftKey)
  );
}
