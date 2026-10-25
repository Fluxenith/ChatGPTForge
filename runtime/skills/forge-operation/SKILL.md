---
name: forge-operation
description: Use ChatGPTForge tools for durable local development, approved browser automation, and MCP integration. Apply when working through a Forge connection; preserve the user's task scope and existing authorizations.
---

# Forge operation

Reason in the host conversation. Forge executes tools and records evidence; it does not run a model provider or a subagent service.

Identify the connection's default with `project_context`; an explicit path may select another allowed project. Read the live tool schema rather than guessing names or copying a different version's arguments. Use the project instructions and user scope already provided. A source checkout, compiled localhost test, authenticated connector call, and actual ChatGPT UI result are different evidence levels.

For task-owned changes, retain the returned task ID, fingerprint, lease and operation IDs. Reuse the same operation ID and identical arguments after interruption. An unknown write outcome requires inspection and recovery, not a fresh ID. A successful command before a subsequent source change is not current acceptance. Complete only after the selected acceptance commands pass on the final fingerprint.

Route advanced work using [references/routing.md](references/routing.md). For continuation and evidence-backed lessons use [references/workflow.md](references/workflow.md). Those guides do not grant new origins, desktop access, account access, publication, or permission to message another conversation.

For new-machine or mixed-component work, load [deployment](references/deployment.md). On a concrete failure, use [recovery](references/recovery.md). For handoffs, reusable lessons and release closure, use the [record templates](references/templates.md). Load only the current workflow's references; preserve the user's narrower scope. The packaged [deployment runbook](../../docs/deployment.md) supplies executable commands and acceptance levels.

Select a workflow from [workflows.json](workflows.json); it is a declarative routing aid, not permission to run every stage. Consult [demonstrated lessons](references/lessons.md) only when their trigger matches current evidence. `deployment guide --file NEW_DIRECTORY` exports this guide with its runbook and profile into a self-contained directory without machine state.

If the user has skipped Chrome/ChatGPT UI acceptance or a second Tunnel, retain those exclusions while completing independent work. Do not treat an optional IDE or every upstream language as a requirement to install unrelated tools. When a boundary genuinely needs user action, report the concrete missing action and the completed independent work.
