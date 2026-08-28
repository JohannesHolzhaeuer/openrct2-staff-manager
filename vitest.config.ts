import { defineConfig } from "vitest/config";

process.env.NO_COLOR = "1";
process.env.CI = "1";

export default defineConfig({
  test: {
    reporters: "dot"
  }
});
