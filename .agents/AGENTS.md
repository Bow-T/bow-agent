# Workspace Security Rules for Bow Agent

This document defines the agent rules and access boundaries based on execution ports and hosting modes:

## 1. Port & Mode Authorizations

* **Port 5173 / API 4000 (Dev Mode - Admin/Localhost)**:
  * **Level**: Full/Unrestricted permissions.
  * **Rights**: Complete filesystem access, unrestricted shell execution, directory selection, and settings modification.
  * **Applies to**: Local host owner on localhost/127.0.0.1.

* **Port 5174 / API 4001 (Safe Mode - read-only share)**:
  * **Level**: High restriction.
  * **Rights**: Read-only access to the specified repository. No terminal execution, no file writes, and no workspace folder switching by clients.
  * **Exception**: Localhost admin can change the Safe Cwd override from their panel.

* **Port 5175 / API 4002 (Collab Mode - interactive collaboration)**:
  * **Level**: Moderate restriction.
  * **Rights**: LAN clients (Collaborators) can submit chat tasks, but EVERY state-changing action (file edits/writes, ALL Bash commands, git operations, MCP writes) is held and approved in real-time by the localhost admin (`requireApprovalForWrites` routes all approvals to the admin bus). Only read-only verification commands (tests/analyze/status) auto-run. There is no longer a "git is free" carve-out — git operations require approval like any other write.

## 2. General Agent Guardrails

* Always enforce `requireAdmin` for directory browsing (`/api/browse-dirs`), repository/config updates (`/api/safe-cwd`, `/api/mcp`, `/api/workspace/*`), and repo-scanning agents (`/api/generate-profile`, `/api/analyze-structure`) across all backend hosts.
* Determine admin/access strictly from the real socket IP (`getSocketIp`, which ignores `X-Forwarded-For`) — never from `getCleanIp` (which trusts the proxy header and is display/log-only). Trusting the header lets a LAN client spoof `X-Forwarded-For: 127.0.0.1` to seize admin.
* Non-admin (non-localhost) clients are read-only by default: in normal mode they are forced to `plan`, and cannot pick an arbitrary `cwd`. Writes are possible only via Collab Mode, gated per-action by the admin.
* Always log user-specific names in audit logs (`memory/audit_share.log` and others) rather than generic IP records.
