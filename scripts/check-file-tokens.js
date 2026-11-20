// Fails when a file is too big for an agent to read and edit in one go.
// Tokens are estimated as bytes / 4, which is close enough for code.
// Usage: node scripts/check-file-tokens.js <file>...
//
// A ratchet: a file already over the limit at HEAD passes as long as it does
// not grow. Otherwise every ticket that touches an oversized file inherits
// splitting it, and the split swamps the ticket.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const MAX_TOKENS = 5000;
const BYTES_PER_TOKEN = 4;

// Generated files that nobody edits by hand, and workflow files, which
// GitHub reads as one file each and which cannot be split.
const IGNORED = [
  /(^|\/)package-lock\.json$/,
  /^drizzle\//,
  /^\.github\/workflows\/[^/]+\.yml$/,
];

const isBinary = (contents) => contents.subarray(0, 8000).includes(0);

const toTokens = (bytes) => Math.ceil(bytes / BYTES_PER_TOKEN);

// Blob size of `<rev>:<file>`, or null when that revision does not have it.
// Blob sizes, unlike working-tree sizes, are free of CRLF line endings.
function blobBytes(rev, file) {
  try {
    const size = execFileSync("git", ["cat-file", "-s", `${rev}:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Number(size.trim());
  } catch {
    return null;
  }
}

const oversized = process.argv
  .slice(2)
  .map((file) => relative(process.cwd(), file).replaceAll("\\", "/"))
  .filter((file) => !IGNORED.some((pattern) => pattern.test(file)))
  .map((file) => ({ file, contents: readFileSync(file) }))
  .filter(({ contents }) => !isBinary(contents))
  .map(({ file, contents }) => ({
    file,
    bytes: blobBytes("", file) ?? contents.length,
    before: blobBytes("HEAD", file),
  }))
  .filter(({ bytes }) => toTokens(bytes) > MAX_TOKENS)
  .filter(
    ({ bytes, before }) =>
      before === null || toTokens(before) <= MAX_TOKENS || bytes > before
  )
  .map(({ file, bytes, before }) => ({
    file,
    tokens: toTokens(bytes),
    tokensBefore: before === null ? null : toTokens(before),
  }));

if (oversized.length > 0) {
  console.error(
    `These files are over ${MAX_TOKENS} tokens (bytes / 4), and are new, newly over, or grew:\n`
  );
  for (const { file, tokens, tokensBefore } of oversized) {
    const was = tokensBefore === null ? "new file" : `was ~${tokensBefore}`;
    console.error(`  ${file}: ~${tokens} tokens (${was})`);
  }
  console.error(`
A file that was already over the limit only has to stop growing: move out at
least as much as you added, and leave the full split to its own ticket.`);
  console.error(`
Split each file before you commit. Do not delete code or squash it onto fewer
lines to get under the limit.

How to split:
- Find the seams. Look for groups of functions, components, or tests that
  change together and share little with the rest of the file.
- Route modules (app/routes/*): keep the loader, action, and page component in
  the route file. Move the business logic into a module in app/modules/ and
  sub-components into their own files in app/components/.
- Logic that is already in a module (app/modules/<name>/): split it into more
  files under lib/. Keep the entry points (index.ts, index.server.ts) small. Do
  not add a barrel file. See app/modules/README.md.
- Tests: split by the behaviour under test, one file per area (for example
  <name>.refunds.test.ts, <name>.permissions.test.ts). Move shared fixtures
  into a fixtures file in the same tests/ folder.
- Scripts and seed data: move large data literals into their own files and
  import them.

When you are done, run \`npm run check\` and commit again.`);
  process.exit(1);
}
