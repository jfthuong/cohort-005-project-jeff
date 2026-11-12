// Seed a Wayfinder checkpoint into your own repo's GitHub Issues, so you can
// pick up the course from that point. Cross-platform port of
// seed-wayfinder-issues.sh: needs only gh (logged in), no bash or jq.
//
//   npm run seed-wayfinder-issues:ts 01-chart-the-map
//   npm run seed-wayfinder-issues:ts 01-chart-the-map --dry-run
//
// Run it from your own copy of the course repo (the one `ai-hero fork` made),
// never the course repo itself. --dry-run reads from GitHub but only prints
// the writes it would make.
//
// Writes go through GraphQL mutations rather than REST: some corporate proxies
// block REST POST/PATCH to api.github.com but allow the GraphQL endpoint.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const GIST = "87be0d1df4945234bba66f775ade6768";
const COURSE_REPO = "ai-hero-dev/cohort-005-project";

const snapshotSchema = z.object({
  labels: z.array(
    z.object({ name: z.string(), color: z.string(), description: z.string() })
  ),
  issues: z.array(
    z.object({
      key: z.number(),
      title: z.string(),
      labels: z.array(z.string()),
      state: z.enum(["open", "closed"]),
      state_reason: z.string().nullable(),
      body: z.string(),
      sub_issues: z.array(z.number()),
      blocked_by: z.array(z.number()),
      comments: z.array(z.object({ body: z.string() })),
    })
  ),
});

const gistSchema = z.object({
  html_url: z.string(),
  files: z.record(z.object({ content: z.string().optional() })),
});

// `id` is the GraphQL node id, used to link issues together.
type NewIssue = { number: number; id: string };

class SeedError extends Error {}

function die(message: string): never {
  throw new SeedError(message);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Point every link at your repo: issue URLs and #N refs get the new numbers,
// research docs point at the gist. Unknown issue numbers are left as they are.
export function rewriteLinks(
  text: string,
  opts: {
    repo: string;
    from: string;
    gistUrl: string;
    numbers: Record<string, { number: number }>;
  }
): string {
  const from = escapeRegExp(opts.from);
  const renumber = (n: string) => String(opts.numbers[n]?.number ?? n);
  return text
    .replace(
      new RegExp(
        `https://github\\.com/${from}/blob/research/[^/]+/docs/research/([a-z0-9-]+)\\.md`,
        "g"
      ),
      (_, file: string) => `${opts.gistUrl}#file-${file}-md`
    )
    .replace(
      new RegExp(`https://github\\.com/${from}/issues/([0-9]+)`, "g"),
      (_, n: string) => `https://github.com/${opts.repo}/issues/${renumber(n)}`
    )
    .replace(
      /(?<![\p{L}\p{N}_&/])#([0-9]+)\b/gu,
      (_, n: string) => `#${renumber(n)}`
    );
}

function gh(args: string[], input?: unknown): string {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      input: input === undefined ? undefined : JSON.stringify(input),
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      die("install the GitHub CLI: https://cli.github.com");
    }
    const detail = err.stderr?.trim() || err.message;
    const hint = detail.includes("invalid character '<'")
      ? "\n(GitHub returned HTML instead of JSON: a proxy is probably blocking this request.)"
      : "";
    die(`gh ${args[0]} ${args[1] ?? ""} failed:\n${detail}${hint}`);
  }
}

function graphql(query: string, variables: Record<string, unknown>): any {
  return JSON.parse(gh(["api", "graphql", "--input", "-"], { query, variables }))
    .data;
}

