# Anthropic-era comparison harnesses (archived Aug 2026)

These scripts exist to answer one question: **"is the cheap Gemini tier as good as the
Sonnet writer?"** They are the record of how the Gemini tiers were validated in the first
place, and the numbers quoted in `lib/modelPolicy.ts` and `services/writerProvider.ts`
came from running them.

They are archived rather than deleted because that evidence is worth keeping. They are
archived rather than kept live because **the question they answer is now moot**: the
Anthropic account was unfunded in Aug 2026 and every LLM role moved to Gemini and OpenAI
(see `lib/modelPolicy.ts`). Every one of these scripts calls `anthropic.messages.create`
directly, so none of them can run.

`tsconfig.json` excludes this directory, so they do not gate the build.

**Revivability differs per script**, because two of them compare against the writer-chain API
that the Aug 2026 migration replaced:

- `smoke-writer-all-languages.ts` and `smoke-cache-languages.ts` still compile against the live
  tree — they touch only `lib/anthropic.ts` and the prompt/lint modules, which are all still
  here. They need only a funded `ANTHROPIC_API_KEY`.
- `smoke-writer.ts` and `smoke-writer-compare-all-languages.ts` are pinned to the **old**
  `services/writerProvider.ts` API (`planWriterChain`, `getPrimaryGeminiModel`, `WriterTier`, ...),
  which no longer exists. To run one, check it out together with its era:
  `git log --follow -- src/scripts/smoke-writer.ts` and run from that commit. Their *results*
  are what mattered, and those are quoted where the decisions were made.

| Script | What it measured | Replaced by |
|---|---|---|
| `smoke-writer.ts` | Gemini Flash / Gemini Pro / Sonnet tier comparison, per cell | `scripts/bench-llm-quality.ts` (any set of models, any vendor) |
| `smoke-writer-all-languages.ts` | Sonnet first-draft quality across all 36 doctrine languages | `scripts/bench-llm-quality.ts --langs <all 36>` |
| `smoke-writer-compare-all-languages.ts` | Flash vs Sonnet, head to head, per language | `scripts/bench-llm-quality.ts --models "a,b"` |
| `smoke-cache-languages.ts` | Anthropic prompt-cache TTL behaviour (1h vs 5m) | nothing — Anthropic-specific, and neither Gemini nor OpenAI exposes an equivalent knob |

**To revive the two live-compatible ones:** they need a funded `ANTHROPIC_API_KEY` and
`lib/anthropic.ts`'s lazy client will build itself on first use. Nothing else is required — the
module was deliberately kept importable for exactly this.
