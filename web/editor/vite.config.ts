import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(() => {
  const runtime = process.env.PULLFICTION_RUNTIME_ORIGIN ?? "http://127.0.0.1:8096";
  return {
    plugins: [react()],
    define: { "import.meta.env.VITE_BROWSER_ASSETS": JSON.stringify("1") },
    publicDir: false as const,
    resolve: {
      alias: {
        "@runtime-art.css": fileURLToPath(new URL("./src/browser-art.css", import.meta.url)),
      },
    },
    build: { outDir: "../../.agent/work/editor", emptyOutDir: false, target: "es2022" },
    server: {
      hmr: process.env.PULLFICTION_RENDERER_LAB_NO_HMR === "1" ? false : undefined,
      proxy: Object.fromEntries(["/archive", "/metadata", "/snippets", "/pullfiction_viewer"].map(path => [path, runtime])),
    },
  };
});
