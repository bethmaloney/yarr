import { defineConfig } from "@playwright/test";

const port = parseInt(process.env.YARR_PORT || "5174", 10);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 15_000,
  use: {
    baseURL,
    viewport: { width: 1400, height: 900 },
  },
  webServer: {
    command: `YARR_PORT=${port} npm run dev`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
