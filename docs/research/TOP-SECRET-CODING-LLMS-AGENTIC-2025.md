# 🔒 TOP SECRET: Coding LLMs & Agentic Tools Intelligence Report
> Scraped: 2026-07-21 | Sources: z.ai, GitHub, Requesty.ai, DevRain, MorphLLM, AugmentCode, TechCrunch
> Classification: Internal — haksterAI Knowledge Base

---

## 1. GLM-5.2 (Zhipu AI / Z.ai)

### Overview
- **Developer:** Zhipu AI (智谱AI) / Z.ai
- **Release:** June 2026
- **Architecture:** Mixture-of-Experts (MoE), 744B total parameters
- **Tagline:** "Built for Long-Horizon Tasks"
- **Repo:** https://github.com/zai-org/GLM-5
- **HuggingFace:** https://huggingface.co/zai-org/GLM-5.2
- **Try it:** https://z.ai/

### Key Capabilities
- **Agentic Coding:** Substantially stronger than GLM-5.1 at comparable token budgets. Designed for multi-step, long-horizon coding tasks.
- **Open Source:** GLM-5.2 is the strongest open-source model in the GLM-5 family. GLM-5.1 is the next-generation flight model.
- **Long-Horizon Tasks:** Optimized for tasks requiring sustained reasoning across many steps — not just single-turn chat.
- **Tool Use:** Supports function calling, tool use, and agentic workflows.
- **Coding Plan:** Available via Z.ai subscription for coding use cases.

### GLM-5 Family
| Model | Description |
|-------|-------------|
| GLM-5.2 | Flagship, strongest open-source, long-horizon tasks |
| GLM-5.1 | Next-generation flight model |
| GLM-5 | Base generation |

### On This Machine
- Crush CLI is configured to use `glm-5.2:cloud` via Ollama (at `127.0.0.1:11434`)
- Installed at `/usr/local/bin/crush`
- Version: v0.0.0-20251002 (forked Deko38code/Crush-CLI)

### Unique Skills/Tools
- Long-horizon task optimization (multi-step reasoning)
- Agentic coding (multi-file editing, tool chaining)
- Function calling / tool use API
- Open-source weights (can self-host)

---

## 2. OpenAI Codex CLI

### Overview
- **Developer:** OpenAI
- **Released:** April 16, 2025
- **Type:** Open-source terminal coding agent
- **Source:** https://github.com/openai/codex

### Key Capabilities
- **Terminal-Native:** Runs locally from terminal — not a cloud-only tool
- **Agentic:** Can read/write files, run commands, and reason about code autonomously
- **Two Faces:** 
  1. Codex CLI — local agent installed on your machine
  2. Codex (cloud) — OpenAI-hosted agentic coding
- **Patching Tools:** Can apply patches, edit files, run builds, and verify changes
- **Model Support:** Pairs with GPT models (GPT-5.5 tops Terminal-Bench 2.1 at 83.4%)

### Terminal-Bench 2.1 Ranking
| Rank | Tool + Model | Score |
|------|-------------|-------|
| #1 | Codex CLI + GPT-5.5 | 83.4% |
| #2 | Claude Code + Opus 4.8 | 78.9% |
| #3 | Claude Fable 5 (suspended) | 83.1% (unavailable) |

### Patching/Editing Features
- File read/write/edit
- Shell command execution
- Patch application (apply_patch style)
- Build verification
- Multi-file refactoring
- Autonomous fix-verify loops

---

## 3. Agentic Coding Tools Landscape (2025-2026)

### Market Signal
- Job postings requiring AI coding tool experience grew **340%** (Jan 2025 → Jan 2026)
- Pure implementation role postings declined **17%**
- Developers who orchestrate AI agents are in higher demand than manual coders

### Top Tools Compared

