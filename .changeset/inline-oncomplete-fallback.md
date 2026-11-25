---
"@convex-dev/workpool": patch
---

When completing an action job inline fails, schedule the retry of `complete`
without running onComplete inline, so an onComplete that aborts its transaction
can't leave the job holding a running slot forever.
