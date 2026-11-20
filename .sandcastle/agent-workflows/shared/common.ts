import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";

export const outputDir = (): string => process.env.OUTPUT_DIR ?? "/tmp";

export const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
};

export const writeJson = (filename: string, value: unknown): void => {
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(
    path.join(outputDir(), filename),
    JSON.stringify(value, null, 2)
  );
};

// The one agent every factory workflow runs. Each workflow installs it and
// passes it the repository secret below.
// Agent: GitHub Copilot
// Install: npm install -g @github/copilot
// Secret: COPILOT_GITHUB_TOKEN
//
// Sandcastle runs every agent with its permission checks skipped, so it can
// use any tool.
export const claudeAgent = () =>
  sandcastle.copilot("claude-opus-5.5", {
    env: {
      COPILOT_GITHUB_TOKEN: required("COPILOT_GITHUB_TOKEN"),
    },
  });
