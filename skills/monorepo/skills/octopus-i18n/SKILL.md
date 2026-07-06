---
name: octopus-i18n
description: Make every user-facing string in the <PROJECT_KEY> mobile app render in the active language (EN/FR) — both hardcoded literals AND admin/DB-sourced vocabulary (catalog name/display_name/description, status, type, category, payment method, rejection reason). Use when adding or editing any UI copy, when binding a Supabase/admin column into Text/title/label/snackbar, when adding an enum/status/vocabulary value, or when QA files a "Missing French Translations" / "still in English under FR" bug. Catches the class of bug that static analysis and unit tests never see. Pairs with [[octopus-ui]] and the localizedX helpers in lib/src/utils.
---

# Octopus i18n — nothing user-facing ships in one language

The app ships EN + FR. `fvm flutter analyze` and unit tests are **blind** to
localization: an English literal and a French one compile identically. So the
"it's still in English under FR" bug (<PROJECT_KEY>-1963, <PROJECT_KEY>-2063, and the recurring
QA filings) only ever surfaces in manual QA — unless you apply the rules below
*before* QA does. **Every string a user can read must resolve through l10n.**

## 1. Two sources of user-facing copy — BOTH must localize

### A. Literals in code
Any display string written in source — `Text('Confirm')`, `AppBarWidget(title:
'Vehicle')`, `showError('This variant is out of stock.')`, `hintText: 'Search'`,
a `switch` arm `=> 'Pending'`. These go through generated l10n: `S.of(context).key`
in a widget, `S.current.key` in a VM/converter/callback (pick by whether a
`BuildContext` is in scope). A display literal with no `S.` is a violation.

### B. Vocabulary that arrives from Supabase / admin — the trap
A value read from a DB column (`name`, `display_name`, `description`, `status`,
`type`, `category`, payment `type`, rejection `reason`, …) is **just as
user-facing** as a literal, but it's easy to miss because it isn't quoted in
your source — you wrote `Text(model.name)`, not `Text('Scooter')`. These columns
are seeded **English-only with no i18n column**, so binding one straight into the
UI ships English under FR. This is the exact class of bug QA keeps filing.

**Tell-tale smells of an un-localized DB value (grep for these):**
- `Text(x.name)` / `title: x.displayName` / `label: x.status` / `x.category` /
  `x.type` / `x.label` bound to a model field with no `localizedXxx(...)` wrapper.
- `value.replaceAll('_', ' ')` or `.replaceAll('_', ' ').toUpperCase()` used to
  "humanize" a stored enum for display — that de-snake-cases instead of
  translating, so `same_day` shows "Same day" in French too.
- A `switch (status) { 'pending' => 'Pending', … }` returning English literals
  (a localizer keyed on the value should return `l10n.…` instead).

## 2. The fix pattern — a `localizedX` helper (NOT a DB i18n column)

For a small, fixed vocabulary (a handful of statuses, types, tiers, categories),
do NOT add `name_fr` columns + admin translation UI. Mirror the established
precedent — `lib/src/utils/order_status_localizer.dart` and
`lib/src/utils/vocabulary_localizer.dart`:

```dart
String localizedThing(BuildContext context, String? value) {
  if (value == null || value.trim().isEmpty) return '';
  final l10n = S.of(context);
  switch (value.trim().toLowerCase()) {          // _norm: tolerate case/whitespace
    case 'priority': return l10n.expressOptionPriority;
    case 'fast':     return l10n.expressOptionFast;
    // … every known value
    default:         return value;               // fall back to raw, never blank
  }
}
```
Rules that make this correct and durable:
- **Pure function, `(BuildContext, value) -> String`** in `lib/src/utils/`.
  Unit-test it with a pumped `MaterialApp` + `S.delegate` (see
  `vocabulary_localizer_test.dart` for the exact harness).
- **Fallback to the raw value**, so a brand-new admin-added entry renders
  untranslated rather than blank or crashing.
