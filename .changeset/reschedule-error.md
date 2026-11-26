---
"@convex-dev/workpool": minor
---

Add `RescheduleError`: throw it from a job to run the job again later with the
same arguments, without using up a retry attempt. Pass `delayMs` to wait before
running again. If the job is canceled while it waits, it doesn't run again.
Reschedules aren't bounded by `maxAttempts`, and don't count toward
`previousAttempts` in `status`.

Delays for retries and reschedules are now capped at four years. A long
exponential retry backoff could previously overflow the queue's timestamp and
stop the pool.
