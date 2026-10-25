# Diagnose, recover, and resume

1. Classify the failing boundary: prerequisite, package install, configured process, transport, tool schema, project permission, authentication, target application or task verification.
2. Preserve the exact error and operation/task identity. For writes, inspect receipt and external post-state before recovery. Never generate a new ID to evade an unknown result.
3. Try one correction at the failed boundary. Keep configuration, process ownership and accepted exclusions intact. Do not repair missing credentials by extracting another app's token or turning off authentication.
4. Repeat only the affected acceptance on the current fingerprint. A changed build must be tested through the actual consuming entrypoint. Record remaining limits, then continue independent authorized work.

| Trigger | Next step | Acceptance |
|---|---|---|
| npm/native addon failure | Check Node engine, lockfile, registry reachability and build-tool availability; retain failed install | Fresh installation plus actual MCP call |
| Busy port | Identify owner and config; choose free ports for a new install | New listener's authenticated identity |
| Missing optional component | Mark optional/skipped; do not fail unrelated core operations | Required profile gates only |
| Approved MCP unavailable | Inspect owned process and configured transport; handshake and safe probe | Actual tool result, not process existence |
| Imported service unapproved | Surface concrete read/write classification needed | Explicit configured approval, then probe |
| Tool absent in Host schema | Inspect deployed catalog and Host refresh state | Distinguish SDK probe from direct Host invocation |
| GUI input interruption | Stop; obtain a fresh observation after user activity | New valid observation; physical Escape requires local reauthorization |
| Foreground switch uncertain | Observe exact HWND and post-state; inspect journal | Target verified foreground before input |
| Browser Extension welcome reappears | Inspect existing context/tabs and connection state | Reuse attributable tab; no duplicate submission |
| Source changed after verify | Refresh fingerprint and affected fixed acceptance | Same fingerprint at completion |

Escalate only the concrete external prerequisite after independent work is complete. Explain which capability is blocked and what evidence already passed. Do not describe a skipped test as a pass.
