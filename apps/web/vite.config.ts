import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { releaseVersion } from "./releaseVersion.ts";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "release-version",
      enforce: "post",
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
      generateBundle: {
        order: "post",
        handler(_options, bundle) {
          // Shared lazy CSS can be deduplicated after transformIndexHtml. Stamp
          // both outputs from the final bundle so the installed PWA has one ID.
          const version = releaseVersion(bundle);
          for (const asset of Object.values(bundle)) {
            if (
              asset.type === "asset" &&
              asset.fileName.endsWith(".html") &&
              typeof asset.source === "string"
            ) {
              asset.source = asset.source.replace(
                /(<meta name="codex-release" content=")[a-f0-9]+("\s*\/?>)/,
                (_match, before, after) => before + version.id + after,
              );
            }
          }
          this.emitFile({
            type: "asset",
            fileName: "version.json",
            source: JSON.stringify(version),
          });
        },
      },
    },
  ],
  server: { proxy: { "/api": { target: "http://127.0.0.1:8780", ws: true } } },
  build: { target: "es2022" },
});