#### Claude Code (Anthropic)
- **Architecture:** Terminal-native agent, runs locally
- **Models:** Opus 4.8 (78.9% Terminal-Bench), Sonnet 4.5, Haiku 3.5
- **Pricing:** $20/mo (Pro), usage-based above limits
- **GitHub Stars:** 134,868
- **Strengths:** Deep reasoning, multi-file editing, tool use, MCP support
- **Unique:** MCP (Model Context Protocol) for extensible tools

#### Cursor 3
- **Architecture:** IDE-integrated (VS Code fork)
- **Pricing:** $20/mo (Pro)
- **Strengths:** Inline completions, codebase awareness, visual diff
- **Unique:** Composer agent, multi-file edits, background tasks

#### OpenAI Codex CLI
- **Architecture:** Terminal-native, open-source
- **Models:** GPT-5.5 (83.4% Terminal-Bench #1)
- **Strengths:** Top benchmark score, open-source, terminal-native
- **Unique:** Cloud + local dual mode

#### Aider
- **Architecture:** Terminal-native, open-source
- **Strengths:** Git-integrated, lightweight, multi-model support
- **Unique:** Works with any LLM, git-aware editing

#### Roo Code / Cline
- **Architecture:** VS Code extension
- **Strengths:** Open-source, multi-model, IDE integration
- **Unique:** Custom modes, MCP support

#### opencode
- **Architecture:** Open-source, MIT license
- **GitHub Stars:** 180,312 (most-stared open-source agent)
- **Strengths:** Community-driven, extensible

### Benchmark Comparison (Terminal-Bench 2.1)
| Tool | Model | Score | Price | License |
|------|-------|-------|-------|--------|
| Codex CLI | GPT-5.5 | 83.4% | Usage | Open |
| Claude Code | Opus 4.8 | 78.9% | $20/mo | Proprietary |
| Claude Code | Fable 5 | 83.1% | — | Suspended |
| opencode | Various | — | Free | MIT |

---

## 4. DevRain 2025 Tool Stack (Real-World Usage)

From DevRain's day-to-day development stack:

| Tool | Role |
|------|------|
| Claude Code (Agent-OS specs) | Primary agentic coding, planning |
| OpenAI Codex | Agentic coding, patching |
| Cursor | IDE-integrated editing |
| GitHub Copilot | Inline completions |
| Cline | VS Code agent extension |

**Workflow:** Planning → Project Management → Coding → Refactoring → PR Reviews → Secure Fixes

---

## 5. Key Takeaways for haksterAI

1. **GLM-5.2 is our local powerhouse** — already configured via Crush CLI + Ollama. Strong for long-horizon agentic tasks.
2. **Codex CLI leads benchmarks** — GPT-5.5 at 83.4% Terminal-Bench. Open-source, terminal-native.
3. **Claude Code is our primary agent** — Opus 4.8 at 78.9%, deep reasoning, MCP support.
4. **Agentic coding is the future** — 340% job growth, 17% decline in manual coding roles.
5. **Multi-model strategy wins** — use GLM-5.2 for local tasks, Claude for reasoning, Codex for benchmarks.
6. **Patching tools are core** — all top agents support file read/write/edit, shell exec, build verify, autonomous fix loops.

---

## 6. Sources
- https://z.ai/blog/glm-5.2 — GLM-5.2 official blog
- https://github.com/zai-org/GLM-5 — GLM-5 GitHub repo
- https://www.requesty.ai/blog/agentic-coding-tools-compared-2026-claude-code-cursor-codex-aider — Full comparison
- https://devrain.com/blog/ai-tools-for-development-2025 — Real-world tool stack
- https://www.morphllm.com/ai-coding-agent — Terminal-Bench 2.1 rankings
- https://techcrunch.com/2025/04/16/openai-debuts-codex-cli-an-open-source-coding-tool-for-terminals/ — Codex CLI launch
- https://www.augmentcode.com/learn/openai-codex-cli-terminal-ag — Codex CLI deep dive