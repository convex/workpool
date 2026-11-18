---
"@convex-dev/workpool": minor
---

Support `completeTransactionally` for queued queries so their non-excluded
success callback and completion bookkeeping commit together. Query reads use an
independent snapshot and may be stale when the callback commits; read data that
must still be current within the callback. Run ordinary queued queries through
the action batch worker with independent snapshots.
