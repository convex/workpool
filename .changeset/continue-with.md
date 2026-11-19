---
"@convex-dev/workpool": minor
---

Add `continueWith`: return it from a job to run the same function again with new
arguments, for work that proceeds in steps like paginating a table. `onComplete`
is called once the job returns anything else. Each step commits its writes and
gets the full retry budget, and canceling stops the next step.
