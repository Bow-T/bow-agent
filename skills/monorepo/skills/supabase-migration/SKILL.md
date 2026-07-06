---
name: supabase-migration
description: Author Supabase schema changes the <PROJECT_KEY> way — every schema change is a versioned migration file (never edit the DB by hand), every new table enables RLS with an ownership-checking policy, views use security_invoker, SECURITY DEFINER triggers pair with a strict INSERT policy, and backfills update the full related column-set. Use when creating or altering a table/column, adding an RLS policy, writing a trigger/function, or when the user says "add a migration", "tạo bảng mới", "đổi schema", "viết RLS", "thêm cột". Authoring counterpart to [[supabase-security-review]] (which audits) — write it right the first time. Pairs with [[impact-sweep]].
---

# Supabase Migration — schema the migration way

Goal: every schema change lands as a reviewable migration that ships RLS-safe by
default, so the du-quest Security axis and `scripts/check-quest.sh` pass on the
first try. **The DB is never edited by hand — the migration file is the source of
truth.** A table shipped without RLS, or a view without `security_invoker`, leaks
data across tenants at runtime while `analyze` and unit tests stay green.

Stack: migrations live in `supabase/migrations/`, edge functions in
`supabase/functions/`. Use the Supabase MCP (`list_tables`, `list_migrations`,
`list_extensions`) to inspect live state before changing it — never guess the
current schema.

## 1. Always start from a new migration file — never touch the DB by hand
```bash
supabase migration new <short_snake_case_name>   # e.g. add_driver_payout_table
```
This creates `supabase/migrations/<timestamp>_<name>.sql`. Write all DDL there.
- **Never** run ad-hoc `ALTER`/`CREATE` against the remote DB or via MCP
  `apply_migration` before the SQL exists in a committed file.
- One logical change per migration. Don't bundle an unrelated column rename with a
  new table.
- Before writing: `list_tables` to confirm the current shape; `list_migrations` to
  see what's already applied.

## 2. Every new table enables RLS with an ownership policy — no exceptions
A `CREATE TABLE` without RLS is a blocking finding. The canonical shape:
```sql
create table public.driver_payouts (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers (id) on delete cascade,
  amount_cents integer not null check (amount_cents >= 0),   -- money via CHECK, not client trust
  created_at timestamptz not null default now()
);

alter table public.driver_payouts enable row level security;

-- INSERT/UPDATE WITH CHECK verifies ownership of EVERY related FK, not just user_id.
create policy "driver reads own payouts" on public.driver_payouts
  for select using ( driver_id = auth.uid() );

create policy "driver inserts own payout" on public.driver_payouts
  for insert with check (
    driver_id = auth.uid()
    -- if this row references other owned rows, verify each here too
  );
```
Rules (mirror `.claude/CLAUDE.md` §3 and the check-quest gate):
- `WITH CHECK` must validate ownership of **every** FK, not only `auth.uid() = user_id`.
  If genuinely N/A, opt out explicitly: `-- du-quest: fk-not-applicable`.
- Never trust client-supplied money/discount amounts — enforce with a `CHECK`
  constraint or server-side, never a plain column.

## 3. Views on RLS tables MUST be security_invoker
```sql
create view public.driver_payout_summary
  with (security_invoker = true) as        -- else the view runs as owner and bypasses RLS
  select driver_id, sum(amount_cents) as total_cents
  from public.driver_payouts
  group by driver_id;
```
Missing `security_invoker = true` leaks data across tenants. This is a
check-quest rule — it will fail the gate.

## 4. SECURITY DEFINER functions/triggers pair with a strict INSERT policy
`SECURITY DEFINER` runs with elevated rights. If a trigger writes to a table,
that table needs a tight INSERT policy so nothing else can abuse the elevated path.
```sql
create function public.fn_bump_payout_counter() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  update public.drivers set payout_count = payout_count + 1 where id = new.driver_id;
  return new;
end $$;
```
- Counter triggers must be **symmetric**: increment on INSERT, decrement on
  DELETE/UPDATE. Account for `ON DELETE CASCADE` firing deletes you didn't write.
- Always `set search_path = ''` on DEFINER functions (schema-qualify everything).

## 5. Backfills update the full related column-set
When adding a column that pairs with another, backfill both together:
```sql
alter table public.orders add column reviewed_at timestamptz;
update public.orders set reviewed_at = updated_at where reviewed_by is not null;
-- setting reviewed_by without reviewed_at is a dead-clause / half-backfill finding
```
No dead clauses (`where created_at < now()`), no half-updated column pairs.

## 6. Cross-cutting change? Sweep before you apply
A new enum value, a widened `CHECK`, a re-pointed FK, or a renamed column touches
more than the migration file. **This is exactly the <PROJECT_KEY>-1793/1797 class of
bug**: a value that compiles clean still crashes at runtime against a frozen `CHECK`
three tables away. Run [[impact-sweep]]:
- `grep -r` every `CHECK`, FK, trigger, function referencing the changed value
  (`pg_constraint`, `pg_get_functiondef`).
- `grep -r supabase/functions/*` for hardcoded allow-lists / validators.
- Trace `insert → validate → read` on every surface (mobile, admin, edge, DB).

## 7. Verify, then apply
1. `bash scripts/check-quest.sh --staged` — the gate must be clean.
2. Apply to a local/staging stack first (`supabase db reset` locally) — never
   land an unverified migration straight on remote.
3. Only after the gate + local verify pass, apply to remote (MCP `apply_migration`
   or `supabase db push`), and say "verified the runtime path" — not "no errors" —
   until you've actually traced the constraint/trigger path (see [[supabase-security-review]]).

## Red flags — stop and fix before commit
- ✗ `CREATE TABLE` with no `enable row level security`. → add RLS + policy.
- ✗ `WITH CHECK ( auth.uid() = user_id )` when the row references other owned FKs. → verify each FK.
- ✗ `CREATE VIEW` on an RLS table without `with (security_invoker = true)`. → add it.
- ✗ Hand-run `ALTER`/`CREATE` on the DB with no migration file. → write the migration first.
- ✗ `SECURITY DEFINER` function without a strict INSERT policy on the table it writes. → add the policy.
- ✗ Applying a cross-cutting migration without an impact sweep. → run [[impact-sweep]] first.

**Write the migration. Enable RLS. Sweep the blast radius. Then apply.**
