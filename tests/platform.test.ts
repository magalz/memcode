import test from "node:test";
import assert from "node:assert/strict";
import {
  desktopPlatform,
  modifierLabel,
  primaryModifier,
  shortcutLabel,
  terminalCopyShortcut,
} from "../src/platform";

test("desktop detection respects modern platform and WebKit fallbacks", () => {
  assert.equal(
    desktopPlatform({
      userAgentData: { platform: "macOS" },
      platform: "Win32",
    }),
    "macos",
  );
  assert.equal(desktopPlatform({ platform: "MacIntel" }), "macos");
  assert.equal(desktopPlatform({ platform: "darwin" }), "macos");
  assert.equal(desktopPlatform({ platform: "Win32" }), "windows");
  assert.equal(desktopPlatform({ platform: "Linux x86_64" }), "linux");
  assert.equal(
    desktopPlatform({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    }),
    "macos",
  );
  assert.equal(desktopPlatform({}), "unknown");
});

test("shortcut labels and actual modifiers agree on each desktop OS", () => {
  const command = { metaKey: true, ctrlKey: false };
  const control = { metaKey: false, ctrlKey: true };
  assert.equal(shortcutLabel("K", "macos"), "⌘+K");
  assert.equal(modifierLabel("macos"), "⌘");
  assert.equal(primaryModifier(command, "macos"), true);
  assert.equal(primaryModifier(control, "macos"), false);
  for (const platform of ["windows", "linux"] as const) {
    assert.equal(shortcutLabel("Enter", platform), "Ctrl+Enter");
    assert.equal(primaryModifier(control, platform), true);
    assert.equal(primaryModifier(command, platform), false);
  }
  assert.equal(primaryModifier({ ...control, altKey: true }, "windows"), false);
});

test("terminal copy uses Command+C on Mac and Ctrl+Shift+C elsewhere, leaving Ctrl+C intact", () => {
  const event = {
    code: "KeyC",
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
    altKey: false,
  };
  assert.equal(terminalCopyShortcut(event, "macos"), true);
  assert.equal(
    terminalCopyShortcut({ ...event, metaKey: false, ctrlKey: true }, "macos"),
    false,
  );
  for (const platform of ["windows", "linux"] as const) {
    assert.equal(
      terminalCopyShortcut(
        { ...event, metaKey: false, ctrlKey: true },
        platform,
      ),
      false,
    );
    assert.equal(
      terminalCopyShortcut(
        { ...event, metaKey: false, ctrlKey: true, shiftKey: true },
        platform,
      ),
      true,
    );
  }
  assert.equal(
    terminalCopyShortcut({ ...event, altKey: true }, "macos"),
    false,
  );
});
