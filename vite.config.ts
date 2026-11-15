import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    {
      name: "development-csp",
      apply: "serve",
      transformIndexHtml: (html) =>
        html.replace(
          /script-src 'self';/,
          "script-src 'self' 'unsafe-inline';",
        ),
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5197,
    strictPort: true,
    watch: {
      usePolling: true,
      interval: 300,
      ignored: [
        "**/src-tauri/**",
        "**/dist/**",
        "**/dist-runtime/**",
        "**/dist-artifact-viewer/**",
        "**/dist-artifact-annotations/**",
        "**/.memcode/**",
        "**/.memdb/**",
        "**/.memtrace/**",
      ],
    },
  },
  build: { target: "es2023" },
});
