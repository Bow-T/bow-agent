# Workspace Security Rules for Bow Agent

This document defines the agent rules and access boundaries based on execution ports and hosting modes:

## 1. Port & Mode Authorizations

* **Port 5173 / API 4000 (Dev Mode - Admin/Localhost)**:
  * **Level**: Full/Unrestricted permissions.
  * **Rights**: Complete filesystem access, unrestricted shell execution, directory selection, and settings modification.
  * **Applies to**: Local host owner on localhost/127.0.0.1.

* **Port 5174 / API 4001 (QC Mode - read-only + Skill + Jira)**:
  * **Level**: High restriction.
  * **Rights**: Read-only access to the repository source. The `Skill` tool (e.g. qc-triage) and Jira read/write (comment/transition tickets) are allowed; everything else — terminal execution, file writes, non-Jira MCP writes, workspace switching — is denied.
  * **Exception**: Localhost admin can change the QC Cwd override from their panel.

* **Port 5175 / API 4002 (Collab Mode - interactive collaboration)**:
  * **Level**: Moderate restriction.
  * **Rights**: LAN clients (Collaborators) can submit chat tasks, but EVERY state-changing action (file edits/writes, ALL Bash commands, git operations, MCP writes) is held and approved in real-time by the localhost admin (`requireApprovalForWrites` routes all approvals to the admin bus). Only read-only verification commands (tests/analyze/status) auto-run. There is no longer a "git is free" carve-out — git operations require approval like any other write.

* **Port 5177 / API 4004 (Reviewer Mode - read-only + PR review)**:
  * **Level**: High restriction.
  * **Rights**: Read-only access to the repository source. Allowed: the `Skill` tool (pr-review), read-only git/gh commands (`git diff/status/log/show`, `gh pr view/diff/list/checks`), PR review writes (`gh pr comment`, `gh pr review`), test/analyze (`SAFE_COMMANDS`), and Jira reads. Denied: any file write to source, `gh pr merge/close/edit`, `git push/commit`, risky/chained Bash, non-Jira MCP writes, and workspace switching.
  * **Exception**: Localhost admin can change the Reviewer Cwd override from their panel.

## 2. General Agent Guardrails

* Always enforce `requireAdmin` for directory browsing (`/api/browse-dirs`), repository/config updates (`/api/qc-cwd`, `/api/mcp`, `/api/workspace/*`), and repo-scanning agents (`/api/generate-profile`, `/api/analyze-structure`) across all backend hosts.
* Determine admin/access strictly from the real socket IP (`getSocketIp`, which ignores `X-Forwarded-For`) — never from `getCleanIp` (which trusts the proxy header and is display/log-only). Trusting the header lets a LAN client spoof `X-Forwarded-For: 127.0.0.1` to seize admin.
* Non-admin (non-localhost) clients are read-only by default: in normal mode they are forced to `plan`, and cannot pick an arbitrary `cwd`. Writes are possible only via Collab Mode, gated per-action by the admin.
* Always log user-specific names in audit logs (`memory/audit_share.log` and others) rather than generic IP records.
