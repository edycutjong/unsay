#!/usr/bin/env python3
"""Pre-submission gate. Every check is verifiable AT SUBMIT TIME.

LESSONS R13: "A gate whose evidence is a sentence describing an intention is a lie
you will believe." DelegAI ticked X Post and Feedback as complete on day one,
describing intentions as done. Both were worth $100 and a winner slot; neither was
ever fired.

So: no check here asks whether something was *planned*. Every one is a file that
exists, a command that exits 0, a grep that hits, or a URL that returns 200.

Exit 0 = safe to submit. Exit 1 = do not submit.

Side effect, deliberately: this regenerates ARCHITECTURE.md in order to diff it. If the
working tree is dirty afterwards, that IS the finding — the committed copy had drifted
from the code it claims to be generated from.
"""
import json, os, re, subprocess, sys, tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails, warns = [], []

def read(p):
    fp = os.path.join(ROOT, p)
    return open(fp, encoding="utf-8").read() if os.path.isfile(fp) else None

def check(name, ok, detail="", warn_only=False):
    mark = "PASS" if ok else ("WARN" if warn_only else "FAIL")
    print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        (warns if warn_only else fails).append(name)

print("unsay · submission readiness\n")

# ── required files ─────────────────────────────────────────────────────────────
print("required artifacts")
for f in ["README.md", "LICENSE", "DEMO.md", "FRICTION.md", "ARCHITECTURE.md", ".env.example",
          "docs/proof/live_run.jsonl", "docs/proof/bench.txt", "docs/proof/resume.json",
          "scripts/bench.ts", "scripts/verify.ts", "scripts/serve.ts",
          "scripts/fresh_clone_check.sh"]:
    check(f, os.path.isfile(os.path.join(ROOT, f)))

# FRICTION.md must be at ROOT, not docs/ (R12 mechanical fix)
check("FRICTION.md at repo root, not docs/", os.path.isfile(os.path.join(ROOT, "FRICTION.md")))
readme = read("README.md") or ""
check("README links FRICTION.md in its first screen",
      "FRICTION.md" in readme[:2000])

# ── no mocks in the judged path (R5 / R10) ────────────────────────────────────
print("\nno mock in the reproduce path")
demo = read("DEMO.md") or ""
# Scan ONLY the fenced command blocks. The prose legitimately NAMES these tokens
# to promise they are absent — an earlier version of this gate failed itself on
# its own disclaimer, which is a nice reminder that a checker is also code.
demo_cmds = "\n".join(re.findall(r"```(?:bash|sh)\n(.*?)```", demo, re.S))
for token in ["MOCK=", "OFFLINE=1", "--dry-run", "FAKE=", "SIMULATE="]:
    check(f'no "{token}" in any DEMO.md command', token not in demo_cmds)

src_hits = []
for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, "src")):
    dirnames[:] = [d for d in dirnames if d != "node_modules"]
    for fn in filenames:
        if fn.endswith(".ts"):
            body = open(os.path.join(dirpath, fn), encoding="utf-8").read()
            if re.search(r"\bmock[A-Z_]", body) or "setTimeout(() => {" in body and "fake" in body.lower():
                src_hits.append(fn)
check("src/ contains no mock* identifiers", not src_hits, ", ".join(src_hits))

# ── placeholders ───────────────────────────────────────────────────────────────
print("\nno placeholders")
placeholder_re = re.compile(r"⟨[A-Z_]+⟩|youtu\.be/xxx|0x\.\.\.|TODO: send|YOUR_[A-Z_]+")
for f in ["README.md", "DEMO.md", "ARCHITECTURE.md"]:
    body = read(f) or ""
    hits = placeholder_re.findall(body)
    check(f"{f} has no placeholder tokens", not hits, ", ".join(sorted(set(hits))[:4]))

# ── claims match reality ───────────────────────────────────────────────────────
print("\nclaims match reality")
# The count lives in the README twice, in two shapes: the prose ("**295 tests**")
# and the shields.io badge, where it is a fragment of a URL. Only the prose was ever
# checked here, so the badge sat at 279 for the length of a rewrite while the
# sentence forty lines down said 295 — a gate cannot catch a form it does not read.
# Both are now compared against the same vitest run.
# Accept **27 tests**, **27** tests, or "27 tests, all passing".
m = re.search(r"\*{0,2}(\d+)\s*tests?\*{0,2}", readme)
declared = int(m.group(1)) if m else None
b = re.search(r"shields\.io/badge/vitest-(\d+)(?:%20|-)passing", readme)
badged = int(b.group(1)) if b else None
try:
    # vitest 5 writes the json reporter to a file, not stdout, so name the file.
    report = Path(tempfile.mkdtemp()) / "vitest.json"
    subprocess.run(["npx", "vitest", "run", "--reporter=json", f"--outputFile={report}"],
                   cwd=ROOT, capture_output=True, text=True, timeout=300)
    actual = json.loads(report.read_text()).get("numTotalTests")
except Exception as e:                                   # noqa: BLE001
    actual = None
    warns.append(f"could not run vitest ({e})")
check("README states an exact test count", declared is not None, f"declared {declared}")
check("README carries a vitest badge with a count", badged is not None, f"badge {badged}")
check("declared test count matches the suite", declared == actual,
      f"README {declared} vs actual {actual}")
check("the test badge matches the suite", badged == actual,
      f"badge {badged} vs actual {actual}")

