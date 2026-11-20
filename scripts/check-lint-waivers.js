// Fails when a commit adds a file to a rule waiver (an `overrides` entry that
// turns rules off) in .oxlintrc.json. New code meets the lint rules; removing
// a file from a waiver is always welcome.
// Usage: node scripts/check-lint-waivers.js

import { execFileSync } from "node:child_process";
import ts from "typescript";

const CONFIG = ".oxlintrc.json";

// `rev` is "HEAD" or "" (the index, which is what is being committed).
function readConfig(rev) {
  let text;
  try {
    text = execFileSync("git", ["show", `${rev}:${CONFIG}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return { overrides: [] };
  }
  const { config, error } = ts.parseConfigFileTextToJson(CONFIG, text);
  if (error) {
    console.error(`Cannot parse ${rev || "staged"} ${CONFIG}.`);
    process.exit(1);
  }
  return config;
}

// rule name -> files waived for it
function waivers(config) {
  const byRule = new Map();
  for (const { files = [], rules = {} } of config.overrides ?? []) {
    for (const [rule, level] of Object.entries(rules)) {
      if (level !== "off") continue;
      const waived = byRule.get(rule) ?? new Set();
      for (const file of files) waived.add(file);
      byRule.set(rule, waived);
    }
  }
  return byRule;
}

const before = waivers(readConfig("HEAD"));
const after = waivers(readConfig(""));

const added = [...after].flatMap(([rule, files]) =>
  [...files]
    .filter((file) => !before.get(rule)?.has(file))
    .map((file) => ({ rule, file }))
);

if (added.length > 0) {
  console.error(`This commit adds files to lint waivers in ${CONFIG}:\n`);
  for (const { rule, file } of added) console.error(`  ${rule}: ${file}`);
  console.error(`
Make the code meet the rule instead, and take the files out of the waiver.
Moved code does not carry its old waiver with it: split the long function, or
leave the code where it was.`);
  process.exit(1);
}
