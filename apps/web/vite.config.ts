import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "release-version",
      generateBundle(_options, bundle) {
        const entry = Object.values(bundle).find(
          (chunk) => chunk.type === "chunk" && chunk.isEntry,
        );
        if (!entry) throw new Error("Missing web entry");
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: JSON.stringify({
            entry: `/${entry.fileName}`,
            styles: Object.values(bundle)
              .filter((asset) => asset.type === "asset" && asset.fileName.endsWith(".css"))
              .map((asset) => `/${asset.fileName}`)
              .sort(),
          }),
        });
      },
    },
  ],
  server: { proxy: { "/api": { target: "http://127.0.0.1:8780", ws: true } } },
  build: { target: "es2022" },
});
