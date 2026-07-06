---
name: bow-ui
description: Build or edit Flutter UI and pages in apps/mobile using the <PROJECT_KEY> Flutter MVVM architecture — the BaseViewModel + MixinBasePage page+view-model pattern (ChangeState state machine, lifecycle hooks, optimistic updates), reusing existing components, the app theme/spacing/localization, and typed models (never raw maps) in widgets. Use whenever creating or changing a screen, page, view-model (vm), widget, dialog, or any UI/MVVM code under apps/mobile/lib/src/pages or components.
---

# Bow UI — build screens the project way

Goal: every new screen looks and behaves like the existing ones, reuses what's
already there, and stays type-safe. **Reuse before you build. Match the base
source before you invent.**

## 1. Reuse first — search the component library
Before writing any widget, check `apps/mobile/lib/src/components/` — there is
almost always something to reuse. Catalog:
- **button/** `AppBounceButton`, `AppCircleButton`, `AppGradientButton`, `AppMonoButton`, `AppOutlinedButton`
- **input/** `AppTextField`, `AppPasswordField`, `AppSearchField`  ·  **checkbox/ radio/ switch/** `AppCheckbox`, `AppRadio`, `AppSwitch`
- **dialog/ modal/ popup/ snack_bar/** `AppDialog`, `ModalConfirm`, `AppModal`, `AppPopupMenu`, `AppSnackBar`, `showTopSnackBar`
- **widget/** `AppBarWidget`, `AppRefreshIndicator`, `TabCard`, `AppChoiceChip`, `CachedImage`, `CachedImageCircle`, `ItemNoFound`, `PagedBuilder`, `ServerError`, `PageError`, `AppLoading`, `AppCircularProgress`, `AppRatingBar`, `StatColumn`, `AppCalendar`, `AppReadMore`, `LuxuryCourierBadge`, …
Search first: `grep -ri "class App" apps/mobile/lib/src/components`. If a near-match exists, extend/parameterise it instead of cloning. Only add a new component when nothing fits — and put shared ones in `components/`, screen-local ones in a `widgets/` folder next to the page (e.g. `…/provider_bookings/widgets/provider_booking_card.dart`).

## 2. Page + ViewModel pattern — the MVVM core (always)
A screen = a `StatelessWidget with MixinBasePage<XxxVm>` (the **View**) + an
`XxxVm extends BaseViewModel` (the **ViewModel**, a `ChangeNotifier`). The View is
dumb: it only reads `provider.*` and calls VM methods. All data + actions live in
the VM; mutate there then `notifyListeners()`.
```dart
@RoutePage()
class FooPage extends StatelessWidget with MixinBasePage<FooVm> {
  FooPage({super.key, this.id = 0});
  final int id;
  @override
  FooVm create() => FooVm(id: id);            // construct VM, pass route params
  @override
  void initialise(BuildContext context) {}    // optional: runs once before build
  @override
  Widget build(BuildContext context) => builder(() => Scaffold(
        appBar: AppBarWidget(title: S.of(context).fooTitle),
        body: ListView.builder(
          itemCount: provider.items.length,    // reactive read
          itemBuilder: (_, i) => FooTile(item: provider.items[i]),
        ),
      ));
}
```
- **`builder(() => …)` wraps the whole tree** — it provides the VM via
  `ChangeNotifierProvider`, renders the loading/error overlays driven by VM state,
  wires snackbars, and fires the appear/disappear hooks.

### 2a. ViewModel lifecycle + state (exact BaseViewModel API)
Override these hooks in the VM. **Override the `on…` variants, NOT `appear()/disAppear()`** — those are the framework's internal callers:
- `void onInit()` — once after the provider is created (load initial data).
- `void onAppear()` / `void onDisAppear()` — page became visible / hidden.
- `void dispose()` — free controllers, then `super.dispose()`.

Drive the screen with the state machine, not ad-hoc booleans:
```dart
// enum ChangeState { loading, blank, page, serverError, clone }
changeState(ChangeState.loading);   // base swaps the matching overlay for you
```
Base helpers (already there — don't reinvent): `isLoading`, `showLoading()/hideLoading()`,
`showSuccess/showError/showInfo/showWarning(msg)`, and `runGuarded(() => …)` which
try/catches, routes errors to `showError`, and returns `null` on failure. Query
singletons are on the base via the locator (`driverQueries`, `rideQueries`,
`voucherQueries`, `orderQueries`, `prefs`, `supa`, …).
```dart
class FooVm extends BaseViewModel {
  FooVm({required this.id});
  final int id;
  List<FooModel> items = [];               // typed models, never Map

  @override
  void onInit() => _load();

  Future<void> _load() async {
    changeState(ChangeState.loading);
    final rows = await runGuarded(() => fooQueries.list(id));  // null on error
    if (rows == null) return changeState(ChangeState.serverError);
    items = rows;
    changeState(ChangeState.page);
    notifyListeners();
  }
}
```

### 2b. Optimistic updates (the project idiom for mutations)
Snapshot → update UI now → call server → revert on failure:
```dart
Future<void> increment(FooItem it) async {
  final snapshot = items;
  items = [for (final r in items) r.id == it.id ? r.copyWith(qty: r.qty + 1) : r];
  notifyListeners();
  try {
    await fooQueries.setQty(it.id, it.qty + 1);
  } catch (e) {
    items = snapshot;                       // revert
    notifyListeners();
    SupabaseError.handle(e, showError);
  }
}
```

### 2c. Folder layout + routing
- One page = its own folder: `foo/foo_page.dart` + `foo/foo_vm.dart`. Screen-local
  widgets in `foo/widgets/*.dart`; private helpers in `foo/_helpers.dart`.
- Nested / multi-step flows nest under `foo/pages/<step>/…` (see
  `…/express_delivery/pages/{delivery_destination,delivery_detail,delivery_offers}`).
- New route → `@RoutePage()` on the page class, then codegen
  (`fvm flutter pub run build_runner build`) so `app_router.gr.dart` picks it up.
  Navigate `context.router.push(FooRoute(id: 1))`; pop a result `context.maybePop(value)`.

## 3. Theme, spacing, text — no raw values
- **Colors:** `AppColor.*` (e.g. `AppColor.primaryText`, `AppColor.background`). Never hardcode `Color(0x…)` / `Colors.*` — **`AppColor` already has an exact equivalent for the common ones**, so map, don't invent:
  - `Colors.white10` → `AppColor.white10` (same for `white20…white90`, `black10…black40`).
  - `Colors.black.withValues(alpha: 0.1)` → `AppColor.black10`; `…alpha: 0.2` → `AppColor.black20`, etc.
  - `Colors.white` → `AppColor.white`; `Colors.black` → `AppColor.black` (`0xFF181818`, NOT pure black).
  - Need a shadow? `AppColor.shadow` / `AppColor.boxShadow` (ready-made `List<BoxShadow>`).
  - **Only exception:** `Colors.transparent` is allowed (there is no `AppColor.transparent`).
- **Text — every `Text` needs a style token; a bare `Text('x')` is a violation:** always `Text('x', style: context.appStyle.<token>)` (e.g. `context.appStyle.display14Bold`). Never write `Text('x')` with no `style:`, and never inline a bespoke `TextStyle` when a token exists. Tints/weights: copy off a token — `context.appStyle.body14.copyWith(color: AppColor.primary)` — not a fresh `TextStyle(...)`.
- **Spacing — use the `num`/`BuildContext` extensions, never a bare spacer `SizedBox`** (defined in `lib/src/utils/extension.dart`; import `package:bow/src/utils/extension.dart`):
  - Vertical gap: `12.sizedHeight` — **not** `SizedBox(height: 12)`.
  - Horizontal gap: `10.sizedWidth` — **not** `SizedBox(width: 10)`.
  - Top safe-area gap: `context.sizedTop([extra])` → `padding.top + extra` (default 12). Replaces `SizedBox(height: context.padding.top + N)`.
  - Bottom safe-area gap: `context.sizedBottom([extra])` → Android-floored `padding.bottom + extra` (default 24). Replaces `SizedBox(height: context.padding.bottom + N)`.
  - Works with any `num` expression too: `_spacer.sizedHeight`, `(context.width * 0.12).sizedWidth`.
  - **Exception — keep `SizedBox` when it has a `child` or constrains *both* dimensions** (e.g. `SizedBox(width: 40, height: 40, child: icon)`): that is a sizing box, not a spacer, and has no extension form.
  - **Paddings:** there are no shared padding constants — write `EdgeInsets.symmetric/only/all(...)` inline, but reuse the same step values the rest of the app uses (8 / 12 / 16 / 20 / 24), not arbitrary numbers.
- **Icons/images:** assets through `AppAsset.icons.*`; remote images through `CachedImage` / `CachedImageCircle` (never a bare `Image.network`).
- **Tap targets — a `GestureDetector`/`InkWell` wrapping a whole row/card MUST set `behavior: HitTestBehavior.opaque`** (or `.translucent` if it must sit over another tappable layer). The default is `deferToChild`: it only registers taps where a *child paints pixels*, so the gaps in a card — `12.sizedWidth`/`sizedHeight` spacers, the slack in an `Expanded` after a short `Text`, the `padding`/`margin` of the wrapped `Container` — become **dead zones that silently swallow the tap**. The user sees a card that only reacts on its text/icon/radio, not the empty area beside them. This bit us repeatedly on selection cards (voucher/offer, payment method, delivery option) — QC logged it twice (<PROJECT_KEY>-2052). Rule of thumb: if the `onTap` is meant to select/open the *item*, make the hit area `opaque`; only leave it `deferToChild` when the `GestureDetector` truly wraps just one small glyph/`Text` (e.g. a trailing chevron with its own action).

## 4. Localization — every user-facing string
All copy goes through generated l10n: `S.of(context).key` in widgets, or
`S.current.key` when there is no `BuildContext` (inside a VM, a converter, a
callback) — both are used heavily, pick by whether a `context` is in scope. No
hardcoded display strings (a literal inside `Text(...)`, an `AppBarWidget(title:
'…')`, a snackbar message, etc. is a violation). To add one:
1. Add the key to **both** `apps/mobile/lib/src/l10n/intl_en.arb` and `intl_fr.arb`
   — **every key must exist in BOTH arb files** (an EN-only key renders English
   under FR; an FR-only key fails the build).
2. Regenerate with **`intl_utils`** (this repo uses `flutter_intl`, NOT Flutter's
   built-in gen-l10n — `fvm flutter gen-l10n` will fail looking for `lib/l10n`):
   `cd apps/mobile && fvm dart run intl_utils:generate`. Config lives under
   `flutter_intl:` in `pubspec.yaml` (arb_dir `lib/src/l10n` → `lib/src/generated`).
3. Use `S.of(context).<key>`.

### 4a. Admin/DB-sourced vocabulary is STILL user-facing — localize it too
A value that arrives from Supabase/admin (a catalog `name` / `display_name` /
`description` column) is NOT exempt from l10n just because it isn't a Dart
literal. These columns are seeded in **English only** and have **no i18n
column**, so binding them straight into `Text(...)` ships English under FR — the
exact bug QC keeps filing (item types, delivery service levels, vehicle names —
<PROJECT_KEY>-2063). Don't add a DB i18n column for a small fixed vocabulary; mirror the
[[order_status_localizer]] precedent — a pure `localizedX(context, value)` helper
in `lib/src/utils/` that maps the canonical label to `S.of(context).<key>` and
**falls back to the raw value** so a brand-new admin entry still renders (just
untranslated) instead of blank. Then wire it at EVERY render site, not just the
picker (also the collapsed card, the booking summary, the courier/handling
screen, history/tracking/detail). Two traps:
- **Key on the English `name`, NOT the row `key`/`icon_key`.** Admins repurpose
  stable keys in prod (e.g. `vehicle_types.key = 'van'` was renamed to "Electric
  Scooter", `key = 'car'` → "Scooter"), so a key→l10n map mistranslates. The
  rendered English name is the only semantically reliable anchor — `_norm` it
  (`.trim().toLowerCase()`) and switch on that. **Verify the live vocabulary**
  (`select name,key from <catalog>`) before writing the map — never trust the
  seed migration.
- **Don't localize free-text that only LOOKS like a type.** A driver's
  `vehicleLabel` is `make + model` ("Toyota Vios"), not a catalog vehicle type —
  leave it raw. Only the catalog `name`/`display_name` goes through the helper.

## 5. Data binding — typed models only
Widgets read **typed model fields**, never `map['key']`. The query layer returns
models (RideModel, OrderModel, CourierOrderModel, DriverWalletModel, …); the VM
holds typed fields/lists; the page binds `provider.someModel.field`. If you find
yourself indexing a `Map<String,dynamic>` in a widget, the model/query is missing
a field — fix it there (see the `supabase-security-review` / model conventions),
don't dig the map in the UI.

## 6. Lists, empty & error states
- Pull-to-refresh: wrap in `AppRefreshIndicator(onRefresh: provider.refresh, …)`.
- Pagination: `PagedBuilder` / `PagedSliverList` with `infinite_scroll_pagination` (see trips/earnings pages).
- Empty: `ItemNoFound`. Error: `ServerError` / `PageError`. Loading: `AppLoading` / `AppCircularProgress`.

## 6a. Live-data widgets — re-sync on prop change, clean up subscriptions
These surfaces rebuild constantly from realtime pushes; a widget that snapshots
its props once, a subscription that leaks, or a getter overloaded across two UIs
each shipped a Sprint-7 QC bug that `analyze` never saw.

- **`didUpdateWidget` when a prop drives derived State.** A `StatefulWidget` with
  `late bool _expanded = widget.initiallyExpanded;` (or any `initState` snapshot)
  will **not** re-apply that prop when the parent rebuilds it in place — and a
  realtime status advance rebuilds the tree. Add `didUpdateWidget` to sync on the
  meaningful edge, respecting a user's manual override (e.g. open on
  false→true "active", don't force-collapse a still-open section). Give list
  items a **stable `ValueKey`** so State tracks the right item across rebuilds
  (`CollapsibleTimelineSection` had neither → the new active leg never opened).
- **Subscriptions dispose + don't leak.** Every `realtime.subscribeToX` in a VM
  needs a matching `unsubscribe` in `dispose()`. Re-subscribing the same key must
  tear down the old channel first (route through `RealtimeService._register`), or
  a VM that re-runs its load orphans a live channel for the app lifetime.
- **A realtime count handler applies the SAME filter as its server query.** The
  bell badge `+= 1` on every `notifications` INSERT while the count/feed excluded
  `type='message'` → phantom badge. Reuse the shared predicate.
- **One getter, one purpose.** Don't overload a getter that drives two surfaces
  with conflicting edge cases (`currentStop` fed both the highlight AND the
  address card) — split it. See [[express-realtime-review]] for the full lens.

## 7. Before you finish
- `cd apps/mobile && fvm flutter analyze` → zero errors AND warnings.
- **Run the self-audit scan on the files you touched** — `analyze` does NOT catch theme/l10n drift, so most non-compliant screens slipped in exactly here. Each line below must return nothing (except the noted exceptions):
  ```bash
  cd apps/mobile/lib/src
  F="<path/to/your_page.dart> <path/to/your_widget.dart>"   # only the files you changed
  grep -n  "Colors\." $F | grep -v transparent # hardcoded colors → AppColor.* (Colors.transparent is OK)
  grep -n  "Color(0x" $F                        # hex colors → AppColor.*
  grep -nE "TextStyle\(" $F                     # inline styles → context.appStyle.<token>(.copyWith)
  grep -nE "Text\([^,)]*\)" $F                  # Text without a style: arg → add context.appStyle.<token>
  grep -nE "SizedBox\((height|width):" $F       # spacer → 12.sizedHeight / 10.sizedWidth (OK if it has a child)
  grep -n  "Image.network" $F                   # → CachedImage / CachedImageCircle
  grep -nE "Text\(['\"]" $F                      # hardcoded copy → S.of(context)/S.current
  grep -nA1 "GestureDetector(" $F | grep -B1 "onTap"  # whole-card onTap? must have behavior: HitTestBehavior.opaque (else dead tap zones — <PROJECT_KEY>-2052)
  ```
- Re-check by hand: no map-indexing in widgets, reused existing components where possible, page follows the MixinBasePage pattern.
- Then hand off to the `bow-commit` skill to commit/push.