bench = read("docs/proof/bench.txt") or ""
check("bench receipt records the speech-window verdict",
      "lands mid-sentence" in bench)
check("bench receipt discloses the loopback caveat",
      "not the production figure" in bench or "loopback" in bench)

# ── the receipts are from THIS code, not a run someone remembers ──────────────
# R13 again: a committed receipt is evidence only while the code that produced it
# still produces it. A stale live_run.jsonl is a sentence describing an intention.
print("\nreceipts are current")
live = read("docs/proof/live_run.jsonl") or ""
summary = {}
for line in live.strip().splitlines():
    try:
        row = json.loads(line)
    except ValueError:
        continue
    if row.get("event") == "summary":
        summary = row
check("live_run.jsonl carries a summary line", bool(summary))
for field in ["unauthenticatedRefused", "audiencePartitionHeld", "tamperedWriteRefused",
              "retractionChainsToPreviousVersion", "briefingSpeakableOnly", "chainIntact"]:
    check(f"live_run.jsonl · {field}", summary.get(field) is True)
check("live_run.jsonl verdict is PASS", summary.get("verdict") == "PASS")

try:
    resume = json.loads(read("docs/proof/resume.json") or "{}")
except ValueError:
    resume = {}
check("resume.json verdict is PASS", resume.get("verdict") == "PASS")
check("resume.json proves a replay, not a live send",
      all(resume.get("checks", {}).values()) and resume.get("sseResumes", 0) >= 1,
      f"{sum(1 for v in resume.get('checks', {}).values() if v)}/{len(resume.get('checks', {}))} checks")

bench_json = {}
try:
    bench_json = json.loads(read("docs/proof/bench.json") or "{}")
except ValueError:
    pass
check("bench receipt landed every run inside the speech window",
      bench_json.get("midSentence", {}).get("count") == bench_json.get("n"),
      f"{bench_json.get('midSentence', {}).get('count')}/{bench_json.get('n')}")
check("bench receipt confirms a host was subscribed for every run",
      bench_json.get("subscribedEveryRun") is True)

# ── the safety property actually holds ────────────────────────────────────────
print("\nsafety property")
for name, script in [("npm run verify exits 0", "verify"),
                     ("npm run e2e exits 0", "e2e"),
                     ("npm run probe:resume exits 0", "probe:resume"),
                     ("npm run typecheck exits 0", "typecheck")]:
    try:
        rc = subprocess.run(["npm", "run", "--silent", script], cwd=ROOT,
                            capture_output=True, text=True, timeout=300).returncode
    except Exception:                                     # noqa: BLE001
        rc = 1
    check(name, rc == 0)

# ── ARCHITECTURE.md has not drifted from the code it is generated from ───────
# R6: eight prior submissions documented routes that were never built. The doc is
# generated, so the check is mechanical — regenerate it and diff everything but the
# timestamp line. A stale generated file is exactly as misleading as a hand-written one.
print("\ngenerated docs match the code")
before = read("ARCHITECTURE.md") or ""
try:
    rc = subprocess.run(["npm", "run", "--silent", "docs:arch"], cwd=ROOT,
                        capture_output=True, text=True, timeout=120).returncode
except Exception:                                         # noqa: BLE001
    rc = 1
after = read("ARCHITECTURE.md") or ""
strip_ts = lambda t: "\n".join(l for l in t.splitlines() if not l.startswith("_Generated:"))
current = strip_ts(before) == strip_ts(after)
check("npm run docs:arch exits 0", rc == 0)
check("ARCHITECTURE.md is current", current,
      "" if current else "regenerating it changed the file — commit the regenerated copy")

# Every MCP surface the doc lists must have a handler in src/, and every handler in
# src/ must be listed. The generator guarantees one direction; this asserts the doc
# on disk was not edited by hand afterwards.
src_all = ""
for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, "src")):
    dirnames[:] = [d for d in dirnames if d != "node_modules"]
    for fn in sorted(filenames):
        if fn.endswith(".ts"):
            src_all += open(os.path.join(dirpath, fn), encoding="utf-8").read()
registered = len(set(re.findall(r"setRequestHandler\((\w+)Schema", src_all)))
documented = len(set(re.findall(r"^\| `([\w/]+)` \| `src/", after, re.M)))
check("ARCHITECTURE.md lists every registered MCP surface",
      documented >= registered, f"{documented} documented vs {registered} handlers in src/")

# ── licence ────────────────────────────────────────────────────────────────────
print("\nlicence")
lic = read("LICENSE") or ""
check("MIT licence present", "MIT License" in lic)

# ── submission-only checks (warn until the URLs exist) ────────────────────────
print("\nsubmission surface (warn until filled)")
for label, pat in [("repo URL in README", r"https://github\.com/\S+"),
                   ("live URL in README", r"https://\S*(vercel\.app|railway\.app|edycu\.dev)"),
                   ("video URL in README", r"https://(www\.)?(youtube\.com|youtu\.be)/\S+")]:
    check(label, bool(re.search(pat, readme)), warn_only=True)

print()
if fails:
    print(f"FAIL — {len(fails)} blocking issue(s): {', '.join(fails)}")
elif warns:
    print(f"PASS with {len(warns)} warning(s) — safe to build on, not yet safe to submit.")
else:
    print("PASS — safe to submit.")
sys.exit(1 if fails else 0)
