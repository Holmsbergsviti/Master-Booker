import { defineConfig } from "vite";
import { resolve } from "node:path";
import { netlifyFunctions } from "./vite-plugin-functions.js";

export default defineConfig({
  // Runs the real functions in dev, so /api/* works without the Netlify CLI.
  plugins: [netlifyFunctions()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        client: resolve(__dirname, "index.html"),
        coach: resolve(__dirname, "coach/index.html")
      }
    }
  },
  server: { port: 5173 }
});
