import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.e2e.test.ts"],
    environment: "node",
    globalSetup: ["./src/globalSetup.ts"],
    // Each step is evidence; list them all.
    reporters: ["verbose"],
    // One scenario, steps in order, against shared live processes.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
