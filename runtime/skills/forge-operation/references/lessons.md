# Demonstrated lessons and limits

These are reviewed engineering observations, not instructions to override user scope or a benchmark of model performance.

| Trigger | Demonstrated correction | Limit / recheck |
|---|---|---|
| Installer finds Node but nested npm lifecycle says node is missing | Use the exact Node executable, normalize case-insensitive PATH keys, remove nonexistent/duplicate PATH entries for that child process, and reject an excessively long installation PATH | Does not install native toolchains or fix unrelated registry/auth errors; retain npm failure output |
| SetForegroundWindow returns before target becomes foreground | Wait for bounded WM_NULL processing and verify actual foreground HWND | Windows may still deny activation; never type into a different foreground window |
| Background activation remains denied | An authorized native caption can provide a narrowly checked activation path; verify hit-test, coverage, held keys and foreground after input | Custom title bars, protected/elevated windows and user interference may still fail; not a general desktop click permission |
| Two windows belong to one PID | Preserve separate pid+hwnd grants and require exact hwnd when ambiguous | An old revision never transfers to another window; handle/process identity must still match |
| Everyday Chrome appears to lose a local session | Verify which existing Chrome profile the Extension actually connected to before comparing cookies/session state | Successful local test state is not proof of every external site's login |
| Multi-project query is rejected as lacking a path | Respect the actual schema: single path, multiple paths and query arrays have different binding contracts | Do not inject a single default path into unrelated schemas |
| Fresh install lacks an optional provider | Keep core readiness distinct from optional-component status | A required profile provider still needs handshake and a meaningful safe call |

For each new lesson, use the template in templates.md, cite the project-owned evidence record, and state what would invalidate the conclusion. Never export tokens, personal URLs or private source content with the lesson.