- **Key on the canonical English value, NOT the row `key`/`icon_key`.** Admins
  repurpose stable keys in prod (e.g. `vehicle_types.key = 'van'` was renamed to
  "Electric Scooter", `key = 'car'` → "Scooter"), so a key→l10n map mistranslates.
  The rendered English name is the only reliable anchor. **Verify the live
  vocabulary first** (`select name,key,type from <catalog>`) — never trust the
  seed migration; see [[verify-runtime-not-just-static-green]].
- **Display is separate from storage.** Localize only the label shown; keep
  persisting / comparing / sending the raw English value (e.g. the item draft
  stores `name`, the chip shows `localizedItemType(ctx, name)`).
- **Don't localize free-text that only looks like vocabulary.** A driver's
  `vehicleLabel` is `make + model` ("Toyota Vios"); a user's typed note is prose.
  Only fixed catalog/enum vocabulary goes through a helper.

## 3. Adding an l10n key (this repo uses `intl_utils`, not gen-l10n)
1. Add the key to **BOTH** `apps/mobile/lib/src/l10n/intl_en.arb` **and**
   `intl_fr.arb`. An EN-only key renders English under FR; an FR-only key fails
   the build. (Parity check: the key counts in the two files must match.)
2. Regenerate with **intl_utils** — `fvm flutter gen-l10n` will FAIL here (it
   looks for `lib/l10n`); the repo is configured under `flutter_intl:` in
   `pubspec.yaml` (arb_dir `lib/src/l10n` → `lib/src/generated`):
   ```bash
   cd apps/mobile && fvm dart run intl_utils:generate
   ```
3. Use `S.of(context).<key>` / `S.current.<key>`. Reuse an existing key when the
   copy already exists (e.g. `expressOption*`, `bookingStatus*`, `category*Title`,
   `courierType*`) instead of adding a duplicate.

## 4. Existing localizers — reuse before writing a new one
- **Order / booking / ride / express status** → `localizedOrderStatus(context, OrderHistoryCategory.X, status)` and `localizedSupportBookingStatus` (`utils/order_status_localizer.dart`).
- **Item type / delivery service level (+desc) / vehicle name** → `localizedItemType` / `localizedServiceLevel` / `localizedServiceLevelDesc` / `localizedVehicleName` (`utils/vocabulary_localizer.dart`).
- If a NEW vocabulary needs localizing (payment method, store/item category, KYC/vehicle rejection reason, legacy `delivery_option`, transaction type), add a `localizedX` helper in `utils/` following §2 — don't inline a `switch` of English literals in the widget.

## 5. Self-audit before you finish — analyze can't see this
Run on the files you touched (each should return nothing but the noted OK cases):
```bash
cd apps/mobile/lib/src
F="<files you changed>"
grep -nE "Text\(\s*['\"][A-Za-z]" $F                  # literal in Text() → S.of/S.current
grep -nE "(title|label|hintText|message):\s*['\"][A-Za-z]" $F   # literal UI param
grep -nE "show(Error|Success|Info|Warning)\(\s*['\"][A-Za-z]" $F # literal snackbar/toast
grep -nE "=> '[A-Z][a-z]+" $F                          # switch arm returning English literal
grep -nE "replaceAll\('_', ' '\)" $F                  # de-snake-case "humanize" of a stored enum → localizer
grep -nE "Text\(\s*[a-zA-Z_.]+\.(name|title|label|status|type|category|description)\b" $F  # raw DB field in Text()
```
Then confirm by hand: EN/FR arb parity holds, every new key exists in both
files, and any DB value rendered goes through a `localizedX` (or `S.`), not raw.
A finished i18n change = the grep lines clean + a localizer unit test green +
visually correct under FR — **not** "analyze passed".

## 6. Report honestly
State which surfaces you localized, which vocabulary, how many render sites you
swept (this is cross-cutting — see [[impact-sweep]]), and call out anything left
raw on purpose (free-text make+model, technical Stripe identifiers like
"PaymentIntent", brand names like "Octopus", language autonyms "English"/"Français").
