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
  * **Rights**: LAN clients (Collaborators) can submit chat tasks and run standard code/git commands, but any potentially destructive commands (e.g., deletions, deployment commands, modifications outside the designated repository) must be held and approved in real-time by the localhost admin.

## 2. General Agent Guardrails

* Always enforce `requireAdmin` for directory browsing (`/api/browse-dirs`) and repository configuration updates (`/api/safe-cwd`) across all backend hosts.
* Ensure client IP validation (`X-Forwarded-For` proxy header resolution) is consistently handled via `getCleanIp` to prevent IP spoofing or bypasses.
* Always log user-specific names in audit logs (`memory/audit_share.log` and others) rather than generic IP records.
