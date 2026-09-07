import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { releaseVersion } from "./releaseVersion.ts";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "release-version",
      transformIndexHtml: {
        order: "post",
        handler(_html, context) {
          if (!context.bundle) return;
          return [
            {
              tag: "meta",
              attrs: { name: "codex-release", content: releaseVersion(context.bundle).id },
              injectTo: "head",
            },
          ];
        },
      },
      generateBundle(_options, bundle) {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: JSON.stringify(releaseVersion(bundle)),
        });
      },
    },
  ],
  server: { proxy: { "/api": { target: "http://127.0.0.1:8780", ws: true } } },
  build: { target: "es2022" },
});
