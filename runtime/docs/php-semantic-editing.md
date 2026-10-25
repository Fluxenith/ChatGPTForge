# PHP cross-file semantic editing

Select `language: "php_phpantom"` for PHP cross-file rename. The existing `php`
identifier continues to select Intelephense; its free backend does not provide
rename. Forge's PHPantom route uses Serena 1.7.0's pinned PHPantom 0.8.0 release
and verifies the installed tree before analysis. It explicitly launches the
verified executable instead of resolving an arbitrary binary on PATH.

If a ChatGPT connector rejects `php_phpantom` with a language enum validation
error, refresh its Forge tool catalog. A server restart alone does not update
the host's stored schema. Do not substitute another language identifier.

## Install on another machine

With Forge's Serena component installed, use a small PHP project containing a
definition and a reference in another file:

```powershell
chatgptforge components language-install php_phpantom --from C:\Projects\php-example --file Calculator.php
chatgptforge components language-verify-rename php_phpantom --from C:\Projects\php-example --file Calculator.php --line 4 --column 21 --new-name sum
chatgptforge components language-list
```

Installation downloads through Serena's pinned installer into Forge's owned
language-server directory and records its tree digest. Rename registration must
produce a genuine two-file plan with references; a successful startup alone is
insufficient. Normal rename calls do not install or update a backend. This
transaction route currently requires Windows owned jobs.

## Preview, apply, rollback

1. Call `serena_rename_preview` with project `path`, `language: "php_phpantom"`,
   project-relative `file`, 1-based `line`/`column` and identifier `new_name`.
   The response includes `references` with file/line/column/end positions,
   per-file exact replacements, any permitted source-file moves and the captured
   `fingerprint`. No project source is changed by preview.
2. Create/resume a leased task for the same project. Call `task_serena_rename`
   with the same language/location/name, a new `operation_id`, the preview's
   `expected_fingerprint`, `task_id` and `lease_token`.
3. Inspect the resulting batch receipt. Repeating the exact operation ID and
   arguments returns its receipt. Changes between preview and apply are refused.
4. Call `task_rollback` with that task/lease, `change_id` set to the rename
   operation ID and a fresh `operation_id`. External changes to affected files
   cause refusal rather than overwrite. Run fixed acceptance before completing.

Forge uses a private captured source tree, requests references and two identical
rename plans, and checks that every reported project reference is covered. The
existing journal handles publication and rollback; upstream does not apply its
WorkspaceEdit to the live project. PHP source and Composer scripts are not
executed by this analysis route.

## Scope

Acceptance covers a class method declaration and typed receiver call across two
PHP files, with an unrelated same-name method, comment and string preserved.
This is not proof of complete coverage for PHP's dynamic calls, reflection,
framework magic, generated code or external consumers. A backend may omit a
reference; two matching plans alone do not prove whole-program completeness.
This version does not claim arbitrary Laravel/Symfony or namespace-directory
moves. Directory moves, external edits and confirmation-requiring plans remain
refused by the shared rename validator. Use project-specific acceptance for
larger changes.

The PHPantom release is deliberately pinned, not claimed to be the newest
upstream version. [Upstream](https://github.com/PHPantom-dev/phpantom_lsp)
documents its semantic features; Forge capability claims depend on the local
registered probe and actual task acceptance.
