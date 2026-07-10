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
"AI-review" section of the Bow pre-commit rubric in `.claude/CLAUDE.md`.

## 4. RBAC gotchas learned the hard way (DUOCT-1776)

**`has_admin_permission(uid, 'broad.key')` reverse-EXPANDS — it does NOT mean
"the role holds broad.key".** The live definition
(`20261010500000_granular_admin_permissions`) is satisfied when the caller holds
ANY *granular sub-key* that `broad.key` expands to (`admin_permission_satisfied`
arm 3 + `expand_legacy_admin_permissions`). So gating a policy on
`has_admin_permission(auth.uid(), 'config.edit')` does **not** restrict writes to
roles granted `config.edit` — it admits every role holding *any* sub-key it
expands to. Real shipped bug: `config.edit` expands to `vehicle_types.assign`,
which `compliance` holds, so compliance kept full write to all delivery-config
tables even though the migration claimed "super_admin only". support_agent +
finance were correctly blocked; compliance slipped — a silent partial gate that
static-green + a policy-text pgTAP test never catch.
- **To require a SPECIFIC role, use a direct role check, not a broad permission
  key.** Fix = an `is_super_admin(uuid)` helper (mirror `is_admin` but pin
  `r.role='super_admin'`); no sub-key can satisfy it. Note edge fns already gate
  `role==='super_admin' || permissions.includes('literal.key')` — the RLS
  `has_admin_permission(broad.key)` is looser than the edge fn it's meant to mirror.
- **Verify a helper against its LATEST definition, not the first grep hit.**
  `has_admin_permission` was redefined literal→reverse-expansion
  (`20260505130000` → `20261010500000`); verifying "super_admin is covered"
  against the OLD literal body is how this shipped. Use
  `grep -rln 'FUNCTION public.<fn>' supabase/migrations | sort | tail -1`, read
  THAT body. Same trap on the sibling `alerts.manage` gate: super_admin's granular
  catalogue holds `alerts.receive` + `finance.manage`, NOT literal `alerts.manage`
  — coverage survived only via the `finance.manage` OR-branch. Always confirm the
  role you're "keeping" passes the *effective* predicate.
