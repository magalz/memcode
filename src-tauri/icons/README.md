# MemCode desktop icon

`source.svg` is the vector source of truth. It preserves the MemCode M and mint node, with a forest surface, restrained edge and transparent desktop inset. Generated assets are real platform icons, not screenshots or mockups.

Regenerate using the repository's pinned Tauri CLI:

```sh
node node_modules/@tauri-apps/cli/tauri.js icon src-tauri/icons/source.svg --output src-tauri/icons
node scripts/verify-icons.mjs
```

The existing bundle paths remain `icon.ico` (Windows), `icon.icns` (macOS) and `icon.png` (Linux). PNG variants cover small and high-density surfaces. Tauri also regenerates its existing mobile/AppX asset families from the same source.

Verify packaged taskbar/Dock/launcher appearance on the target OS after installing a native build; renderer screenshots alone do not establish that integration.
