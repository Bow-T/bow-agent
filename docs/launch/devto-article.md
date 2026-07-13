---
title: "I gave my whole team an AI coding agent — behind a permission gate"
published: false
description: "One agent core, six role-based permission modes, and exactly one function that decides whether a write happens. Plus the four security holes I had to patch to make that true."
tags: ai, opensource, devops, security
canonical_url:
---

Every AI coding agent I've used ships with exactly one trust level: **full access**.

That's fine when the only user is me, in my terminal, watching every tool call scroll by. It stops being fine the moment someone else on the team wants in.

My QC engineer wanted to ask questions about the codebase before writing a bug report. My BA wanted to draft specs against the actual schema instead of guessing. A contractor needed to ship a feature. All of them asked me the same thing, and my answer was always some version of "paste me the file and I'll ask the agent for you."

I had turned myself into a human API for my own codebase.

The obvious fix — give everyone their own agent — meant handing a shell, `Edit`, and a live Supabase connection to five people I could not watch. So I built the boring alternative: **one agent core, and a permission gate everyone else works through.** It's called [bow-agent](https://github.com/Bow-T/bow-agent), it's MIT, and the interesting part isn't the product. It's the four ways I found to walk around my own gate.

---

## The design: exactly one gate

The Claude Agent SDK exposes a `canUseTool` callback. Every tool call the model wants to make — file edit, shell command, MCP call — goes through it, and you return `allow` or `deny`.

So the whole design collapses to one rule:

> **Reads run free. Every write goes through `canUseTool`. There is no second path.**

That's it. `src/core/runner.ts` has one function that decides whether anything happens to your disk, your shell, or your database. If you want to audit this project, you read that one function. If it's wrong, everything is wrong — but at least you know where to look.

Six role modes sit on top of the same gate, each on its own port, each just a different policy inside that one function:

| Mode | Who | Can do | Cannot do |
|---|---|---|---|
| Dev | me | everything, with approval | — |
| QC | QA | read source, triage + comment Jira | touch a line of code |
| Collab | contractors | write code, run tests | any write — *including git* — without my approval |
| BA | analysts | write `docs/`, `*.md`, full Jira | source, DB, deploy (hard denied) |
| Reviewer | tech leads | read code, `gh pr comment` / `gh pr review` | edit, merge, push |
| DevOps | infra | write Dockerfile / workflows / `*.tf` / k8s | app source; deploy is routed to me |

Sounds clean. It was not clean. Here is what I actually found.

---

## Hole 1: `Bash` walks around a hard-denied `Edit`

BA mode hard-denies file writes to anything that isn't a document. The check is straightforward — `src/core/runner.ts`:

```ts
/** Tool sửa/ghi file (trong repo). */
const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
```

Deny those four, and the agent cannot write source code. Right?

No. Because `Bash` is a tool too, and `sed -i` is a file editor.

DevOps mode deliberately allows `Bash` — you cannot deploy anything without a shell. So an agent in DevOps mode, hard-denied from `Edit`ing `src/auth.ts`, can simply run:

```bash
sed -i '' 's/requireAuth()/\/\/ requireAuth()/' src/auth.ts
```

Same write. No `Edit` tool involved. And critically, this command matches **none** of my "risky command" patterns — there's no `rm`, no `mv`, no output redirect. It sails through as a normal, boring shell command.

`git apply` does it. `patch` does it. `perl -i` does it. `ed`. `awk` with a redirect. So the fix is a second class of Bash command that is neither "safe" nor "destructive" — it's *"quietly writes to an arbitrary path"*:

```ts
// src/core/runner.ts
const INPLACE_FILE_EDIT_COMMANDS = [
  /(?:^|[\s;&|(])sed\s+[^\n]*-i/,            // sed -i / -i'' (GNU & BSD)
  /(?:^|[\s;&|(])perl\s+[^\n]*-i/,           // perl -i -pe
  /(?:^|[\s;&|(])ruby\s+[^\n]*-i/,           // ruby -i
  /(?:^|[\s;&|(])patch(?=$|[\s/])/,          // patch (incl. `patch f < diff`)
  /(?:^|[\s;&|(])git\s+apply\b/,             // git apply <diff>
  /(?:^|[\s;&|(])git\s+checkout\s+-p\b/,     // git checkout -p (applies hunks)
  /(?:^|[\s;&|(])(ex|ed)\s+-/,               // ex -sc / ed - (editor scripts)
  /(?:^|[\s;&|(])install\s+[^\n]*\s[^\s]/,   // install <src> <dst>
  /(?:^|[\s;&|(])(awk|gawk)\s+/,             // awk (output usually redirected)
];

const isInPlaceFileEdit = (cmd: string): boolean =>
  INPLACE_FILE_EDIT_COMMANDS.some((re) => re.test(cmd));
```

