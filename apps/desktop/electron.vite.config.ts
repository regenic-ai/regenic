import { resolve } from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), {
      name: "semantic-runtime-assets",
      writeBundle() {
        const output = resolve("out/main/embedding");
        mkdirSync(output, { recursive: true });
        for (const file of ["serve.py", "requirements.txt"]) {
          copyFileSync(resolve("../../packages/embedding-provider/python", file), resolve(output, file));
        }
      },
    }],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
      },
    },
    plugins: [react()],
  },
});
