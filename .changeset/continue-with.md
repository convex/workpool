---
"@convex-dev/workpool": minor
---

Add `continueWith`: return it from a job to run the same function again with new
arguments, for work that proceeds in steps like paginating a table. `onComplete`
is called once: after the final step, or when a step fails for good, is
canceled, or can't store its next args. Each step commits its writes and gets
the full retry budget, and canceling stops the next step. Steps are logged with
status `continued` and counted in the report's `continued` field, separately
from `rescheduled`.
