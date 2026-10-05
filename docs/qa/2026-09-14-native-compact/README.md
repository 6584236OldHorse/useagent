# Native compact completion

Live QA thread `54f9f77f-4c00-4bf6-8301-84e21a46918b` advertised `/compact`. Submitting it created run `5214992b-db93-43e4-9bfe-f9b8ab1d3dee`, which failed after45 seconds with "The provider produced no first activity". A normal follow-up still found the original files in the same sandbox.

The screenshot of the failure and the retained-workspace follow-up is attached to pull request #335.

The pinned native runtime handles Compact as a non-turn operation. Its completion is a context-compaction activity with the accepted message requestId, not a new latestTurn. The old waiter ignored these unchanged-turn snapshots. The screenshot proves the observed timeout; source and regression tests establish the wrong completion contract, not that every timed-out provider operation necessarily succeeded.

The fix waits for exact correlated success/failure, revalidates commands before dispatch, and restores operation identity across restart. Recovery uses the original prompt-delivered receipt for its ten-minute bound. Stop only ends useAgent's wait because the native API has no request-scoped compact cancellation; the native runtime prevents overlapping sends. Durable cancel wording is selected under the finalizer lock and remains neutral in the UI.

This change is stacked on PR330, preserving its atomic fenced narration capture. It does not deploy or merge either PR. Database finalization regressions require CI.