And in the DevOps branch of `canUseTool`, these **always** stop at the gate — including for the admin, including in `auto` mode:

```ts
if (toolName === 'Bash' && typeof input.command === 'string') {
  const cmd = input.command.trim();
  if (isInPlaceFileEdit(cmd) && isExecuting && opts.onApproval) {
    const approved = await opts.onApproval(toolName, input, {
      decisionReason:
        'DevOps Mode: lệnh sửa file tại chỗ/áp patch (sed -i, patch, git apply…) ' +
        'có thể ghi vào source — cần xác nhận không đụng code ứng dụng.',
    });
    return approved ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', ... };
  }
}
```

Why always, even for me? Because **you cannot tell from a command string whether the target is a Dockerfile or `auth.ts`.** `sed -i 's/x/y/' "$F"` is unresolvable. The only honest answer is: stop, show the human the command, let them decide.

The general lesson, which cost me the most: **your deny-list is only as strong as the most expressive tool you left enabled.** Denying `Edit` while enabling `Bash` is denying the front door while leaving the shell open.

---

## Hole 2: `auto` mode auto-approved `DROP TABLE`

Modes have an execution level. `auto` means "edit files in the repo and run safe commands without pestering me" — which is exactly what you want when you're the admin and you're watching.

The problem: MCP write tools were falling into that same auto-allow bucket. `mcp__supabase__execute_sql`. `mcp__supabase__apply_migration`. Against the **real** database.

In `auto`, one sentence in a prompt was one `execute_sql` away from a schema change nobody reviewed. The agent doesn't need to be malicious for this to hurt — "clean up the orphaned rows" is a perfectly reasonable-sounding instruction with a perfectly unrecoverable implementation.

So MCP writes are excluded from `auto` entirely. They always gate — not just for LAN contributors, but for the admin on localhost:

```ts
// src/core/runner.ts — DevOps branch. Same defense-in-depth idea in BA mode.
// MCP write (execute_sql/apply_migration…) — DEFENSE-IN-DEPTH: KHÔNG để admin
// auto-allow DROP TABLE ở 'auto'.
if (
  toolName.startsWith('mcp__') &&
  !/(?:^|__)(?:list|get|search|describe|read|show|fetch)/i.test(toolName) &&
  isExecuting &&
  opts.onApproval
) {
  const approved = await opts.onApproval(toolName, input, {
    decisionReason: `DevOps Mode: thao tác MCP "${toolName}" có thể đổi DB/hạ tầng — cần xác nhận.`,
  });
  return approved ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', ... };
}
```

Note the shape of the check: it's an **allow-list of read verbs** (`list|get|search|describe|read|show|fetch`), and everything else is treated as a write. Not a deny-list of dangerous MCP tools — I don't know what MCP servers you're going to plug in, and neither does the code. Unknown tool → treated as a write → gated.

---

## Hole 3: `Read` was auto-approved, so my secret-file check never ran

This one is embarrassing, and it's the kind of bug you only find by reading the code with hostile intent.

`Read` and `Grep` are read-only. Obviously safe. So they were auto-approved by a `PreToolUse` hook, which short-circuits *before* `canUseTool` ever fires:

```ts
const readAutoTools = [
  'Read', 'Grep', 'Glob',
  ...mcpReadToolPatterns(mcpNames),
];
```

Meanwhile, inside `canUseTool`, I had a careful check that blocks reads of sensitive paths:

```ts
// src/core/runner.ts
const isSensitivePath = (p: string): boolean => {
  const t = p.toLowerCase();
  return (
    t.includes('.env') ||
    t.includes('.git-credentials') ||
    t.includes('.npmrc') ||
    t.includes('.netrc') ||
    t.endsWith('.pem') ||
    t.endsWith('.key') ||
    t.includes('id_rsa') ||
    t.includes('/.ssh/') ||
    t.includes('.aws/') ||
    t.includes('.kube/') ||
    t.includes('.docker/config') ||
    t.includes('credentials.json') ||
    t.includes('service-account') ||
    /(^|[\/\\])secrets?[\/\\]/.test(t) ||
    // …
  );
};
```

That check was dead code in the modes that needed it most. A QC engineer's agent — the *least* trusted role in the system — could `Read` `.env` and print your production database URL into a chat window, because `Read` never reached the function that would have stopped it.

The fix is one line, and it's the whole point of this section:

```ts
// QC/Reviewer/DevOps Mode: do NOT auto-approve Read/Grep — let them fall
// into canUseTool so the sensitive-file check actually runs.
const readAutoTools = [
  ...(isQcMode || isReviewerMode || isDevOpsMode ? [] : ['Read', 'Grep']),
  'Glob',
  ...(subagents ? ['Agent'] : []),
  ...mcpReadToolPatterns(mcpNames),
];
```

