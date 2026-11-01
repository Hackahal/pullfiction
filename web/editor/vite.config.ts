import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LandingPage } from "./src/LandingPage.tsx";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(() => {
  const runtime =
    process.env.PULLFICTION_RUNTIME_ORIGIN ?? "http://127.0.0.1:8096";
  return {
    plugins: [
      react(),
      {
        name: "pullfiction-static-landing",
        transformIndexHtml(html) {
          return html.replace(
            "<!--pullfiction-landing-->",
            renderToStaticMarkup(createElement(LandingPage)),
          );
        },
      },
    ],
    define: { "import.meta.env.VITE_BROWSER_ASSETS": JSON.stringify("1") },
    publicDir: "public",
    resolve: {
      alias: {
        "@runtime-art.css": fileURLToPath(
          new URL("./src/browser-art.css", import.meta.url),
        ),
      },
    },
    build: {
      outDir: "../../.agent/work/editor",
      emptyOutDir: false,
      target: "es2022",
    },
    server: {
      hmr:
        process.env.PULLFICTION_RENDERER_LAB_NO_HMR === "1" ? false : undefined,
      proxy: {
        "/api/shares": {
          target:
            process.env.PULLFICTION_SHARING_ORIGIN ?? "http://localhost:8787",
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (request) => {
              request.setHeader(
                "Origin",
                process.env.PULLFICTION_SHARING_ORIGIN ??
                  "http://localhost:8787",
              );
            });
          },
        },
        ...Object.fromEntries(
          ["/archive", "/metadata", "/snippets", "/pullfiction_viewer"].map(
            (path) => [path, runtime],
          ),
        ),
      },
    },
  };
});
