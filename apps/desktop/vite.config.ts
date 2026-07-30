import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const desktopRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(desktopRoot, "src/renderer"),
  plugins: [react()],
  base: "./",
  build: {
    outDir: resolve(desktopRoot, "dist-renderer"),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
