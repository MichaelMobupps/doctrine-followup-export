#!/usr/bin/env python3
"""
apply_reddit_followupper.py (v1.1) — add or correct the Reddit Gold Agency
Partner angle in getFollowupSystemPrompt in followupPrompts.ts.

v1.1 changes one sentence from v1 to remove a comma-plus-negation cadence:
  v1   : "Use it as ONE short, human line, never a full re-pitch."
  v1.1 : "Express it in one short, human line that adds a single new point."

States handled (one physical line, no internal newlines):
  - v1.1 already present  -> skip (idempotent)
  - any REDDIT marker line present (e.g. v1) -> replace that whole line
  - clean file -> insert the corrected bullet after the anchor

Safety: anchored, backup to <file>.reddit.bak, no backtick / no ${ in the
inserted text, backtick parity must stay unchanged or the write is refused.
The context-nudge path (contextFollowupPrompts.ts) is never touched.
"""
import os, shutil, sys

MARKER = "REDDIT GOLD AGENCY PARTNER"
V11_FINGERPRINT = "Express it in one short, human line that adds a single new point."
ANCHOR = "Never repeat an angle from a previous stage. Keep it short and human."

CANDIDATES = [
    os.environ.get("FOLLOWUP_FILE", ""),
    "artifacts/api-server/services/followupPrompts.ts",
    "api-server/services/followupPrompts.ts",
    "source-code/api-server/services/followupPrompts.ts",
]

BULLET = (
    "- REDDIT GOLD AGENCY PARTNER (optional fresh angle, conditional): one "
    "available angle for a later stage is that MobUpps is a Reddit Gold Agency "
    "Partner, which secures preferential access and pricing to premium Reddit "
    "inventory beyond direct buying, runnable on CPI or CPA. Express it in one "
    "short, human line that adds a single new point. INCLUDE it only when the "
    "prospect's market is a Reddit-strong geography (United States, Canada, "
    "United Kingdom, Ireland, Australia, New Zealand, or Western or Northern "
    "Europe) AND the vertical fits Reddit demand (gaming, crypto or fintech, tech "
    "or SaaS, DTC e-commerce, finance, entertainment, dating, automotive, "
    "education, or iGaming where permitted). Infer the market from the original "
    "email content and the language. OMIT it entirely, and never mention Reddit, "
    "when the market is China, Hong Kong, Russia, Belarus, a CIS country, India, "
    "most of MENA, or any market where Reddit has little reach, or when the "
    "vertical has no plausible Reddit audience. GUARDRAIL: never claim or imply "
    "that advertising through MobUpps influences, trains, or changes how AI "
    "assistants rank, cite, or describe the prospect. The only permitted "
    "AI-adjacent point is that buyers increasingly research the category on "
    "Reddit. State the access point positively and keep \"Reddit\" in Latin "
    "script in every language."
)


def halt(msg):
    sys.stderr.write("\n!!! HALT: %s\n" % msg)
    sys.exit(1)


def main():
    path = next((p for p in CANDIDATES if p and os.path.isfile(p)), None)
    if not path:
        halt("followupPrompts.ts not found. Tried: %s. Set FOLLOWUP_FILE."
             % ", ".join(c for c in CANDIDATES if c))
    print(">>> Target: %s" % path)

    if "`" in BULLET or "${" in BULLET:
        halt("internal error: bullet contains a template-literal-breaking token.")

    text = open(path, "r", encoding="utf-8").read()
    if V11_FINGERPRINT in text:
        print("  already v1.1, leaving unchanged.")
        return

    before_ticks = text.count("`")
    lines = text.split("\n")
    marker_idx = next((i for i, ln in enumerate(lines) if MARKER in ln), -1)

    if marker_idx >= 0:
        action = "migrated existing Reddit line to v1.1"
        lines[marker_idx] = BULLET
        new_text = "\n".join(lines)
    else:
        idx = text.find(ANCHOR)
        if idx < 0:
            halt("anchor not found in %s. File unchanged; send me the current file." % path)
        cut = idx + len(ANCHOR)
        new_text = text[:cut] + "\n" + BULLET + text[cut:]
        action = "inserted v1.1 Reddit bullet"

    if new_text.count("`") != before_ticks:
        halt("backtick parity changed; refusing to write. File unchanged.")

    shutil.copy2(path, path + ".reddit.bak")
    open(path, "w", encoding="utf-8").write(new_text)
    print("  %s (backup at %s.reddit.bak)" % (action, path))


if __name__ == "__main__":
    main()
