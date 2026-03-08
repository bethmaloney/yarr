import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const port = parseInt(process.env.YARR_PORT || "5174", 10);

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    strictPort: true,
    port,
  },
  test: {
    exclude: ["e2e/**", "node_modules/**"],
  },
});
