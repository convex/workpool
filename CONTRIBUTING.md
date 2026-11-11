# Developing guide

## Running locally

```sh
npm ci
npm run dev
```

## Running the example dashboard

The `example/` app includes a dashboard for launching benchmark scenarios,
inspecting individual runs (throughput, latency CDF), and comparing two runs
side-by-side. To use it, run the backend and the frontend together:

```sh
npm run dev          # in one terminal: convex dev + library codegen watch
npm run dev:dashboard # in another:     vite dev server for example/
```

Then open the URL vite prints (typically <http://localhost:5173>). The "Run
scenario" tab launches presets; "History" lists past runs; "Compare" diffs two
of them. See `example/README.md` for more.

## Testing

```sh
npm run build
npm run check
npm run test:e2e
```

When component APIs change, regenerate and commit the generated files:

```sh
npm run build:codegen
```

## Releases

Include a changeset with changes that need a release:

```sh
npx changeset
```

Choose the version bump, describe the user-visible change, and commit the
generated file with your implementation. Docs-only and development-tooling
changes do not need a changeset.

Review and merge the release PR when ready. Click **Approve workflows to run**
on the PR if its checks are waiting for approval. To refresh it manually, run
the [Update release PR workflow](./.github/workflows/version.yml) on main.

After staging, review the package on npm's **Staged Packages** page and approve
with 2FA, or run:

```sh
npm stage approve <stage-id>
```

Use the stage ID from the workflow log. Approve versions in order to avoid
moving `latest` backward.

### Local preparation and prereleases

To prepare a release locally instead of using the bot:

```sh
npm ci
npm run build
npm run check
npx changeset version
```

Review and commit the version, changelog, and consumed changesets, then merge
through a checked PR. A push to main containing a version bump stages the tip
commit of that push. The built source must match the workflow run commit for npm
provenance verification.

For a branch prerelease, prepare a prerelease version with Changesets and
dispatch **Release** from the Actions page on that branch. The first prerelease
identifier selects the npm channel, such as `alpha`. Stable releases require
main.

### Recovery

Dispatch **Release** on the appropriate ref to release its current tip,
including fixes made after the version bump. The optional commit input is an
expected 40-character SHA and must equal the selected ref at dispatch time; it
cannot select an older commit. Stable releases still require main.

Once staging starts, inspect npm before retrying: dispatching **Release** runs
`npm stage publish` again. If the package is already staged, retry only the
failed tag job or, after verifying the staged version, create its source tag at
the workflow run commit. If staging failed and npm confirms the version is
absent, merge any necessary fixes and dispatch from the corrected main tip.

| Failure                                        | Recovery                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Failure before staging was attempted           | Retry failed jobs for the same commit.                                           |
| Staging succeeded; tagging failed              | Retry only the failed tag job, or create the source tag after verifying staging. |
| Upload outcome uncertain                       | Inspect npm; retry staging only if absent, or recover the tag if already staged. |
| Already-staged candidate requires code changes | Prepare a new version-bump commit.                                               |
| Candidate rejected after staging               | Leave its tag and prepare a new version.                                         |
