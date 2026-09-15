# v2.0.0-beta.9

- A tool call's status row on the plain surface is now written at the level its outcome deserves: a
  successful call at INFO, a rater clarification at WARNING, a failure at ERROR. A quieted console
  can drop the tool chatter and still keep what broke. A failed call also shows at least three
  preview lines, because an errored tool carries its explanation in its content, and a configured
  depth of zero would otherwise tell you something broke while withholding what.
- An approval-gated tool no longer loses its arguments on the plain surface. The gate suspends the
  run, so the result arrives in a resumed stream that had never seen the call, and tool tracking now
  lives for the whole turn rather than for one stream. Every gated tool was affected, not only the
  file reader in issue #445.
