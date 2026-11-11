import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL } from "node:url";

const workflow = readFileSync(
  new URL("../workflows/release.yml", import.meta.url),
  "utf8",
);
// Exercise the actual workflow script, rather than a second implementation.
const selection = workflow
  .match(/ {6}- id: select[\s\S]*? {8}run: \|\n([\s\S]*?)\n {2}build:/)[1]
  .split("\n")
  .map((line) => line.replace(/^ {10}/, ""))
  .join("\n");
function fixture(t, version = "0.4.16") {
  const cwd = mkdtempSync(join(tmpdir(), "workpool-release-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release-test@example.invalid");
  const commit = (version, message) => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "@convex-dev/workpool", version }),
    );
    writeFileSync(join(cwd, "notes.txt"), message);
    git("add", ".");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const before = commit("0.4.15", "Initial version");
  const bump = commit(version, "Version packages");
  const head = commit(version, "Fix release tooling");
  const run = (overrides = {}, eventBefore = before) => {
    const output = join(cwd, "output");
    const event = join(cwd, "event.json");
    writeFileSync(output, "");
    writeFileSync(event, JSON.stringify({ before: eventBefore }));
    const result = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", selection],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_SHA: head,
          GITHUB_REF: "refs/heads/main",
          GITHUB_OUTPUT: output,
          GITHUB_EVENT_PATH: event,
          RELEASE_COMMIT: "",
          ...overrides,
        },
      },
    );
    return { ...result, output: readFileSync(output, "utf8") };
  };
  return { before, bump, head, git, run };
}
function succeeds(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function fails(result, message) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, message);
}
test("manual recovery releases the workflow tip after a version bump", (t) => {
  const { run, head } = fixture(t);
  const result = run();
  succeeds(result);
  assert.match(result.output, new RegExp(`sha=${head}\\n`));
  assert.match(result.output, /version=0\.4\.16\n/);
  assert.match(result.output, /channel=latest\n/);
});
test("explicit commit is an equality guard, not an older source selector", (t) => {
  const { run, head, bump } = fixture(t);
  succeeds(run({ RELEASE_COMMIT: head }));
  fails(run({ RELEASE_COMMIT: bump }), /must match the selected ref/);
  fails(run({ RELEASE_COMMIT: "main" }), /40-character commit SHA/);
});
test("a push containing a bump and subsequent fix releases the push tip", (t) => {
  const { run, head } = fixture(t);
  const result = run({ GITHUB_EVENT_NAME: "push" });
  succeeds(result);
  assert.match(result.output, new RegExp(`sha=${head}\\n`));
});
test("a push without a version bump does not stage a release", (t) => {
  const { run, bump } = fixture(t);
  const result = run({ GITHUB_EVENT_NAME: "push" }, bump);
  succeeds(result);
  assert.equal(result.output, "");
});
test("manual dispatch without any version bump is rejected", (t) => {
  const { run, before } = fixture(t);
  fails(run({ GITHUB_SHA: before }), /No version bump/);
});
test("stable releases still require main", (t) => {
  const { run } = fixture(t);
  fails(
    run({ GITHUB_REF: "refs/heads/release" }),
    /Stable releases require main/,
  );
});
test("prereleases use their channel on a branch", (t) => {
  const { run } = fixture(t, "0.4.16-alpha.0");
  const result = run({ GITHUB_REF: "refs/heads/alpha" });
  succeeds(result);
  assert.match(result.output, /channel=alpha\n/);
});
test("downgrades and invalid versions are rejected", (t) => {
  fails(fixture(t, "0.4.14").run(), /must increase/);
  fails(fixture(t, "invalid").run(), /must increase/);
});
test("a staged tag at a different source prevents manual restaging", (t) => {
  const { run, git, bump } = fixture(t);
  git("tag", "v0.4.16", bump);
  fails(run(), /points elsewhere/);
  const automatic = run({ GITHUB_EVENT_NAME: "push" });
  succeeds(automatic);
  assert.doesNotMatch(automatic.output, /sha=/);
});
test("a staged tag at this source permits explicit recovery", (t) => {
  const { run, git, head } = fixture(t);
  git("tag", "v0.4.16", head);
  succeeds(run());
});
test("stage checks the signed source and does not override GITHUB_SHA", () => {
  assert.match(workflow, /test "\$SOURCE_SHA" = "\$GITHUB_SHA"/);
  assert.doesNotMatch(workflow, /GITHUB_SHA=.*npm stage publish/);
});
test("the baseline alias stays at 0.4.7 in manifest and lockfile", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url)),
  );
  const lock = JSON.parse(
    readFileSync(new URL("../../package-lock.json", import.meta.url)),
  );
  assert.equal(
    pkg.devDependencies["@convex-dev/workpool-old"],
    "npm:@convex-dev/workpool@0.4.7",
  );
  assert.equal(
    lock.packages[""].devDependencies["@convex-dev/workpool-old"],
    pkg.devDependencies["@convex-dev/workpool-old"],
  );
  assert.equal(
    lock.packages["node_modules/@convex-dev/workpool-old"].version,
    "0.4.7",
  );
});
