---
"@convex-dev/workpool": minor
---

Order queues by commit timestamp and recover near-term scheduled work that
commits behind the queue cursor. Requires Convex 1.47 or later.

Queued work from older versions migrates automatically, preserving scheduled
start times. Large queues may briefly delay new work during migration. Before
upgrading from a version earlier than 0.4.15, deploy 0.4.15 and run
`npx convex run --component workpool migrations:backfillPendingStartIds`,
replacing `workpool` with each component instance's name.

Downgrading after this upgrade is unsupported because the queue format changes.
