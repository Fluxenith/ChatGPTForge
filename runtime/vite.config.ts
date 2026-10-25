import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "src/ui"),
  plugins: [react()],
  base: "./",
  resolve: {
    alias: [{find: /^shiki$/, replacement: resolve(__dirname, "src/ui/compact-highlighter.ts")}],
  },
  build: {
    // MCP resources must work without a second HTTP route through the tunnel.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    outDir: resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: resolve(__dirname, "src/ui/workspace-app.html"),
      output: {
        inlineDynamicImports: true,
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
