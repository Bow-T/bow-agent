---
name: octopus-model
description: Write Octopus data models and parsing the project way — every model is a @JsonSerializable class with a part '*.g.dart' file and _$FromJson/_$ToJson, dates/ints/enums go through the shared Utilities converters and @JsonValue enums, and build_runner regenerates the .g.dart. NEVER hand-write fromJson/toJson/fromMap, never index map['key'] in app code, never edit generated files. Use when creating or editing anything under apps/mobile/lib/src/models, when parsing an API/Supabase payload, when adding a field/enum, or when "gen" output (.g.dart/.gr.dart) is involved. Pairs with [[octopus-ui]].
---

# Octopus Model — data the generated way

Goal: every model parses, serialises and type-checks like the 54 existing ones.
**If a generator exists, generate — never hand-write what build_runner produces.**
The data layer is where "didn't follow base source" hurts most: a hand-rolled
`fromMap` silently drifts from the payload and crashes at runtime, not at analyze.

Stack (`apps/mobile/pubspec.yaml`): `json_annotation` + `json_serializable` +
`build_runner`. 54 / 56 models already follow this. Match them.

## 1. The canonical model shape — copy this every time
```dart
import 'package:json_annotation/json_annotation.dart';
import 'package:octopus/src/utils/enum.dart';
import 'package:octopus/src/utils/utils.dart';

part 'foo_model.g.dart';                       // 1. part file = <name>.g.dart

@JsonSerializable(includeIfNull: false, explicitToJson: true)   // 2. standard annotation
class FooModel {
  @JsonKey(name: 'id') int? id;                // 3. explicit server key on EVERY field
  @JsonKey(name: 'productId') String? productId;
  @JsonKey(name: 'status') SubscriptionStatus? status;          // 4. enum, not String

  @JsonKey(name: 'startedAt', fromJson: Utilities.fromJsonDate, // 5. dates via Utilities
           toJson: Utilities.toJsonDate)
  DateTime? startedAt;

  @JsonKey(includeFromJson: false, includeToJson: false)        // 6. computed/UI-only field
  bool isSelected = false;

  FooModel();

  factory FooModel.fromJson(Map<String, dynamic> json) =>      // 7. delegate to generated code
      _$FooModelFromJson(json);
  Map<String, dynamic> toJson() => _$FooModelToJson(this);
}
```
Reference: [subscription_model.dart](apps/mobile/lib/src/models/subscription_model.dart).

## 2. Always use the shared converters — never reparse by hand
`Utilities` (`lib/src/utils/utils.dart`) already has every converter. Use them in
`@JsonKey(fromJson:/toJson:)`, do NOT write `DateTime.parse` / `int.tryParse` inline:
- Dates: `fromJsonDate` / `toJsonDate` (also `fromJsonDateLoose`, `fromJsonDateLocal`, `fromJsonDateOrNow`)
- Ints: `fromJsonIntOrZero`, `fromJsonIntOrNull`
- Doubles: `fromJsonDouble`, `fromJsonDoubleOrNull`
- Color: `fromJsonColor` / `toJsonColor` · Duration: `fromJsonDuration` / `toJsonDuration` · Uint8List: `fromJsonUint8List` / `toJsonUint8List`

If a needed converter is missing, add it to `Utilities` (so it's reused), not inline in the model.

## 3. Enums are generated too
Define enums in [enum.dart](apps/mobile/lib/src/utils/enum.dart) with `@JsonValue`, and
let codegen map them. Never `switch`/`if` on raw strings to parse an enum.
```dart
enum SubscriptionStatus {
  @JsonValue('inactive') inactive,
  @JsonValue('active') active,
  @JsonValue('expired') expired,
}
```
The field is then just `SubscriptionStatus? status` — the generator does the mapping.

## 4. Nested models & lists
Keep `explicitToJson: true` so nested `toJson()` is called. Nested fields are typed
models / `List<XxxModel>`, never `Map`/`dynamic`. The generator recurses automatically
as long as the nested type is itself a `@JsonSerializable` model.

## 5. Regenerate — the step people skip
After adding/editing ANY model, field, converter, or enum:
```bash
cd apps/mobile && fvm flutter pub run build_runner build --delete-conflicting-outputs
```
- Commit the regenerated `*.g.dart` alongside the model (54 are tracked — keep parity).
- **Never hand-edit `*.g.dart`.** It's overwritten on the next run.
- Same rule for other generators: router `*.gr.dart` (auto_route — see [[octopus-ui]] §routing) and l10n. "Gen" means gen: change the source, run build_runner, commit the output.
- Then `fvm flutter analyze` must be clean before commit (see [[octopus-commit]]).

## 6. Consume models type-safely
App code (VMs, widgets, queries) reads **typed fields**: `model.status`, `model.price`.
If you find yourself writing `json['key']` or `map['price']` outside a model's parse
layer, the model is missing — add the field instead of indexing a map. See [[octopus-ui]] §typed models.

## Red flags — stop and fix before commit
- ✗ `factory X.fromJson` / `fromMap` with a **hand-written body** (not `_$XFromJson`). → annotate `@JsonSerializable`, add `part`, run build_runner.
- ✗ A model `.dart` with **no matching `.g.dart`**. → it's not generated; convert it.
- ✗ Inline `DateTime.parse`, `int.tryParse`, manual enum string-switch in a model. → use `Utilities` / `@JsonValue`.
- ✗ Editing a `*.g.dart` by hand, or committing a model without regenerating. → change source, rerun build_runner.
- ✗ `map['key']` indexing in a VM/widget. → expose a typed field.
- Known deviations to migrate when touched: `support_category_model.dart`, `vehicle_type_catalog_model.dart` (hand-written `fromJson`). Immutable models are fine — `@JsonSerializable` supports a `const` constructor; use `createToJson: false` if read-only.

**Reuse the pattern before you invent one. Generate before you hand-write.**