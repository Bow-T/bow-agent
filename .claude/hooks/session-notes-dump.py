#!/usr/bin/env python3
"""PreCompact hook — ghi 'sổ tay phiên' ra .claude/session-notes.md trước khi context bị dọn.

Trích từ transcript: yêu cầu người dùng, file đã sửa, lệnh đáng nhớ, nhánh git.
Bản ghi này là context BỀN — sống sót qua compact, được SessionStart nạp lại.
"""
import json, os, subprocess, sys
from datetime import datetime

MAX_BLOCKS = 3          # giữ 3 mốc gần nhất
MAX_PROMPTS = 12        # số yêu cầu người dùng ghi lại
PROMPT_CHARS = 220      # cắt mỗi yêu cầu cho gọn

def read_event():
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}

def scan_transcript(path):
    prompts, files, branch = [], [], None
    if not path or not os.path.exists(path):
        return prompts, files, branch
    for line in open(path, errors="replace"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        branch = d.get("gitBranch") or branch
        msg = d.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        if d.get("type") == "user":
            origin = d.get("origin")
            # transcript cũ không có 'origin' → nhận diện bằng nội dung (không chứa tool block)
            if isinstance(origin, dict) and origin.get("kind") != "human":
                continue
            if any(isinstance(b, dict) and b.get("type") in ("tool_result", "tool_use") for b in content):
                continue
            for b in content:
                if isinstance(b, dict) and b.get("type") == "text":
                    t = " ".join(b.get("text", "").split())
                    if t and not t.startswith("<"):
                        prompts.append(t[:PROMPT_CHARS])
        elif d.get("type") == "assistant":
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") in ("Edit", "Write", "NotebookEdit"):
                    f = (b.get("input") or {}).get("file_path")
                    if f and f not in files:
                        files.append(f)
    return prompts, files, branch

def git_state(cwd):
    def run(*a):
        try:
            return subprocess.run(a, cwd=cwd, capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:
            return ""
    return run("git", "rev-parse", "--abbrev-ref", "HEAD"), run("git", "status", "--porcelain")

def main():
    ev = read_event()
    cwd = ev.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    notes = os.path.join(cwd, ".claude", "session-notes.md")
    if not os.path.isdir(os.path.dirname(notes)):
        return 0

    prompts, files, tbranch = scan_transcript(ev.get("transcript_path"))
    branch, dirty = git_state(cwd)
    branch = branch or tbranch or "?"

    L = []
    L.append("## %s · %s · nhánh `%s` · compact %s" % (
        datetime.now().strftime("%Y-%m-%d %H:%M"),
        (ev.get("session_id") or "?")[:8],
        branch,
        ev.get("trigger") or "?",
    ))
    ci = (ev.get("custom_instructions") or "").strip()
    if ci:
        L.append("")
        L.append("**Chỉ đạo compact:** %s" % " ".join(ci.split())[:400])
    if prompts:
        L.append("")
        L.append("### Yêu cầu người dùng trong phiên (theo thứ tự)")
        for p in prompts[-MAX_PROMPTS:]:
            L.append("- %s" % p)
    if files:
        L.append("")
        L.append("### File đã sửa")
        for f in files[:25]:
            L.append("- `%s`" % os.path.relpath(f, cwd))
    if dirty:
        lines = [x for x in dirty.splitlines() if x.strip()]
        L.append("")
        L.append("### Git chưa commit (%d file)" % len(lines))
        for x in lines[:20]:
            L.append("- `%s`" % x.strip())
    L.append("")

    block = "\n".join(L)
    HEADER = "# Sổ tay phiên (tự sinh bởi PreCompact hook — đừng sửa tay)\n"
    old = ""
    if os.path.exists(notes):
        old = open(notes, errors="replace").read()
        if old.startswith(HEADER):
            old = old[len(HEADER):]
    blocks = [b for b in old.split("\n## ") if b.strip()]
    kept = ("\n## " + "\n## ".join(b.rstrip() for b in blocks[:MAX_BLOCKS - 1])) if blocks else ""
    with open(notes, "w") as fh:
        fh.write(HEADER + "\n" + block + kept.lstrip("\n") + "\n")

    print(json.dumps({"systemMessage": "🧠 Đã ghi sổ tay phiên → .claude/session-notes.md (%d yêu cầu, %d file)" % (len(prompts), len(files))}))
    return 0

if __name__ == "__main__":
    sys.exit(main())
