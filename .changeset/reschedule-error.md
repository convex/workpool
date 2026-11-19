---
"@convex-dev/workpool": minor
---

Add `RescheduleError`: throw it from a job to run the job again later with the
same arguments, without using up a retry attempt. Pass `delayMs` to wait before
running again. If the job is canceled while it waits, it doesn't run again.
