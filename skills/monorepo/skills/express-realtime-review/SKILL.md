---
name: express-realtime-review
description: Catch the recurring DUOCT express/delivery/notification/realtime bug classes BEFORE QC does — the six patterns a Sprint-7 multi-agent sweep found live in merged code (status-enum widened but not swept to every surface, per-stop timeline active-leg mis-derivation, copy-pasted realtime-badge logic, realtime channel/subscription leaks, widgets that don't re-sync when props change live, and DB FK/table re-points whose consumers still read the old table). Use when adding or editing anything under the express-delivery / courier-handling / delivery-tracking / notifications surfaces, when adding an express or booking status value, when touching a realtime subscription (subscribeToX / postgres_changes / badge count), when building a multi-stop timeline or any grouped/per-item UI, or when a QC bug lands on those surfaces. Pairs with [[impact-sweep]], [[octopus-ui]], [[octopus-i18n]] and [[verify-runtime-not-just-static-green]].
---

# Express / Realtime review — the six bug classes QC keeps finding

`fvm flutter analyze` + unit tests were **green** on every one of these when they
shipped. They are runtime/logic/lifecycle defects that only manual QC (or an
adversarial code read) catches. Before declaring an express/delivery/notification
change done, walk this checklist against the code you touched. Each item cites the
real Sprint-7 site so you can see the shape.

> This skill is a **review lens**, not a build guide. For building the UI use
> [[octopus-ui]]; for blast-radius mapping use [[impact-sweep]]; for the runtime
> audit use [[verify-runtime-not-just-static-green]].

---

## 1. A new status/enum value must reach EVERY surface — grep, don't trust memory
Adding one express/booking status (`arrived_at_pickup` was the Sprint-7 case,
added to the DB CHECK in `20261024100000`) fans out to **many** hand-maintained
lists that a grep for the *new* token won't find, because they enumerate the
*other* members:

- **Mobile status→label/colour switches** — `_StatusBadge._styleFor` dropped
  `failed` to a raw-token default (rendered "failed" under FR too).
- **Admin filter option arrays** — `express-deliveries/index.tsx` `STATUS_OPTIONS`
  missed `arrived_at_pickup`, so admins couldn't filter that state.
- **DB functions with hardcoded status IN-lists** — the campaign segment
  resolver `_resolve_campaign_audience` (`users_with_active_bookings`) omitted it,
  silently excluding those senders from broadcasts.
- **Edge-function validators / allow-lists**, l10n `.arb` keys, admin `labels.ts`
  colour+label maps.

**Do:** grep a *peer* status already wired everywhere (`grep -rln "picked_up"
apps/mobile apps/admin supabase`) — its hits ARE your checklist. Prefer a
`switch` with **no default** (or a `Record<Status,…>`) so the next added value is
a compile error, not a silent miss. See [[impact-sweep]] §"enum-widen".

## 2. Multi-stop timeline: derive the active leg the SAME way on every surface
The courier and the sender render the same delivery; if they compute "which stop
is current" differently, they disagree — and QC files it (DUOCT-2159).

- **Trap:** every not-yet-reached stop carries a `pending` history row from
  booking time, so "highest non-terminal stop" ≠ "the leg being worked". The
  sender builder used `lastWhere(non-terminal)` and highlighted the trailing
  `pending` stop instead of the `in_transit` one the courier showed.
- **Rule:** pick the **lowest** stop that is `in_transit`/`arrived` (active),
  else the lowest non-terminal, else none — mirror `CourierDeliveryModel.currentStop`.
  Any surface showing an "active/current stop" must use that one derivation.
- **Terminal booking = no active leg.** A fully-delivered multi-stop booking must
  report active-stop `0`/none, NOT fall back to Stop 1 (that badged/auto-expanded
  Stop 1 as live on a finished booking). If a getter's fallback exists to keep an
  address card filled, add a **separate** getter for the highlight (see §5).

## 3. Realtime row handlers must apply the SAME filter as the server query
A badge/count fed by a `postgres_changes` INSERT stream must exclude exactly what
the server count and the feed exclude — the realtime filter is only on `user_id`,
never on `type`.

- **Trap:** the bell badge did `unreadNotifCount += 1` on every `notifications`
  INSERT, but `countUnread()` and the feed both chain `.neq('type','message')`.
  A chat message inflated the badge until the next re-read. Copy-pasted across
  **three** VMs (home / home_driver / express_delivery) — see §4.
- **Rule:** before mutating a locally-maintained count from a realtime row, apply
  the identical predicate the authoritative query uses (`isMessageNotificationPayload`
  is the shared one). If the server query filters it, the realtime handler must too.

## 4. Same logic in N view-models → extract ONE predicate/helper
When you fix a realtime/badge/derivation bug, grep for the identical block — it
was almost certainly pasted. The badge bug lived verbatim in 3 VMs; the fix is one
shared `isMessageNotificationPayload` (top-level, unit-testable without a live
client) that all three call. Fixing one copy and leaving two is a QC re-file.
`grep -rn "unreadNotifCount += 1" apps/mobile` — every hit is a site.

## 5. One getter, one purpose — don't overload a getter that drives two UIs
`CourierDeliveryModel.currentStop` drove BOTH the highlight and the dropoff
address card. Making it null-on-terminal (right for highlight) would blank the
address card (wrong). The fix was a **second** getter `activeStopNumber` (0 on a
terminal booking) for the highlight, leaving `currentStop`/`currentStopNumber`
with their stop-1 fallback for the card+chip. When a getter feeds two surfaces
with different edge-case needs, split it rather than bend one to both.

## 6. A widget must re-sync when its props change LIVE (realtime rebuild)
A `StatefulWidget` whose `initState`/`late` field snapshots a prop (e.g.
`late bool _expanded = widget.initiallyExpanded;`) will **not** re-apply that prop
when the parent rebuilds it in place — and realtime status advances rebuild the
tree constantly.

- **Trap:** `CollapsibleTimelineSection` never re-opened the newly-active stop on
  a live advance (no `didUpdateWidget`); and the section list had no `key`, so
  Flutter reconciled State to the wrong section.
- **Rule:** add `didUpdateWidget` to sync the derived state on the meaningful edge
  (respecting a user's manual override — open on false→true active, don't yank a
  still-open section shut), and give list items a **stable `ValueKey`** so State
  tracks the right item across rebuilds. See [[octopus-ui]] §"live props".

## 7. Realtime subscriptions: no leaks, no double-subscribe
- **Re-subscribe leak:** `subscribeToX` that does `_channels[key] = channel`
  without tearing down the prior channel leaks it when a VM re-runs its load
  (e.g. `cancelDelivery → _load` re-subscribed express+location; the originals
  stayed subscribed for the app lifetime because `dispose` could only reach the
  newest). Route every subscribe through a helper that `unsubscribe`s the existing
  key first (`RealtimeService._register`).
- **Cleanup:** every `subscribeToX` in a VM needs a matching `unsubscribe` in
  `dispose`; a non-PK-filtered channel needs the table at `REPLICA IDENTITY FULL`
  ([[rls-realtime-needs-replica-identity-full]]).

## 8. Cross-cutting DB re-point: update the consumer, not just the writer
When a migration re-points an FK or a table's meaning (DUOCT-1900 re-pointed
`support_tickets.context_order_id` from `orders` → `express_deliveries`), grep
**every reader** of that column. The admin reader still did
`from('orders').eq('id', context_order_id)` — which now holds an
`express_deliveries` id never present in `orders`, so it returned null for every
delivery ticket. A schema re-point is a Cross-cutting change: its consumers are in
scope, not just the writer. See [[impact-sweep]] §"FK/table re-point".

---

## Before you say an express/realtime change is done
- [ ] New status value: swept mobile switch + admin filter/labels + DB IN-lists +
      edge validators + `.arb` (grep a peer, §1).
- [ ] Active-leg derivation identical courier↔sender; terminal booking → no active
      leg (§2).
- [ ] Realtime count handler applies the server query's filter; predicate shared
      across all copies (§3, §4).
- [ ] No getter overloaded across two surfaces with conflicting edge cases (§5).
- [ ] Widgets re-sync on live prop change (`didUpdateWidget` + stable key) (§6).
- [ ] Subscriptions can't leak/double-subscribe; disposed; RLS/replica-identity ok (§7).
- [ ] DB re-point consumers updated, not just the writer (§8).
- [ ] Runtime verified, not just analyze/test green ([[verify-runtime-not-just-static-green]]).
