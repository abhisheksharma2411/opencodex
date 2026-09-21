import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * `privacy:scan` is the gate that makes a public `devlog/` safe rather than
 * merely visible, and it was inert for exactly the diffs that fill that
 * directory. The scan runs as a step of `gates`, `gates` is gated on the `ci`
 * path filter, and that filter does not list `devlog/**` — so a devlog-only
 * pull request skipped `gates` and the aggregate `ci` check still concluded
 * success. #5467 landed sixteen devlog files that way, with a hand sweep for
 * addresses, hostnames and user paths as its only evidence (#5468).
 *
 * The fix mirrors `docs` and `structure`: its own filter and its own job,
 * rather than widening `ci` and starting the cross-platform matrix for a scan
 * that takes seconds.
 */
const source = readFileSync(repoPath(".github", "workflows", "ci.yml"), "utf8");
const workflow = Bun.YAML.parse(source) as {
  on?: { push?: { paths?: string[] } };
  jobs?: Record<string, {
    if?: string;
    needs?: string | string[];
    outputs?: Record<string, string>;
    steps?: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, unknown> }>;
  }>;
};

const changes = workflow.jobs?.changes;
const filterStep = (changes?.steps ?? []).find(step => step.uses?.startsWith("dorny/paths-filter@"));
const filters = Bun.YAML.parse(String(filterStep?.with?.filters ?? "")) as Record<string, string[]>;

test("a change under devlog/ selects a job that runs the privacy scan", () => {
  // The whole defect was that nothing satisfied this. Read the condition off the
  // job rather than naming the job, so renaming it does not quietly pass.
  expect(filters.privacy).toContain("devlog/**");
  expect(changes?.outputs?.privacy).toBe("${{ steps.filter.outputs.privacy }}");

  const selected = Object.entries(workflow.jobs ?? {})
    .filter(([, job]) => job.if?.includes("needs.changes.outputs.privacy == 'true'"))
    .filter(([, job]) => (job.steps ?? []).some(step => step.run?.includes("bun run privacy:scan")));
  expect(selected.map(([name]) => name)).toEqual(["privacy-gate"]);
});

test("a devlog edit still does not start the cross-platform matrix", () => {
  // This is the tradeoff the narrow job buys, and it is worth pinning: widening
  // the `ci` filter would also close #5468, and would also start nine Windows
  // shards and two macOS shards for a scan that takes seconds. A future edit
  // that takes that route fails here and gets read by a human.
  expect(filters.ci).not.toContain("devlog/**");
  expect(filters.ci).not.toContain("devlog/");
});

test("the scan still runs for ordinary source changes, exactly once", () => {
  // `gates` keeps its own Privacy scan step, so a `ci`-scoped pull request is
  // still covered by the path it always used. The new job must NOT also fire
  // there: that would run the same scan twice on every source pull request.
  const gates = workflow.jobs?.gates;
  expect((gates?.steps ?? []).some(step => step.run?.includes("bun run privacy:scan"))).toBe(true);
  expect(gates?.if).toContain("needs.changes.outputs.ci == 'true'");
  expect(workflow.jobs?.["privacy-gate"]?.if).not.toContain("needs.changes.outputs.ci");
});

test("the push trigger keeps mirroring the ci filter exactly", () => {
  // Pull-request scope, like `docs-site-build` and `structure-gate`: the push
  // trigger's `paths:` is pinned to equal the `ci` filter and `devlog/**`
  // deliberately is not in it. `dev`, `main` and `preview` are protected to
  // require a pull request, so no devlog change reaches an integration line
  // without passing through one.
  expect([...(workflow.on?.push?.paths ?? [])].sort()).toEqual([...(filters.ci ?? [])].sort());
});

test("the aggregate gate expects the job instead of ignoring it", () => {
  // ci.yml's own comment: adding a job without adding it here fails the gate by
  // name rather than passing unnoticed. That only holds if the arm exists, and a
  // job missing from `expected_for` reads as `undeclared`, not as skipped.
  const gate = workflow.jobs?.ci;
  expect(Array.isArray(gate?.needs) ? gate?.needs : []).toContain("privacy-gate");
  const script = (gate?.steps ?? []).map(step => step.run ?? "").join("\n");
  expect(script).toContain("privacy-gate) echo \"$privacy\" ;;");
  expect(script).toContain("GATED_JOBS=\"$GATED_JOBS structure-gate privacy-gate widget\"");
  expect(script).toContain("CHANGES_PRIVACY");
});
