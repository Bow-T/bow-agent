---
name: supabase-security-review
description: Audit Supabase/backend changes (RLS, views, triggers, edge functions, SQL) for the recurring security issues the du-quest AI reviewer penalises, before committing. Use when changes touch supabase/ (migrations, policies, views, edge functions) or when the user asks to "check RLS", "security review the migration", "quest check", or "review supabase changes".
---

# Supabase Security Review (du-quest Security axis)

Catch the cross-tenant / secret / RLS mistakes that lose points on review.
Run the project gate first, then apply the manual checklist for anything the
grep-based gate can't see.

## 1. Run the project gate
```bash
bash scripts/check-quest.sh --staged      # pre-commit: staged diff
# or, for the whole MR:
bash scripts/check-quest.sh --branch       # diff vs origin/develop
```
Exit 0 = clean. On a finding it prints `✗ [rule] file` + the offending line.
The automated rules are:
- **view-security-invoker** — `CREATE VIEW` on RLS tables must include `WITH (security_invoker = true)`, else it runs as owner and bypasses RLS.
- **cors-wildcard** — edge functions must not use `Access-Control-Allow-Origin: *` on admin/mutation endpoints.
- **secret-*** — no hardcoded Stripe live keys, Supabase service-role keys, OpenAI/Anthropic keys.
- **rls-with-check-user-id-only** — a `WITH CHECK` whose only predicate is `auth.uid() = user_id` (FK ownership of related rows not verified). Opt out only with a `-- du-quest: fk-not-applicable` comment when genuinely N/A.

> Any finding is BLOCKING. Fix at the printed file:line and re-run. Recipes: docs/quest-score-playbook.md#layer-267.

## 2. Manual checklist (beyond the grep gate)
**RLS policies**
- INSERT/UPDATE `WITH CHECK` validates ownership of *every* related FK, not just `user_id`.
- Money / discount amounts are never trusted from the client — enforce server-side or via a `CHECK` constraint.
- Owner-read policies preserved (don't widen SELECT scope unintentionally).

**Triggers**
- `SECURITY DEFINER` triggers run with elevated rights → must pair with a strict INSERT policy on the table.
- Counter triggers are symmetric: increment on INSERT, decrement on DELETE/UPDATE; account for `ON DELETE CASCADE`.

**Edge functions**
- CORS scoped (no `*` for admin/mutation).
- Post-mutation side effects (logging, notifications) wrapped in `try/catch` so a secondary failure can't break the main DB transaction.

**SQL hygiene**
- No dead/meaningless clauses (e.g. `WHERE created_at < now()`).
- Backfills update the full related column-set (e.g. set `reviewed_at` whenever `reviewed_by` is set).

## 3. Report
For each item give `[✓/✗/N/A] <rule> <file:line> — note`. End with a verdict:
clean / list of blocking findings to fix before commit. This maps onto the
"AI-review" section of the Octopus pre-commit rubric in `.claude/CLAUDE.md`.
