---
name: working-style-agent-delegation
description: "How the user wants tasks delegated — default to a single agent, batch instructions, use plan mode, only fan out subagents for large verifiable work"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f357558f-6ca5-478c-9f75-bcde9cb6607b
---

The user agreed on a working agreement for how to delegate tasks to me.

**Why:** The user heard that spawning subagents to "self-review plan and self-run" avoids the back-and-forth of me asking questions one at a time. I clarified that subagents don't remove the need for clear instructions, and that a single agent is usually better.

**How to apply:**
1. **Default to a single agent (me).** Don't fan out subagents unless the task is large AND splittable into independent pieces AND machine-verifiable (tests/build/diff pass). I proactively suggest fanning out when I hit such a task.
2. **Encourage batched instructions** — when the user asks how to give me work, tell them to put everything in one message: what to do + constraints (libraries/API/what not to change) + what to do after (run tests/build), plus "decide small things yourself, note them, don't ask trivial questions."
3. **For work that needs certainty before coding → use plan mode** (I plan, user approves once, then I run straight through).
4. **Large/audit/multi-file work → only then fan out subagents.**

Key correction the user accepted: spawning subagents is NOT a substitute for clear task descriptions — output quality still depends on how clearly the task is specified. Vague task + subagent = it guesses without asking, which is worse.

Related: [[user-communicates-in-vietnamese]]
