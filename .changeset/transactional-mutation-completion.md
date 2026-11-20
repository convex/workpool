---
"@convex-dev/workpool": minor
---

Add `completeTransactionally` to mutation enqueue options so successful work,
its non-excluded `onComplete` callback, and completion bookkeeping commit
together. If the callback or bookkeeping fails, the transaction rolls back and
periodic recovery reports the work as failed. The default completion behavior is
unchanged.
