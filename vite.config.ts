import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    strictPort: true,
    port: 5174,
  },
  test: {
    exclude: ["e2e/**", "node_modules/**"],
  },
});
