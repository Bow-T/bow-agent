---
name: codemagic-build-prod
description: Trigger a Codemagic production build of the mobile app on the develop branch (production-flavor APK → Firebase App Distribution). Use when the user says "build production trên develop codemagic", "build production codemagic", "build prod develop", "build APK production", or otherwise asks to kick a Codemagic production/Firebase build.
---

# Codemagic — Build Production (develop → Firebase)

Trigger a **production-flavor** build of `apps/mobile` on Codemagic via the
`codemagic` MCP. Result: `app-production-release.apk` (built from
`lib/app/main_prod.dart` + `.env`) distributed to **Firebase App Distribution**
(tester group `du-test`). The Slack `notify_slack_success` step updates a single
"latest build" message in place.

> This is the **Firebase** production path. It is NOT Google Play / TestFlight —
> those are the `android-play` / `ios-testflight` workflows, triggered by
> `release/*` tags, and are out of scope here.

## Steps

### 1. Trigger the build — `mcp__codemagic__trigger_build`
Call with EXACTLY these arguments:

| arg | value | why |
| --- | --- | --- |
| `app_id` | `6a2fd0d4a19317a8091fcc73` | the registered app "monorepo" |
| `workflow_id` | `android-firebase` | the yaml workflow key (does NOT show in `list_workflows` until first run — pass the string directly) |
| `branch` | `develop` | default build branch (override only if the user names another) |
| `variables` | `{"FLAVOR": "production"}` | overrides the workflow's default `FLAVOR: development` so it builds the **production** flavor |
| `instance_type` | `mac_mini_m2` | **REQUIRED.** The Codemagic token is a personal account (no team) → `linux_x2`/`linux_x4`/`mac_mini_m4` are unavailable and the build dies in ~15s with 0 steps. The yaml defaults `android-firebase` to `linux_x2`, so this override is mandatory. macOS builds Android fine. |

If the user asks for **iOS through Firebase** instead, use `workflow_id: ios-firebase`
(already `mac_mini_m2` in the yaml — no `instance_type` override needed).

### 2. Confirm it actually started — `mcp__codemagic__get_build`
Pass the returned build ID. A healthy build reaches `initializing` → `fetching`
→ `building`. If it shows `failed` with **"not started"** and **0 steps in ~15s**,
the instance type was rejected — re-trigger making sure `instance_type` is
`mac_mini_m2`.

### 3. Report
Give the user the build URL
(`https://codemagic.io/app/6a2fd0d4a19317a8091fcc73/build/<id>`), the status, and
note it takes ~10–12 min → production APK on Firebase (group `du-test`). Offer to
poll and report when finished (artifact link + Slack confirmation).

## Notes
- Codemagic reads `codemagic.yaml` **from the branch being built** — a change to
  the build/Slack config only takes effect once it is merged into `develop`.
- Before triggering a fresh build, if a prior identical build is still running,
  point the user to it instead of spawning a duplicate (avoids double Firebase
  upload + Slack races).
