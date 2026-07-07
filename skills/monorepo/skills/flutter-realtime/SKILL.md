---
name: flutter-realtime
description: Wire Supabase realtime in the <PROJECT_KEY> Flutter app the safe way — subscribe inside a service, own the channel in the view-model, ALWAYS removeChannel in dispose (no leaks), apply the SAME filter the server query uses, and re-sync the UI when the row changes live. Use when adding or editing a realtime subscription (postgres_changes / broadcast / presence), a live badge/count, or any screen that must update when the DB changes. Build-guide counterpart to [[express-realtime-review]] (the review lens that catches the leak/desync bug classes). Pairs with [[bow-ui]] and [[bow-model]].
---

# Bow Flutter Realtime — subscribe, filter, and ALWAYS clean up

Goal: a realtime feature that updates live AND tears down cleanly — no leaked
channels, no badge that drifts from the server count. `analyze` + unit tests are
**green** on every realtime bug QC files; these are lifecycle/filter defects only a
runtime trace or an adversarial read catches. This skill is how you avoid shipping
the four realtime bug classes in [[express-realtime-review]] §3–5.

Stack: `supabase_flutter`'s `SupabaseClient.channel(...)`. Realtime logic belongs in
`services/` (not widgets), the channel is **owned by the view-model** following the
`BaseViewModel` lifecycle from [[bow-ui]].

## 1. The canonical subscription — own the channel, clean it up
```dart
class DeliveryTrackingVM extends BaseViewModel {
  RealtimeChannel? _channel;                      // VM owns the channel

  @override
  void init() {                                   // BaseViewModel lifecycle hook
    super.init();
    _channel = supabase
        .channel('delivery_tracking_${bookingId}')  // unique, scoped name
        .onPostgresChanges(
          event: PostgresChangeEvent.update,
          schema: 'public',
          table: 'bookings',
          filter: PostgresChangeFilter(            // SAME filter as the server query
            type: PostgresChangeFilterType.eq,
            column: 'id',
            value: bookingId,
          ),
          callback: _onBookingChanged,
        )
        .subscribe();
  }

  void _onBookingChanged(PostgresChangePayload payload) {
    final updated = BookingModel.fromJson(payload.newRecord);   // typed model, never raw map
    booking = updated;
    notifyListeners();                             // re-sync the UI (§4)
  }

  @override
  void dispose() {
    if (_channel != null) supabase.removeChannel(_channel!);   // ALWAYS — no leak
    _channel = null;
    super.dispose();
  }
}
```

## 2. ALWAYS removeChannel in dispose — the #1 leak (express-realtime-review §4)
A channel subscribed in `init`/`initState` but never removed keeps receiving events
after the screen is gone, multiplies on re-entry, and drifts counts.
- Every `.subscribe()` needs a matching `removeChannel` in `dispose`.
- Store the channel in a field so `dispose` can reach it — never subscribe to an
  anonymous channel you can't tear down.
- Re-entering a page must not stack a second subscription: remove-then-subscribe,
  or guard with `if (_channel != null) return;`.
- **Check when you touch a realtime file:** `grep -n "\.subscribe()" <file>` then
  confirm each has a `removeChannel` in the same class's `dispose`.

## 3. Realtime handlers apply the SAME filter as the server query
A badge/count fed by a `postgres_changes` stream must include/exclude **exactly**
what the server query does (express-realtime-review §3). If the server count filters
`user_id = me AND type != 'system'`, the realtime `INSERT` handler must apply the
same `type != 'system'` check — the channel `filter` only covers `user_id`, so the
rest is your job in the callback. A filter mismatch = a badge that disagrees with
the list, which QC files.

## 4. Re-sync the UI when the row changes — don't cache a stale snapshot
A widget that read a value once in `build` won't update when the row changes live
(express-realtime-review §5). After applying a realtime payload:
- Update the VM's typed model field, then `notifyListeners()` (the provider rebuilds).
- Widgets read the **current** VM field, never a value captured at first build.
- If a child widget takes the value as a prop, make sure it re-reads on
  `didUpdateWidget` — a `StatefulWidget` that caches props in `initState` goes stale.

## 5. Don't copy-paste realtime/badge logic — extract a service
The same subscribe+filter+count logic pasted across screens drifts (one gets fixed,
others don't — express-realtime-review §3). Put the subscription and its filter in a
`services/` method (e.g. `NotificationService.subscribeUnreadCount(...)`) and reuse
it. One source of truth for the filter means one place to fix.

## Red flags — stop and fix before commit
- ✗ `.subscribe()` with no matching `removeChannel` in `dispose`. → add the teardown.
- ✗ Channel stored in a local variable `dispose` can't reach. → make it a field.
- ✗ Re-entering the page stacks subscriptions. → remove-then-subscribe or guard.
- ✗ Realtime callback parses `payload.newRecord` as a raw `Map`. → `Model.fromJson` ([[bow-model]]).
- ✗ Badge/count realtime filter ≠ server-query filter. → mirror the exact filter.
- ✗ Applying a payload without `notifyListeners()` / a widget caching a stale prop. → re-sync.
- ✗ Copy-pasted subscribe logic across screens. → extract a `services/` method.

**Subscribe in a service, own the channel in the VM, filter like the server, and always removeChannel.**