`Glob` stays auto-approved — it returns filenames, not contents. `Grep` is denied outright in QC and Reviewer mode, because a matching line *is* file contents, and `grep -r 'KEY' .` is a great way to exfiltrate a secret one line at a time.

**A guard that runs after a fast path is not a guard.** I had written the security check and shipped the bypass in the same file.

---

## Hole 4: `X-Forwarded-For: 127.0.0.1` made you the admin

Admin in bow-agent means localhost. You're at the machine; you get to approve things. Everyone else is on the LAN and has to ask.

Here's how the client IP used to be resolved — and this code still exists, for a reason:

```ts
// src/web/server.ts
/** IP client cho HIỂN THỊ/LOG. Tin x-forwarded-for (lấy IP đầu) để log đúng IP sau proxy.
 *  KHÔNG dùng cho quyết định quyền — header này client tự đặt được. */
function getCleanIp(req: express.Request): string {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (Array.isArray(ip)) ip = ip[0];
  let cleanIp = typeof ip === 'string' ? ip : '';
  if (cleanIp.includes(',')) {
    cleanIp = cleanIp.split(',')[0].trim();
  }
  return normalizeIp(cleanIp);
}
```

`X-Forwarded-For` is a header. Headers are set by clients. So:

```bash
curl -H 'X-Forwarded-For: 127.0.0.1' http://192.168.1.50:4002/api/admin/approve -d '{"id":"...","approved":true}'
```

Anyone on the LAN was one `curl` away from being the admin — and could approve *their own* pending write requests.

The fix is to have two functions with two jobs, and to never confuse them:

```ts
// src/web/server.ts
/** IP THẬT của kết nối socket — KHÔNG tin bất kỳ header nào (x-forwarded-for giả mạo được).
 *  Đây là mốc DUY NHẤT để xác định admin (localhost). */
function getSocketIp(req: express.Request): string {
  return normalizeIp(req.socket.remoteAddress || '');
}

/** Admin = truy cập từ localhost. Dùng getSocketIp (IP socket THẬT). */
function isAdminReq(req: express.Request): boolean {
  return getSocketIp(req) === '127.0.0.1';
}
```

`getCleanIp` still exists — it's fine for logs, where a spoofed value is a lie in a log file, not a privilege escalation. `getSocketIp` is the only thing allowed near an authorization decision. The socket's peer address is the one value in an HTTP request that the client cannot forge.

Same class of bug bit the access-token flow: access records are bound to `getSocketIp`, because binding them to a spoofable header lets an attacker collide with someone else's approved session.

---

## The lesson: capability, not policy

Every one of those four holes has the same shape. In each case I had *told* the agent not to do something — via a mode, a prompt, a deny-list — and left it *able* to do it anyway.

- I denied `Edit`, and left `sed -i` reachable.
- I said "auto mode is only for safe things", and left `execute_sql` in the safe bucket.
- I wrote a secret-file check, and put a fast path in front of it.
- I said "admin means localhost", and read localhost from a client-supplied string.

An LLM is not an attacker. But it is a very fast, very literal, extremely creative path-finder, and it will find the reachable path — not the one you intended, the one that exists. Which makes the design rule simple, if unglamorous:

> **Don't tell the agent not to do X. Make X unreachable.**

Concretely, that means: one gate, no fast paths in front of it, allow-lists instead of deny-lists for anything you don't fully enumerate, and every authorization decision built on a value the client cannot set. A QC engineer's agent doesn't *decline* to edit files. It has no file-write tool at all.

---

## Where it is now

[**github.com/Bow-T/bow-agent**](https://github.com/Bow-T/bow-agent) — MIT. Node ≥ 18, uses your existing Claude CLI login (no API key, no server of mine in the middle, code never leaves your machine).

```bash
git clone https://github.com/Bow-T/bow-agent.git
cd bow-agent && npm install && npm run ui
```

Honest limitations, stated up front:

- **Claude only.** It's built on the Claude Agent SDK. The gate itself is model-agnostic in principle, but I built on what I use daily. This is the thing I'd most like help with.
- **LAN only.** "Approve by name on the local network" is not real auth. It's enough for a team in one office. I would not expose it to the internet, and the README says so. Real auth is an open issue.
- **It's not a sandbox.** A container stops the agent from wrecking your *machine*. This stops it from writing what it shouldn't and lets a human see the diff first. They compose; run this inside a container if you like.
- **Some comments are still Vietnamese.** It started as an internal tool. Translation PRs are the easiest possible contribution.

And the question I most want answered: **if you find hole number five, please tell me.** Open an issue, or reach out privately if it's serious. Four is what I found by reading my own code adversarially for a week. I don't believe it's the total.