function main(argv: string[]) {
  // npm swallows a bare --dry-run as its own flag; it then sets this env var.
  const dryRun =
    argv.includes("--dry-run") || process.env.npm_config_dry_run === "true";
  const checkpoint = argv.find((arg) => !arg.startsWith("--"));

  // Every write goes through here, so --dry-run can print it instead.
  const mutate = (
    description: string,
    query: string,
    variables: Record<string, unknown>
  ): any => {
    if (dryRun) {
      console.log(`  [dry-run] ${description}`);
      return undefined;
    }
    return graphql(query, variables);
  };

  // 1. Load the checkpoint from the gist.
  const gist = gistSchema.parse(JSON.parse(gh(["api", `gists/${GIST}`])));
  const available = Object.keys(gist.files)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort()
    .join("\n");
  if (!checkpoint) {
    die(
      `usage: npm run seed-wayfinder-issues:ts <checkpoint>\navailable checkpoints:\n${available}`
    );
  }
  const content = gist.files[`${checkpoint}.json`]?.content;
  if (!content) {
    die(
      `no checkpoint called "${checkpoint}". Available checkpoints:\n${available}`
    );
  }
  const snapshot = snapshotSchema.parse(JSON.parse(content));
  const gistUrl = gist.html_url;

  // 2. Work out which repo we're seeding: always your origin remote.
  const repoInfo = z
    .object({
      id: z.string(),
      nameWithOwner: z.string(),
      hasIssuesEnabled: z.boolean(),
    })
    .parse(
      JSON.parse(
        gh(["repo", "view", "--json", "id,nameWithOwner,hasIssuesEnabled"])
      )
    );
  const repo = repoInfo.nameWithOwner;
  const [owner, name] = repo.split("/");
  if (repo === COURSE_REPO) {
    die(
      "origin is the course repo itself. Run `ai-hero fork` first, then rerun this from your copy."
    );
  }
  console.log(
    `Seeding checkpoint ${checkpoint} into ${repo}${dryRun ? " (dry run)" : ""}`
  );

  if (!repoInfo.hasIssuesEnabled) {
    console.log(`Issues are turned off on ${repo}. Turning them on...`);
    mutate(
      "enable issues",
      `mutation($id: ID!) { updateRepository(input: {repositoryId: $id, hasIssuesEnabled: true}) { clientMutationId } }`,
      { id: repoInfo.id }
    );
  }

  // 3. Refuse if a map is already open. A closed map doesn't count.
  const openMap = gh([
    "issue",
    "list",
    "-R",
    repo,
    "--label",
    "wayfinder:map",
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number // empty",
  ]).trim();
  if (openMap) {
    die(
      `${repo} already has an open Wayfinder map (#${openMap}).\nClose it (gh issue close ${openMap} -R ${repo}) if you want to seed a fresh set.`
    );
  }

  // 4. Labels. Existing ones are updated, like `gh label create --force`.
  const labelIds: Record<string, string> = {};
  const findLabel = (label: string): string | undefined =>
    graphql(
      `query($owner: String!, $name: String!, $label: String!) { repository(owner: $owner, name: $name) { label(name: $label) { id } } }`,
      { owner, name, label }
    ).repository.label?.id;
  for (const label of snapshot.labels) {
    const existing = findLabel(label.name);
    const fields = { color: label.color, description: label.description };
    labelIds[label.name] = existing
      ? (mutate(
          `update label ${label.name}`,
          `mutation($input: UpdateLabelInput!) { updateLabel(input: $input) { label { id } } }`,
          { input: { id: existing, ...fields } }
        )?.updateLabel.label.id ?? existing)
      : (mutate(
          `create label ${label.name}`,
          `mutation($input: CreateLabelInput!) { createLabel(input: $input) { label { id } } }`,
          { input: { repositoryId: repoInfo.id, name: label.name, ...fields } }
        )?.createLabel.label.id ?? `dry-run:${label.name}`);
  }
  const labelId = (label: string) =>
    labelIds[label] ??
    findLabel(label) ??
    die(`label "${label}" is not in the checkpoint or ${repo}`);

  // 5. Create the issues in map order. Bodies come later, once we know every
  //    new number. `numbers` maps old number -> {number, id}.
  const numbers: Record<string, NewIssue> = {};
  for (const issue of snapshot.issues) {
    const created: NewIssue = mutate(
      `create issue #${issue.key} "${issue.title}"`,
      `mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }`,
      {
        input: {
          repositoryId: repoInfo.id,
          title: issue.title,
          body: "Seeding...",
          labelIds: issue.labels.map(labelId),
        },
      }
    )?.createIssue.issue ?? { number: issue.key, id: `dry-run:${issue.key}` };
    numbers[String(issue.key)] = created;
    console.log(`  #${issue.key} -> #${created.number}`);
  }
  const newIssue = (key: number) =>
    numbers[String(key)] ?? die(`snapshot references unknown issue #${key}`);

  // 6. Point every link at your repo, then fill in the bodies.
  const rewrite = (text: string) =>
    rewriteLinks(text, { repo, from: COURSE_REPO, gistUrl, numbers });
  for (const issue of snapshot.issues) {
    const { number, id } = newIssue(issue.key);
    mutate(
      `set body of #${number}`,
      `mutation($id: ID!, $body: String!) { updateIssue(input: {id: $id, body: $body}) { clientMutationId } }`,
      { id, body: rewrite(issue.body) }
    );
  }

  // 7. Sub-issues, in map order.
  for (const issue of snapshot.issues) {
    const parent = newIssue(issue.key);
    for (const key of issue.sub_issues) {
      const child = newIssue(key);
      mutate(
        `#${child.number} is a sub-issue of #${parent.number}`,
        `mutation($parent: ID!, $child: ID!) { addSubIssue(input: {issueId: $parent, subIssueId: $child}) { clientMutationId } }`,
        { parent: parent.id, child: child.id }
      );
    }
  }

  // 8. Blocked-by edges.
  for (const issue of snapshot.issues) {
    const blocked = newIssue(issue.key);
    for (const key of issue.blocked_by) {
      const blocker = newIssue(key);
      mutate(
        `#${blocked.number} is blocked by #${blocker.number}`,
        `mutation($issue: ID!, $blocker: ID!) { addBlockedBy(input: {issueId: $issue, blockingIssueId: $blocker}) { clientMutationId } }`,
        { issue: blocked.id, blocker: blocker.id }
      );
    }
  }

  // 9. Comments, then close whatever was closed.
  for (const issue of snapshot.issues) {
    const { number, id } = newIssue(issue.key);
    for (const comment of issue.comments) {
      mutate(
        `comment on #${number}`,
        `mutation($id: ID!, $body: String!) { addComment(input: {subjectId: $id, body: $body}) { clientMutationId } }`,
        { id, body: rewrite(comment.body) }
      );
    }
    if (issue.state === "closed") {
      mutate(
        `close #${number} (${issue.state_reason})`,
        `mutation($id: ID!, $reason: IssueClosedStateReason) { closeIssue(input: {issueId: $id, stateReason: $reason}) { clientMutationId } }`,
        { id, reason: issue.state_reason?.toUpperCase() ?? null }
      );
    }
  }

  const map = snapshot.issues.find((issue) =>
    issue.labels.includes("wayfinder:map")
  );
  if (map) {
    console.log(
      `Done. Your map: https://github.com/${repo}/issues/${newIssue(map.key).number}`
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof SeedError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
