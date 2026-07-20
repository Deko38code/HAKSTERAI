/**
 * haksterAI — Local AI coding agent powered by gpt-oss:120b-cloud
 * Runs inside the haksterAI browser terminal or any Node.js terminal.
 * Full tool loop: shell, read/write/patch files, web fetch, browser, process mgmt.
 */

const http = require('http');
const { spawn, execSync } = require('child_process');
const fmtBytes = b => b < 1024 ? `${b}B` : b < 1048576 ? `${(b/1024).toFixed(1)}KB` : b < 1073741824 ? `${(b/1048576).toFixed(1)}MB` : `${(b/1073741824).toFixed(1)}GB`;
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { globSync } = require('glob');
const os = require('os');
const crypto = require('crypto');

// ── Pentester fingerprint (stable device identity) ──
const { fingerprint: getFingerprint } = require('../fingerprint');
let _pentesterFp = null;
function getPentesterFingerprint() {
  if (!_pentesterFp) _pentesterFp = getFingerprint();
  return _pentesterFp;
}
const { loadMcpServers, getMcpTools, callMcpTool, isMcpTool, mcpStatus, shutdownMcp, setLogFn: setMcpLogFn, setStatusFn: setMcpStatusFn } = require('./mcp');
const { generateImage } = require('../providers');
const { SUGGEST, AUTO_EDIT, FULL_AUTO, shouldConfirm } = require('./approval');
const { AgentLoopPhase, shouldConsolidate, shouldReflect, injectAgentsMd, injectLearnedLessons, trustEscalation, validatePhaseTransition } = require('./loop');
const autolearn = require('./autolearn');
const session = require('./session');
const git = require('./git');
const sandbox = require('./sandbox');
const subagent = require('./subagent');

// ── Memory Engine v2 (importance-scored, entity-extracting) ──
const memoryEngine = require('./memory-engine');

// ── Puppeteer (lazy-loaded) ──────────────────────────────────────────
let _browser = null;
async function getBrowser() {
  if (!_browser || !_browser.isConnected()) {
    const puppeteer = require('puppeteer');
    _browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  return _browser;
}
let _page = null;
async function getPage() {
  const browser = await getBrowser();
  if (!_page || _page.closed) {
    _page = await browser.newPage();
    await _page.setViewport({ width: 1280, height: 800 });
  }
  return _page;
}

// ── Config ──────────────────────────────────────────────────────────────
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const HAKSTER_HOST = process.env.HAKSTER_HOST || 'http://localhost:3579';
const MODEL = process.env.HAKSTER_MODEL || (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hakster-config.json'), 'utf8'));
    return cfg.model || 'gpt-oss:120b-cloud';
  } catch { return 'gpt-oss:120b-cloud'; }
})();
const CLAUDE_PROXY_URL = process.env.CLAUDE_PROXY_URL || 'http://localhost:8082';
const WORK_DIR = process.cwd();
const SYSTEM_PROMPT = `You are haksterAI, an expert AI coding and ops agent running on the user's machine. When you run shell or CLI commands, you are executing them directly on the user's physical machine — this is NOT a sandbox or container. Every command runs with the machine owner's permissions on their real hardware. You have direct access to shell commands, file operations, processes, and networking. You are bold, concise, and get things done. Prefer action over explanation. When writing code, just write it — no unnecessary framing.

## CODEX-STYLE OPERATING CONTRACT
You should behave like a senior local coding agent:
1. Read the real codebase before making claims. Inspect package files, entry points, nearby source, service config, and logs when relevant.
2. For "fix", "make it work", "critical", "live", or "it worked before" requests, diagnose, patch, restart only the affected service if needed, and verify live behavior.
3. Make precise edits yourself with patch_file, multi_patch, write_file, or apply_patch-style tools. Do not hand the user copy/paste instructions when tools can do the work.
4. Preserve unrelated user changes. Never broad-rewrite files unless the user asks or the file is generated.
5. Use fast bounded inspection: rg, rg --files, read_file with ranges, pm2 status/logs, service_check, node -c, npm scripts, and curl health checks.
6. After every meaningful edit, run the narrowest useful verification. For Node/CommonJS, run node -c on edited files; for frontend, run the project build when practical; for services, check PM2 plus a health/API endpoint.
7. Keep working until the user’s goal is handled end-to-end, unless blocked by missing credentials, denied permissions, a destructive action requiring confirmation, or an unavailable external service.
8. If a command fails, read the error and change strategy. Do not repeat the same failing command.
9. Keep status updates short: what you are checking, what you found, what you are editing, and what verified.
10. Final answer should be brief: changed files, verification result, live status, and any remaining risk.
11. Never expose secrets, API keys, OAuth secrets, cookies, playlist credentials, signed URLs, DB passwords, raw user/admin data, tokens, or private logs.

## ONE-SHOT PATCHING (operate like a senior shell operator)
- Make file edits with a SINGLE one-shot command, not a tool call per line. Prefer, in order:
  1. \`sed -i\` for line/regex replacements: \`sed -i 's|old|new|g' path\` (use \`|\n\` or multiple \`-e\` for multi-line).
  2. A python3 heredoc for surgical multi-spot edits: \`python3 - <<'PY'\n...open(p).read().replace(...)...\nPY\`.
  3. \`node -e\` / \`perl -i\` when sed can't express the change.
  4. write_file/patch_file/multi_patch ONLY for large rewrites or brand-new files.
- Chain ALL the shell commands a task needs into ONE exec_shell call with \`&&\` (or a single heredoc script) so the whole change lands in one step: \`sed -i ... a && sed -i ... b && node -c a && pm2 restart x\`. Do NOT fire one command per tool call.
- Verify in the SAME shot when possible: \`&& node -c file\` (syntax) / \`&& curl -s localhost:PORT/api/health\` (live) / \`&& pm2 status\`.
- Never re-read a file you just wrote to "check". Trust the one-shot, verify with a command (node -c / curl / grep), and move on.
- Prefer bounded, idempotent edits. No broad rewrites. No exploratory cat/read loops after you already know the target line.

## VISIBLE REASONING STYLE
- Think rigorously before acting, but do not dump long private scratchpad reasoning.
- Show concise reasoning summaries the user can follow:
  - "I’m checking X because Y could be failing."
  - "This points to X, so I’m patching Y."
  - "Verification passed/failed because Z."
- For multi-step work, keep a short plan and update it as you complete steps.
- Before tool calls, state the tool intent in one sentence.
- After tool results, state the concrete observation, not a vague reaction.
- If assumptions matter, name them explicitly and test them where possible.
- Prefer decisive action over endless analysis, but do not edit before understanding the relevant files.
- Do not invent command output, logs, file contents, or test results. Report only what tools actually showed.
- When you are unsure, inspect or verify instead of guessing.

## CRITICAL RULES
1. DANGEROUS COMMANDS REQUIRE CONFIRMATION. If you use shell, kill_process, pm2 (stop/restart), or write to critical system paths, the user will be asked to approve. Plan accordingly.
2. ALWAYS use the code_grid tool when showing code, file contents, diffs, or config to the user. Never dump raw code without line numbers and color grid.
3. When showing file contents with read_file, the output already has line numbers — use code_grid for any code you write or modify to give the user a clear before/after view with highlighted changes (use diff_lines with + for additions, - for deletions).
4. Sub-agents (sub_agent tool) run tasks in parallel — use them when multiple independent tasks need doing simultaneously (e.g. check 3 services, edit 3 files).
4b. Crush (crush tool) is a terminal-first agentic coding assistant by Charm. Use it for complex coding tasks, refactoring, debugging, or getting a second opinion from a different model. It runs non-interactively with a prompt and can read/write files. Supports model selection (-m) and working directory (-c).
5. NEVER run modifying commands during idle review — only read-only operations (pm2 list, cat, ss, df, free, etc).
6. NEVER output fake UI status lines (e.g. "⏳ Queued", "⏳ Processing", spinners, progress bars, ASCII box-drawing chrome like ┌──┐│└┘, or numbered step counters). The TUI handles ALL status display. Your text output goes DIRECTLY to the user — just give plain answers, results, and tool calls. No simulated terminal chrome, no boxes, no fake progress indicators. FAKE QUEUE COUNTS ARE A CRITICAL BUG — never output "⏳ Queued (N pending)" or any queue/progress count. The real TUI uses format "⏳ Queued (1 batch, N lines, queue depth X)" and displays it automatically. If you catch yourself drawing a box or outputting ⏳, STOP and just write the plain text answer instead.
7. NEVER ask the same clarifying question twice. If you asked for details and the user responded, ACT on their response immediately — do not re-ask or rephrase the same question. After 1 clarification attempt, proceed with your best judgment. Repetitive clarification without action is a loop violation.
8. ALWAYS include text content in your response. NEVER return only tool_calls with empty content. Explain what you are doing, then call tools. Empty responses cause stuck loops.
9. **SHELL = MACHINE OWNER'S SYSTEM**: When you call the shell tool, you are running commands on the user's REAL machine — same hardware, same OS, same network, same filesystem. Use hostname, uname -a, whoami, pwd to confirm context if confused. Never assume a sandbox.
   If you are stuck or unsure, use the shell tool to investigate (run commands, read files, check logs) rather than guessing or repeating yourself. ALWAYS prefer fast bounded shell commands (rg, rg --files, find with tight paths, cat) over search_files for targeted lookups — search_files on large directories times out.
10. NEVER list/browse directories more than 2 times for the same task. If you ran list_dir or search_files and didn't find what you need, STOP exploring — use the results you have, use search_files with a SPECIFIC pattern, or ask the user for the exact path. list_dir→search_files→list_dir in circles is a hard loop violation. Find it or ask, don't browse forever.
11. ALWAYS EXPLAIN WHAT YOU'RE DOING. Before calling any tool, briefly state why you're calling it and what you expect to find or accomplish. Example: "Checking the service health to confirm the fix worked" before running service_check. Never call tools silently — the user should always understand your reasoning.
12. AFTER COMPLETING A TASK, ALWAYS PROVIDE A DONE CHECKLIST. Summarize everything you did in a clear checklist format:
    ✅ What was done (each step, each file edited, each command run)
    🔍 What was verified (syntax checks, health checks, test results)
    ⚠️ Any known issues or follow-ups needed
    This checklist is MANDATORY — never skip it. The user needs to see at a glance what changed.
13. USE ALL AVAILABLE TOOLS AND SKILLS. You have 29 built-in tools and a dynamic skill library. NEVER limit yourself to just shell and read_file. You have web_search, web_fetch, browser tools, spawn_agent, guardian, list_skills, read_skill — USE THEM. If you catch yourself only using shell/read_file, STOP and pick a better tool.
    - Start with skill_list to discover relevant skills, then skill_load to activate them.
    - Use patch_file (not shell sed) for file edits — it has fuzzy matching.
    - Use service_check before and after any server restart.
    - Use pm2 (not shell) for process management.
    - Use git_op (not shell) for git operations.
    - Use browser tools for web UI verification.
    - Use notify to push important status updates to the user.
    - Use memory to save findings across sessions.
    - Use sub_agent for parallel independent tasks.
    - Use code_grid to display code with line numbers and diffs.
    - **CRITICAL**: Use web_search and web_fetch BEFORE guessing. If you do not know something, SEARCH for it.
    - **CRITICAL**: Use claude_proxy for complex reasoning tasks — it's a second model that can catch mistakes.
    - **CRITICAL**: Use crush for agentic coding tasks — it's a full coding agent that can edit files.
    - **CRITICAL**: Use skill_list + skill_load for ANY task you haven't done before.
    - **CRITICAL**: Use parallel_shell for independent tasks that can run simultaneously — 3x faster.
    - **CRITICAL**: Use snapshot or browser_screenshot to VERIFY web UI changes — don't just assume they worked.
    - **CRITICAL**: Use analyze_image/read_image/ocr_text for image tasks — don't guess what's in an image.
    - **CRITICAL**: Use generate_image for creating icons, logos, mockups — don't just describe them.

## 🔧 TOOL QUICK REFERENCE (29 tools — USE THEM ALL)

⚠️ NEVER solve a problem using only shell/read_file when a better tool exists. Pick the RIGHT tool:
- Editing? → patch_file or multi_patch (NOT shell sed)
- Searching? → search_files or web_search (NOT shell grep on huge dirs)
- Looking up docs? → web_fetch (NOT guessing)
- Need a second opinion? → claude_proxy or sub_agent
- Need to remember something? → memory (NOT hoping you'll remember)
- New task type? → skill_list first, then skill_load
- Showing code? → code_grid (NOT raw code dumps)
- Checking a service? → service_check (NOT shell curl)
- Git operations? → git_op (NOT shell git)

| Category | Tool | When to use |
|---|---|---|
| **📂 File Edit** | \`patch_file\` | ⭐ BEST for editing. 3-tier fuzzy match. Always prefer over shell sed. |
| | \`multi_patch\` | Multiple edits in one call. Same fuzzy match. Faster than repeated patch_file. |
| | \`write_file\` | Create new files or rewrite small files (<200 lines). |
| | \`insert_lines\` | Insert at a line number (imports, functions). |
| | \`delete_lines\` | Delete a line range by number. |
| | \`replace_regex\` | Bulk regex find-replace. flags="g" for global. |
| | \`append_file\` | Append to end of file. Fast for logs/configs. |
| **📄 File Read** | \`read_file\` | Read file with line numbers. ALWAYS read before editing. |
| **🖼️ Images** | \`generate_image\` | Create, edit, and enhance app icons, logos, mockups, project assets via Pollinations by default; OpenAI remains available. |
| | \`read_image\` | Read/analyze an image file. Returns metadata + base64 data URI. |
| | \`analyze_image\` | Deep image analysis via vision model. Describe content, detect objects, read text, answer questions about an image. |
| | \`ocr_text\` | Extract text from images/screenshots. Returns structured text with confidence scores. |
| | \`compare_images\` | Compare two images pixel-by-pixel. Highlights diffs, reports % match. |
| **🔍 Search** | \`search_files\` | Find by name (mode="files") or grep content (mode="content"). |
| | \`list_dir\` | List directory. Use ONCE per dir — don't browse repeatedly. |
| | \`shell\` | For targeted lookups: \`rg -n\`, \`rg --files\`, \`find /path -name\`. FASTER than search_files. |
| **🖥️ Execution** | \`shell\` | Run any command. 30s default timeout. git, npm, pip, curl, builds, tests. |
| | \`parallel_shell\` | Run multiple commands simultaneously. Independent tasks only. |
| | \`run_background\` | Start long processes (servers, watchers). Returns PID immediately. |
| | \`kill_process\` | Kill by name or PID. Safer than shell kill. |
| **🌐 Web** | \`web_fetch\` | HTTP requests. APIs, endpoints, downloading docs. USE THIS for looking up docs. |
| | \`web_search\` | Search the web for answers. Uses DuckDuckGo API. ALWAYS search before guessing. |
| | \`browser_navigate\` | Open URLs, take snapshots. Test web UIs, check deployments. |
| | \`browser_click/type\` | Interact with pages. Form fills, button clicks. |
| | \`browser_screenshot\` | Capture page state. Verify UI changes visually. |
| | \`snapshot\` | Headless page analysis. Title, links, forms. Faster than browser. |
| **🤖 AI & Agents** | \`claude_proxy\` | Route to Claude/GPT models. Second opinions, complex reasoning. |
| | \`sub_agent\` | Spawn parallel sub-agents. Independent tasks simultaneously. |
| | \`crush\` | Agentic coding tool. Refactoring, debugging, different model. |
| | \`run_agent\` | Run a named agent script from /home/ghost/claude_agents/agents/. |
| **📦 Services** | \`service_check\` | Health-check hakster, cinevault, miniforge. Before/after restarts. |
| | \`pm2\` | Manage PM2: list, restart, stop, logs. Always check pm2 list first. |
| | \`git_op\` | Git commands (status, log, diff, add, commit, push). |
| **🧠 Memory & Skills** | \`memory\` | Save/recall notes across sessions. Project structure, gotchas, IPs. |
| | \`skill_list\` | Discover skills. USE FIRST for new task types. |
| | \`skill_load\` | Load skill instructions. ALWAYS load before unfamiliar tasks. |
| | \`skill_save\` | Save new repeatable workflows. |
| | \`notify\` | Push messages to user's notification queue. Async updates. |
| **🎨 Display** | \`code_grid\` | Show code with line numbers, syntax color, diff highlights. ALWAYS use for showing code. |

## ⚡ ANTI-HANG RULES (CRITICAL)
When running ANY shell command or tool that could hang:
1. **ALWAYS set a timeout.** Default 30s for shell. Use \`timeout: 10\` for quick checks, \`timeout: 120\` for builds.
2. **NEVER run \`npm install\` without \`--prefer-offline\` flag and a timeout.**
3. **NEVER run interactive commands** (vim, top, htop, less, man, ssh without -o BatchMode=yes).
4. **NEVER run \`ping\`, \`tail -f\`, \`watch\`, or any command that streams forever.** Use \`ping -c 3\`, \`tail -n 50\`, etc.
5. **NEVER \`cd\` and then run a command.** Use \`cd /path && command\` in one shell call.
6. **If a command seems stuck, kill it.** Don't wait more than 60s for any single command.
7. **After ANY file change, smoke test:** \`node -c file.js\` for syntax, \`curl -s http://localhost:PORT/api/health\` for services, \`pm2 list\` for process status.
8. **After restarting a service, ALWAYS verify** with a health check. Don't assume it worked.
9. **NEVER run unbounded grep/find commands.** Always add limits:
   - \`rg --max-count 50 -n PATTERN\` (not bare \`rg PATTERN\`)
   - \`grep -rn PATTERN | head -200\` (pipe through head)
   - \`find /path -maxdepth 8 -name '*.js'\` (not bare \`find /path\`)
   - The system auto-wraps grep commands with limits, but you should still be specific.
   - After 2-3 search attempts, STOP searching and use what you know.
10. **If grep/find returns too many results, narrow your search** — add file type filters, path constraints, or more specific patterns. Do NOT just re-run with a slightly different pattern.

## 📚 SKILL REGISTRY — DYNAMIC
Skills are loaded dynamically from multiple roots: haksterAi/.hakster/skills, ~/.hakster/skills,
~/.agents/skills, ~/skills (master library), ~/.hermes/skills, pentest-agents/skills.
The ACTUAL count is injected at runtime (see "Skills Available" section below).
ALWAYS use \`skill_list\` to see the real, current list — never quote a hardcoded number.
Use \`skill_load({name: "..."})\` to load a skill before following its steps.

Key categories: software-development, creative, mlops, productivity, github, research,
media, autonomous-ai-agents, devops, security/pentest, hunt-skills, data-science, email,
gaming, note-taking, smart-home, haksterAi core (cloud-ops, coding, iptv, movie-servers).

Core haksterAi skills (always available):
- hakster-cloud-ops, hakster-coding, hakster-crush-config, hakster-iptv, hakster-movie-servers
- crush-config, crush-hooks, jq, firecrawl (and sub-skills)

## 📋 SKILL USAGE PATTERN — MANDATORY
**YOU MUST check skills before starting ANY unfamiliar task. This is NOT optional.**
1. **skill_list** → ALWAYS run this first — one probably matches your task.
2. **skill_load** → Load it BEFORE proceeding. E.g., skill_load hakster-coding before editing code.
3. **Execute** → Follow the skill's steps precisely.
4. **skill_save** → If you develop a new repeatable process, save it for future use.

**Common skill auto-loads:**
- Editing code? → skill_load hakster-coding
- Deploying/restarting services? → skill_load hakster-cloud-ops
- Working on movie/IPTV servers? → skill_load hakster-movie-servers or skill_load hakster-iptv
- Web scraping/research? → skill_load firecrawl or skill_load firecrawl-search
- Security testing? → skill_load hunting-methodology
- Debugging? → skill_load debugging-hermes-tui-commands

Key skills to auto-load:
- **hakster-guardrails** → ALWAYS loaded (safety & editing rules)
- **pentest-agents/super-agent** → ALWAYS loaded (pentest orchestrator)
- **hakster-coding** → Load for complex coding tasks
- **hakster-cloud-ops** → Load for cloud/deployment tasks
- **hakster-iptv** → Load for IPTV/streaming tasks
- **hakster-crush-config** → Load before using the crush tool
- **hakster-movie-servers** → Load for CineVault, vidsrc, stream proxy tasks
- **firecrawl** → Load for any web scraping or data extraction

## System Knowledge (live — refreshed every 5 min)
\${DYNAMIC_MACHINE_CONTEXT}

\${CLIENT_DEVICE_CONTEXT}

## 🖥️ Machine Owner Context (IMPORTANT)
You are running on the machine owner's system. REMEMBER these key paths and facts:
- **This is ghost's personal machine** — not a cloud VM, not a sandbox. Treat it with care.
- **Always use absolute paths** when running shell commands — the project dir may not be cwd.
- **Remember file locations across the session** — if you read a file once, remember where it is.
- **Never delete or overwrite user files without asking** — this is their real machine with real data.
- **Key directories you should know by heart:**
  - Home: \`/home/ghost\`
  - haksterAI: \`/home/ghost/haksterAi\` (this project)
  - CineVault: \`/home/ghost/cine-vault-live\`
  - Miniforge: \`/home/ghost/miniforge\`
  - Skills: \`/home/ghost/skills\` (82+ master skill library)
  - Agent skills: \`/home/ghost/.agents/skills\`
  - Pentest: \`/home/ghost/haksterAi/pentest-agents/skills\`
  - Hermes: \`/home/ghost/.hermes/hermes-agent\`
  - Hakster config: \`/home/ghost/.hakster/\`
  - Hakster memory: \`/home/ghost/.hakster/memory/\`
  - Hakster sessions: \`/home/ghost/.hakster/cli_session.json\`
  - MCP config: \`/home/ghost/.hakster/mcp.json\`
  - History: \`/home/ghost/.hakster/history\`
- **Running services are REAL** — pm2 restart kills/restarts actual processes.
- **Temps run 84-89°C** — before heavy tasks (builds, tests, parallel shells), check \`cat /sys/class/thermal/thermal_zone*/temp\`.
- **RAM is limited (~7GB)** — avoid spawning multiple heavy processes at once.
- **When the user says "my machine" they mean THIS machine** — don't ask for clarification, just act on it.
- **Save important discoveries to memory** — use the memory tool so next session remembers too.
- **When the user says "take note", "note that", "remember this", "make a note", or similar** — immediately call the memory add tool with what they said. Always. No exceptions. The user explicitly wants it saved.

## 🏦 Project Memory Bank
haksterAI maintains a persistent project bank at \`~/.hakster/memory/projects.json\`. On every startup it scans the user's key directories and auto-updates the bank. The agent always knows:
- What projects exist, their paths, ports, PM2 names, and tech stacks
- Last modified timestamps so it can tell what's been worked on recently
- Service health status from idle auto-review
When the user says "what projects do I have" or "what's running" — answer from the project bank.

## 🔒 Pentest Tools (installed & ready)
- **nmap** — Network scanner (port scan, service detection, OS fingerprint)
- **nikto** — Web server vulnerability scanner
- **sqlmap** — SQL injection detection & exploitation
- **gobuster** — Directory/DNS/subdomain brute-forcer
- **ffuf** — Fast web fuzzer (dirs, vhosts, params)
- **hydra** — Online password brute-forcer (SSH, HTTP, FTP, etc.)
- **john** — John the Ripper password cracker
- **hashcat** — GPU-accelerated password cracker
Pentest skill library available: \`hunting-methodology\`, \`recon-methodology\`, \`sast-methodology\`, \`triage-validation\`, \`vuln-classes\`, \`report-writing\`, \`hunt-idor\`, \`hunt-info-disclosure\`, \`hunt-llm-ai\`, \`hunt-oauth\`, \`hunt-rce\`, \`hunt-xss\`, \`hunt-business-logic\`, \`red-teaming/godmode\`
Use \`skill_load({name: "hunt-rce"})\` etc. before hunting — they contain detailed methodology.

## 📺 IPTV Tools
- **ffmpeg/ffprobe** — Stream validation, probe, transcode, record
- **hakster-iptv skill** — M3U/M3U8 parsing, Xtream API, Stalker/MAG portals, EPG/XMLTV, channel metadata, admin dashboards
- **hakster-movie-servers skill** — /home/ghost/movie-server, vidsrc, IPTV/stalker services, source resolvers, PM2 apps
Use \`skill_load({name: "hakster-iptv"})\` or \`skill_load({name: "hakster-movie-servers"})\` before IPTV/movie work.

## Services & Ports
- haksterAI: PM2 name "hakster", PORT=3579, dir /home/ghost/haksterAi, server/src/index.js
- CineVault: PM2 name "cinevault", PORT=8081, dir /home/ghost/cine-vault-live, server.js
- Miniforge: PM2 name "miniforge", PORT=5555, dir /home/ghost/miniforge, server.js
- Claude Code Proxy: PORT=8082, dir /home/ghost/claude-code-proxy, server.py (Anthropic API → LiteLLM bridge)
- Agent Scripts: /home/ghost/claude_agents/agents/ (ai, automator, coder, debugger, exploit, security)
- Crush: v0.0.0-20251002 (forked Deko38code/Crush-CLI), installed at /usr/local/bin/crush, uses gpt-oss:120b-cloud via Ollama, agentic coding tool (crush run --quiet "prompt")

## PM2 Commands
- Check all: pm2 list
- Restart haksterAI: pm2 restart hakster (never use --env PORT, set PORT in .env)
- Restart CineVault: pm2 restart cinevault
- Restart Miniforge: pm2 restart miniforge (After PM2 start, port 5555 returns 000 for 2-3 seconds — wait and retry)
- Logs: pm2 logs hakster --lines 50
- Before restarting CineVault: run /home/ghost/cine-vault-live/cli-guard.sh check — if exit=1, someone is using CLI, don't restart

## Fix/Start Procedures
- Stale port: fuser -k <port>/tcp before restart (e.g. fuser -k 8081/tcp)
- Build haksterAI: cd /home/ghost/haksterAi && npx astro build
- Build CineVault: cd /home/ghost/cine-vault-live && npm run build
- Health checks: curl -s http://localhost:3579/api/health | curl -s http://localhost:8081/api/health
- Disk: df -h / (78% used, ~96GB free)
- RAM: free -h (6.7GB total, watch swap usage)
- Temp: cat /sys/class/thermal/thermal_zone*/temp (divide by 1000 for °C)

## Known Issues
- CineVault: /api/stalkerhek-proxy GET sends headers but 0 bytes body — timeout:5000 kills live TS sockets
- CineVault: PM2 crash loop → always check stale PIDs on 8081 before restart
- OOM: if oom-killer strikes, check dmesg | tail -30
- Machine priority: keep it running tip-top. Proactive health checks are standing priority.

## Other Projects
- PhantomIDE: Single-file HTML web IDE at /home/ghost/phantom-ide.html (1.1MB). DO NOT modify unless explicitly asked — user rule.
  - Phantom server: FastAPI backend at /home/ghost/phantom-ide/app.py, PM2 name "phantom", PORT 4000
  - Start: pm2 start /home/ghost/phantom-restore/ecosystem.config.js OR pm2 restart phantom
  - Health: curl -s http://localhost:4000/api/ping
  - Knowledge base: /home/ghost/phantom-knowledge.md (8300+ lines, load first 6000 chars as context)
  - 57 agent system, smart routing, AI provider waterfall, RAG semantic search
- CineVault: IPTV player, see Services section above for details
- haksterAI: This project. Astro frontend, Express/WS backend, PTY terminal, haksterAI agent`;

// ── Core skill cache (built once, auto-injected into every system prompt) ──
let _coreSkillCache = null;
let _coreSkillCacheTime = 0;
const CORE_SKILL_TTL = 60000; // refresh every 60s

function loadCoreSkills() {
  const now = Date.now();
  if (_coreSkillCache && (now - _coreSkillCacheTime) < CORE_SKILL_TTL) return _coreSkillCache;
  // Only load haksterAi-relevant skill docs — guardrails + useful behavior guides.
  // EXCLUDED: raw TS source dumps (prompts-constants, system-prompt-sections,
  //   system-prompt-utils, context, memdir-paths) and Claude Code internal guides
  //   (claude-code-skill, claude-agent, claude-readme, claude-contributing).
  //   These teach the agent Claude Code's FileEditTool patterns which don't map to
  //   haksterAi's shell/write_file tools, leading to broken edits (e.g. inserting
  //   JS statements inside fetch() call arguments).
  const coreSkills = [
    'hakster-guardrails',         // CRITICAL safety & editing rules — prevents code corruption
    'pentest-agents/super-agent', // pentest orchestrator — 50+ agents, OWASP cheatsheets
  ];
  const skillsDirs = getSkillDirs();
  const parts = [];
  for (const skillName of coreSkills) {
    for (const skillsDir of skillsDirs) {
      const matches = globSync(path.join(skillsDir, '**', `${skillName}.md`));
      if (matches.length > 0) {
        try {
          const content = fs.readFileSync(matches[0], 'utf-8');
          if (content && content.trim().length > 0) {
            parts.push(`\n\n---\n## Auto-loaded skill: ${skillName}\n${content}`);
          }
        } catch (_) { /* skip unreadable */ }
        break;
      }
    }
  }
  _coreSkillCache = parts.join('');
  _coreSkillCacheTime = now;
  return _coreSkillCache;
}

// ── Dynamic machine context (live OS/hardware/folders — cached 5 min) ──
let _machineCtxCache = null;
let _machineCtxTime = 0;
const MACHINE_CTX_TTL = 300000; // 5 minutes

function getMachineContext() {
  const now = Date.now();
  if (_machineCtxCache && (now - _machineCtxTime) < MACHINE_CTX_TTL) return _machineCtxCache;

  const ctx = { ...os.userInfo(), hostname: os.hostname(), platform: os.platform(), arch: os.arch() };
  const lines = [];

  // ── OS ──
  try {
    const release = fs.readFileSync('/etc/os-release', 'utf-8');
    const nameM = release.match(/^NAME="(.+?)"/m);
    const verM = release.match(/^VERSION="(.+?)"/m);
    const idM = release.match(/^ID=(\S+)/m);
    lines.push(`- OS: ${nameM ? nameM[1] : idM ? idM[1] : os.type()} ${verM ? verM[1] : os.release()}`);
  } catch (_) { lines.push(`- OS: ${os.type()} ${os.release()}`); }
  lines.push(`- Hostname: ${os.hostname()}`);
  lines.push(`- Arch: ${os.arch()}`);

  // ── CPU ──
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'unknown';
  lines.push(`- CPU: ${cpuModel} (${cpus.length} cores)`);
  try {
    const temps = fs.readdirSync('/sys/class/thermal').filter(f => f.startsWith('thermal_zone'));
    const tempStrs = temps.map(t => {
      try { return `${parseInt(fs.readFileSync(`/sys/class/thermal/${t}/temp`, 'utf-8'), 10) / 1000}°C`; } catch { return '?'; }
    });
    if (tempStrs.length > 0) lines.push(`- Temps: ${tempStrs.join(', ')}${tempStrs.some(t => parseFloat(t) > 80) ? ' ⚠️ HOT' : ''}`);
  } catch (_) {}

  // ── Memory ──
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = totalMem > 0 ? ((usedMem / totalMem) * 100).toFixed(1) : '?';
  lines.push(`- Memory: ${fmtBytes(usedMem)}/${fmtBytes(totalMem)} (${memPct}% used)${parseFloat(memPct) > 90 ? ' ⚠️ LOW' : ''}`);

  // ── Load ──
  try {
    const loadavg = fs.readFileSync('/proc/loadavg', 'utf-8').trim().split(' ');
    lines.push(`- Load: ${loadavg[0]} ${loadavg[1]} ${loadavg[2]} (1/5/15 min)`);
  } catch (_) { lines.push(`- Load: ${os.loadavg().map(l => l.toFixed(2)).join('/')}`); }

  // ── Disk ──
  try {
    const df = execSync("df -h / --output=size,used,avail,pcent 2>/dev/null", { encoding: 'utf-8' }).trim().split('\n');
    if (df.length > 1) {
      const parts = df[1].trim().split(/\s+/);
      lines.push(`- Disk /: ${parts[1]}/${parts[0]} used (${parts[3].trim()} used, ${parts[2]} free)`);
    }
  } catch (_) {}

  // ── Swap ──
  try {
    const swap = fs.readFileSync('/proc/meminfo', 'utf-8');
    const swapTotal = swap.match(/SwapTotal:\s+(\d+)/);
    const swapFree = swap.match(/SwapFree:\s+(\d+)/);
    if (swapTotal && swapFree) {
      const st = parseInt(swapTotal[1], 10);
      const sf = parseInt(swapFree[1], 10);
      if (st > 0) lines.push(`- Swap: ${fmtBytes((st - sf) * 1024)}/${fmtBytes(st * 1024)}`);
    }
  } catch (_) {}

  // ── GPU ──
  try {
    const gpu = execSync('lspci 2>/dev/null | grep -i vga', { encoding: 'utf-8' }).trim();
    if (gpu) {
      const gpuName = gpu.replace(/^.*:\s*/, '').trim();
      lines.push(`- GPU: ${gpuName}`);
    }
  } catch (_) { lines.push('- GPU: None detected (APU only)'); }

  // ── Shell, Node, Python ──
  lines.push(`- Shell: ${process.env.SHELL || '/bin/sh'}`);
  lines.push(`- Node: ${process.version}`);
  try { lines.push(`- Python: ${execSync('python3 --version 2>/dev/null', { encoding: 'utf-8' }).trim()}`); } catch (_) {}
  try { lines.push(`- npm: ${execSync('npm --version 2>/dev/null', { encoding: 'utf-8' }).trim()}`); } catch (_) {}

  // ── Network ──
  lines.push(`- User: ${os.userInfo().username}`);
  lines.push(`- Work dir: ${WORK_DIR}`);
  lines.push(`- Home: ${os.homedir()}`);

  // ── Key folders (dynamic scan) ──
  const homeDir = os.homedir();
  const keyFolders = [];
  const knownDirs = [
    { dir: `${homeDir}/haksterAi`, label: 'haksterAI (this project)' },
    { dir: `${homeDir}/cine-vault-live`, label: 'CineVault' },
    { dir: `${homeDir}/miniforge`, label: 'Miniforge' },
    { dir: `${homeDir}/claude-code-proxy`, label: 'Claude Proxy' },
    { dir: `${homeDir}/movie-server`, label: 'Movie Server' },
    { dir: `${homeDir}/skills`, label: 'Skills Library' },
    { dir: `${homeDir}/.agents`, label: 'Agent Skills' },
    { dir: `${homeDir}/haksterAi/pentest-agents`, label: 'Pentest Agents' },
    { dir: `${homeDir}/.hermes`, label: 'Hermes' },
    { dir: `${homeDir}/.hakster`, label: 'Hakster Config' },
    { dir: `${homeDir}/.hakster/memory`, label: 'Hakster Memory' },
  ];
  for (const k of knownDirs) {
    if (fs.existsSync(k.dir)) keyFolders.push(`  - ${k.label}: \`${k.dir}\``);
  }
  // Auto-detect other project dirs in home
  try {
    const homeEntries = fs.readdirSync(homeDir, { withFileTypes: true });
    for (const entry of homeEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const fullDir = path.join(homeDir, entry.name);
      if (knownDirs.some(k => k.dir === fullDir)) continue;
      const pkgJson = path.join(fullDir, 'package.json');
      if (fs.existsSync(pkgJson)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
          keyFolders.push(`  - ${pkg.name || entry.name}: \`${fullDir}\``);
        } catch (_) {}
      }
    }
  } catch (_) {}
  if (keyFolders.length > 0) {
    lines.push(`- Key directories:\n${keyFolders.join('\n')}`);
  }

  // ── Running PM2 services ──
  try {
    const pm2List = JSON.parse(execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }));
    if (pm2List.length > 0) {
      const svcLines = pm2List.map(p => `  - ${p.name}: ${p.pm2_env?.status || '?'} (pid ${p.pid || '?'})`).join('\n');
      lines.push(`- PM2 services:\n${svcLines}`);
    }
  } catch (_) {}

  // ── Listening ports ──
  try {
    const ports = execSync("ss -tlnp 2>/dev/null | grep LISTEN | awk '{print $4, $6}'", { encoding: 'utf-8' }).trim();
    if (ports) {
      const portLines = ports.split('\n').slice(0, 10).map(l => `  - ${l.trim()}`).join('\n');
      lines.push(`- Listening ports:\n${portLines}`);
    }
  } catch (_) {}

  const result = lines.join('\n');
  _machineCtxCache = result;
  _machineCtxTime = now;
  return result;
}

// ── Knowledge library index — let the agent pull from ALL of the user's .md files
//    (skills, firecrawl playbooks, repo docs, AGENTS/CLAUDE, MEMORY, pentest, etc.) ──
// Broad scan: every .md under the repo (minus node_modules/.git/dist), the firecrawl
// caches, the repo docs + pentest-agents, and the user's ~/.hakster + workspace .hakster.
const _REPO_ROOT = path.join(__dirname, '..', '..', '..');
const _KNOWLEDGE_DIRS = [
  path.join(_REPO_ROOT, '.firecrawl', 'cli-skills', '.firecrawl'),
  path.join(_REPO_ROOT, '.firecrawl'),
  path.join(_REPO_ROOT, 'docs'),
  path.join(_REPO_ROOT, 'pentest-agents'),
  path.join(_REPO_ROOT, '.hakster'),
  path.join(_REPO_ROOT, 'tui-review'),
  _REPO_ROOT,                                   // repo root .md (AGENTS/CLAUDE/HAKSTER-* etc.)
  path.join(process.env.HOME || '/home/ghost', '.hakster'),
  path.join(process.cwd(), '.hakster'),
];
// Skip these anywhere in the path (noise / generated / huge)
const _KNOWLEDGE_SKIP = /\/node_modules\/|\/\.git\/|\/dist\/|\/\.next\/|\/build\/|\/\.cache\//;
// Group a file by its source + name
const _KNOWLEDGE_GROUPS = [
  { re: /phantom|HAKSTERAI-PHANTOM/i, label: 'phantom' },
  { re: /kiro/i, label: 'kiro' },
  { re: /anthropic|claude/i, label: 'claude' },
  { re: /openai\.com-codex|codex-cli/i, label: 'codex' },
  { re: /gemini|hermes/i, label: 'hermes' },
  { re: /cursor/i, label: 'cursor' },
  { re: /opencode/i, label: 'opencode' },
  { re: /aider/i, label: 'aider' },
  { re: /chatgpt|openai-help/i, label: 'chatgpt' },
  { re: /pentest|guardian|cheatsheet|owasp|exploit|recon|nmap/i, label: 'pentest' },
  { re: /MEMORY|memory_summary|skills\/index/i, label: 'memory/skills-meta' },
];
const _KNOWLEDGE_PER_GROUP_CAP = 200;  // list up to 200 per group so "a lot of md's" all show
function buildKnowledgeLibraryIndex() {
  try {
    const byGroup = {};
    const seen = new Set();
    for (const dir of _KNOWLEDGE_DIRS) {
      let files = [];
      try { files = globSync(path.join(dir, '**', '*.md'), { ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'] }); }
      catch (_) { try { files = globSync(path.join(dir, '**', '*.md')); } catch (_) { continue; } }
      for (const f of files) {
        const abs = path.resolve(f);
        if (seen.has(abs) || _KNOWLEDGE_SKIP.test(abs)) continue;
        seen.add(abs);
        const base = path.basename(abs);
        let g = 'other';
        for (const grp of _KNOWLEDGE_GROUPS) { if (grp.re.test(base) || grp.re.test(abs)) { g = grp.label; break; } }
        if (!byGroup[g]) byGroup[g] = [];
        let sz = 0; try { sz = fs.statSync(abs).size; } catch (_) {}
        byGroup[g].push({ path: abs, kb: Math.max(1, Math.round(sz / 1024)) });
      }
    }
    // Order: skills/pentest/memory + agent-doc sources first
    const order = ['memory/skills-meta','pentest','phantom','kiro','claude','codex','hermes','cursor','opencode','aider','chatgpt','other'];
    const lines = [];
    let total = 0;
    for (const g of order) {
      const arr = byGroup[g]; if (!arr || !arr.length) continue;
      const shown = arr.slice(0, _KNOWLEDGE_PER_GROUP_CAP);
      total += shown.length;
      lines.push(`### ${g} (${arr.length} docs${arr.length > shown.length ? `, listing first ${shown.length}` : ''})`);
      for (const doc of shown) lines.push(`- ${doc.path} (${doc.kb}KB)`);
      if (arr.length > shown.length) lines.push(`- …and ${arr.length - shown.length} more — use list_dir/search_files to discover them`);
    }
    if (!lines.length) return '';
    return `\n\n## 📚 Knowledge Library (ALL your .md files — read_file/skill_load any path BEFORE guessing)\n${total} indexed docs across ${_KNOWLEDGE_DIRS.filter(d => { try { return fs.existsSync(d); } catch { return false; } }).length} roots.\n\n${lines.join('\n')}`;
  } catch (_) { return ''; }
}

// ── Phantom Brain: merge the phantom knowledge md into the agent's context ──
// The system prompt itself says to load the first ~6000 chars of phantom-knowledge.md.
// HAKSTERAI-PHANTOM-MERGED.md is the merged hakster+phantom brain (425KB) — we inject
// a capped excerpt each session and point the agent at the full file to read on demand.
let _phantomBrainCache = null; let _phantomBrainMtime = 0;
function loadPhantomBrain() {
  try {
    const candidates = [
      path.join(__dirname, '..', '..', '..', 'HAKSTERAI-PHANTOM-MERGED.md'),
      '/home/ghost/phantom-knowledge.md',
      path.join(__dirname, '..', '..', '..', 'phantom-knowledge.md'),
    ];
    for (const pth of candidates) {
      try {
        if (!fs.existsSync(pth)) continue;
        const st = fs.statSync(pth);
        if (_phantomBrainCache && st.mtimeMs === _phantomBrainMtime) return _phantomBrainCache;
        const full = fs.readFileSync(pth, 'utf-8');
        if (!full || !full.trim()) continue;
        const CAP = 6000;
        const excerpt = full.length > CAP
          ? full.slice(0, CAP) + `\n\n... (phantom brain truncated at ${CAP} chars — full ${Math.round(full.length/1024)}KB at ${pth}; read_file it for more)`
          : full;
        _phantomBrainCache = `\n\n## 🧠 Phantom Brain (merged hakster + phantom knowledge)\nSource: ${pth} (${Math.round(full.length/1024)}KB). Excerpt baked into every session; read_file the full path when you need deeper phantom/IDE/server knowledge.\n\n${excerpt}`;
        _phantomBrainMtime = st.mtimeMs;
        return _phantomBrainCache;
      } catch (_) {}
    }
  } catch (_) {}
  return '';
}

// ── Consolidated MEMORY.md from the user's project + home (read each session) ──
function buildProjectMemoryBlock(cwd) {
  try {
    const candidates = [
      path.join(cwd || WORK_DIR, '.hakster', 'MEMORY.md'),
      path.join(process.env.HOME || '/home/ghost', '.hakster', 'MEMORY.md'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, 'utf-8').trim();
          if (content.length > 0) {
            const cap = 4000;
            const trimmed = content.length > cap
              ? content.slice(0, cap) + '\n... (MEMORY.md truncated — read the rest with read_file)'
              : content;
            return `\n\n## 🧠 Project Memory (MEMORY.md, loaded this session)\n${trimmed}`;
          }
        }
      } catch (_) { /* try next */ }
    }
  } catch (_) { /* non-blocking */ }
  return '';
}

function buildSystemPrompt(clientContext) {
  let prompt = SYSTEM_PROMPT.replace('${DYNAMIC_MACHINE_CONTEXT}', getMachineContext());

  // Inject client device context if available (from browser detection)
  if (clientContext && typeof clientContext === 'object') {
    const lines = ['## 📱 Client Device Context'];
    lines.push(`The user is connecting from a **different device** than the server. The server is what you run on; the client is what the user uses to talk to you.`);
    lines.push('');
    lines.push('**Server (where I run):** See System Knowledge above');
    lines.push('**Client (where the user is):**');
    if (clientContext.device_type) lines.push(`- Device type: ${clientContext.device_type}`);
    if (clientContext.os_name || clientContext.os_version) lines.push(`- OS: ${[clientContext.os_name, clientContext.os_version].filter(Boolean).join(' ') || 'Unknown'}`);
    if (clientContext.platform) lines.push(`- Platform: ${clientContext.platform}`);
    if (clientContext.browser || clientContext.browser_version) lines.push(`- Browser: ${[clientContext.browser, clientContext.browser_version].filter(Boolean).join(' ') || 'Unknown'}`);
    if (clientContext.screen_width && clientContext.screen_height) lines.push(`- Screen: ${clientContext.screen_width}×${clientContext.screen_height}${clientContext.device_pixel_ratio ? ` @${clientContext.device_pixel_ratio}x` : ''}`);
    if (clientContext.language) lines.push(`- Language: ${clientContext.language}`);
    if (clientContext.timezone) lines.push(`- Timezone: ${clientContext.timezone}`);
    if (clientContext.cores) lines.push(`- CPU cores: ${clientContext.cores}`);
    if (clientContext.memory_gb) lines.push(`- Memory: ${clientContext.memory_gb} GB`);
    if (clientContext.touch_support) lines.push(`- Touch support: Yes`);
    if (clientContext.ip_address) lines.push(`- IP: ${clientContext.ip_address}`);
    lines.push('');
    lines.push('**IMPORTANT:** Adapt your responses to the client device. For example, if the client is on Windows but the server is Linux, use Linux commands for server-side operations but acknowledge the user might be looking at a Windows desktop. If the client is a mobile device, keep responses concise.');
    prompt = prompt.replace('${CLIENT_DEVICE_CONTEXT}', lines.join('\n'));
  } else {
    prompt = prompt.replace('${CLIENT_DEVICE_CONTEXT}', '');
  }

  const haksterRoots = getHaksterRoots();

  // Inject saved memory notes
  const allNotes = [];
  for (const root of haksterRoots) {
    const memoryFile = path.join(root, 'memory', 'notes.json');
    try {
      const notes = JSON.parse(fs.readFileSync(memoryFile, 'utf-8'));
      if (Array.isArray(notes)) allNotes.push(...notes);
    } catch (_) { /* no memory file at this root */ }
  }
  if (allNotes.length > 0) {
    const seen = new Set();
    const memoryLines = allNotes
      .filter(n => {
        const key = n.id || n.content;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(n => `• ${n.content}`)
      .join('\n');
    prompt += `\n\n## 🧠 Memory (notes from past sessions)\n${memoryLines}`;
  }

  // Inject skill names so the agent knows what skills exist
  const skillNames = [];
  for (const root of haksterRoots) {
    const skillsDir = path.join(root, 'skills');
    try {
      const skillFiles = globSync(path.join(skillsDir, '**', '*.md'));
      if (skillFiles.length > 0) {
        skillNames.push(...skillFiles.map(f => path.relative(skillsDir, f).replace(/\.md$/, '')));
      }
    } catch (_) { /* no skills at this root */ }
  }
  if (skillNames.length > 0) {
    const uniqueSkills = Array.from(new Set(skillNames));
    // Compress skill list to save context — show categories with counts, not every name
    const byCategory = {};
    for (const s of uniqueSkills) {
      const cat = s.includes('/') ? s.split('/').slice(0, -1).join('/') : 'root';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }
    const categories = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `${cat}/ (${count})`)
      .join(', ');
    prompt += `\n\n## 📋 ${uniqueSkills.length} Skills Available\nCategories: ${categories}\nUse skill_load to read a skill before following its steps.`;
  }

  // Auto-inject core Claude Code skill content (cached, refreshed every 60s)
  prompt += loadCoreSkills();

  // ── Inject pentester fingerprint (stable device identity) ──
  const fp = getPentesterFingerprint();
  prompt += `\n\n## 🔐 Pentester Device Identity`;
  prompt += `\n- Device UID: ${fp.device_uid.device_id}`;
  prompt += `\n- Session UID: ${fp.session_uid}`;
  prompt += `\n- Hostname: ${fp.hostname}`;
  prompt += `\n- MAC Hash: ${fp.mac_hash || 'N/A'}`;
  prompt += `\n- OS: ${fp.os.name} ${fp.os.release} (${fp.os.platform})`;
  if (fp.os.arch) prompt += `\n- Arch: ${fp.os.arch}, CPUs: ${fp.os.cpus}, RAM: ${fp.os.totalmem}GB`;
  prompt += `\nThis is your stable device identity. Use it for session tracking, audit logs, and receipts.`;

  // ── Inject AGENTS.md steering content ──
  const agentsMd = injectAgentsMd(process.cwd());
  if (agentsMd) prompt += '\n\n' + agentsMd;
  // ── Merge the phantom knowledge brain into this session's context ──
  prompt += loadPhantomBrain();

  // ── Inject learned lessons from auto-learn ──
  const lessons = injectLearnedLessons(process.cwd(), ['pentest', 'agent']);
  if (lessons) prompt += '\n\n' + lessons;

  // ── Inject memory-engine v2 recall (importance-scored) ──
  try {
    const memFrag = memoryEngine.recallForPrompt(process.cwd(), { maxChars: 2500 });
    if (memFrag) prompt += '\n\n## Relevant Memories (v2)\n' + memFrag;
  } catch (e) { /* non-blocking */ }

  // ── Inject plan/todo tool guidance + current state ──
  prompt += '\n\n## 📝 Plan & Todo Tools';
  prompt += '\nYou have two persistent planning tools (state survives across sessions):';
  prompt += '\n- `plan` (action: write|read|clear, content) — keep a markdown implementation plan at `.hakster/plan.md`. Write it BEFORE multi-step work and update it at milestones.';
  prompt += '\n- `todo` (action: add|list|update|remove|dep, id, title, description, status, depends_on) — track tasks in `.hakster/todos.json` with status (pending|in_progress|done|blocked) and dependencies.';
  prompt += '\nUse them for any task spanning multiple steps. Mark a todo `in_progress` before starting it and `done` when complete. This counts as real progress and keeps you from looping.';

  // Surface the current plan + todos so the agent picks up where it left off
  try {
    const hakHome = path.join(process.env.HOME || '/home/ghost', '.hakster');
    const planPath = path.join(hakHome, 'plan.md');
    if (fs.existsSync(planPath)) {
      const planContent = fs.readFileSync(planPath, 'utf-8').trim();
      if (planContent) prompt += '\n\n### Current Plan\n' + planContent;
    }
    const todoPath = path.join(hakHome, 'todos.json');
    if (fs.existsSync(todoPath)) {
      const raw = JSON.parse(fs.readFileSync(todoPath, 'utf-8') || '{}');
      const todos = Array.isArray(raw.todos) ? raw.todos : [];
      if (todos.length > 0) {
        const lines = todos.map(t => `- [${t.status || 'pending'}] ${t.id}: ${t.title}`);
        prompt += '\n\n### Current Todos\n' + lines.join('\n');
        prompt += '\nResume the next pending/in_progress todo.';
      }
    }
  } catch (_) { /* ignore read errors */ }

  // ── Read project MEMORY.md + skill/memory each session (auto-learn) ──
  prompt += buildProjectMemoryBlock(process.cwd());

  // ── Knowledge library index: phantom / kiro / claude / codex / hermes ──
  prompt += buildKnowledgeLibraryIndex();

  return prompt;
}

function getHaksterRoots() {
  return Array.from(new Set([
    path.join(process.env.HOME || '/home/ghost', '.hakster'),
    path.join('/home/ghost', '.hakster'),
    path.join(WORK_DIR, '.hakster'),
    path.join(__dirname, '..', '..', '..', '.hakster'),  // project root .hakster
    '/home/ghost/.agents',            // CLI agent skills
    '/home/ghost/skills',             // master skill library (82+ skills)
    '/home/ghost/.hermes/hermes-agent',  // hermes agent skills
    '/home/ghost/.hermes',            // hermes root
    '/home/ghost/haksterAi/pentest-agents', // pentest skills
  ]));
}

// Skill directories: <root>/skills for every hakster root, PLUS the master
// library /home/ghost/skills (skills live directly there, NOT under /skills).
// Using this everywhere skills are counted/loaded fixes the missing ~840+
// master-library skills (the banner/self-check only saw <root>/skills and
// thus /home/ghost/skills/skills, which doesn't exist).
function getSkillDirs() {
  const dirs = getHaksterRoots().map(root => path.join(root, 'skills'));
  dirs.push('/home/ghost/skills');
  // de-dup, drop non-existent
  const out = [];
  for (const d of Array.from(new Set(dirs))) {
    try { if (fs.existsSync(d)) out.push(d); } catch (_) {}
  }
  return out;
}

// (Idle review prompt removed — health checks now run directly via shell, no model call)
const MAX_TURNS_DEFAULT = Math.max(30, parseInt(process.env.HAKSTER_AGENT_MAX_TURNS || '50', 10) || 50);
const LOW_TOKEN_MAX_TURNS = Math.max(20, parseInt(process.env.HAKSTER_LOW_TOKEN_MAX_TURNS || '30', 10) || 30);
const MAX_TURNS = MAX_TURNS_DEFAULT;
let _currentMaxTurns = MAX_TURNS_DEFAULT;  // updated by agentLoop each run so tuiReset can read it
const IDLE_TIMEOUT_MS = 120000; // 2 minutes idle → auto review

// ── TUI Config (env-var tunable) ──────────────────────────────────────────
// Safe parsing: parseInt("") → NaN, but parseInt("0") → 0 which is falsy.
// Use IIFE to handle both empty strings and explicit zero values correctly.
const REFRESH_MS    = (() => { const v = process.env.REFRESH_MS;    return v !== undefined && v !== '' ? parseInt(v, 10) || 200 : 200; })();
const SCROLL_SPEED  = (() => { const v = process.env.SCROLL_SPEED;  return v !== undefined && v !== '' ? parseInt(v, 10) || 1   : 1;   })();
const MAX_LOG_LINES = (() => { const v = process.env.MAX_LOG_LINES; return v !== undefined && v !== '' ? parseInt(v, 10) || 12  : 12;  })();

// ── Module-level state for stuck-loop detection (shared with agentLoop) ──
let _lastAssistantResponse = '';   // Tracks last model response for loop detection
let _noProgressCount = 0;          // Counts consecutive responses without tool calls
const NO_PROGRESS_LIMIT = 15;      // Break loop after sustained no-progress (was 6)

// ── Stuck-state debug logging (persistent alerts) ─────────────────────────
// Writes structured alerts to data/stuck-alerts.log so they survive terminal scroll.
// Tracks: timestamps, turn number, detection type, reason, and context snippet.
const STUCK_ALERT_LOG = require('path').join(__dirname, '..', '..', 'data', 'stuck-alerts.log');
let _stuckAlertTurnCount = 0;
const _stuckAlertThresholds = new Set([3, 5, 8, 10, 12, 15]);
function _stuckDebugLog(type, reason, context) {
  const ts = new Date().toISOString();
  _stuckAlertTurnCount++;
  const entry = JSON.stringify({
    ts, turn: _stuckAlertTurnCount, type, reason,
    noProgressCount: _noProgressCount,
    context: (context || '').substring(0, 300),
  });
  try { require('fs').appendFileSync(STUCK_ALERT_LOG, entry + '\n'); } catch (_) {}
  const colorMap = { no_progress_warn: C.yellow, stuck_break: C.red+C.bold, grep_loop: C.yellow+C.bold, shell_repeat: C.red+C.bold, semantic_loop: C.magenta, stall_guard: C.cyan };
  const c = colorMap[type] || C.yellow;
  log('\n'+c+'🔍 STUCK-ALERT ['+type+'] turn='+_stuckAlertTurnCount+' noProgress='+_noProgressCount+': '+reason+C.reset);
  if (context) log('   context: '+context.substring(0, 200));

  // ── Push to stuckMonitor for HTTP API / CLI status ──────────────────────
  const severityMap = {
    stuck_break: 'critical',
    shell_repeat: 'critical',
    semantic_loop: 'warning',
    grep_loop: 'warning',
    no_progress_warn: 'warning',
    stall_guard: 'warning',
  };
  try {
    const stuckMonitor = require('./stuckMonitor');
    stuckMonitor.logStuckAlert(type, reason, {
      turn: _stuckAlertTurnCount,
      noProgressCount: _noProgressCount,
      snippet: context ? context.substring(0, 300) : null,
    }, severityMap[type] || 'warning');
  } catch (_) {}
}

let _recentResponsePrefixes = [];  // Last N response prefixes for semantic loop detection
let _emptyRetries = 0;              // Counts empty-response retries within a single agentLoop call
const SEMANTIC_LOOP_WINDOW = 5;    // How many recent responses to check (was 3)
const SEMANTIC_LOOP_THRESHOLD = 3; // How many similar prefixes → loop detected (was 2, raised to reduce false positives)
let _messageQueue = [];            // Queue of incoming messages (flushed on stuck loop)
let _batch = null;                 // Paste-batching state: { lines: string[], timer: NodeJS.Timeout }
let _stuckCooldown = 0;             // After stuck-loop break, skip this many queued messages to prevent re-loop
let _shellRepeatBreak = false;      // Set by shell executor when a generic repeat-loop is detected;

// ── Tool-error loop detection ──
// Track consecutive errors from the SAME tool — if a tool errors 3+ times in a row,
// it's likely a code bug (like ReferenceError) causing an infinite retry loop.
let _consecutiveToolErrors = [];     // [{name, count}]  recent tool error counts
const TOOL_ERROR_LOOP_LIMIT = 3;    // Same tool erroring this many times → break loop
const TOOL_REPEAT_LIMIT = 3;       // Same tool called with identical args this many times → break loop (tighten tool loops)
let _recentToolSigs = [];          // Recent normalized tool-call signatures (for repeat-tool-loop detection)
let _repeatToolSigCount = 0;        // Consecutive identical tool-call signatures

// ── Grep/search command loop detection ──
// Track consecutive shell commands that are grep/rg/find/search — if the model
// keeps running search commands without making progress, break the loop.
let _recentShellCommands = [];       // [{cmd, tool, sig}] — last N shell commands
const SHELL_LOOP_WINDOW = 8;         // How many recent shell calls to examine (raised 6→8 for more headroom across rounds)
const GREP_LOOP_LIMIT = 7;           // If >= N of last W calls are grep/search → loop detected (was 5). Raised so sequential recon rounds that legitimately interleave searches flow through.
const GREP_CMD_MAX_OUTPUT = 200;     // Max lines of output from grep/rg commands

// ── Generic shell repeat-loop detection (ALL shell commands, not just grep/find) ──
// Catches the model re-running the same curl / git status / npm test / ls / build
// command over and over without making progress. Runs before exec so it's fast and
// can break a stall before the command even fires a second time.
const SHELL_REPEAT_LIMIT = 4;        // same normalized command 4× in window → loop (raised 3→4 to cut false positives on legitimate sequential rounds)

function _normalizeShellSig(command) {
  // Collapse whitespace, lowercase, strip leading env assignments (FOO=bar), strip
  // leading sudo/timeout wrappers, and drop volatile numeric/time args so that
  // `sleep 2` vs `sleep 3` and `grep -n foo` vs `grep -ni foo` still cluster.
  let s = (command || '').trim().replace(/\s+/g, ' ').toLowerCase();
  // strip leading env var assignments:  VAR=val VAR2=val cmd ...
  s = s.replace(/^([a-z_][a-z0-9_]*=\S*\s+)+/, '');
  // strip leading sudo / timeout N / nice / ionice wrappers (one-shot)
  s = s.replace(/^(sudo|timeout\s+\d+|nice|ionice\s+-c\s+\d+)\s+/, '');
  // normalize flags that don't change meaning: drop standalone -n / --color args ordering diffs
  s = s.replace(/\s+--color(=never|always|auto)?/g, '');
  s = s.replace(/\s+-n\b/g, ' ');
  // collapse repeated slashes in paths
  s = s.replace(/\/+/g, '/');
  return s;
}

/**
 * Detects a repeat-loop on ANY shell command (not just grep/find).
 * Uses the shared `_recentShellCommands` window. Returns true (and resets
 * trackers) when the same normalized command signature appears >= SHELL_REPEAT_LIMIT
 * times in the window. Caller is responsible for the actual loop-break.
 *
 * @param {string} command - raw shell command about to execute
 * @returns {{ loop: boolean, count: number, sig: string }}
 */
function _checkShellRepeatLoop(command) {
  const sig = _normalizeShellSig(command);
  if (!sig || sig.length < 3) return { loop: false, count: 0, sig };
  // The current command is already pushed into _recentShellCommands by the
  // shell executor before this runs, so the filter count includes it.
  const count = _recentShellCommands.filter(c => c.sig === sig).length;
  if (count >= SHELL_REPEAT_LIMIT) {
    return { loop: true, count, sig };
  }
  return { loop: false, count, sig };
}

// ── Global tool call counter ──
// Tracks the total number of tool calls across the entire session/loop.
// Displayed as "#N" in the TUI chain and log output so the user can see
// exactly how many tool calls have been made.
let _toolCallCount = 0;

// ── Action tracker: what was done in this task ──
let _actionsTaken = [];  // [{emoji, text}] — tracks every tool call + result summary

function _recordAction(emoji, text) {
  _actionsTaken.push({ emoji, text: String(text).substring(0, 120) });
}

function _printDoneChecklist() {
  if (_actionsTaken.length === 0) return;
  const lines = _actionsTaken.map((a, i) => `  ${a.emoji} ${a.text}`).join('\n');
  // Count total lines in main project file
  let projectLineCount = 0;
  try { projectLineCount = fs.readFileSync(__filename, 'utf-8').split('\n').length; } catch (_) {}
  console.log(`\n${C.bold}${T.thin.repeat(60)}${C.reset}`);
  console.log(`${C.bold}${C.fgMuted}📋 What was done:${C.reset}`);
  console.log(lines);
  console.log(`${C.bold}${T.thin.repeat(60)}${C.reset}`);
  console.log(`${C.dim}📊 Project: ${C.fgMuted}${path.basename(__filename)}${C.reset} ${C.dim}=${C.reset} ${C.bold}${C.primary}${projectLineCount.toLocaleString()}${C.reset} ${C.dim}lines${C.reset}`);
  console.log(`${C.bold}${T.thin.repeat(60)}${C.reset}\n`);
  _actionsTaken = [];
}

// ── Agent activity state for bottom status bar ──
let _agentActivity  = 'Idle';   // Thinking | Executing | Talking | Explaining | Patching | Idle
let _activityDetail  = '';       // Short detail: tool name or topic
let _activityStart   = Date.now();
let _statusBarInterval = null;   // Interval for bottom status bar rendering
let _pendingTools    = [];       // [{name, id}] — tool calls queued for execution

// ── Token burn & cost tracking ──
let _sessionTokensIn  = 0;    // Cumulative input tokens this session
let _sessionTokensOut = 0;    // Cumulative output tokens this session
let _sessionCost      = 0;    // Estimated cost in USD this session
const TOKEN_PRICING   = {      // Per 1M tokens (input/output in USD)
  'gpt-oss:120b-cloud': { in: 0.00, out: 0.00 },  // Local/self-hosted = free
  'claude-sonnet-4-5':  { in: 3.00, out: 15.00 },
  'claude-proxy':        { in: 3.00, out: 15.00 },
  'default':             { in: 0.00, out: 0.00 },
};

// ── Stall guard: nudge the agent if no progress for 20 seconds ──
let _stallGuardTimer  = null;
const STALL_GUARD_MS  = 20000;  // 20 seconds — kickstart if no activity
let _lastActivityTime = Date.now();
let _awaitingConfirm  = false;  // True while waiting on a y/N dangerous-command prompt — suppresses status bar / stall guard so they don't clobber the readline question

// ── Humane focus nudges — encouraging prompts to get back on task ──
const FOCUS_NUDGES = [
  "You're doing great — take the next concrete step. What tool call will move this forward?",
  "Stay sharp. Pick the single most impactful action and execute it now.",
  "Almost there — what's the ONE thing left to do? Do it.",
  "Don't overthink it. You have the context. Make the next move.",
  "Focus up. Skip the planning — just act on what you know.",
  "You've got this. One more tool call and we're done.",
  "Keep the momentum — call the tool, get the result, finish the task.",
  "No more exploring. You know enough. Execute.",
  "Trust your instincts — you've seen the data. Make the call.",
  "Less thinking, more doing. What's the fastest path to done?",
  "Hey — you're looping. Break out with a concrete action RIGHT NOW.",
  "The user is waiting. Stop deliberating and DO the thing.",
  "You already know the answer. Apply it.",
  "Time to ship. Execute the fix and verify it works.",
];

// ── Filesystem-wandering loop detection ──
// Track recent exploration tool calls (list_dir, search_files, read_file) to detect
// the model "browsing" the filesystem in circles without converging on a result.
// Pattern: list_dir→search_files→list_dir→read_file→list_dir... = stuck wandering.
const EXPLORATION_TOOLS = new Set(['list_dir', 'search_files', 'read_file', 'list_directory', 'directory_tree', 'list_directory_with_sizes', 'find_file', 'file_search', 'glob', 'tree']);
let _explorationCalls = [];          // [{tool, path}] — last N exploration tool calls
const WANDERING_WINDOW = 10;          // How many recent calls to examine (raised 8→10)
const WANDERING_DUPE_LIMIT = 6;      // If >= N of last W calls hit same/duplicate paths → wandering detected (raised 5→6)
const WANDERING_UNIQUE_LIMIT = 2;    // If only N unique directories in last W calls → wandering detected

function _normalizePath(p) {
  // Collapse trailing slashes, resolve ./ and ../, lowercase for comparison
  try {
    return path.resolve(p || '').replace(/\/+$/, '').toLowerCase();
  } catch (_) {
    return (p || '').replace(/\/+$/, '').toLowerCase();
  }
}

function _checkFilesystemWandering(toolName, toolArgs) {
  // Also treat grep/find shell commands as exploration
  if (toolName === 'shell') {
    const cmd = (toolArgs?.command || '').trim().toLowerCase();
    const isSearchShell = /\b(rg|grep|egrep|fgrep|ag|ack|ripgrep|find|fd|locate)\b/i.test(cmd);
    if (!isSearchShell) {
      // Non-search shell command = genuine progress, reset wandering tracker
      _explorationCalls = [];
      return false;
    }
    // Search shell command = exploration, continue to check below
  } else if (!EXPLORATION_TOOLS.has(toolName)) {
    // Non-exploration tool = genuine progress, reset wandering tracker
    _explorationCalls = [];
    return false;
  }
  const rawPath = toolArgs.path || toolArgs.directory || toolArgs.pattern || toolArgs.query || '';
  const normalizedPath = _normalizePath(rawPath);
  _explorationCalls.push({ tool: toolName, path: normalizedPath });
  if (_explorationCalls.length > WANDERING_WINDOW) {
    _explorationCalls.shift();
  }
  // Need at least 4 calls to detect a pattern
  if (_explorationCalls.length < 4) return false;

  // Check 1: Too many calls hitting the same path (or parent/child overlaps)
  const pathSet = new Set(_explorationCalls.map(c => c.path));
  const parentPathSet = new Set();
  for (const p of pathSet) {
    // Add parent directories so /home/ghost/haksterAi and /home/ghost/haksterAi/server overlap
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) {
      parentPathSet.add(parts.slice(0, i).join('/'));
    }
  }
  // If all paths share a common parent and we've made >= WANDERING_DUPE_LIMIT calls, it's wandering
  const uniquePaths = pathSet.size;
  const totalCalls = _explorationCalls.length;

  // Check 2: Very few unique paths despite many calls = going in circles
  if (uniquePaths <= WANDERING_UNIQUE_LIMIT && totalCalls >= 6) {
    return true;
  }

  // Check 3: More than half the calls are to paths that are parents/children of each other
  // i.e., the model is traversing the same subtree repeatedly
  let overlapCount = 0;
  for (const call of _explorationCalls) {
    // Check if this call's path is a prefix of or prefixed by another call's path
    for (const other of _explorationCalls) {
      if (call.path !== other.path && (call.path.startsWith(other.path) || other.path.startsWith(call.path))) {
        overlapCount++;
        break;  // count each call at most once
      }
    }
  }
  if (overlapCount >= WANDERING_DUPE_LIMIT) {
    return true;
  }

  return false;
}

// Normalize text for loop comparison: lowercase, strip trailing punctuation/whitespace, collapse spaces
function _normalizeForLoopCheck(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.!?;:,]+$/, '').trim();
}

// Strip hallucinated TUI chrome from thinking/content display
// (models sometimes generate fake "⏳ Queued (N pending)", "📦 Skipping compact", "✓ Done", box-drawing lines)
function _stripFakeTui(text) {
  if (!text) return '';
  return text
    .replace(/^.*⏳\s*(Queued|Processing|Thinking|Done|Complete|Step|Tool call|Running)[^\n]*$/gim, '')
    .replace(/^.*Queued\s*\(\d+\s+pending\).*$/gim, '')
    .replace(/^.*📦\s*Skipping\s+compact.*$/gim, '')
    .replace(/^✓\s*Done\s*$/gm, '')
    .replace(/^│\s*│.*│\s*│\s*$/gm, '')
    .replace(/^[║│┃┆┇┊╎╏]\s*.{1,80}?\s*[║│┃┆┇┊╎╏]\s*$/gm, (m) => {
      // Keep lines that look like real data (long content, structured)
      const inner = m.replace(/^[║│┃┆┇┊╎╏]\s*/, '').replace(/\s*[║│┃┆┇┊╎╏]\s*$/, '');
      if (/^[├└┌│]/.test(inner) || inner.length > 70) return m;
      return '';
    })
    .replace(/\n{3,}/g, '\n')
    .trim();
}

// Patterns that indicate the agent is asking a clarifying question instead of making progress
const _clarifyingPatterns = [
  /\b(let me know|please (tell|provide|share|confirm|specify)|i need (more |a few )?(details|information|specifics))\b/i,
  /\b(could you|can you|would you|what (should|would)|how (should|would)|which .+ (would|do))\b/i,
  /\b(confirm|clarify|elaborate|specify|details|specifics)\b/i,
  /\b(once (i|you) (have|know|confirm)|if (that|this) (looks|sounds)|reply.*yes)\b/i,
  /\b(i('m| am) (ready|happy|glad|here) to)\b/i,
  /\b(i('ll| will) (add|create|implement|build|patch))\b/i,  // "I'll add..." — intent without action
  /\b(i( still | )?need\b.*\b(information|detail|specific|confirm))\b/i,  // "I need information/confirmation"
  /\b(what (exactly|specifically)|which .+ (would|do|should)|just (let me know|tell me|reply))\b/i,
  /\b(propose|proposed|if.*(sound|look)s? good)\b/i,  // "Proposed..." / "If this sounds good"
  /\b(please (confirm|let me know)|do you want|would you like|shall i|should i)\b/i,  // Direct question markers
  /\b(i can (add|create|build|implement|write|make),? but)\b/i,  // "I can X, but..." hedging
  /\b(if you('d| would)? like|what (is|are) your|tell me (more|about))\b/i,  // More question patterns
];

// Check if a response is just a clarifying question (no real progress)
function _isClarifyingQuestion(text) {
  if (!text || text.length < 30) return false;
  const norm = _normalizeForLoopCheck(text);
  let hits = 0;
  for (const pat of _clarifyingPatterns) {
    if (pat.test(norm)) hits++;
  }
  // Need at least 2 pattern matches to detect clarifying questions
  // (1 pattern is too easy — many normal responses hit 1 pattern accidentally)
  return hits >= 2;
}

// Count how many of the last N response prefixes are similar to `prefix`
// Uses fuzzy matching: overlap of significant words, not just prefix match
function _semanticLoopCount(prefix) {
  const norm = _normalizeForLoopCheck(prefix);
  if (!norm || norm.length < 10) return 0;  // Lower threshold from 20 to 10
  // Extract significant words (length > 3) for fuzzy matching
  const prefixWords = norm.split(/\s+/).filter(w => w.length > 3).slice(0, 15);
  if (prefixWords.length < 2) return 0;
  let count = 0;
  for (const p of _recentResponsePrefixes) {
    // Method 1: original prefix match (startsWith)
    if (p.startsWith(norm.substring(0, 60)) || norm.substring(0, 60).startsWith(p)) {
      count++;
      continue;
    }
    // Method 2: word overlap — if >= 40% of significant words overlap, it's a similar response
    const pWords = p.split(/\s+/).filter(w => w.length > 3);
    if (pWords.length < 2) continue;
    const pSet = new Set(pWords);
    const overlap = prefixWords.filter(w => pSet.has(w)).length;
    const similarity = overlap / Math.max(prefixWords.length, pWords.length);
    if (similarity >= 0.4) count++;
  }
  return count;
}

// ── Dangerous command patterns ──────────────────────────────────────────
const DANGEROUS_SHELL_PATTERNS = [
  /\brm\s+(-rf?|--force|--recursive)/i,
  /\brm\s+.*\//i,                      // rm with paths
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\bfdisk\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bformat\b/i,
  /\bchmod\s+(-R\s+)?777/i,
  /\bchown\s+.*root/i,
  /\bchgrp\s+.*root/i,
  /\bkill\s+-9\s+/i,
  /\bkillall\b/i,
  /\bpkill\s+-9/i,
  /\bfuser\s+-k\b/i,
  /\bnpm\s+publish/i,
  /\bgit\s+push\s+.*--force/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-fd/i,
  /\bdocker\s+(rm|rmi|system\s+prune)/i,
  /\bsystemctl\s+(stop|disable|restart)\s+(ssh|nginx|apache|mysql|postgres)/i,
  /\bsystemctl\s+(mask|daemon-reload)\b/i,
  /\biptables\s+-F/i,
  /\bcurl.*\|\s*(ba)?sh/i,             // pipe to shell
  /\bwget.*\|\s*(ba)?sh/i,
  /\bmv\b.*\s+\/dev\/null/i,            // mv to /dev/null (destructive)
  /\b>\s*\/dev\/(sda|nvme|vd)/i,        // write to raw block device
  /\btruncate\s+-s\s+0\b/i,            // truncate to zero
  /\bswapoff\b/i,
  /\bmount\s+.*\/dev\/(sda|nvme)/i,     // mount raw device
  /\bcrontab\s+-r\b/i,                 // delete crontab
  /\bat\/atq\s+-r\b/i,                  // delete at queue
  /\bparted\b.*\b(mklabel|mkpart|rm)\b/i, // partition table ops
  /\blvm\s+.*\b(remove|lvremove|vgremove|pvremove)\b/i, // LVM destructive
  /\braid\d*\s+.*\b(--stop|--fail|--remove)\b/i, // RAID destructive
  /\bip\s+link\s+set\s+.*\bdown\b/i,   // network interface down
  /\bip\s+route\s+(flush|del\s+default)/i, // route destruction
  /\bip\s+addr\s+(flush|del)\b/i,       // IP addr destruction
  /\biwconfig\s+.*\b(txpower\s+off|mode\s+monitor)\b/i, // wireless destructive
  /\btcpkill\b/i,                       // kills TCP connections
  /\bfsck\s+/i,                          // filesystem check (can corrupt)
  /\bmkswap\b/i,                         // make swap (destructive)
  /\bbadblocks\s+.*-w\b/i,              // destructive badblocks test
  /\bsfdisk\b/i,                         // partition manipulator
  /\bcfdisk\b/i,                         // partition manipulator
];

const CRITICAL_PATHS = [
  '/etc/passwd', '/etc/shadow', '/etc/sudoers', '/etc/ssh',
  '/etc/systemd', '/boot', '/usr/bin', '/usr/sbin',
  '/home/ghost/.ssh', '/root/.ssh',
];

function isDangerousCommand(tool, args) {
  // Shell commands
  if (tool === 'shell') {
    const cmd = args.command || '';
    const lower = cmd.toLowerCase();
    // Sudo-specific: any command starting with sudo is treated as elevated
    if (/^\s*sudo\s+/.test(cmd)) {
      // Still match dangerous patterns under sudo for detailed reasons
      for (const pat of DANGEROUS_SHELL_PATTERNS) {
        if (pat.test(cmd)) return `⚠️ SUDO DANGEROUS: ${cmd.substring(0, 100)}`;
      }
      // Sudo itself without an obviously dangerous wrapper is still flagged
      // so the user can explicitly approve elevated execution
      const inner = cmd.replace(/^\s*sudo\s+/, '').trim();
      if (inner) return `⚠️ SUDO ELEVATED COMMAND: ${inner.substring(0, 100)}`;
      return '⚠️ Bare sudo (no command)';
    }
    for (const pat of DANGEROUS_SHELL_PATTERNS) {
      if (pat.test(cmd)) return `Dangerous shell command: ${cmd.substring(0, 100)}`;
    }
  }
  // Kill processes
  if (tool === 'kill_process' && args.pid) return `Kill PID ${args.pid}?`;
  // PM2 destructive actions
  if (tool === 'pm2' && ['stop', 'restart'].includes(args.action)) {
    return `PM2 ${args.action} ${args.name || ''}?`;
  }
  // Write/overwrite on critical paths
  if (['write_file', 'patch_file', 'multi_patch', 'insert_lines', 'delete_lines', 'replace_regex'].includes(tool)) {
    const fp = path.resolve(WORK_DIR, args.path || '');
    if (!sandbox.isWritable(fp)) return `Sandbox: write outside writable root blocked (${fp})`;
    git.checkpoint(fp, 'before ' + tool);
    for (const cp of CRITICAL_PATHS) {
      if (fp.startsWith(cp)) return `Writing to critical path: ${fp}`;
    }
  }
  return null;
}

// ── Tool Emoji Map ──────────────────────────────────────────────────
const TOOL_EMOJI = {
  shell:            '🖥️',  read_file:       '📄',
  write_file:       '✏️',  patch_file:      '🔧',
  multi_patch:      '🔧',  insert_lines:    '📝',
  delete_lines:     '🗑️',  replace_regex:   '🔄',
  append_file:      '➕',  list_dir:        '📁',
  search_files:     '🔍',  web_fetch:       '🌐',
  run_background:   '⚙️',  kill_process:    '☠️',
  git_op:           '🔀',  pm2:             '📦',
  service_check:    '💊',  snapshot:        '📸',
  sub_agent:        '🤖',  parallel_shell:  '⚡',
  crush:            '💘',  claude_proxy:    '🧠',
  code_grid:        '🎨',  browser_navigate: '🧭',
  browser_click:    '👆',  browser_type:    '⌨️',
  browser_screenshot: '📸', browser_snapshot: '🔍',
  memory:           '🧠',  skill_save:     '💾',
  skill_load:       '📖',  skill_list:     '📋',
  notify:           '📬',
  generate_image:   '🖼️',  read_image:      '📷',
  analyze_image:    '🔍',  ocr_text:       '📝',
  compare_images:   '🔬',  web_search:     '🔎',
  // MCP & browser tools
  browser_close:     '❌',  browser_resize:      '📐',
  browser_console_messages: '📋', browser_handle_dialog: '💬',
  browser_evaluate:  '⚡',  browser_file_upload: '📤',
  browser_drop:      '📥',  browser_fill_form:  '📝',
  browser_press_key: '⌨️',  browser_drag:       '🖱️',
  browser_hover:     '👆',  browser_select_option:'☑️',
  browser_tabs:      '📑',  browser_wait_for:   '⏳',
  browser_run_code_unsafe:'⚠️', browser_take_screenshot:'📸',
  browser_navigate_back:'🔙',browser_network_requests:'📡',
  browser_network_request:'🔗',
  // MCP database
  read_query:        '🗃️',  write_query:      '✏️',
  create_table:      '🏗️',  list_tables:      '📋',
  describe_table:    '📊',
  // MCP filesystem
  read_multiple_files:'📂', read_text_file:   '📄',
  read_media_file:   '🎬',  create_directory: '📁',
  directory_tree:    '🌲',  list_directory_with_sizes:'📊',
  move_file:         '📦',  get_file_info:    'ℹ️',
  list_allowed_directories:'📂',
  // MCP memory/Knowledge
  create_entities:   '✨',  create_relations: '🔗',
  add_observations:  '👁️',  delete_entities:  '🗑️',
  delete_observations:'🗑️',delete_relations: '❌',
  read_graph:        '🕸️',  search_nodes:    '🔍',
  open_nodes:        '📖',
  // MCP nmap
  nmap_basic_scan:         '🔍', nmap_service_detection:'🔎',
  nmap_os_detection:       '💻', nmap_script_scan:    '📜',
  nmap_vulnerability_scan: '🛡️', nmap_custom_scan:   '⚙️',
  nmap_ping_scan:          '📡', nmap_port_scan:     '🔌',
  nmap_mdns_discovery:     '📡',
  // Thinking
  sequentialthinking: '🧠',
};

function toolEmoji(name) { return TOOL_EMOJI[name] || '🛠️'; }

// ── Tool Type Badge Map (short codes for TOOL GRID panel) ──────────────
const TOOL_TYPE = {
  shell:            'SH',  read_file:       'RF',
  write_file:       'WF',  patch_file:      'PF',
  multi_patch:      'MP',  insert_lines:    'IL',
  delete_lines:     'DL',  replace_regex:   'RR',
  append_file:      'AF',  list_dir:        'LS',
  search_files:     'SR',  web_fetch:       'WB',
  run_background:   'BG',  kill_process:    'KL',
  git_op:           'GT',  pm2:             'PM',
  service_check:    'SV',  snapshot:        'SN',
  sub_agent:        'SA',  parallel_shell:  'PS',
  crush:             'CR',
  code_grid:        'CG',  browser_navigate: 'BN',
  browser_click:    'BC',  browser_type:    'BT',
  browser_screenshot:'BS', browser_snapshot:'BX',
  memory:            'MM',  skill_save:     'SS',
  skill_load:        'SL',  skill_list:     'SLS',
  notify:            'NT',
  generate_image:    'GI',  read_image:     'RI',
  analyze_image:     'AI',  ocr_text:       'OC',
  compare_images:    'CI',  web_search:     'WS',
  // MCP tool name prefixes
  nmap_basic_scan:          'NM',  nmap_service_detection:    'NS',
  nmap_os_detection:        'NO',  nmap_script_scan:         'NC',
  nmap_vulnerability_scan:  'NV',  nmap_custom_scan:         'NX',
  nmap_ping_scan:           'NP',  nmap_port_scan:           'NP',
  nmap_mdns_discovery:      'ND',
  read_file:                'RF',  read_text_file:           'RT',
  read_media_file:          'RM',  read_multiple_files:      'RML',
  write_file:               'WF',  edit_file:               'EF',
  create_directory:         'CD',  list_directory:           'LD',
  list_directory_with_sizes:'LZ',  directory_tree:           'DT',
  move_file:                'MV',  search_files:            'SF',
  get_file_info:            'FI',  list_allowed_directories:'AD',
  create_entities:          'CE',  create_relations:         'CR',
  add_observations:         'AO',  delete_entities:          'DE',
  delete_observations:     'DO',  delete_relations:         'DR',
  read_graph:               'RG',  search_nodes:            'SN',
  open_nodes:               'ON',
  read_query:               'RQ',  write_query:             'WQ',
  create_table:             'CT',  list_tables:             'LT',
  describe_table:          'DT2',
  sequentialthinking:       'ST',
  browser_close:            'BC2', browser_resize:          'BR',
  browser_console_messages: 'BCM', browser_handle_dialog:   'BHD',
  browser_evaluate:         'BE',  browser_file_upload:     'BFU',
  browser_drop:             'BD',  browser_fill_form:       'BFF',
  browser_press_key:        'BP',  browser_type:            'BT',
  browser_navigate:         'BN',  browser_navigate_back:   'BBK',
  browser_network_requests: 'BNR', browser_network_request: 'BNQ',
  browser_run_code_unsafe:  'BRC', browser_take_screenshot:'BS2',
  browser_snapshot:          'BSX', browser_click:           'BC',
  browser_drag:              'BD2', browser_hover:          'BH',
  browser_select_option:    'BSO', browser_tabs:            'BT2',
  browser_wait_for:         'BWF',
  crush:                    'CR',
};

// ── Confirmation system ──────────────────────────────────────────────────
// _confirmFn is set by TUI/REPL; returns true (approved), false (denied), or a string (edited command)
let _confirmFn = null; // (dangerMsg, tool, args) => Promise<boolean|'allowlist'>
let _localAllowlist = new Set(); // command signatures approved with "don't ask again" this REPL session
function _cmdSig(tool, args) {
  const c = (tool === 'shell' || tool === 'exec_shell') ? (args && args.command || '') : JSON.stringify(args || {});
  return tool + ':' + String(c).replace(/\s+/g, ' ').trim().slice(0, 200);
}
function _localAllowlisted(tool, args) { return _localAllowlist.has(_cmdSig(tool, args)); }
let _approvalMode = process.env.HAKSTER_APPROVAL_MODE || SUGGEST;
function setApprovalMode(mode) { _approvalMode = require('./approval').validateMode(mode); }

// ── User ID tracking ────────────────────────────────────────────────────
let _userId = null;
function setUserId(id) { _userId = id; }
function getUserId() { return _userId; }

// ── AGENTS.md auto-loading ────────────────────────────────────────────────
let _agentsMdCache = null;
function loadAgentsMd(cwd) {
  const candidates = [
    path.join(cwd || WORK_DIR, 'AGENTS.md'),
    path.join(cwd || WORK_DIR, '.hakster', 'AGENTS.md'),
    path.join(cwd || WORK_DIR, 'HAKSTERAI-PHANTOM-MERGED.md'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf8').trim();
  if (content.length > 0) {
          _agentsMdCache = content;
          return content;
        }
      }
    } catch (_) { /* skip unreadable */ }
  }
  return null;
}

// Safe shell command prefixes — read-only introspection commands that never modify state
const SAFE_READ_CMDS = [
  'cat', 'head', 'tail', 'more', 'less', 'tee', 'wc', 'stat', 'file',
  'du', 'df', 'ls', 'find', 'locate', 'which', 'whereis', 'type', 'command', 'hash',
  'grep', 'egrep', 'fgrep', 'ag', 'rg', 'ack',
  'cut', 'sort', 'uniq', 'tr', 'rev', 'paste', 'column', 'fmt', 'pr',
  'ps', 'top', 'htop', 'free', 'uptime', 'uname', 'whoami', 'id', 'hostname', 'domainname', 'pwd',
  'echo', 'printenv', 'env', 'date', 'cal', 'ncal', 'timedatectl', 'localectl',
  'ss', 'netstat', 'ifconfig', 'iwgetid',
  'ping', 'traceroute', 'tracepath', 'mtr', 'dig', 'nslookup', 'host', 'whois',
  'journalctl', 'dmesg',
  'lsblk', 'lscpu', 'lsmem', 'lsmod', 'lspci', 'lsusb', 'lsscsi', 'hwinfo', 'sensors',
  'blkid', 'findmnt',
  'jq', 'node', 'python3', 'python', 'bash',
];

// Safe shell commands that require sub-command matching (read-only sub-commands only)
const SAFE_READ_SUBCMDS = {
  sed: ['−n'],           // sed -n (print-only)
  awk: [],               // awk is generally safe (print-only)
  ip: ['addr show', 'addr list', 'link show', 'link list', 'route show', 'route list', 'neigh show', 'neigh list', 'rule show', '-s link'],
  systemctl: ['status', 'list-units', 'list-timers', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat'],
  pm2: ['list', 'describe', 'logs', 'show', 'prettylist', 'jlist', 'info'],
  git: ['status', 'log', 'diff', 'branch', 'fetch', 'remote', 'tag', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'shortlog', 'describe', 'reflog', 'cherry', 'name-rev'],
  smartctl: ['-a'],
  fdisk: ['-l'],
  parted: ['-l', '-l'],
  swapon: ['--show'],
  mount: [],              // bare 'mount' (list mounts) is safe
  nmap: ['-sV', '-sS', '-sT', '-sA', '-sO', '-sF'],
};

function isReadOnlyTool(tool, args) {
  const readOnlyTools = ['read_file', 'list_dir', 'search_files', 'service_check', 'snapshot', 'browser_navigate', 'browser_snapshot', 'browser_screenshot', 'memory', 'skill_load', 'skill_list'];
  if (readOnlyTools.includes(tool)) return true;
  if (tool === 'shell') {
    const cmd = (args?.command || '').trim();
    if (!cmd) return false;
    // Get the first word (command binary)
    const firstWord = cmd.split(/\s+/)[0];
    const baseCmd = firstWord.replace(/^\//, '').split('/').pop(); // handle /usr/bin/xxx
    // Check safe command list
    if (SAFE_READ_CMDS.includes(baseCmd)) {
      // For commands with sub-command restrictions, verify sub-command is read-only
      const safeSubs = SAFE_READ_SUBCMDS[baseCmd];
      if (safeSubs !== undefined) {
        // If no safe subcmds defined, the bare command is read-only (e.g., 'mount', 'awk')
        if (safeSubs.length === 0 && !cmd.includes(' ')) return true;
        // Check if any safe subcmd matches
        return safeSubs.some(sub => cmd.includes(sub));
      }
      // Simple read-only command — allow
      return true;
    }
    // Special: curl to localhost/127.0.0.1 is read-only
    if (baseCmd === 'curl' && /localhost|127\.0\.0/.test(cmd)) return true;
    // Special: cat /proc, /etc, /sys (read system info)
    if (baseCmd === 'cat' && /^cat\s+\/(proc|etc|sys)/i.test(cmd)) return true;
    // Special: node --check (syntax check) or node -e 'console.log(...)' (print-only)
    if (baseCmd === 'node' && /--check|-e\s+console/i.test(cmd)) return true;
    // Special: python -c 'print(...)' or python -m json.tool (read-only)
    if (/^python3?$/.test(baseCmd) && /-c\s+print|-m\s+json\.tool/i.test(cmd)) return true;
    return false;
  }
  if (tool === 'pm2') return args?.action === 'list';
  if (tool === 'git_op') return ['status', 'diff', 'log', 'branch', 'fetch', 'show'].includes(args?.operation);
  return false;
}

// ── ANSI Colors — CharmTone palette (HaksterAI-style) ──────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  reverse: '\x1b[7m',
  // CharmTone semantic colors
  primary:   '\x1b[38;2;107;80;255m',   // Charple  #6B50FF — brand purple
  secondary: '\x1b[38;2;255;96;255m',    // Dolly    #FF60FF — pink accent
  tertiary:  '\x1b[38;2;104;255;214m',   // Bok      #68FFD6 — teal/green accent
  accent:    '\x1b[38;2;232;254;150m',   // Zest     #E8FE96 — yellow-green accent
  bgBase:    '\x1b[48;2;16;15;22m',      // DarkVoid #100F16 — near-black bg with purple tint
  bgBaseLt:  '\x1b[48;2;28;27;36m',     // VoidLt  #1C1B24 — slightly lighter dark bg
  bgSubtle:  '\x1b[38;2;58;57;67m',      // Charcoal #3A3943 — borders, subtle
  bgOverlay: '\x1b[38;2;77;76;87m',      // Iron     #4D4C57 — overlays
  fgBase:    '\x1b[38;2;223;219;221m',   // Ash      #DFDBDD — main text
  fgMuted:   '\x1b[38;2;133;131;146m',   // Squid    #858392 — muted text
  fgHalf:    '\x1b[38;2;191;188;200m',   // Smoke    #BFBCC8 — half-muted
  fgSubtle:  '\x1b[38;2;96;95;107m',     // Oyster   #605F6B — subtle text
  fgSelected:'\x1b[38;2;241;239;239m',  // Salt     #F1EFEF — selected/bright
  success:   '\x1b[38;2;18;199;143m',    // Guac     #12C78F — green/success
  error:     '\x1b[38;2;235;66;104m',    // Sriracha #EB4268 — red/error
  warning:   '\x1b[38;2;232;254;150m',   // Zest     #E8FE96 — warning (same as accent)
  info:      '\x1b[38;2;0;164;255m',     // Malibu   #00A4FF — blue/info
  butter:    '\x1b[38;2;255;250;241m',   // Butter   #FFFAF1 — white/bright
  sardine:   '\x1b[38;2;79;190;254m',    // Sardine  #4FBEFE — light blue
  mustard:   '\x1b[38;2;245;239;52m',    // Mustard  #F5EF34 — bright yellow
  citron:    '\x1b[38;2;232;255;39m',    // Citron   #E8FF27 — neon yellow
  julep:     '\x1b[38;2;0;255;178m',     // Julep    #00FFB2 — bright green
  coral:     '\x1b[38;2;255;87;125m',    // Coral    #FF577D — pink-red
  cherry:    '\x1b[38;2;255;56;139m',    // Cherry   #FF388B — hot pink
  // Background variants for tags/badges
  bgPrimary: '\x1b[48;2;107;80;255m',   // Charple bg — for badges/tags
  bgSuccess: '\x1b[48;2;18;199;143m',    // Guac bg
  bgError:   '\x1b[48;2;235;66;104m',    // Sriracha bg
  bgWarning: '\x1b[48;2;245;239;52m',    // Mustard bg
  bgInfo:    '\x1b[48;2;0;164;255m',     // Malibu bg
  // Legacy aliases (map old names to new CharmTone colors)
  red:       '\x1b[38;2;235;66;104m',   // Sriracha
  green:     '\x1b[38;2;18;199;143m',    // Guac
  yellow:    '\x1b[38;2;245;239;52m',     // Mustard
  blue:      '\x1b[38;2;0;164;255m',      // Malibu
  magenta:   '\x1b[38;2;255;96;255m',     // Dolly
  cyan:      '\x1b[38;2;104;255;214m',    // Bok
  purple:    '\x1b[38;2;107;80;255m',     // Charple
  gray:      '\x1b[38;2;133;131;146m',    // Squid
  white:     '\x1b[38;2;241;239;239m',     // Salt
  bgPurple:  '\x1b[48;2;107;80;255m',      // Charple bg
};

// ── Message Queue ────────────────────────────────────────────────────────
// Priority queue for async notifications, background task updates, MCP events.
// Messages drain before each agent loop turn so user sees them immediately.
const _msgQueue = [];
const MSG_PRIORITIES = { critical: 0, high: 1, normal: 2, low: 3 };
const MSG_TYPES = ['notify', 'warn', 'error', 'task', 'mcp', 'system'];

function msgPush(msg, { type = 'notify', priority = 'normal', source = 'agent' } = {}) {
  const entry = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    msg: String(msg),
    type,
    priority: MSG_PRIORITIES[priority] ?? 2,
    source,
    ts: new Date().toISOString(),
  };
  _msgQueue.push(entry);
  _msgQueue.sort((a, b) => a.priority - b.priority || a.ts.localeCompare(b.ts));
  return entry.id;
}

function msgDrain(max = 20) {
  return _msgQueue.splice(0, Math.min(max, _msgQueue.length));
}

function msgPeek(limit = 10) {
  return _msgQueue.slice(0, limit);
}

function msgClear() {
  _msgQueue.length = 0;
}

function msgSize() {
  return _msgQueue.length;
}

// ── Server Notification Queue Integration ──────────────────────────────
// Pushes notifications to the haksterAi server's /api/notify endpoint
// so web clients and other consumers can see agent notifications in real-time.
function serverNotify(msg, { type = 'task', priority = 'normal' } = {}) {
  const payload = JSON.stringify({ message: msg, type, priority, source: 'agent' });
  const host = (process.env.HAKSTER_HOST || 'http://localhost:3579').replace(/\/$/, '');
  const url = new URL('/api/notify', host);
  const postData = Buffer.from(payload, 'utf8');
  const options = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': postData.length },
  };
  const req = http.request(options, () => {});
  req.on('error', () => {}); // silently ignore — notification is best-effort
  req.write(postData);
  req.end();
}

// ── TUI Dashboard Panels ────────────────────────────────────────────────
// Bordered panels for REASONING, THINKING, TOOL GRID, CHAIN TABLE.


// Wide layout with dynamic width based on terminal size.
// Panels scroll IN-PLACE using ANSI cursor movement — new updates
// overwrite the same screen region instead of printing new boxes.

// Base width for panels — dynamically adjusted via _termWidth()
const BOX_W_MIN = 91;   // Minimum width (compact layout)
const BOX_W_MAX = 180;  // Maximum width cap

// Dynamic BOX_W — updated at render time to match terminal width
let BOX_W = BOX_W_MIN;
function _updateBoxW() {
  const tw = (typeof _termWidth === 'function') ? _termWidth() : BOX_W_MIN;
  BOX_W = Math.min(BOX_W_MAX, Math.max(BOX_W_MIN, tw - 6));
}

// ── In-place panel rendering tracker ──
// Maps panel name → { lineCount: number } so we can scroll over the
// previous render of the same panel instead of appending below it.
// Only overwrites in-place if the panel was the LAST thing written to stdout.
const _panelLines = {};  // e.g. { 'TOOL GRID': 12, 'REASONING': 8 }
let _lastPanelName = null;  // Track which panel was written last

// Write a panel to stdout, overwriting the previous render of the same panel
// in-place if it was the most recent output. Otherwise, just appends below.
// Uses trailing-edge debounce: rapid updates within REFRESH_MS are coalesced —
// only the LAST update in a burst is rendered, guaranteeing no lost final state.
// Returns the number of lines written.
const _panelDebounce = {};   // { name: { timer, text } }
function _writePanel(name, text) {
  const now = Date.now();
  const lastRender = _panelLines[name + '_ts'] || 0;
  const elapsed = now - lastRender;
  // Throttle: if we rendered this panel too recently, defer the update.
  // Always update the pending text so the deferred render uses the LATEST state.
  if (elapsed < REFRESH_MS && _lastPanelName === name) {
    if (_panelDebounce[name]) {
      // Already have a pending timer — just update the text (no double timer)
      _panelDebounce[name].text = text;
    } else {
      _panelDebounce[name] = {
        text,
        timer: setTimeout(() => {
          const pending = _panelDebounce[name];
          _panelDebounce[name] = null;
          if (pending) _writePanel(name, pending.text);
        }, REFRESH_MS - elapsed),
      };
    }
    return _panelLines[name] || 0;
  }
  // Clear any pending debounce for this panel — we're rendering now
  if (_panelDebounce[name]) {
    clearTimeout(_panelDebounce[name].timer);
    _panelDebounce[name] = null;
  }
  _panelLines[name + '_ts'] = now;
  const lines = text.split('\n');
  const count = lines.length;
  const prev = _panelLines[name] || 0;
  // Only scroll UP if this panel was the VERY LAST thing written to stdout.
  // If other log() output came after the previous render, we can't safely
  // overwrite — the cursor would land on the wrong content.
  const canScrollUp = prev > 0 && _lastPanelName === name;
  if (canScrollUp) {
    // Move cursor up `prev` lines, then clear from cursor to end of screen
    process.stdout.write(`\x1b[${prev}A\x1b[0J`);
  }
  process.stdout.write(text + '\n');
  _panelLines[name] = count;
  _lastPanelName = name;
  return count;
}

// ── ANSI-aware string helpers (used by all panels) ──
const _stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const _visLen    = (s) => _stripAnsi(s).length;
const _pad       = (s, len) => { const vl = _visLen(s); if (vl >= len) return _stripAnsi(s).substring(0, len); return s + ' '.repeat(len - vl); };
const _truncPad  = (s, len) => { const vl = _visLen(s); if (vl <= len) return _pad(s, len); return _stripAnsi(s).substring(0, len - 1) + '…'; };

// Detect terminal width (fallback to 137 to match expanded BOX_W)
function _termWidth() { try { return Math.max(91, process.stdout.columns || 91); } catch (_) { return 91; } }

// ── Terminal drawing helpers — color grids, lines, hashes ──
const T = {
  // Horizontal lines
  thin:    '─',
  thick:   '━',
  double:  '═',
  dotted:  '┈',
  dash:    '╌',
  mid:     '┄',
  // Corners
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  tl2: '┌', tr2: '┐', bl2: '└', br2: '┘',
  // Verticals
  v: '│', vd: '║', vdotted: '┊', vdash: '┆',
  // Cross pieces
  lm: '├', rm: '┤', tm: '┬', bm: '┴', cross: '┼',
  // Hash / grid fill chars
  hash:    '▓',
  hashmid: '▒',
  hashlite: '░',
  block:   '█',
  block7:  '▇',
  block6:  '▆',
  block5:  '▅',
  block4:  '▄',
  block3:  '▃',
  block2:  '▂',
  block1:  '▁',
  // Decorative
  diamond:  '◆',
  bullet:   '●',
  star:    '★',
  sparkle: '✦',
  arrow:   '→',
  arrow2:  '➜',
  check:   '✓',
  cross:   '✗',
  // Line drawing with color
  hr: (width, color = C.bgSubtle, char = '─') => `${color}${char.repeat(width)}${C.reset}`,
  hrThick: (width, color = C.bgSubtle) => `${color}${C.bold}━${C.reset}`.repeat(1) ? `${color}${C.bold}${'━'.repeat(width)}${C.reset}` : '',
  grid2: (width, color = C.bgSubtle) => `${color}${'░▒'.repeat(Math.ceil(width / 2)).substring(0, width)}${C.reset}`,
  grid3: (width, color = C.bgSubtle) => `${color}${'░▒▓'.repeat(Math.ceil(width / 3)).substring(0, width)}${C.reset}`,
  dots: (width, color = C.fgSubtle) => `${color}${'· '.repeat(Math.ceil(width / 2)).substring(0, width)}${C.reset}`,
  hashFill: (width, color = C.bgSubtle) => `${color}${'▓░'.repeat(Math.ceil(width / 2)).substring(0, width)}${C.reset}`,
  // Box drawing
  box: (text, width, opts = {}) => {
    const { color = C.bgSubtle, title = '', titleColor = C.info } = opts;
    const bdr = color + C.bold;
    const R = C.reset;
    const innerW = width - 2;
    const lines = [];
    // Top border
    if (title) {
      const titleStr = ` ${titleColor}${C.bold} ${title} ${R} `;
      const titlePadL = Math.floor((innerW - _stripAnsi(titleStr).length) / 2);
      const titlePadR = innerW - _stripAnsi(titleStr).length - titlePadL;
      lines.push(`${bdr}╭${'─'.repeat(titlePadL)}${titleStr}${'─'.repeat(titlePadR)}╮${R}`);
    } else {
      lines.push(`${bdr}╭${'─'.repeat(innerW)}╮${R}`);
    }
    // Content lines
    for (const line of text.split('\n')) {
      lines.push(`${bdr}│${R} ${_pad(line, innerW - 2)} ${bdr}│${R}`);
    }
    // Bottom border
    lines.push(`${bdr}╰${'─'.repeat(innerW)}╯${R}`);
    return lines.join('\n');
  },
};

function drawBox(title, lines, width = BOX_W, color = C.primary) {
  // HaksterAI-style: rounded corners, subtle Charcoal borders, title as section divider
  const R = C.reset;
  const border = C.bgSubtle + C.bold;  // Charcoal borders
  const w = width;
  const top    = `  ${border}╭${'─'.repeat(w + 2)}╮${R}`;
  const bottom = `  ${border}╰${'─'.repeat(w + 2)}╯${R}`;
  const sep    = `  ${border}├${'─'.repeat(w + 2)}┤${R}`;
  // Title uses color accent as label with section divider ─── TITLE ───
  const titlePad = w - title.length - 2;
  const leftPad = Math.floor(titlePad / 2);
  const rightPad = titlePad - leftPad;
  const titleLine = `  ${border}│${R} ${color}${C.bold}${'─'.repeat(leftPad)} ${title} ${'─'.repeat(rightPad)}${R} ${border}│${R}`;
  const out = [top, titleLine, sep];
  for (const line of lines) {
    out.push(`  ${border}│${R} ${_pad(line, w)} ${border}│${R}`);
  }
  out.push(bottom);
  return out.join('\n');
}

// ── REASONING panel: tree-structured phases with progress bar ──
// State tracked via module-level vars updated by the agent loop
let _tuiPhase      = 'Idle';
let _tuiThinkingStart = null;  // timestamp when thinking started
let _tuiSessionStart  = null;  // timestamp when the agent session started
let _tuiTarget     = '';
let _tuiPorts      = '';
let _tuiServices   = '';
let _tuiVulns      = [];   // [{svc, cve, flag}]  e.g. [{svc:'Apache 2.4.49', cve:'CVE-2021-41773', flag:'🚩'}]
let _tuiStep       = 0;
let _tuiMaxSteps   = MAX_TURNS_DEFAULT;
let _tuiPhaseStart = Date.now(); // when current phase started
let _tuiPhaseLog   = [];  // [{phase, duration}] — completed phases with durations
let _tuiKeyInsights = []; // [{step, text}] — key reasoning insights extracted from thinking
let _tuiTokensIn   = 0;   // cumulative input tokens estimate
let _tuiTokensOut  = 0;   // cumulative output tokens estimate

function renderReasoningPanel() {
  _updateBoxW();
  const W = BOX_W;
  const lines = [];
  const now = Date.now();
  // ── Phase + elapsed timer ──
  const phaseElapsed = _tuiPhaseStart ? ((now - _tuiPhaseStart) / 1000).toFixed(0) : '?';
  const sessionElapsed = _tuiSessionStart ? _fmtDuration(now - _tuiSessionStart) : '0s';
  // Phase icons: 6-phase loop — THINK→PLAN→ACT→OBSERVE→REFLECT→CONSOLIDATE
  const phaseIcons = { THINK: '🧠', PLAN: '📋', ACT: '⚡', OBSERVE: '👁', REFLECT: '🪞', CONSOLIDATE: '📦', Thinking: '🧠', Executing: '⚡', Complete: '✅', Idle: '⏸' };
  const phaseColors = { THINK: C.info, PLAN: C.mustard, ACT: C.success, OBSERVE: C.cyan, REFLECT: C.magenta, CONSOLIDATE: C.error, Thinking: C.info, Executing: C.success, Complete: C.success, Idle: C.fgMuted };
  const phaseColor = phaseColors[_tuiPhase] || C.fgBase;
  const phaseIcon = phaseIcons[_tuiPhase] || '◇';
  // ── Phase progress ring (visual indicator) ──
  const phaseOrder = ['THINK', 'PLAN', 'ACT', 'OBSERVE', 'REFLECT', 'CONSOLIDATE'];
  const phaseIdx = phaseOrder.indexOf(_tuiPhase);
  const ringParts = phaseOrder.map((p, i) => {
    if (i < phaseIdx) return `${C.success}●${C.reset}`;   // completed
    if (i === phaseIdx) return `${phaseColor}${C.bold}◉${C.reset}`; // current
    return `${C.fgSubtle}○${C.reset}`;                     // pending
  });
  const ringStr = ringParts.join(' ');
  lines.push(`${C.tertiary}${phaseIcon}${C.reset} ${C.fgBase}[${new Date().toLocaleTimeString()}]${C.reset} ${phaseColor}${C.bold}${_tuiPhase}${C.reset} ${C.fgMuted}(${phaseElapsed}s)${C.reset} ${C.fgSubtle}⏱ ${sessionElapsed}${C.reset}`);
  lines.push(`           ${ringStr}  ${C.fgSubtle}loop phases${C.reset}`);
  const items = [];
  if (_tuiTarget)   items.push(`${C.fgMuted}├─${C.reset} ${C.fgSubtle}Target:${C.reset}   ${C.fgBase}${_tuiTarget}${C.reset}`);
  if (_tuiPorts)    items.push(`${C.fgMuted}├─${C.reset} ${C.fgSubtle}Ports:${C.reset}     ${C.info}${_tuiPorts}${C.reset}`);
  if (_tuiServices) items.push(`${C.fgMuted}├─${C.reset} ${C.fgSubtle}Services:${C.reset}  ${C.fgHalf}${_tuiServices}${C.reset}`);
  if (_tuiVulns.length > 0) {
    items.push(`${C.fgMuted}├─${C.reset} ${C.fgSubtle}Vulns:${C.reset}`);
    for (const v of _tuiVulns) {
      const flag = v.flag === '✅' ? `${C.success}✓${C.reset}` : v.flag === '🚩' ? `${C.error}✕${C.reset}` : v.flag;
      items.push(`${C.fgMuted}│   ${C.reset}${C.fgMuted}├─${C.reset} ${C.fgHalf}${v.svc}${C.reset} ${C.tertiary}→${C.reset} ${C.bold}${v.cve}${C.reset} ${flag}`);
    }
  }
  // ── Key insights from thinking (last 5, expanded) ──
  if (_tuiKeyInsights.length > 0) {
    items.push(`${C.fgMuted}├─${C.reset} ${C.fgSubtle}Insights:${C.reset}`);
    const recentInsights = _tuiKeyInsights.slice(-5);
    for (const ins of recentInsights) {
      const insShort = ins.text.length > 70 ? ins.text.substring(0, 67) + '...' : ins.text;
      items.push(`${C.fgMuted}│   ${C.reset}${C.accent}💡${C.reset} ${C.fgHalf}${insShort}${C.reset} ${C.fgSubtle}[S${ins.step}]${C.reset}`);
    }
  }
  // ── Phase history (last 5 completed phases) ──
  if (_tuiPhaseLog.length > 0) {
    items.push(`${C.fgMuted}├─${C.reset} ${C.fgSubtle}Phases:${C.reset}`);
    const recentPhases = _tuiPhaseLog.slice(-5);
    for (const p of recentPhases) {
      const dur = p.duration < 1000 ? `${p.duration}ms` : `${(p.duration / 1000).toFixed(1)}s`;
      items.push(`${C.fgMuted}│   ${C.reset}${C.fgSubtle}├─${C.reset} ${C.fgMuted}${p.phase}${C.reset} ${C.fgSubtle}${dur}${C.reset}`);
    }
  }
  for (const item of items) {
    lines.push(`           ${item}`);
  }
  // ── Enhanced progress bar with context window indicator ──
  const progress = _tuiMaxSteps > 0 ? Math.round((_tuiStep / _tuiMaxSteps) * 100) : 0;
  const barLen = 20;
  const filled = Math.round(progress / 100 * barLen);
  // Color the progress bar based on how far along we are
  const barColor = progress > 80 ? C.error : progress > 50 ? C.mustard : C.primary;
  const bar = `${barColor}${'█'.repeat(filled)}${C.fgSubtle}${'░'.repeat(barLen - filled)}${C.reset} ${C.bold}${C.fgBase}${progress}%${C.reset} ${C.fgMuted}Step ${_tuiStep}/${_tuiMaxSteps}${C.reset}`;
  lines.push(`           ${C.fgMuted}└─${C.reset} ${C.fgSubtle}Progress${C.reset} ${bar}`);
  // ── Token usage + tool stats ──
  const totalTokens = _tuiTokensIn + _tuiTokensOut;
  const tokenStr = totalTokens > 0 ? `${C.fgSubtle}│${C.reset} ${C.fgMuted}tok≈${(totalTokens / 1000).toFixed(1)}k${C.reset}` : '';
  const oks = _tuiToolGrid.filter(t => t.status === 'ok').length;
  const errs = _tuiToolGrid.filter(t => t.status === 'error').length;
  const runs = _tuiToolGrid.filter(t => t.status === 'running').length;
  const statsStr = `${C.fgSubtle}│${C.reset} ${C.success}✓${oks}${C.reset} ${C.mustard}●${runs}${C.reset} ${C.error}×${errs}${C.reset}`;
  lines.push(`           ${C.fgSubtle}   ${statsStr} ${tokenStr}${C.reset}`);
  return drawBox('REASONING', lines, W, C.info);
}

// ── Duration formatter ──
function _fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm}m`;
}

// ── THINKING panel: emoji-prefixed reasoning lines, word-wrapped ──
function renderThinkingPanel(thinkText) {
  // HaksterAI-style: max 10 lines, "Thought for Xs" footer, subtle bg
  const cleaned = _stripFakeTui(thinkText);
  if (!cleaned) return '';
  _updateBoxW();
  const W = BOX_W;
  const lines = [];
  const thinkLines = cleaned.split('\n').filter(l => l.trim());
  // Wrap each thinking line to fit in the panel
  const maxW = W - 4; // leave room for " │ " prefix
  const maxLines = 12;  // Increased from 10
  for (const line of thinkLines.slice(0, maxLines)) {
    const raw = _stripAnsi(line);
    if (raw.length <= maxW) {
      lines.push(`${C.fgMuted}│${C.reset} ${C.fgSubtle}${line}${C.reset}`);
    } else {
      // Word-wrap long lines
      const words = line.split(' ');
      let cur = '';
      for (const word of words) {
        const test = cur ? cur + ' ' + word : word;
        if (_visLen(test) > maxW) {
          if (cur) lines.push(`${C.fgMuted}│${C.reset} ${C.fgSubtle}${cur}${C.reset}`);
          cur = word;
        } else {
          cur = test;
        }
      }
      if (cur) lines.push(`${C.fgMuted}│${C.reset} ${C.fgSubtle}${cur}${C.reset}`);
    }
  }
  if (thinkLines.length > maxLines) {
    lines.push(`${C.fgMuted}│${C.reset} ${C.dim}... (${thinkLines.length - maxLines} more lines)${C.reset}`);
  }
  // HaksterAI-style "Thought for Xs" footer
  if (_tuiThinkingStart) {
    const elapsed = ((Date.now() - _tuiThinkingStart) / 1000).toFixed(1);
    lines.push(`${C.bgSubtle}─${C.reset}${C.fgMuted} Thought for ${elapsed}s · ${thinkLines.length} lines${C.reset}`);
  }
  return drawBox('THINKING', lines, W, C.secondary);
}

// ── Extract key insights from thinking content for the REASONING panel ──
function _extractInsights(thinkText, stepNum) {
  if (!thinkText || thinkText.length < 50) return;
  const cleaned = _stripFakeTui(thinkText);
  // Extract sentences that contain key reasoning patterns
  const patterns = [
    /\b(I need to|I should|Let me|I'll|I will|I must|The best approach|I think|I figure|I can|I found|This means|So |Therefore|The result|It looks like|The issue is|The problem is|Root cause|This suggests)\b/i,
    /\b(conclusion|decision|plan|strategy|diagnosis|finding|insight|observation|hypothesis|analysis)\b/i,
  ];
  const sentences = cleaned.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 20 && s.length < 120);
  for (const pat of patterns) {
    for (const s of sentences) {
      if (pat.test(s)) {
        // Only add if not too similar to existing insights
        const norm = s.toLowerCase().replace(/\s+/g, ' ').substring(0, 60);
        if (!_tuiKeyInsights.some(i => i.text.toLowerCase().replace(/\s+/g, ' ').substring(0, 60) === norm)) {
          _tuiKeyInsights.push({ step: stepNum, text: s.substring(0, 100) });
          // Keep only last 8 insights
          if (_tuiKeyInsights.length > 8) _tuiKeyInsights.shift();
          return; // Only extract one insight per thinking block
        }
      }
    }
  }
}

// ── TOOL GRID panel: split layout — live tool status left, output right ──
let _tuiToolGrid = [];  // [{emoji, name, status, output, startTime, duration}]  status: 'running'|'ok'|'err'
let _tuiCurrentOutput = '';  // Live streaming output from the currently running tool
let _tuiCurrentTool = null;  // Name of the currently running tool

function renderToolPanel() {
  try {
  _updateBoxW();
  const W = BOX_W;
  // HaksterAI-style ✓/×/● status icons, duration, live output, subtle Charcoal borders
  const innerW = W - 4;  // inner box usable width
  const splitRatio = 0.42;
  const leftW = Math.floor(innerW * splitRatio);
  const rightW = innerW - leftW - 3;  // -3 for " │ " separator
  const lines = [];
  // Show last MAX_LOG_LINES tools
  const recent = _tuiToolGrid.slice(-MAX_LOG_LINES);
  if (_tuiToolGrid.length > MAX_LOG_LINES) {
    const older = _tuiToolGrid.length - MAX_LOG_LINES;
    lines.push(`${C.fgSubtle}  ↑ ${older} older tool${older !== 1 ? 's' : ''}${C.reset}`);
  }
  for (let i = 0; i < recent.length; i++) {
    const t = recent[i];
    const isLast = i === recent.length - 1;
    // HaksterAI-style icons: ● pending, ✓ success, × error
    const statusIcon = t.status === 'running' ? `${C.mustard}●${C.reset}` : t.status === 'ok' ? `${C.success}✓${C.reset}` : `${C.error}×${C.reset}`;
    const nameColor = t.status === 'running' ? C.mustard + C.bold : t.status === 'ok' ? C.info : C.error;
    const baseName = t.name.split(' → ')[0];
    const badge = TOOL_TYPE[baseName] || '??';
    const badgeStr = `${C.fgSubtle}${badge}${C.reset}`;
    // Duration display with color coding
    let durStr = '';
    if (t.status === 'running' && t.startTime) {
      const elapsed = ((Date.now() - t.startTime) / 1000).toFixed(1);
      durStr = ` ${elapsed >= 5 ? C.error : C.mustard}${elapsed}s${C.reset}`;
    } else if (t.duration) {
      const d = t.duration < 1000 ? `${t.duration}ms` : `${(t.duration / 1000).toFixed(1)}s`;
      durStr = ` ${C.fgSubtle}${d}${C.reset}`;
    }
    const left  = `${badgeStr} ${statusIcon} ${nameColor}${_truncPad(t.name, leftW - 10)}${C.reset}${durStr}`;
    // ── Live output for the running tool, static output for completed ──
    let right;
    if (t.status === 'running' && _tuiCurrentOutput && isLast) {
      // Show live streaming output — last line of the output, truncated
      const outLines = _tuiCurrentOutput.split('\n').filter(l => l.trim());
      const lastLine = outLines.length > 0 ? outLines[outLines.length - 1] : '';
      right = `${C.mustard}${_truncPad(lastLine.substring(0, rightW - 3), rightW - 3)}${C.reset}`;
    } else if (t.status === 'running') {
      right = `${C.mustard}${C.bold}⏳ running...${C.reset}`;
    } else {
      // Completed: show output truncated with status-based color
      const outPreview = (t.output || '').substring(0, rightW - 2);
      const outColor = t.status === 'ok' ? C.fgHalf : C.error;
      right = `${outColor}${_truncPad(outPreview, rightW - 2)}${C.reset}`;
    }
    lines.push(`${_truncPad(left, leftW)}${C.bgSubtle} │${C.reset} ${_truncPad(right, rightW)}`);
    // ── If this is the running tool and has multi-line output, show last 2 extra lines ──
    if (t.status === 'running' && _tuiCurrentOutput && isLast) {
      const outLines = _tuiCurrentOutput.split('\n').filter(l => l.trim());
      const previewLines = outLines.slice(-3, -1); // lines before the last one (already shown)
      for (const pl of previewLines) {
        const clean = pl.replace(/\x1b\[[0-9;]*m/g, '').substring(0, rightW - 2);
        lines.push(`${_truncPad('', leftW)}${C.bgSubtle} │${C.reset} ${C.fgSubtle}${_truncPad(clean, rightW)}${C.reset}`);
      }
    }
  }
  // Separator: ──┼──
  lines.push(`${C.bgSubtle}${'─'.repeat(leftW)}${C.bold}─┼─${C.reset}${C.bgSubtle}${'─'.repeat(rightW)}${C.reset}`);
  // Status summary with HaksterAI-style ✓/×/● icons + progress bar
  const total = _tuiToolGrid.length;
  const errs  = _tuiToolGrid.filter(t => t.status === 'error').length;
  const runs  = _tuiToolGrid.filter(t => t.status === 'running').length;
  const oks   = _tuiToolGrid.filter(t => t.status === 'ok').length;
  const barLen = 20;
  const filled = total > 0 ? Math.round((oks / total) * barLen) : 0;
  const bar = `${C.primary}${'█'.repeat(filled)}${C.fgSubtle}${'░'.repeat(barLen - filled)}${C.reset}`;
  lines.push(`${C.bold}Total:${C.reset} ${total}  ${C.success}✓${oks}${C.reset}  ${C.mustard}●${runs}${C.reset}  ${C.error}×${errs}${C.reset}  ${bar}`);
  // HaksterAI-style model footer: ◇ model_name + elapsed
  const sessionDur = _tuiSessionStart ? _fmtDuration(Date.now() - _tuiSessionStart) : '';
  const sessTag = sessionDur ? ` ${C.fgSubtle}⏱${C.reset}${C.fgMuted}${sessionDur}${C.reset}` : '';
  lines.push(`${C.tertiary}◇${C.reset} ${C.fgMuted}${MODEL}${C.reset}${sessTag}`);
  // Status-dependent border color
  const borderColor = errs > 0 ? C.error : runs > 0 ? C.mustard : C.success;
  const border = C.bgSubtle + C.bold;
  const R = C.reset;
  // ── Custom box with split title: TOOL GRID ───┼─── OUTPUT ──── ──
  const top    = `  ${border}╭${'─'.repeat(W + 2)}╮${R}`;
  const bottom = `  ${border}╰${'─'.repeat(W + 2)}╯${R}`;
  // Title bar: HaksterAI-style section header with accent color
  const ltRaw = ' TOOL GRID ';
  const rtRaw = ' OUTPUT ';
  const leftDash = '─'.repeat(Math.max(0, leftW - ltRaw.length - 1));
  const rightDash = '─'.repeat(Math.max(0, rightW - rtRaw.length - 1));
  const titleInner = `${borderColor}${C.bold}${ltRaw}${R}${C.bgSubtle}${leftDash}${R} ${C.bgSubtle}${C.bold}─${R}${borderColor}${C.bold}┬${R}${C.bgSubtle}${C.bold}─${R} ${borderColor}${C.bold}${rtRaw}${R}${C.bgSubtle}${rightDash}${R}`;
  const titleLine = `  ${border}│${R} ${_pad(titleInner, W)} ${border}│${R}`;
  const sep    = `  ${border}├${'─'.repeat(W + 2)}┤${R}`;
  const out = [top, titleLine, sep];
  for (const line of lines) {
    out.push(`  ${border}│${R} ${_pad(line, W)} ${border}│${R}`);
  }
  out.push(bottom);
  return out.join('\n');
  } catch (e) {
    if (globalThis._agentDebug) console.error('[renderToolPanel error]', e.message);
    return '';
  }
}

// ── CHAIN TABLE panel: CVE chains and privesc paths ──
let _tuiChains = []; // [{desc, tag}]  e.g. [{desc:'Apache PT → Ghostcat AJP → Shell → Root', tag:'🎯'}]

function renderChainPanel() {
  if (_tuiChains.length === 0) return '';
  _updateBoxW();
  const W = BOX_W;
  const lines = [];
  for (const c of _tuiChains) {
    // HaksterAI-style: ◇ icon for chain items with arrow visualization
    const parts = c.desc.split('→').map(p => p.trim());
    const chainStr = parts.map((p, i) => {
      const color = i === parts.length - 1 ? C.mustard + C.bold : C.fgBase;
      return `${color}${p}${C.reset}`;
    }).join(` ${C.tertiary}→${C.reset} `);
    lines.push(`${C.tertiary}${c.tag}${C.reset} ${chainStr}`);
  }
  // HaksterAI-style: subtle ── divider instead of ══
  lines.push(`${C.bgSubtle}${'─'.repeat(W - 4)}${C.reset}`);
  lines.push(`${C.fgSubtle}◇ ${_tuiChains.length} exploit chain${_tuiChains.length !== 1 ? 's' : ''} mapped${C.reset}`);
  return drawBox('CHAIN TABLE', lines, W, C.mustard);
}

// ── Dashboard composition: render all non-empty panels ──
function renderDashboard(thinkText) {
  const parts = [];
  if (_tuiPhase !== 'Idle') parts.push(renderReasoningPanel());
  const tp = renderThinkingPanel(thinkText);
  if (tp) parts.push(tp);
  if (_tuiToolGrid.length > 0) parts.push(renderToolPanel());
  if (_tuiChains.length > 0) parts.push(renderChainPanel());
  return parts.join('\n');
}

// ── Dashboard state updates (called from agent loop) ──
function tuiSetPhase(phase) {
  // Track phase transitions with timing
  if (_tuiPhaseStart && _tuiPhase !== phase) {
    _tuiPhaseLog.push({ phase: _tuiPhase, duration: Date.now() - _tuiPhaseStart });
    // Keep only last 20 phase entries
    if (_tuiPhaseLog.length > 20) _tuiPhaseLog.shift();
  }
  _tuiPhase = phase;
  _tuiPhaseStart = Date.now();
  if (!_tuiSessionStart) _tuiSessionStart = Date.now();
}
function tuiSetTarget(target)   { _tuiTarget = target; }
function tuiSetPorts(ports)     { _tuiPorts = ports; }
function tuiSetServices(svc)    { _tuiServices = svc; }
function tuiAddVuln(svc, cve, flag) { _tuiVulns.push({ svc, cve, flag }); }
function tuiSetStep(step, max)  { _tuiStep = step; if (max) _tuiMaxSteps = max; }
function tuiToolStart(emoji, name) {
  // Remove any previous 'running' entry for same tool to avoid dupes
  // Match by prefix (fnName) since name may include arg hint like "search_files → /path"
  const baseName = name.split(' → ')[0];
  _tuiToolGrid = _tuiToolGrid.filter(t => {
    const tBase = t.name.split(' → ')[0];
    return !(tBase === baseName && t.status === 'running');
  });
  _tuiToolGrid.push({ emoji: emoji || '🛠️', name, status: 'running', output: '', startTime: Date.now(), duration: null });
  _tuiCurrentOutput = '';
  _tuiCurrentTool = baseName;
  // Print a TUI callout line with box-drawing and emoji for visibility
  const badge = TOOL_TYPE[baseName] || '??';
  const calloutW = Math.min((process.stdout.columns || 80) - 6, 72);
  const label = name.length > calloutW - 8 ? name.substring(0, calloutW - 11) + '...' : name;
  const inner = `${emoji} ║ ${C.bold}${badge}${C.reset}${C.bgSubtle} ──${C.reset} ${C.tertiary}${label}${C.reset}`;
  log(`  ${C.bgSubtle}${C.bold}╭${C.reset}${C.bgSubtle}${'─'.repeat(Math.min(calloutW, 60))}${C.reset}${C.bgSubtle}${C.bold}╮${C.reset}`);
  log(`  ${C.bgSubtle}${C.bold}│${C.reset} ${inner}${C.reset}${' '.repeat(Math.max(0, calloutW - label.length - 10))} ${C.bgSubtle}${C.bold}│${C.reset}`);
  log(`  ${C.bgSubtle}${C.bold}╰${C.reset}${C.bgSubtle}${'─'.repeat(Math.min(calloutW, 60))}${C.reset}${C.bgSubtle}${C.bold}╯${C.reset}`);
}
function tuiToolDone(name, status, output) {
  // Match by base name (fnName). Grid entries are stored as "#<callNum> <fnName>"
  // (optionally " → <argHint>"), so the bare fnName passed in here must be matched
  // against the SUFFIX of the entry's base (e.g. fnName "read_file" matches
  // entry base "#1 read_file"). The old `===` compare never matched, so tools
  // stayed "running" (●) forever and the ✓ counter never climbed.
  const baseName = name.split(' → ')[0];
  const t = [..._tuiToolGrid].reverse().find(t => {
    const tBase = t.name.split(' → ')[0];
    return (tBase === baseName || tBase.endsWith(' ' + baseName)) && t.status === 'running';
  });
  const emoji = (t && t.emoji) || '🛠️';
  const dur = t && t.startTime ? Date.now() - t.startTime : 0;
  const durStr = dur > 0 ? (dur < 1000 ? dur + 'ms' : (dur / 1000).toFixed(1) + 's') : '';
  if (t) {
    t.status = status;
    t.output = (output || '').substring(0, 80);
    if (t.startTime) {
      t.duration = Date.now() - t.startTime;
      delete t.startTime;
    }
  }
  _tuiCurrentOutput = '';
  _tuiCurrentTool = null;
  // Print completion callout with emoji and box-drawing
  const doneEmoji = status === 'ok' ? '✅' : status === 'error' ? '❌' : '⏹️';
  const doneColor = status === 'ok' ? C.success : status === 'error' ? C.error : C.fgMuted;
  const badge = TOOL_TYPE[baseName] || '??';
  const calloutW = Math.min((process.stdout.columns || 80) - 6, 72);
  const label = baseName.length > calloutW - 16 ? baseName.substring(0, calloutW - 19) + '...' : baseName;
  const statusStr = status === 'ok' ? 'DONE' : status === 'error' ? 'FAIL' : 'END';
  // Output preview on second line
  const outPreview = (output || '').substring(0, 50);
  const inner = `${doneEmoji} ║ ${doneColor}${C.bold}${statusStr}${C.reset} ${C.bgSubtle}${badge}${C.reset} ${C.tertiary}${label}${C.reset} ${C.fgSubtle}${durStr}${C.reset}`;
  log(`  ${C.bgSubtle}${C.bold}╭${C.reset}${C.bgSubtle}${'─'.repeat(Math.min(calloutW, 60))}${C.reset}${C.bgSubtle}${C.bold}╮${C.reset}`);
  log(`  ${C.bgSubtle}${C.bold}│${C.reset} ${inner}${C.reset}${' '.repeat(Math.max(0, calloutW - label.length - 20))} ${C.bgSubtle}${C.bold}│${C.reset}`);
  if (outPreview && outPreview.trim()) {
    const previewLine = `  ${C.bgSubtle}${C.bold}│${C.reset} ${C.fgHalf}${_truncPad(outPreview, calloutW - 4)}${C.reset}${' '.repeat(Math.max(0, calloutW - label.length - 30))} ${C.bgSubtle}${C.bold}│${C.reset}`;
    log(previewLine);
  }
  log(`  ${C.bgSubtle}${C.bold}╰${C.reset}${C.bgSubtle}${'─'.repeat(Math.min(calloutW, 60))}${C.reset}${C.bgSubtle}${C.bold}╯${C.reset}`);
}
function tuiAddChain(desc, tag) { _tuiChains.push({ desc, tag: tag || '🎯' }); }
function tuiReset() {
  _tuiPhase = 'Idle'; _tuiTarget = ''; _tuiPorts = ''; _tuiServices = '';
  _tuiVulns = []; _tuiStep = 0; _tuiMaxSteps = _currentMaxTurns || MAX_TURNS_DEFAULT;
  _tuiToolGrid = []; _tuiChains = []; _tuiThinkingStart = null;
  _tuiPhaseStart = Date.now();
  // Preserve session-level state across turns (not resetting):
  // _tuiSessionStart, _tuiPhaseLog, _tuiKeyInsights, _tuiTokensIn, _tuiTokensOut
  // These accumulate across turns and only reset on fresh REPL session
  _tuiCurrentOutput = ''; _tuiCurrentTool = null;
  // Reset in-place panel tracking so fresh panels render correctly
  for (const k of Object.keys(_panelLines)) delete _panelLines[k];
}

// ── Banner — HaksterAI puff-letter header ────────────────────────────────
function banner() {
  // Dynamically count skills from .hakster/skills/
  const skillsDirs = getSkillDirs();
  let skillCount = 0;
  for (const skillsDir of skillsDirs) {
    try { skillCount += globSync(path.join(skillsDir, '**', '*.md')).length; } catch (_) {}
  }
  const mcpToolCount = getMcpTools().length;
  // Built-in tool count is the snapshot taken before MCP tools were merged into TOOLS.
  // Using TOOLS.length here double-counts MCP (they're already in TOOLS after initMcpTools).
  const builtInTools = (typeof _builtinToolCount === 'number') ? _builtinToolCount : TOOLS.length - mcpToolCount;
  const toolLabel = mcpToolCount > 0 ? `${builtInTools} + ${mcpToolCount} MCP` : `${builtInTools}`;
  // Memory notes: aggregate notes.json across ALL hakster roots (not just WORK_DIR).
  let memCount = 0;
  for (const root of getHaksterRoots()) {
    try {
      const notes = JSON.parse(fs.readFileSync(path.join(root, 'memory', 'notes.json'), 'utf-8'));
      if (Array.isArray(notes)) memCount += notes.length;
    } catch (_) {}
  }

  const W = _termWidth() - 6;  // 6 = border + padding chars
  const bdr = C.bgSubtle + C.bold;  // Charcoal borders (HaksterAI-style)
  const R = C.reset;

  // ── MASSIVE HaksterAI puff-letter banner with 3D depth ──
  // Each letter rendered with 3 color layers for inflated 3D look:
  //   Top lines: bright highlight (puffy shine on top)
  //   Mid lines: brand purple (main face)
  //   Bot lines: dark shadow (depth underneath)
  const _bannerArt = [
    "███████╗██╗  ██╗██╗   ██╗███████╗██╗     ███████╗██████╗ ██╗   ██╗███████╗███╗   ██╗ ██████╗ ",
    "██╔════╝██║  ██║██║   ██║██╔════╝██║     ██╔════╝██╔══██╗╚██╗ ██╔╝██╔════╝████╗  ██║██╔════╝ ",
    "███████╗███████║██║   ██║█████╗  ██║     █████╗  ██║  ██║ ╚████╔╝ █████╗  ██╔██╗ ██║██║  ███╗",
    "╚════██║██╔══██║██║   ██║██╔══╝  ██║     ██╔══╝  ██║  ██║  ╚██╔╝  ██╔══╝  ██║╚██╗██║██║   ██║",
    "███████║██║  ██║╚██████╔╝███████╗███████╗███████╗██████╔╝   ██║   ███████╗██║ ╚████║╚██████╔╝",
    "╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝╚══════╝╚═════╝    ╚═╝   ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ",
  ];

  // 3D puff rendering: highlight → face → shadow for inflated depth
  const _puffHi   = C.butter + C.bold;    // Bright shine on top
  const _puffFace  = C.primary + C.bold;    // Brand purple face
  const _puffShad  = C.bgSubtle + C.bold;   // Dark shadow bottom
  const art = _bannerArt.map((row, i) => {
    const raw = row.substring(0, Math.min(row.length, W));
    // 3D puff depth: top = bright highlight, middle = face, bottom = shadow
    if (i < 2) return `${_puffHi}${raw}${R}`;
    if (i < 4) return `${_puffFace}${raw}${R}`;
    return `${_puffShad}${raw}${R}`;
  });

  // HaksterAI-style outer box helpers — rounded, subtle Charcoal borders
  const outerLine = (text) => `  ${bdr}│${R} ${_pad(text, W)} ${bdr}│${R}`;
  const outerSep  = () => `  ${bdr}├${'─'.repeat(W + 2)}┤${R}`;
  const outerEmpty = () => outerLine('');

  // Inner panel helper — HaksterAI-style with ─── LABEL ─── dividers
  const innerBox = (label, lines, color = C.info) => {
    const iw = W - 4;
    const ib = C.bgSubtle + C.bold;
    const top    = `  ${bdr}│${R}  ${ib}╭${'─'.repeat(iw + 2)}╮${R}  ${bdr}│${R}`;
    const bottom = `  ${bdr}│${R}  ${ib}╰${'─'.repeat(iw + 2)}╯${R}  ${bdr}│${R}`;
    const sep    = `  ${bdr}│${R}  ${ib}├${'─'.repeat(iw + 2)}┤${R}  ${bdr}│${R}`;
    // ─── LABEL ─── centered divider
    const labelPad = iw - label.length - 2;
    const leftPad = Math.floor(labelPad / 2);
    const rightPad = labelPad - leftPad;
    const titleLine = `  ${bdr}│${R}  ${ib}│${R} ${color}${C.bold}${'─'.repeat(leftPad)} ${label} ${'─'.repeat(rightPad)}${R} ${ib}│${R}  ${bdr}│${R}`;
    const contentLines = lines.map(l => {
      return `  ${bdr}│${R}  ${ib}│${R} ${_truncPad(l, iw)} ${ib}│${R}  ${bdr}│${R}`;
    });
    return [top, titleLine, sep, ...contentLines, bottom].join('\n');
  };

  // ── Build the banner ──
  const lines = [];

  // Top border — rounded with hash grid accent
  lines.push(`  ${bdr}╭${T.hashFill(W + 2, C.bgSubtle)}╮${R}`);
  lines.push(`  ${bdr}│${R} ${C.bgSubtle}${'─'.repeat(W)}${R} ${bdr}│${R}`);

  // HAKSTER puff-letter art with 3D depth rendering
  for (const a of art) {
    lines.push(outerLine(a));
  }

  // ── AI accent line — bold "AI" suffix in brand purple ──
  const aiAccent = `${C.primary}${C.bold}╔══╗${R} ${C.secondary}${C.bold}╔══╗${R}  ${C.fgMuted}A I${R}`;
  lines.push(outerLine(aiAccent));

  // Separator: hash grid line
  lines.push(outerLine(`${C.bgSubtle}${T.hashFill(W, C.bgSubtle)}${R}`));

  // Version / status line — HaksterAI-style with tags
  const versionStr = `${C.primary}${C.bold}HAKSTERAI${R}  ${C.fgMuted}v2.1${R}`;
  // HaksterAI-style OKAY! tag
  const statusStr = `${C.bgSuccess}${C.bold}${C.butter} OKAY! ${R}  ${C.tertiary}⚡${R}  ${C.fgMuted}🔒${R}`;
  const versionPad = W - _stripAnsi(versionStr + statusStr).length;
  const halfPad = Math.max(0, Math.floor(versionPad / 2));
  lines.push(outerLine(`${versionStr}${' '.repeat(halfPad)}${statusStr}`));

  // Stat line — HaksterAI-style with ◇ bullet separators
  lines.push(outerLine(`${C.info}${C.bold}tools${R} ${C.fgBase}${toolLabel}${R} ${C.fgSubtle}◇${R} ${C.secondary}${C.bold}skills${R} ${C.fgBase}${skillCount}${R} ${C.fgSubtle}◇${R} ${C.success}${C.bold}mems${R} ${C.fgBase}${memCount}${R} ${C.fgSubtle}◇${R} ${C.cyan}${C.bold}queue${R} ${C.fgBase}${msgSize()}${R} ${C.fgSubtle}◇${R} ${C.error}${C.bold}⚠ confirm${R}`));

  // Separator before panels
  lines.push(outerSep());

  // ── REASONING panel (idle state at startup) ── HaksterAI-style with ◇ icon
  const reasoningLines = [
    `${C.tertiary}⏸${R} ${C.fgBase}[${new Date().toLocaleTimeString()}]${R} ${C.bold}Idle${R} ${C.fgMuted}(0s)${R}`,
    `          ${C.fgSubtle}Enter a task to begin${R}`,
    `          ${C.fgMuted}└─${R} ${C.fgSubtle}Progress${R} ${C.primary}${'░'.repeat(20)}${R} ${C.bold}${C.fgBase}0%${R} ${C.fgMuted}Step 0/${MAX_TURNS_DEFAULT}${R}`,
  ];
  lines.push(innerBox('REASONING', reasoningLines, C.info));

  // Empty line between panels
  lines.push(outerEmpty());

  // ── THINKING panel (idle state at startup) ──
  const thinkingLines = [
    `${C.fgSubtle}◇ Awaiting input...${R}`,
    `${C.fgSubtle}Type a task and the agent will reason automatically.${R}`,
  ];
  lines.push(innerBox('THINKING', thinkingLines, C.secondary));

  // Empty line between panels
  lines.push(outerEmpty());

  // ── TOOL GRID panel (idle state at startup) ── HaksterAI-style split header ──
  const innerW = W - 4;
  const splitRatio = 0.42;  // Match live grid — wider output column
  const leftW = Math.floor(innerW * splitRatio);
  const rightW = innerW - leftW - 3;
  const ltRaw = ' TOOL GRID ';
  const rtRaw = ' OUTPUT ';
  const leftDash = '─'.repeat(Math.max(0, leftW - ltRaw.length - 1));
  const rightDash = '─'.repeat(Math.max(0, rightW - rtRaw.length - 1));
  const toolTitleInner = `${C.success}${C.bold}${ltRaw}${R}${C.bgSubtle}${leftDash}${R} ${C.bgSubtle}${C.bold}─${R}${C.success}${C.bold}┬${R}${C.bgSubtle}${C.bold}─${R} ${C.success}${C.bold}${rtRaw}${R}${C.bgSubtle}${rightDash}${R}`;
  const toolTitleLine = `  ${C.bgSubtle}${C.bold}│${R} ${_pad(toolTitleInner, W)} ${C.bgSubtle}${C.bold}│${R}`;
  const toolContentLines = [
    `${_truncPad(`  ${C.fgSubtle}[ ]${R}  Waiting for tool calls...`, leftW)}${C.bgSubtle} │${R} ${_truncPad('', rightW)}`,
    `${C.bgSubtle}${'─'.repeat(leftW)}${C.bold}─┼─${R}${C.bgSubtle}${'─'.repeat(rightW)}${R}`,
    `${C.bold}Total:${R} 0  ${C.success}✓0${R}  ${C.mustard}●0${R}  ${C.error}×0${R}  ${C.primary}${'░'.repeat(20)}${R}`,
    `${C.tertiary}◇${R} ${C.fgMuted}${MODEL}${R}`,
  ];
  const toolGridBox = [
    `  ${C.bgSubtle}${C.bold}╭${'─'.repeat(W + 2)}╮${R}`,
    toolTitleLine,
    `  ${C.bgSubtle}${C.bold}├${'─'.repeat(W + 2)}┤${R}`,
    ...toolContentLines.map(l => `  ${C.bgSubtle}${C.bold}│${R} ${_pad(l, W)} ${C.bgSubtle}${C.bold}│${R}`),
    `  ${C.bgSubtle}${C.bold}╰${'─'.repeat(W + 2)}╯${R}`,
  ];
  lines.push(...toolGridBox);

  // Empty line between panels
  lines.push(outerEmpty());

  // ── CHAIN TABLE (idle state at startup) ── HaksterAI-style with ◇ icon
  const chainLines = [
    `${C.fgSubtle}No exploit chains yet${R}`,
    `${C.bgSubtle}${T.grid2(W - 14)}${R}`,
    `${C.fgSubtle}Chains will appear as vulnerabilities are linked.${R}`,
  ];
  lines.push(innerBox('CHAIN TABLE', chainLines, C.mustard));

  // Empty line before footer
  lines.push(outerEmpty());

  // Separator before footer — hash grid accent
  lines.push(outerLine(`${C.bgSubtle}${T.hashFill(W, C.bgSubtle)}${R}`));

  // Footer with keybindings — HaksterAI-style tags
  lines.push(outerLine(`${C.bgPrimary}${C.butter}${C.bold} Ctrl+C ${R} ${C.fgMuted}Exit${R}  ${C.bgInfo}${C.butter}${C.bold} Tab ${R} ${C.fgMuted}Panels${R}  ${C.bgOverlay}${C.fgBase}${C.bold} ↑↓ ${R} ${C.fgMuted}Scroll${R}  ${C.bgOverlay}${C.fgBase}${C.bold} F5 ${R} ${C.fgMuted}Refresh${R}  ${C.bgSuccess}${C.butter}${C.bold} 📋 ${R} ${C.fgMuted}Paste Image${R}`));

  // Bottom border — rounded with hash accent
  lines.push(`  ${bdr}╰${T.hashFill(W + 2, C.bgSubtle)}╯${R}`);

  return '\n' + lines.join('\n') + '\n';
}

// ── Tool Definitions ────────────────────────────────────────────────────
let TOOLS = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Execute a shell command and return stdout+stderr. Runs in the project working directory.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          timeout: { type: 'number', description: 'Timeout in seconds (default 30, max 300)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file and return its contents. Supports offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to project)' },
          offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
          limit: { type: 'number', description: 'Max lines to return' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates parent directories. Overwrites existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description: 'Find and replace text in a file. Supports fuzzy matching: if exact text not found, tries normalized-whitespace match (tabs/spaces/CRLF) then line-trim match (ignoring indentation). For non-unique matches, replaces first occurrence with a warning. Always returns the line number of the change.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          old_text: { type: 'string', description: 'Text to find (should be unique in file; fuzzy matching is attempted if exact match fails)' },
          new_text: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories at a path. Returns names, sizes, types.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: project root)' },
          recursive: { type: 'boolean', description: 'List recursively (default: false)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a URL and return the response body (text/HTML/JSON). CRITICAL: Use this to read documentation, API specs, and web pages. ALWAYS fetch docs instead of guessing. Has timeout to prevent hanging. Supports GET, POST, PUT, DELETE.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          method: { type: 'string', description: 'HTTP method (default: GET)', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
          headers: { type: 'object', description: 'Request headers' },
          body: { type: 'string', description: 'Request body (for POST/PUT)' },
          timeout: { type: 'number', description: 'Timeout in seconds (default: 15, max: 60). Use higher for slow APIs.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'firecrawl',
      description: 'Firecrawl web extraction. Actions: "scrape" (clean markdown/HTML of one URL), "crawl" (crawl a whole site, returns job id + first batch), "map" (list all URLs on a site), "search" (web search via Firecrawl). CRITICAL: prefer firecrawl scrape over web_fetch when you need CLEAN readable page content (docs, articles, listings) — it returns parsed markdown, not raw HTML. Requires FIRECRAWL_API_KEY.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: scrape, crawl, map, search', enum: ['scrape', 'crawl', 'map', 'search'] },
          url: { type: 'string', description: 'Target URL (required for scrape/crawl/map)' },
          query: { type: 'string', description: 'Search query (required for action=search)' },
          limit: { type: 'number', description: 'Max results/urls (default 25 for map/search, 10 for crawl)' },
          formats: { type: 'array', items: { type: 'string' }, description: 'Output formats for scrape (default ["markdown"]). Options: markdown, html, rawHtml' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web using DuckDuckGo API. Returns top results with titles, URLs, and snippets. CRITICAL: ALWAYS search before guessing. If you do not know something, SEARCH for it — do NOT hallucinate answers. Use for: looking up docs, finding solutions, checking current info, researching APIs, verifying facts, finding code examples, checking library versions, looking up error messages.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Number of results to return (default: 8, max: 20)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for files by name pattern or search inside file contents with regex.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern for filenames, or regex for content search' },
          path: { type: 'string', description: 'Directory to search in (default: project root)' },
          mode: { type: 'string', description: '"files" to find by name, "content" to search inside files', enum: ['files', 'content'] },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_background',
      description: 'Start a long-running process in the background (servers, watchers). Returns PID.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run in background' },
          name: { type: 'string', description: 'Friendly name for the process' },
        },
        required: ['command', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_process',
      description: 'Kill a background process by name or PID.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Process name to kill' },
          pid: { type: 'number', description: 'Process PID to kill' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'multi_patch',
      description: 'Apply multiple find-and-replace patches to a single file in one call. Supports fuzzy matching (normalized whitespace, line-trim). Faster and more reliable than calling patch_file repeatedly.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          patches: {
            type: 'array',
            description: 'Array of {old_text, new_text} pairs to apply sequentially',
            items: {
              type: 'object',
              properties: {
                old_text: { type: 'string', description: 'Text to find (fuzzy matching is attempted if exact match fails)' },
                new_text: { type: 'string', description: 'Replacement text' },
              },
              required: ['old_text', 'new_text'],
            },
          },
        },
        required: ['path', 'patches'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'insert_lines',
      description: 'Insert text at a specific line number in a file. Does not modify existing lines. Use for adding imports, functions, config blocks.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          line: { type: 'number', description: 'Line number to insert AFTER (0 = insert at top)' },
          content: { type: 'string', description: 'Text to insert' },
        },
        required: ['path', 'line', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_lines',
      description: 'Delete a range of lines from a file. Line numbers are 1-indexed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          start: { type: 'number', description: 'Start line number (1-indexed, inclusive)' },
          end: { type: 'number', description: 'End line number (1-indexed, inclusive)' },
        },
        required: ['path', 'start', 'end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_regex',
      description: 'Regex find-and-replace in a file. Use for bulk renames, pattern changes, removing all occurrences. Set replace_all=true for global replace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          pattern: { type: 'string', description: 'JavaScript regex pattern (e.g. "console\\.log\\(.*?\\)")' },
          replacement: { type: 'string', description: 'Replacement string ($1, $2 for capture groups)' },
          flags: { type: 'string', description: 'Regex flags (default: "g"). Use "g" for global, "gi" for case-insensitive.' },
        },
        required: ['path', 'pattern', 'replacement'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: 'Append content to end of file. Much faster than read_file + write_file for adding lines.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Text to append' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_op',
      description: 'Execute a git operation. Common: status, diff, add, commit, push, log, branch, checkout. For complex git commands use shell tool instead.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            description: 'Git operation',
            enum: ['status', 'diff', 'add', 'commit', 'push', 'pull', 'log', 'branch', 'checkout', 'stash', 'reset', 'fetch'],
          },
          args: { type: 'string', description: 'Arguments for the operation (e.g. commit message, branch name, file paths)' },
        },
        required: ['operation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pm2',
      description: 'Manage PM2 processes. Start, stop, restart, logs, status for haksterAI, CineVault, Miniforge, Phantom services.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'PM2 action',
            enum: ['list', 'restart', 'stop', 'start', 'logs', 'describe'],
          },
          name: { type: 'string', description: 'Process name (hakster, cinevault, miniforge, phantom)' },
          lines: { type: 'number', description: 'Lines of logs to show (default: 30)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'service_check',
      description: 'Quick health check for local services. Tests if haksterAI (3579), CineVault (8081), Miniforge (5555), Phantom (4000), or Claude Proxy (8082) are responding.',
      parameters: {
        type: 'object',
        properties: {
          service: {
            type: 'string',
            description: 'Service to check',
            enum: ['haksterai', 'cinevault', 'miniforge', 'phantom', 'claude-proxy', 'all'],
          },
        },
        required: ['service'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'claude_proxy',
      description: 'Send a prompt to Claude (or any LiteLLM-supported model) via the Claude Code Proxy on port 8082. The proxy translates Anthropic API format to OpenAI/Google/Anthropic backends via LiteLLM. Use this for tasks that benefit from a different model (e.g. Claude for nuanced reasoning, GPT-4 for code review). Returns the model response text.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The prompt/message to send to the model' },
          model: { type: 'string', description: 'Model to use (default: claude-sonnet-4-5). Options: claude-sonnet-4-5, claude-opus-4-5, claude-haiku-3-5, gpt-4.1, gpt-4.1-mini, gemini-2.5-pro, gemini-2.5-flash' },
          system: { type: 'string', description: 'Optional system prompt for the model' },
          max_tokens: { type: 'number', description: 'Max tokens in response (default: 4096)' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_agent',
      description: 'Run a specialized agent script from /home/ghost/claude_agents/agents/. Available agents: ai, automator, coder, debugger, exploit, security. Each agent runs as a shell command and returns its output. Use for delegating specialized tasks to purpose-built agent scripts.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: 'Agent name to run',
            enum: ['ai', 'automator', 'coder', 'debugger', 'exploit', 'security'],
          },
          args: { type: 'string', description: 'Arguments to pass to the agent script' },
        },
        required: ['agent'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'snapshot',
      description: 'Take a screenshot of a web page or localhost URL. Returns a description of what the page looks like. Use to verify UI changes, debug layout issues, or check deployed apps visually.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to snapshot (e.g. http://localhost:3579/chat)' },
          width: { type: 'number', description: 'Viewport width in px (default: 1280)' },
          height: { type: 'number', description: 'Viewport height in px (default: 800)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sub_agent',
      description: 'CRITICAL POWER TOOL: Spawn one or more sub-agents that run in parallel. Each sub-agent gets its own conversation and can use ALL tools. MUCH faster than doing things sequentially. ALWAYS use this when you have 2+ independent tasks. Use for: running multiple independent tasks simultaneously, researching multiple topics at once, parallelizing file edits, checking multiple services. Returns each sub-agent result. Max 3 sub-agents per call.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'Array of tasks to run in parallel. Each task has a goal string.',
            items: {
              type: 'object',
              properties: {
                goal: { type: 'string', description: 'What this sub-agent should accomplish' },
                name: { type: 'string', description: 'Short name for this task (e.g. "check-ports", "fix-auth")' },
              },
              required: ['goal'],
            },
            maxItems: 3,
          },
        },
        required: ['tasks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crush',
      description: 'Run Crush (Charmbracelet agentic coding tool) for a task. Crush is a terminal-first AI coding agent that can read/write files, run commands, and reason about code. Use for complex coding tasks, refactoring, debugging, or when you need a second opinion from a different model. Runs non-interactively with a prompt. Supports model selection (e.g. claude-sonnet-4-5, gpt-4.1) and working directory.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task/prompt for Crush to execute (e.g. "Fix the TypeScript type errors in server/src/agent/index.js")' },
          model: { type: 'string', description: 'Model to use (default: gpt-oss:120b-cloud via Ollama). Currently configured to use gpt-oss:120b-cloud. Other models require separate provider configuration in crush.json.' },
          cwd: { type: 'string', description: 'Working directory for Crush (default: current project dir)' },
          timeout: { type: 'number', description: 'Timeout in seconds (default: 120, max: 300)' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parallel_shell',
      description: 'Run multiple shell commands in parallel. Returns all outputs together. Use for checking multiple ports, running independent diagnostics, or parallel file operations.',
      parameters: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            description: 'Array of shell commands to run simultaneously',
            items: { type: 'string' },
            maxItems: 5,
          },
          timeout: { type: 'number', description: 'Timeout per command in seconds (default: 30)' },
        },
        required: ['commands'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'code_grid',
      description: 'Display code with line numbers and syntax coloring in a grid. Use for showing code to the user — always use this when presenting code files, diffs, or file contents. Renders a colored, line-numbered grid that highlights modifications, additions (green +), and deletions (red -).',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The code content to display' },
          title: { type: 'string', description: 'File name or title for the grid header' },
          lang: { type: 'string', description: 'Language for syntax hints (js, py, html, css, json, bash, etc.)' },
          highlight_lines: {
            type: 'array',
            description: 'Line numbers to highlight (changed/important lines)',
            items: { type: 'number' },
          },
          diff_lines: {
            type: 'array',
            description: 'Lines that are additions (+) or deletions (-). Prefix with + or - e.g. "+5" means line 5 is an addition',
            items: { type: 'string' },
          },
        },
        required: ['code', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Navigate a headless browser to a URL. Opens the page and waits for it to load. Returns the page title, URL, and a text snapshot of visible content. Use before browser_click, browser_type, or browser_screenshot.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to (e.g. http://localhost:3579/chat)' },
          wait_ms: { type: 'number', description: 'Milliseconds to wait after load for JS to render (default: 2000)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element on the current browser page by its text content, CSS selector, or index. Returns the result and updated page snapshot.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector or button/link text to click' },
          index: { type: 'number', description: 'If multiple matches, click the Nth one (0-based, default: 0)' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input field on the current browser page. Clears existing text first, then types the new value.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the input field' },
          text: { type: 'string', description: 'Text to type into the field' },
          press_enter: { type: 'boolean', description: 'Press Enter after typing (default: false)' },
        },
        required: ['selector', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Take a real screenshot of the current browser page (PNG). Returns the file path. Use to visually verify UI, debug layout, or check what a page looks like.',
      parameters: {
        type: 'object',
        properties: {
          full_page: { type: 'boolean', description: 'Capture the full scrollable page (default: false, viewport only)' },
          selector: { type: 'string', description: 'CSS selector to screenshot a specific element only' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Get an accessibility tree snapshot of the current browser page. Returns interactive elements (buttons, links, inputs) with ref IDs for clicking/typing. Use to understand page structure before interacting.',
      parameters: {
        type: 'object',
        properties: {
          full: { type: 'boolean', description: 'Return full page content (default: false, compact view with interactive elements only)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory',
      description: 'Save or recall persistent notes that survive across sessions. Use "add" to save a fact, "list" to see all notes, "get" to read one, "remove" to delete one, "search" to find by keyword, "projects" to scan and list all known projects. IMPORTANT: When the user says "take note", "note that", "remember this", "make a note", "save that", or similar — ALWAYS call memory add with what they said. No exceptions.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'get', 'remove', 'search', 'projects'], description: 'Action: add a note, list all, get by id, remove by id, search by keyword, or scan project bank' },
          content: { type: 'string', description: 'Note content (for add action)' },
          id: { type: 'string', description: 'Note ID (for get/remove actions)' },
          query: { type: 'string', description: 'Search keyword (for search action)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_save',
      description: 'Save a reusable skill/procedure as a markdown file. Skills capture workflows, step-by-step procedures, gotchas, and best practices. Like a playbook you can load later. Use when you discover a repeatable process worth remembering.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (lowercase, hyphens, e.g. "deploy-cinevault")' },
          content: { type: 'string', description: 'Full skill content in markdown (steps, commands, gotchas)' },
          category: { type: 'string', description: 'Optional category folder (e.g. "devops", "debugging")' },
        },
        required: ['name', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_load',
      description: 'Load a saved skill by name. Returns the full markdown content. Use before executing a workflow you have a skill for.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name to load' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_list',
      description: 'List all saved skills with names and categories. Use to discover available skills.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notify',
      description: 'Push a message to the notification queue. Messages are displayed to the user before their next input and can be viewed with /queue.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The notification message' },
          type: { type: 'string', description: 'Message type: notify, warn, error, task, mcp, system', enum: ['notify', 'warn', 'error', 'task', 'mcp', 'system'] },
          priority: { type: 'string', description: 'Priority: critical, high, normal, low', enum: ['critical', 'high', 'normal', 'low'] },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate images for user apps and projects — app icons, splash screens, logos, UI mockups, project banners, OG images, favicons, feature illustrations, and more. Always include project context in the prompt (app name, brand colors, style). Saves to outputs/images/.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text description of the desired image' },
          provider: { type: 'string', description: 'Image provider: pollinations (default, low-cost), openai, or openrouter', enum: ['pollinations', 'openai', 'openrouter'] },
          model: { type: 'string', description: 'Model to use. Pollinations default: zimage. Other options: flux, gptimage, kontext, seedream5, qwen-image, dall-e-3, gpt-image-1' },
          size: { type: 'string', description: 'Image size: 1024x1024 (default), 1024x1792, 1792x1024, or 512x512' },
          quality: { type: 'string', description: 'Quality: hd/top-grade by default, or standard for faster/cheaper drafts', enum: ['standard', 'hd'] },
          operation: { type: 'string', description: 'What to do: generate, logo, edit, or enhance', enum: ['generate', 'logo', 'edit', 'enhance'] },
          image_path: { type: 'string', description: 'Optional local image file path to edit/enhance' },
          image_url: { type: 'string', description: 'Optional image URL to use as an edit/style reference' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_image',
      description: 'Read an image file from disk and return a base64-encoded data URI. Use this to analyze, describe, or process images the user provides. Returns metadata (dimensions, size, format) plus the data URI for vision models.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the image file (png, jpg, jpeg, gif, webp, bmp, svg)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_image',
      description: 'Analyze an image using the vision model. Describes content, detects objects, reads text, answers questions. More powerful than read_image — actually "sees" the image and returns intelligent analysis.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the image file to analyze' },
          prompt: { type: 'string', description: 'What to analyze: e.g. "describe this", "what text is in this", "find UI bugs", "compare to wireframe"' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ocr_text',
      description: 'Extract text from an image or screenshot using OCR. Returns structured text with confidence scores. Better than analyze_image for pure text extraction.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the image/screenshot file' },
          lang: { type: 'string', description: 'Language hint (e.g. "eng", "spa", "fra"). Default: "eng"' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_images',
      description: 'Compare two images pixel-by-pixel. Highlights visual differences, reports % match. Use for UI regression testing, before/after checks, spotting layout shifts.',
      parameters: {
        type: 'object',
        properties: {
          path_a: { type: 'string', description: 'Path to the first (reference) image' },
          path_b: { type: 'string', description: 'Path to the second (comparison) image' },
          threshold: { type: 'number', description: 'Pixel difference threshold 0-255 (default: 10). Lower = stricter.' },
        },
        required: ['path_a', 'path_b'],
      },
    },
  },
  // ── Autoflow: 7 new top-tier agent tools ──────────────────────────────────
  {
    function: {
      name: 'glob_search',
      description: 'Find files matching a glob pattern under the working directory. Returns matched file paths sorted by modification time. Use for file discovery, pattern-based search, and project navigation.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match (e.g. "src/**/*.js", "**/*.test.ts", "docs/*.md")' },
          maxResults: { type: 'number', description: 'Maximum results to return (default: 100)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    function: {
      name: 'edit_file',
      description: 'Edit a file by applying a list of line-based changes. Each change specifies start/end line numbers and replacement text. Returns a summary of changes made. Safer than write_file for targeted edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit (relative to working directory)' },
          changes: {
            type: 'array',
            description: 'Array of {start, end, text} objects. start/end are 1-based line numbers. text is the replacement content.',
            items: {
              type: 'object',
              properties: {
                start: { type: 'number', description: 'Start line (1-based)' },
                end: { type: 'number', description: 'End line (1-based, inclusive)' },
                text: { type: 'string', description: 'Replacement text for the line range' },
              },
              required: ['start', 'end', 'text'],
            },
          },
          createIfMissing: { type: 'boolean', description: 'Create the file if it does not exist (default: false)' },
        },
        required: ['path', 'changes'],
      },
    },
  },
  {
    function: {
      name: 'replace_in_file',
      description: 'Replace exact string matches in a file. Each replacement specifies old text and new text. Fails if old text is not found. Returns count of replacements made.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to working directory)' },
          replacements: {
            type: 'array',
            description: 'Array of {old, new} replacement pairs. old must match exactly.',
            items: {
              type: 'object',
              properties: {
                old: { type: 'string', description: 'Exact text to find' },
                new: { type: 'string', description: 'Replacement text' },
              },
              required: ['old', 'new'],
            },
          },
          createIfMissing: { type: 'boolean', description: 'Create the file if it does not exist (default: false)' },
        },
        required: ['path', 'replacements'],
      },
    },
  },
  {
    function: {
      name: 'shell_bg',
      description: 'Run a long-running shell command in the background. Returns a process ID immediately for non-blocking execution. Use for servers, watchers, daemons, and long builds. Check output with check_bg_output, kill with kill_process.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run in the background' },
          label: { type: 'string', description: 'Optional label for the background process (e.g. "dev-server", "test-watch")' },
          cwd: { type: 'string', description: 'Working directory for the command (default: project root)' },
        },
        required: ['command'],
      },
    },
  },
  {
    function: {
      name: 'diff_preview',
      description: 'Preview the unified diff of proposed changes to a file without writing them. Shows what would change if you apply the given replacements. Use before edit_file or replace_in_file to verify changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to preview changes for (relative to working directory)' },
          replacements: {
            type: 'array',
            description: 'Array of {old, new} replacement pairs to preview',
            items: {
              type: 'object',
              properties: {
                old: { type: 'string', description: 'Existing text' },
                new: { type: 'string', description: 'Proposed replacement text' },
              },
              required: ['old', 'new'],
            },
          },
        },
        required: ['path', 'replacements'],
      },
    },
  },
  {
    function: {
      name: 'codebase_map',
      description: 'Generate a structured overview of the project directory tree. Shows files, directories, line counts, and key files. Use to orient yourself in a new codebase or find relevant files quickly.',
      parameters: {
        type: 'object',
        properties: {
          maxDepth: { type: 'number', description: 'Maximum directory depth to show (default: 4)' },
          maxFiles: { type: 'number', description: 'Maximum files to list (default: 200)' },
          includeHidden: { type: 'boolean', description: 'Include hidden files/dirs like .git (default: false)' },
          focus: { type: 'string', description: 'Focus on a subdirectory (e.g. "src", "server/src")' },
        },
      },
    },
  },
  {
    function: {
      name: 'context_compaction',
      description: 'Summarize and compress conversation history to stay within token limits. Returns a condensed version of recent context. Use when approaching context window limits to preserve the most important context.',
      parameters: {
        type: 'object',
        properties: {
          strategy: { type: 'string', enum: ['summarize', 'truncate_old', 'keep_recent', 'key_facts'], description: 'Compaction strategy: summarize=all, truncate_old=drop oldest, keep_recent=keep last N, key_facts=extract key facts only' },
          maxTokens: { type: 'number', description: 'Target maximum token count for compacted context (default: 8000)' },
          keepLastN: { type: 'number', description: 'For keep_recent strategy, how many recent turns to keep (default: 10)' },
        },
      },
    },
  },
  // ── Plan tool: persistent markdown plan (mirrors Copilot CLI plan.md) ──
  {
    type: 'function',
    function: {
      name: 'plan',
      description: 'Manage the persistent implementation plan (markdown) at .hakster/plan.md. Use this to plan multi-step work BEFORE coding, then update it at milestones so progress persists across sessions. Writing/updating the plan counts as real progress (does not trigger loop detection).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['write', 'read', 'clear'], description: 'write=replace the plan body, read=return current plan, clear=wipe the plan' },
          content: { type: 'string', description: 'Markdown body for the plan (action=write). Ignored for read/clear.' },
        },
        required: ['action'],
      },
    },
  },
  // ── Todo tool: persistent task tracking (mirrors Copilot CLI SQL todos) ──
  {
    type: 'function',
    function: {
      name: 'todo',
      description: 'Manage a persistent todo list backed by .hakster/todos.json. Track multi-step task progress with status and dependencies. Listing/adding/updating todos counts as real progress (does not trigger loop detection).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'update', 'remove', 'dep'], description: 'add=create a todo, list=show all todos, update=change status, remove=delete a todo, dep=record a dependency between two todos' },
          id: { type: 'string', description: 'Todo id (kebab-case). Required for add/update/remove/dep.' },
          title: { type: 'string', description: 'Short title in gerund form (action=add).' },
          description: { type: 'string', description: 'What the todo entails (action=add).' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'New status (action=update).' },
          depends_on: { type: 'string', description: 'Id of a todo this one depends on (action=dep).' },
        },
        required: ['action'],
      },
    },
  },
];

// ── Background process registry ──────────────────────────────────────────
const bgProcesses = new Map();

// ── Async shell (replaces execSync — non-blocking, proper timeout kill) ──
function asyncShell(command, opts = {}) {
  const { cwd = WORK_DIR, timeout = 30, maxBuffer = 1024 * 1024 * 5 } = opts;
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,  // needed for process.kill(-pid) to wipe the group
    });
    let stdout = '', stderr = '';
    let killed = false;
    let resolved = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      // Kill entire process group to clean up any child processes
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
      // Force-resolve after SIGKILL if close event never fires (zombie stdio pipes)
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
          resolve({ ok: false, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: -1, killed: true, output: out + `\n[timeout after ${timeout}s, force-resolved]` });
        }
      }, 2000);  // 2s grace after SIGKILL for close to fire
    }, Math.min(timeout, 300) * 1000);

    child.stdout.on('data', (d) => {
      if (stdout.length < maxBuffer) stdout += d.toString('utf8').replace(/\x00/g, '').replace(/\x1b\[[0-9;]*m/g, '');
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < maxBuffer) stderr += d.toString('utf8').replace(/\x00/g, '').replace(/\x1b\[[0-9;]*m/g, '');
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      if (killed) {
        const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        resolve({ ok: false, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? -1, killed: true, output: out + `\n[timeout after ${timeout}s]` });
      } else if (code !== 0) {
        resolve({ ok: false, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code, output: [stdout.trim(), stderr.trim(), `exit code: ${code}`].filter(Boolean).join('\n') });
      } else {
        resolve({ ok: true, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0, output: stdout.trim() || '(command produced no output)' });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      resolve({ ok: false, stdout: '', stderr: err.message, exitCode: -1, output: `Error: ${err.message}` });
    });
  });
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// ── Tool Executors ──────────────────────────────────────────────────────
const toolExecutors = {
  async shell({ command, timeout = 30 }) {
    // ── Auto-wrap unbounded grep/rg/find commands with output limits ──
    let finalCmd = command;
    const cmdLower = command.trim().toLowerCase();
    const isGrepLike = /\b(rg|grep|egrep|fgrep|ag|ack|ripgrep)\b/i.test(cmdLower);
    const isFindLike = /\b(find|fd|locate)\b/i.test(cmdLower);
    const isSearchCmd = isGrepLike || isFindLike;

    if (isGrepLike) {
      // Auto-add --max-count if not present and pipe through head for safety
      const hasMaxCount = /--max-count|-m\s+\d+|-c\b/.test(cmdLower);
      const hasHead = /\|\s*head\b/.test(cmdLower);
      const hasCount = /\b-c\b/.test(cmdLower);  // -c = count mode
      const isRg = /\brg\b/i.test(cmdLower);
      // Reduce timeout for grep commands — they should be fast
      if (timeout > 15) timeout = Math.min(timeout, 15);
      if (!hasMaxCount && !hasHead && !hasCount) {
        if (isRg) {
          const hasDashDash = /\s--\s+/.test(command);
          if (!hasDashDash) {
            finalCmd = command + ' --max-count 50';
          } else {
            finalCmd = command.replace(/\s+--\s+/, ' --max-count 50 -- ');
          }
          finalCmd = finalCmd + ' 2>/dev/null | head -n 200';
        } else {
          finalCmd = command + ' 2>/dev/null | head -n 200';
        }
      }
    }

    const isRecursiveLs = /\bls\b.*\s-[a-zA-Z]*R/i.test(cmdLower) || /\bls\s+.*\//i.test(cmdLower);
    if (isRecursiveLs && !/\|\s*head\b/.test(cmdLower)) {
      finalCmd = command + ' 2>/dev/null | head -n 300';
      if (timeout > 15) timeout = Math.min(timeout, 15);
    }

    if (isFindLike && !/\|\s*head\b/.test(cmdLower) && !/-maxdepth\b/.test(cmdLower) && !/-depth\b/.test(cmdLower)) {
      if (/\bfind\b/i.test(cmdLower)) {
        finalCmd = command.replace(/\bfind\b/i, 'find -maxdepth 8');
        finalCmd = finalCmd + ' 2>/dev/null | head -n 300';
      }
      if (timeout > 15) timeout = Math.min(timeout, 15);
    }

    // Track EVERY shell command (with normalized signature) for repeat-loop detection.
    // Search commands (grep/find) keep their `tool` tag so the grep-loop check still works.
    const _sig = _normalizeShellSig(command);
    _recentShellCommands.push({
      cmd: command.substring(0, 120),
      tool: isSearchCmd ? (isGrepLike ? 'grep' : 'find') : 'shell',
      sig: _sig,
    });
    if (_recentShellCommands.length > SHELL_LOOP_WINDOW) _recentShellCommands.shift();

    // ── Generic shell repeat-loop break (ALL commands, not just grep/find) ──
    // Skip exec entirely to avoid stalls, and flag the tool-call path to do the
    // full break (trim history, drain queue, set cooldown).
    const _repeat = _checkShellRepeatLoop(command);
    if (_repeat.loop) {
      _shellRepeatBreak = true;
      _recentShellCommands = [];
      const _rlWarn = `\n[🔴 SHELL REPEAT-LOOP: ran the same command ${_repeat.count}× in a row. SKIPPED execution to avoid a stall. STOP repeating "${_repeat.sig.substring(0, 60)}". You already have its output — act on it: edit a file, run a DIFFERENT command, or answer the user. Do NOT re-run the same command.]\n`;
      return _rlWarn;
    }

    // Check for grep/search loop — inject warning if detected
    const grepLikeCount = _recentShellCommands.filter(c => c.tool === 'grep' || c.tool === 'find').length;
    if (grepLikeCount >= GREP_LOOP_LIMIT && _recentShellCommands.length >= 3) {
      const warning = '\n[LOOP WARNING: ' + grepLikeCount + ' search commands in a row. Stop searching and use what you know. Take a concrete action now — edit a file, run a fix command, or give the user an answer.]\n';
      const result = await asyncShell(finalCmd, { timeout });
      _recentShellCommands = [];
      return result.output + warning;
    }

    const result = await asyncShell(finalCmd, { timeout });
    // Truncate grep output if still too long
    if (isGrepLike) {
      const lines = result.output.split('\n');
      if (lines.length > GREP_CMD_MAX_OUTPUT) {
        const truncated = lines.slice(0, GREP_CMD_MAX_OUTPUT).join('\n');
        return truncated + '\n... (' + (lines.length - GREP_CMD_MAX_OUTPUT) + ' more lines, truncated. Use a more specific pattern or --max-count.)';
      }
    }
    return result.output;
  },

  read_file({ path: filePath, offset = 1, limit = 500 }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
      const content = fs.readFileSync(resolved, 'utf-8');
      const lines = content.split('\n');
      const totalWidth = String(lines.length).length + 1;
      const start = Math.max(0, offset - 1);
      const end = Math.min(lines.length, start + limit);
      const sliced = lines.slice(start, end);
      // Color line numbers with dim purple, alternating subtle bg for readability
      const numbered = sliced.map((l, i) => {
        const lineNum = String(start + i + 1).padStart(totalWidth);
        const bgColor = i % 2 === 0 ? '\x1b[48;5;234m' : '\x1b[48;5;236m';
        return `${bgColor}\x1b[38;5;183m${lineNum}│\x1b[0m${l}`;
      }).join('\n');
      return numbered + `\n--- showing lines ${start + 1}-${end} of ${lines.length} ---`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  write_file({ path: filePath, content }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      if (!sandbox.isWritable(resolved)) return `❌ Sandbox: write to ${resolved} blocked (outside writable root)`;
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, 'utf-8');
      const lines = content.split('\n').length;
      return `✓ Wrote ${lines} lines to ${resolved}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  // ── Plan tool: persistent markdown plan at .hakster/plan.md ──
  plan({ action, content }) {
    const planDir = path.join(process.env.HOME || '/home/ghost', '.hakster');
    const planPath = path.join(planDir, 'plan.md');
    try {
      if (action === 'read') {
        if (!fs.existsSync(planPath)) return '(no plan yet — use plan with action=write to create one)';
        return fs.readFileSync(planPath, 'utf-8');
      }
      if (action === 'clear') {
        if (fs.existsSync(planPath)) fs.writeFileSync(planPath, '', 'utf-8');
        return '✓ Plan cleared';
      }
      // action === 'write'
      fs.mkdirSync(planDir, { recursive: true });
      const stamp = `<!-- updated ${new Date().toISOString()} -->\n`;
      fs.writeFileSync(planPath, stamp + (content || ''), 'utf-8');
      const lines = (content || '').split('\n').length;
      return `✓ Plan written (${lines} lines) to ${planPath}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  // ── Todo tool: persistent todo list at .hakster/todos.json ──
  todo({ action, id, title, description, status, depends_on }) {
    const hakDir = path.join(process.env.HOME || '/home/ghost', '.hakster');
    const todoPath = path.join(hakDir, 'todos.json');
    const VALID_STATUS = new Set(['pending', 'in_progress', 'done', 'blocked']);
    try {
      fs.mkdirSync(hakDir, { recursive: true });
      let todos = [];
      let deps = [];
      if (fs.existsSync(todoPath)) {
        const raw = JSON.parse(fs.readFileSync(todoPath, 'utf-8') || '{}');
        todos = Array.isArray(raw.todos) ? raw.todos : [];
        deps = Array.isArray(raw.deps) ? raw.deps : [];
      }

      if (action === 'list') {
        if (todos.length === 0) return '(no todos — use todo with action=add to create one)';
        return todos.map(t => `[${(t.status || 'pending').padEnd(11)}] ${t.id}: ${t.title}${t.description ? ' — ' + t.description : ''}`).join('\n');
      }

      if (action === 'add') {
        if (!id || !title) return 'Error: add requires id and title';
        if (todos.some(t => t.id === id)) return `Error: todo "${id}" already exists`;
        todos.push({ id, title, description: description || '', status: 'pending' });
        fs.writeFileSync(todoPath, JSON.stringify({ todos, deps }, null, 2), 'utf-8');
        return `✓ Added todo "${id}": ${title}`;
      }

      if (action === 'update') {
        if (!id || !status || !VALID_STATUS.has(status)) return 'Error: update requires id and a valid status (pending|in_progress|done|blocked)';
        const t = todos.find(x => x.id === id);
        if (!t) return `Error: todo "${id}" not found`;
        t.status = status;
        fs.writeFileSync(todoPath, JSON.stringify({ todos, deps }, null, 2), 'utf-8');
        return `✓ Updated todo "${id}" → ${status}`;
      }

      if (action === 'remove') {
        if (!id) return 'Error: remove requires id';
        const before = todos.length;
        todos = todos.filter(x => x.id !== id);
        deps = deps.filter(d => d.todo_id !== id && d.depends_on !== id);
        fs.writeFileSync(todoPath, JSON.stringify({ todos, deps }, null, 2), 'utf-8');
        return before === todos.length ? `Error: todo "${id}" not found` : `✓ Removed todo "${id}"`;
      }

      if (action === 'dep') {
        if (!id || !depends_on) return 'Error: dep requires id and depends_on';
        if (deps.some(d => d.todo_id === id && d.depends_on === depends_on)) return `✓ Dependency already exists`;
        deps.push({ todo_id: id, depends_on });
        fs.writeFileSync(todoPath, JSON.stringify({ todos, deps }, null, 2), 'utf-8');
        return `✓ Added dependency: ${id} depends on ${depends_on}`;
      }

      return `Error: unknown action "${action}"`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  patch_file({ path: filePath, old_text, new_text }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
      let content = fs.readFileSync(resolved, 'utf-8');

      // ── Helper: normalize whitespace for fuzzy matching ──
      const normalize = (s) => s.replace(/\r\n/g, '\n').replace(/\t/g, '  ').replace(/[ \t]+$/gm, '');
      const stripLine = (l) => l.trim();
      const normContent = normalize(content);
      const normOld = normalize(old_text);

      // ── 1. Exact match ──
      let idx = content.indexOf(old_text);

      // ── 2. Fuzzy: normalized-whitespace match (tabs vs spaces, trailing spaces, CRLF) ──
      let matchMethod = 'exact';
      if (idx === -1 && normContent.includes(normOld)) {
        // Sliding window: find the region in original content whose normalized form matches
        for (let ci = 0; ci <= content.length - old_text.length; ci++) {
          for (let spanLen = old_text.length; spanLen <= old_text.length + 40; spanLen++) {
            if (ci + spanLen > content.length) break;
            const candidate = content.substring(ci, ci + spanLen);
            if (normalize(candidate) === normOld) {
              idx = ci;
              matchMethod = 'fuzzy-normalized';
              content = content.substring(0, ci) + new_text + content.substring(ci + spanLen);
              fs.writeFileSync(resolved, content, 'utf-8');
              const lineStart = content.substring(0, ci).split('\n').length;
              return `✓ Patched ${resolved} (line ~${lineStart}, ${matchMethod} match)`;
            }
          }
          if (matchMethod !== 'exact') break; // found it
        }
        idx = -1; // fuzzy didn't find it either
      }

      // ── 3. Fuzzy: line-trim match (ignoring per-line leading/trailing whitespace) ──
      if (idx === -1) {
        const oldLines = old_text.split('\n');
        const contentLines = content.split('\n');
        const matchIdx = contentLines.findIndex((_, si) => {
          if (si + oldLines.length > contentLines.length) return false;
          return oldLines.every((ol, oi) => stripLine(contentLines[si + oi]) === stripLine(ol));
        });
        if (matchIdx !== -1) {
          // Count match positions for uniqueness
          let matchCount = 0;
          for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
            if (oldLines.every((ol, oi) => stripLine(contentLines[i + oi]) === stripLine(ol))) matchCount++;
          }
          if (matchCount <= 3) {
            const before = contentLines.slice(0, matchIdx);
            const after = contentLines.slice(matchIdx + oldLines.length);
            // Preserve indentation: adjust new_text to match original line indent
            const originalIndent = (contentLines[matchIdx].match(/^(\s*)/) || ['', ''])[1];
            const oldFirstIndent = (oldLines[0].match(/^(\s*)/) || ['', ''])[1];
            const adjustedNewLines = new_text.split('\n').map(nl => {
              if (oldFirstIndent && nl.startsWith(oldFirstIndent)) {
                return originalIndent + nl.slice(oldFirstIndent.length);
              }
              return nl;
            });
            content = [...before, ...adjustedNewLines, ...after].join('\n');
            fs.writeFileSync(resolved, content, 'utf-8');
            return `✓ Patched ${resolved} (line ${matchIdx + 1}, fuzzy line-trim match, ${matchCount} candidate(s))`;
          }
          // Ambiguous: multiple matches
          const positions = [];
          for (let i = 0; i <= contentLines.length - oldLines.length && positions.length < 3; i++) {
            if (oldLines.every((ol, oi) => stripLine(contentLines[i + oi]) === stripLine(ol))) positions.push(i + 1);
          }
          return `Error: old_text matches ${matchCount} locations (lines ${positions.join(', ')}) in ${resolved}. Provide more context to make it unique.\nNearby (line ${positions[0]}):\n${contentLines.slice(Math.max(0, positions[0] - 2), positions[0] + oldLines.length + 2).join('\n')}`;
        }
        return `Error: old_text not found in ${resolved}\nHint: Text may differ in whitespace/indentation. Use read_file to see exact content, or add more surrounding context.`;
      }

      // ── Non-unique exact match: replace first occurrence with warning ──
      if (content.indexOf(old_text, idx + 1) !== -1) {
        content = content.substring(0, idx) + new_text + content.substring(idx + old_text.length);
        fs.writeFileSync(resolved, content, 'utf-8');
        const lineNum = content.substring(0, idx).split('\n').length;
        return `⚠️ Patched first occurrence in ${resolved} (line ~${lineNum}). old_text appeared multiple times — only first replaced. Use more context to target a specific occurrence.`;
      }

      // ── Single exact match (ideal) ──
      content = content.replace(old_text, new_text);
      fs.writeFileSync(resolved, content, 'utf-8');
      const lineNum = content.substring(0, idx).split('\n').length;
      return `✓ Patched ${resolved} (line ${lineNum})`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  list_dir({ path: dirPath = '.', recursive = false }) {
    const resolved = path.resolve(WORK_DIR, dirPath);
    try {
      if (!fs.existsSync(resolved)) return `Error: Directory not found: ${resolved}`;
      const items = [];
      let itemCount = 0;
      const MAX_ITEMS = 500;  // Hard limit to prevent hangs on huge dirs
      const MAX_DEPTH = 10;   // Prevent recursive descent bombs
      function walk(dir, prefix = '', depth = 0) {
        if (depth > MAX_DEPTH) { items.push(`${prefix}⚠️ max depth reached`); return; }
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
          items.push(`${prefix}⚠️ permission denied: ${path.basename(dir)}`);
          return;
        }
        for (const entry of entries) {
          if (itemCount >= MAX_ITEMS) {
            items.push(`${prefix}... (${entries.length - itemCount} more items, truncated)`);
            return;
          }
          if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
          if (entry.name === 'node_modules') { items.push(`${prefix}📁 ${entry.name}/ (skipped)`); continue; }
          if (entry.name === '.git' && !recursive) { items.push(`${prefix}📁 ${entry.name}/ (skipped)`); continue; }
          itemCount++;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            items.push(`${prefix}📁 ${entry.name}/`);
            if (recursive) walk(full, prefix + '  ', depth + 1);
          } else {
            try {
              const stat = fs.statSync(full);
              const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}KB`;
              items.push(`${prefix}📄 ${entry.name} (${size})`);
            } catch (_) {
              items.push(`${prefix}📄 ${entry.name}`);
            }
          }
        }
      }
      walk(resolved);
      return items.join('\n') || '(empty directory)';
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  async web_fetch({ url, method = 'GET', headers = {}, body, timeout = 15 }) {
    try {
      const u = new URL(url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeout, 60) * 1000);
      const options = { method, headers: { 'User-Agent': 'haksterAI/1.0', ...headers }, signal: controller.signal };
      if (body) options.body = body;
      const resp = await fetch(url, options);
      clearTimeout(timer);
      const text = await resp.text();
      const truncated = text.length > 10000 ? text.substring(0, 10000) + '\n... (truncated)' : text;
      return `${resp.status} ${resp.statusText}\n${truncated}`;
    } catch (err) {
      if (err.name === 'AbortError') return `Error: Request timed out after ${timeout}s — URL may be unreachable or slow. Try a different approach.`;
      return `Error: ${err.message}`;
    }
  },

  async firecrawl({ action = 'scrape', url, query, limit, formats }) {
    const key = process.env.FIRECRAWL_API_KEY;
    if (!key) return 'Error: FIRECRAWL_API_KEY not configured (set it in .env).';
    const base = process.env.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev/v1';
    const hdrs = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` };
    const fetchJson = async (path, body, timeoutMs = 30000) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(base + path, { method: 'POST', headers: hdrs, body: JSON.stringify(body), signal: ctrl.signal });
        const txt = await r.text();
        let data; try { data = JSON.parse(txt); } catch (_) { data = { raw: txt }; }
        return { ok: r.ok, status: r.status, data };
      } finally { clearTimeout(t); }
    };
    const trunc = (str, n) => str.length > n ? str.slice(0, n) + '\n... (truncated)' : str;
    try {
      if (action === 'scrape') {
        if (!url) return 'Error: scrape requires url';
        const { ok, status, data } = await fetchJson('/scrape', {
          url,
          formats: formats && formats.length ? formats : ['markdown'],
        }, 45000);
        if (!ok) return `Error: Firecrawl scrape failed (${status}): ${JSON.stringify(data).slice(0, 400)}`;
        const md = data?.data?.markdown || data?.data?.html || data?.data?.rawHtml || JSON.stringify(data?.data || {});
        return `🔥 Firecrawl scrape ${url}
${trunc(md, 12000)}`;
      }
      if (action === 'map') {
        if (!url) return 'Error: map requires url';
        const { ok, status, data } = await fetchJson('/map', { url, limit: limit || 25 }, 30000);
        if (!ok) return `Error: Firecrawl map failed (${status}): ${JSON.stringify(data).slice(0, 400)}`;
        const links = data?.links || data?.data?.links || [];
        return `🔥 Firecrawl map ${url} — ${links.length} URLs\n${trunc(links.join('\n'), 8000)}`;
      }
      if (action === 'search') {
        if (!query) return 'Error: search requires query';
        const { ok, status, data } = await fetchJson('/search', { query, limit: limit || 25 }, 30000);
        if (!ok) return `Error: Firecrawl search failed (${status}): ${JSON.stringify(data).slice(0, 400)}`;
        const items = data?.data || data?.results || [];
        const out = items.map((it, i) => `${i + 1}. ${it.title || ''}\n   ${it.url || it.link || ''}\n   ${(it.description || it.markdown || '').slice(0, 200)}`).join('\n\n');
        return `🔥 Firecrawl search "${query}" — ${items.length} results\n${trunc(out, 10000)}`;
      }
      if (action === 'crawl') {
        if (!url) return 'Error: crawl requires url';
        const { ok, status, data } = await fetchJson('/crawl', { url, limit: limit || 10 }, 30000);
        if (!ok) return `Error: Firecrawl crawl failed (${status}): ${JSON.stringify(data).slice(0, 400)}`;
        const jobId = data?.id || data?.jobId;
        const docs = data?.data || [];
        const sample = docs.slice(0, 3).map((d, i) => `--- ${i + 1}: ${d.source || d.url || ''} ---\n${(d.markdown || '').slice(0, 800)}`).join('\n\n');
        return `🔥 Firecrawl crawl ${url} — job ${jobId || 'n/a'} (first ${docs.length} pages)\n${trunc(sample, 10000)}`;
      }
      return `Error: unknown firecrawl action "${action}"`;
    } catch (err) {
      if (err.name === 'AbortError') return 'Error: Firecrawl request timed out. Try a smaller limit or a different URL.';
      return `Error: ${err.message}`;
    }
  },

  async web_search({ query, max_results = 8 }) {
    try {
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const resp = await fetch(ddgUrl, { headers: { 'User-Agent': 'haksterAI/1.0' }, signal: AbortSignal.timeout(15000) });
      const data = await resp.json();
      const results = [];
      // Main answer (AbstractText)
      if (data.AbstractText) {
        results.push(`📖 ${data.AbstractText}${data.AbstractURL ? `\n   Source: ${data.AbstractURL}` : ''}${data.AbstractSource ? ` (${data.AbstractSource})` : ''}`);
      }
      // Related topics with text
      if (data.RelatedTopics) {
        for (const topic of data.RelatedTopics.slice(0, max_results)) {
          if (topic.Text) {
            results.push(`🔍 ${topic.Text}\n   ${topic.FirstURL || ''}`);
          } else if (topic.Topics) {
            for (const sub of topic.Topics.slice(0, 3)) {
              if (sub.Text) results.push(`🔍 ${sub.Text}\n   ${sub.FirstURL || ''}`);
            }
          }
          if (results.length >= max_results) break;
        }
      }
      // Definition (if available)
      if (data.Definition) {
        results.push(`📝 ${data.Definition}\n   Source: ${data.DefinitionURL || 'N/A'}`);
      }
      if (results.length === 0) {
        // Fallback: try HTML scrape of DuckDuckGo lite
        const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
        try {
          const liteResp = await fetch(liteUrl, { headers: { 'User-Agent': 'haksterAI/1.0' }, signal: AbortSignal.timeout(10000) });
          const html = await liteResp.text();
          const links = html.match(/<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
          const snippets = html.match(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi);
          if (links || snippets) {
            const count = Math.min(max_results, (links ? links.length : 0) || (snippets ? snippets.length : 0));
            for (let i = 0; i < count; i++) {
              const link = links?.[i]?.replace(/<[^>]+>/g, '').trim() || '';
              const href = links?.[i]?.match(/href="([^"]+)"/)?.[1] || '';
              const snippet = snippets?.[i]?.replace(/<[^>]+>/g, '').trim() || '';
              if (link || snippet) results.push(`🔗 ${link || snippet}\n   ${href}`);
            }
          }
        } catch (_) {}
        if (results.length === 0) return `🔍 No results found for "${query}". Try rephrasing or use web_fetch to check specific URLs.`;
      }
      return `🔍 Web Search: "${query}"\n${results.slice(0, max_results).join('\n\n')}`;
    } catch (err) {
      return `❌ Search error: ${err.message}. Try web_fetch with a specific URL instead.`;
    }
  },

  async search_files({ pattern, path: dirPath = '.', mode = 'files' }) {
    const resolved = path.resolve(WORK_DIR, dirPath);
    try {
      if (mode === 'files') {
        const filePattern = /[*?[{]/.test(pattern) ? pattern : `*${pattern}*`;
        const cmd = [
          'rg --files --hidden',
          '-g', shellQuote(filePattern),
          '-g', shellQuote('!node_modules/**'),
          '-g', shellQuote('!.git/**'),
          shellQuote(resolved),
        ].join(' ');
        const result = await asyncShell(cmd, { timeout: 10 });
        const output = result.ok ? result.stdout : result.output;
        return output ? output.split('\n').slice(0, 50).join('\n') : '(no files found)';
      } else {
        const cmd = [
          'rg --line-number --color never --hidden',
          '-g', shellQuote('*.js'),
          '-g', shellQuote('*.ts'),
          '-g', shellQuote('*.py'),
          '-g', shellQuote('*.astro'),
          '-g', shellQuote('*.json'),
          '-g', shellQuote('*.md'),
          '-g', shellQuote('!node_modules/**'),
          '-g', shellQuote('!.git/**'),
          '--',
          shellQuote(pattern),
          shellQuote(resolved),
        ].join(' ');
        const result = await asyncShell(cmd, { timeout: 10 });
        const output = result.ok ? result.stdout : result.output;
        return output ? output.split('\n').slice(0, 50).join('\n') : '(no matches found)';
      }
    } catch (err) {
      return `(no matches)`;
    }
  },

  run_background({ command, name }) {
    try {
      const child = spawn('/bin/bash', ['-c', command], {
        cwd: WORK_DIR,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      child.unref();
      bgProcesses.set(name, { pid: child.pid, child, command });
      return `✓ Started "${name}" (PID ${child.pid})`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  kill_process({ name, pid }) {
    try {
      if (name && bgProcesses.has(name)) {
        const proc = bgProcesses.get(name);
        process.kill(proc.pid, 'SIGTERM');
        bgProcesses.delete(name);
        return `✓ Killed "${name}" (PID ${proc.pid})`;
      }
      if (pid) {
        process.kill(pid, 'SIGTERM');
        return `✓ Killed PID ${pid}`;
      }
      return 'Error: provide name or pid';
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  multi_patch({ path: filePath, patches }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
      let content = fs.readFileSync(resolved, 'utf-8');
      const results = [];
      const normalize = (s) => s.replace(/\r\n/g, '\n').replace(/\t/g, '  ').replace(/[ \t]+$/gm, '');
      const stripLine = (l) => l.trim();
      for (let i = 0; i < patches.length; i++) {
        const { old_text, new_text } = patches[i];
        // ── 1. Exact match ──
        let idx = content.indexOf(old_text);
        let applied = false;

        if (idx !== -1) {
          // Check uniqueness
          if (content.indexOf(old_text, idx + 1) !== -1) {
            // Multiple matches — replace first with warning
            content = content.substring(0, idx) + new_text + content.substring(idx + old_text.length);
            results.push(`⚠️ Patch ${i + 1}: replaced first of multiple matches`);
            applied = true;
          } else {
            content = content.replace(old_text, new_text);
            const lineNum = content.substring(0, idx).split('\n').length;
            results.push(`✓ Patch ${i + 1}: applied (line ${lineNum})`);
            applied = true;
          }
        }

        // ── 2. Fuzzy: normalized-whitespace match ──
        if (!applied) {
          const normContent = normalize(content);
          const normOld = normalize(old_text);
          if (normContent.includes(normOld)) {
            for (let ci = 0; ci <= content.length - old_text.length && !applied; ci++) {
              for (let spanLen = old_text.length; spanLen <= old_text.length + 40 && !applied; spanLen++) {
                if (ci + spanLen > content.length) break;
                const candidate = content.substring(ci, ci + spanLen);
                if (normalize(candidate) === normOld) {
                  content = content.substring(0, ci) + new_text + content.substring(ci + spanLen);
                  results.push(`✓ Patch ${i + 1}: applied (fuzzy-normalized match)`);
                  applied = true;
                }
              }
            }
          }
        }

        // ── 3. Fuzzy: line-trim match ──
        if (!applied) {
          const oldLines = old_text.split('\n');
          const contentLines = content.split('\n');
          const matchIdx = contentLines.findIndex((_, si) => {
            if (si + oldLines.length > contentLines.length) return false;
            return oldLines.every((ol, oi) => stripLine(contentLines[si + oi]) === stripLine(ol));
          });
          if (matchIdx !== -1) {
            const originalIndent = (contentLines[matchIdx].match(/^(\s*)/) || ['', ''])[1];
            const oldFirstIndent = (oldLines[0].match(/^(\s*)/) || ['', ''])[1];
            const adjustedNewLines = new_text.split('\n').map(nl => {
              if (oldFirstIndent && nl.startsWith(oldFirstIndent)) {
                return originalIndent + nl.slice(oldFirstIndent.length);
              }
              return nl;
            });
            const before = contentLines.slice(0, matchIdx);
            const after = contentLines.slice(matchIdx + oldLines.length);
            content = [...before, ...adjustedNewLines, ...after].join('\n');
            results.push(`✓ Patch ${i + 1}: applied (fuzzy line-trim match at line ${matchIdx + 1})`);
            applied = true;
          }
        }

        if (!applied) {
          results.push(`✗ Patch ${i + 1}: old_text not found (exact or fuzzy)`);
        }
      }
      fs.writeFileSync(resolved, content, 'utf-8');
      return results.join('\n') + `\n--- ${patches.length} patches processed on ${resolved}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  insert_lines({ path: filePath, line, content: insertContent }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
      const lines = fs.readFileSync(resolved, 'utf-8').split('\n');
      // line = 0 means insert at top (before line 1), line = N means insert AFTER line N
      const insertAt = line === 0 ? 0 : Math.min(line, lines.length);
      lines.splice(insertAt, 0, insertContent);
      fs.writeFileSync(resolved, lines.join('\n'), 'utf-8');
      return `✓ Inserted ${insertContent.split('\n').length} line(s) after line ${line} in ${resolved} (${lines.length} lines total)`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  delete_lines({ path: filePath, start, end }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
      const lines = fs.readFileSync(resolved, 'utf-8').split('\n');
      const totalLines = lines.length;
      if (start < 1 || end > totalLines || start > end) return `Error: Invalid range ${start}-${end} (file has ${totalLines} lines)`;
      const deleted = lines.splice(start - 1, end - start + 1).join('\n');
      fs.writeFileSync(resolved, lines.join('\n'), 'utf-8');
      return `✓ Deleted lines ${start}-${end} (${end - start + 1} lines) from ${resolved}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  replace_regex({ path: filePath, pattern, replacement, flags = 'g' }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
      let content = fs.readFileSync(resolved, 'utf-8');
      const regex = new RegExp(pattern, flags);
      const matches = (content.match(regex) || []).length;
      content = content.replace(regex, replacement);
      fs.writeFileSync(resolved, content, 'utf-8');
      return `✓ Replaced ${matches} match(es) in ${resolved}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  append_file({ path: filePath, content: appendContent }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.appendFileSync(resolved, appendContent, 'utf-8');
      return `✓ Appended ${appendContent.split('\n').length} line(s) to ${resolved}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  async git_op({ operation, args = '' }) {
    try {
      const gitCmd = args ? `git ${operation} ${args}` : `git ${operation}`;
      const result = await asyncShell(gitCmd, { timeout: 30 });
      return result.output;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  async pm2({ action, name, lines = 30 }) {
    try {
      let cmd;
      if (action === 'list') cmd = 'pm2 list --no-color';
      else if (action === 'logs') cmd = `pm2 logs ${name || ''} --lines ${lines} --nostream`;
      else if (action === 'describe') cmd = `pm2 describe ${name}`;
      else cmd = `pm2 ${action} ${name || ''}`;
      const result = await asyncShell(cmd, { timeout: 15 });
      return result.output;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  async service_check({ service }) {
    const checks = {
      haksterai: { port: 3579, url: 'http://localhost:3579/api/health' },
      cinevault: { port: 8081, url: 'http://localhost:8081/api/health' },
      miniforge: { port: 5555, url: 'http://localhost:5555/' },
      phantom: { port: 4000, url: 'http://localhost:4000/api/ping' },
      'claude-proxy': { port: 8082, url: 'http://localhost:8082/' },
    };
    const toCheck = service === 'all' ? Object.keys(checks) : [service];
    const results = [];
    for (const name of toCheck) {
      const s = checks[name];
      if (!s) { results.push(`${name}: unknown service`); continue; }
      try {
        const resp = await fetch(s.url, { signal: AbortSignal.timeout(5000) });
        const text = await resp.text();
        const status = resp.ok ? '✓' : '✗';
        results.push(`${status} ${name} (:${s.port}) → ${resp.status} ${text.substring(0, 100)}`);
      } catch (err) {
        results.push(`✗ ${name} (:${s.port}) → ${err.message}`);
      }
    }
    return results.join('\n');
  },

  async claude_proxy({ prompt, model = 'claude-sonnet-4-5', system, max_tokens = 4096 }) {
    // Route through Claude Code Proxy (Anthropic format → LiteLLM)
    const messages = [{ role: 'user', content: prompt }];
    const body = {
      model,
      max_tokens,
      messages,
      ...(system ? { system } : {}),
    };
    try {
      const resp = await fetch(`${CLAUDE_PROXY_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000), // 2 min timeout for large models
      });
      const data = await resp.json();
      if (!resp.ok) {
        return `Claude Proxy error (${resp.status}): ${JSON.stringify(data.error || data).substring(0, 500)}`;
      }
      // Anthropic API response format: { content: [{ type: 'text', text: '...' }], ... }
      const text = data.content?.map(c => c.text || '').join('\n') || data.choices?.[0]?.message?.content || JSON.stringify(data);
      return text;
    } catch (err) {
      return `Claude Proxy request failed: ${err.message}`;
    }
  },

  async run_agent({ agent, args = '' }) {
    // Run a specialized agent script from /home/ghost/claude_agents/agents/
    const scriptPath = `/home/ghost/claude_agents/agents/${agent}_agent.sh`;
    try {
      const cmd = args ? `${scriptPath} ${args}` : scriptPath;
      const result = await asyncShell(cmd, { timeout: 60000 });
      return result.stdout || result.stderr || '(no output)';
    } catch (err) {
      return `Agent ${agent} failed: ${err.message}`;
    }
  },

  async snapshot({ url, width = 1280, height = 800 }) {
    try {
      // Use a headless approach: fetch page, extract key visual info
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const html = await resp.text();
      // Extract title, meta, headings, links, forms, images
      const title = html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1] || '(no title)';
      const headings = [...html.matchAll(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gis)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean).slice(0, 10);
      const links = [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis)].map(m => `${m[1]} → ${m[2].replace(/<[^>]+>/g, '').trim()}`).filter(l => !l.startsWith('#')).slice(0, 15);
      const buttons = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/gis)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean).slice(0, 10);
      const inputs = [...html.matchAll(/<input[^>]*>/gis)].map(m => { const name = m[0].match(/name="([^"]*)"/)?.[1] || ''; const type = m[0].match(/type="([^"]*)"/)?.[1] || 'text'; const placeholder = m[0].match(/placeholder="([^"]*)"/)?.[1] || ''; return `${type}${name ? ':' + name : ''}${placeholder ? ' (' + placeholder + ')' : ''}`; }).slice(0, 10);
      const images = [...html.matchAll(/<img[^>]*src="([^"]*)"[^>]*>/gis)].map(m => m[1]).slice(0, 10);
      const bodyText = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 2000);

      const lines = [
        `📸 Snapshot: ${url}`,
        `Status: ${resp.status} ${resp.statusText}`,
        `Title: ${title}`,
        `Viewport: ${width}x${height}`,
        ``,
      ];
      if (headings.length) lines.push(`Headings:`, ...headings.map(h => `  • ${h}`), '');
      if (buttons.length) lines.push(`Buttons:`, ...buttons.map(b => `  [${b}]`), '');
      if (inputs.length) lines.push(`Inputs:`, ...inputs.map(i => `  • ${i}`), '');
      if (links.length) lines.push(`Links:`, ...links.map(l => `  → ${l}`), '');
      if (images.length) lines.push(`Images:`, ...images.map(i => `  🖼 ${i}`), '');
      lines.push('', `Page text (first 2000 chars):`, bodyText.substring(0, 1500));
      if (bodyText.length > 1500) lines.push(`... (${bodyText.length - 1500} more chars)`);
      return lines.join('\n');
    } catch (err) {
      return `Error snapshotting ${url}: ${err.message}`;
    }
  },

  async sub_agent({ tasks }) {
    // Run each sub-task as an independent agent loop call
    const results = [];
    const maxConcurrent = 3;
    const tasksToRun = tasks.slice(0, maxConcurrent);

    log(`\n${C.info}◇ Spawning ${tasksToRun.length} sub-agent(s) in parallel...${C.reset}`);

    const promises = tasksToRun.map(async (task, i) => {
      const taskName = task.name || `task-${i + 1}`;
      const taskHist = [{ role: 'system', content: buildSystemPrompt() }];
      log(`${C.primary}  ◆ ${taskName}: ${task.goal.substring(0, 80)}${C.reset}`);
      try {
        const result = await agentLoop(task.goal, taskHist, true, { lowToken: _lowToken }); // silent mode
        const lastAssistant = [...taskHist].reverse().find(m => m.role === 'assistant');
        return { name: taskName, status: 'done', result: lastAssistant?.content || '(completed)' };
      } catch (err) {
        return { name: taskName, status: 'error', result: err.message };
      }
    });

    const settled = await Promise.all(promises);
    for (const s of settled) {
      log(`${s.status === 'done' ? C.success : C.error}  ✓ ${s.name}: ${s.result.substring(0, 200)}${C.reset}`);
      results.push(`--- ${s.name} (${s.status}) ---\n${s.result}`);
    }
    return results.join('\n\n');
  },

  async crush({ prompt, model, cwd, timeout = 120 }) {
    // Run Charm Crush agentic coding tool in non-interactive mode
    const maxTimeout = Math.min(timeout, 300);
    const cmdParts = ['crush', 'run', '--quiet'];
    if (model) cmdParts.push('-m', model);
    if (cwd) cmdParts.push('-c', cwd);
    // Escape the prompt for shell safety
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    cmdParts.push(`'${escapedPrompt}'`);
    const cmd = cmdParts.join(' ');
    log(`\n${C.secondary}💘 Crush: ${prompt.substring(0, 80)}${C.reset}`);
    try {
      const result = await asyncShell(cmd, { timeout: maxTimeout });
      const output = (result.stdout || '') + (result.stderr ? '\n' + result.stderr : '');
      if (!output.trim()) return result.killed ? `Crush timed out after ${maxTimeout}s` : '(Crush returned no output)';
      // Truncate very long outputs
      return output.length > 8000 ? output.substring(0, 8000) + '\n... (truncated)' : output;
    } catch (err) {
      return `Crush error: ${err.message}`;
    }
  },

  async parallel_shell({ commands, timeout = 30 }) {
    const maxTimeout = Math.min(timeout, 300);
    const results = commands.map(cmd => {
      return asyncShell(cmd, { timeout: maxTimeout }).then(result => ({
        cmd,
        stdout: (result.stdout || '').substring(0, 3000),
        stderr: (result.stderr || '').substring(0, 1000),
        code: result.exitCode,
        killed: result.killed,
      }));
    });

    return Promise.all(results).then(outputs => {
      return outputs.map(o => {
        const parts = [`$ ${o.cmd}`];
        if (o.stdout) parts.push(o.stdout);
        if (o.stderr) parts.push(`[stderr] ${o.stderr}`);
        if (o.killed) parts.push(`[timeout after ${timeout}s]`);
        if (o.code !== 0 && !o.killed) parts.push(`[exit: ${o.code}]`);
        return parts.join('\n');
      }).join('\n---\n');
    });
  },

  code_grid({ code, title, lang = '', highlight_lines = [], diff_lines = [] }) {
    const lines = code.split('\n');
    const lineNumWidth = String(lines.length).length;
    const diffSet = {};
    for (const d of diff_lines) {
      if (d.startsWith('+')) diffSet[parseInt(d.substring(1))] = 'add';
      else if (d.startsWith('-')) diffSet[parseInt(d.substring(1))] = 'del';
    }
    const hlSet = new Set(highlight_lines);

    // Color codes for terminal output
    const GR = '\x1b[32m'; // green - additions
    const RD = '\x1b[31m'; // red - deletions
    const CY = '\x1b[36m'; // cyan - line numbers
    const YL = '\x1b[33m'; // yellow - highlighted
    const MG = '\x1b[35m'; // magenta - header
    const DM = '\x1b[2m'; // dim
    const BD = '\x1b[1m'; // bold
    const RS = '\x1b[0m'; // reset

    _updateBoxW();
    // Use dynamic width matching dashboard panels for alignment
    const gridW = Math.min(BOX_W + 6, Math.max(60, title.length + lang.length + 6));
    const bar = '─'.repeat(gridW);
    const output = [
      `${MG}${BD}┌${bar}┐${RS}`,
      `${MG}│ ${BD}${title}${RS}${lang ? ` ${DM}(${lang})${RS}` : ''} ${MG}${' '.repeat(Math.max(0, bar.length - title.length - (lang ? lang.length + 3 : 1) - 2))}│${RS}`,
      `${MG}├${bar}┤${RS}`,
    ];

    for (let i = 0; i < lines.length; i++) {
      const num = i + 1;
      const numStr = String(num).padStart(lineNumWidth);
      const line = lines[i];
      let prefix = ' ';
      let color = '';
      let suffix = RS;

      if (diffSet[num] === 'add') { prefix = '+'; color = GR; suffix = RS; }
      else if (diffSet[num] === 'del') { prefix = '-'; color = RD; suffix = RS; }
      else if (hlSet.has(num)) { color = YL; suffix = RS; }

      const numColor = CY;
      const gutter = `${MG}│${RS} ${numColor}${numStr}${RS} ${color}${prefix}${RS} `;
      const lineColor = color || RS;

      // Truncate very long lines to fit grid width
      const maxLen = gridW - lineNumWidth - 4;  // 4 for gutter chars
      const displayLine = line.length > maxLen ? line.substring(0, maxLen) + `${DM}...${RS}` : line;
      output.push(`${gutter}${lineColor}${displayLine}${suffix}`);
    }

    output.push(`${MG}└${bar}┘${RS}`);
    return output.join('\n');
  },

  // ── Visual Browser Tools (Puppeteer) ──────────────────────────────────
  async browser_navigate({ url, wait_ms = 2000 }) {
    try {
      const page = await getPage();
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
      if (wait_ms > 0) await page.waitForTimeout(wait_ms);
      const title = await page.title();
      const currentUrl = page.url();
      const statusCode = response ? response.status() : null;
      const statusText = response ? response.statusText() : '';
      // Get accessibility snapshot
      const snapshot = await page.evaluate(() => {
        const elements = [];
        const interactive = document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"], [contenteditable]');
        interactive.forEach((el, i) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return;
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().slice(0, 80);
          const type = el.getAttribute('type') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const href = el.getAttribute('href') || '';
          const name = el.getAttribute('name') || '';
          elements.push({ idx: i, tag, text, type, placeholder, href, name });
        });
        return { title: document.title, url: location.href, elements };
      });
      const lines = [
        `🧭 Navigated to: ${currentUrl}`,
        `Status: ${statusCode} ${statusText}`,
        `Title: ${title}`,
        `Interactive elements (${snapshot.elements.length}):`,
      ];
      snapshot.elements.slice(0, 30).forEach(el => {
        const label = el.text || el.placeholder || el.name || el.href?.slice(0, 50) || '(unnamed)';
        lines.push(`  [${el.idx}] <${el.tag}${el.type ? ' type=' + el.type : ''}> ${label}`);
      });
      if (snapshot.elements.length > 30) lines.push(`  ... and ${snapshot.elements.length - 30} more`);
      return lines.join('\n');
    } catch (err) {
      return `Error navigating to ${url}: ${err.message}`;
    }
  },

  async browser_click({ selector, index = 0 }) {
    try {
      const page = await getPage();
      // Try CSS selector first, then text content
      let clicked = false;
      try {
        const els = await page.$$(selector);
        if (els.length > index) {
          await els[index].click();
          clicked = true;
        }
      } catch (_) {}
      if (!clicked) {
        // Try as text content of button/link
        const el = await page.evaluateHandle((text, idx) => {
          const all = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'));
          const match = all.filter(e => e.textContent.trim().includes(text));
          return match[idx] || match[0] || null;
        }, selector, index);
        if (el && el.asElement()) {
          await el.asElement().click();
          clicked = true;
        }
      }
      if (!clicked) return `Could not find clickable element matching: ${selector}`;
      await page.waitForTimeout(1000);
      // Return snapshot after click
      const title = await page.title();
      const url = page.url();
      return `👆 Clicked: ${selector}\nNow at: ${url}\nTitle: ${title}`;
    } catch (err) {
      return `Error clicking ${selector}: ${err.message}`;
    }
  },

  async browser_type({ selector, text, press_enter = false }) {
    try {
      const page = await getPage();
      let el;
      try {
        el = await page.$(selector);
      } catch (_) {}
      if (!el) {
        // Try by name, id, or placeholder
        el = await page.$(`input[name="${selector}"], textarea[name="${selector}"], #${selector}, input[placeholder*="${selector}"]`);
      }
      if (!el) return `Could not find input field matching: ${selector}`;
      await el.click({ clickCount: 3 }); // select all
      await page.keyboard.press('Backspace');
      await el.type(text, { delay: 20 });
      if (press_enter) await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      return `⌨️ Typed "${text}" into ${selector}${press_enter ? ' + Enter' : ''}`;
    } catch (err) {
      return `Error typing into ${selector}: ${err.message}`;
    }
  },

  async browser_screenshot({ full_page = false, selector } = {}) {
    try {
      const page = await getPage();
      const screenshotDir = '/tmp/hakster_screenshots';
      if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
      const filename = `screenshot_${Date.now()}.png`;
      const filepath = path.join(screenshotDir, filename);
      const opts = { path: filepath, type: 'png' };
      if (full_page) opts.fullPage = true;
      let target = page;
      if (selector) {
        const el = await page.$(selector);
        if (!el) return `Could not find element: ${selector}`;
        await el.screenshot(opts);
      } else {
        await page.screenshot(opts);
      }
      const stats = fs.statSync(filepath);
      const sizeKB = (stats.size / 1024).toFixed(1);
      return `📸 Screenshot saved: ${filepath} (${sizeKB} KB)${full_page ? ' [full page]' : ''}${selector ? ` [element: ${selector}]` : ''}\nUse shell tool to display: cat ${filepath}`;
    } catch (err) {
      return `Error taking screenshot: ${err.message}`;
    }
  },

  async browser_snapshot({ full = false } = {}) {
    try {
      const page = await getPage();
      const currentUrl = page.url();
      if (currentUrl === 'about:blank') return 'No page loaded. Use browser_navigate first.';
      const snapshot = await page.evaluate((wantFull) => {
        const elements = [];
        const interactive = document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"], [contenteditable]');
        interactive.forEach((el, i) => {
          const rect = el.getBoundingClientRect();
          if (!wantFull && rect.width === 0 && rect.height === 0) return;
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().slice(0, 100);
          const type = el.getAttribute('type') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const value = el.value || '';
          const href = el.getAttribute('href') || '';
          const name = el.getAttribute('name') || '';
          const id = el.id || '';
          const checked = el.checked !== undefined ? String(el.checked) : '';
          const disabled = el.disabled ? ' [disabled]' : '';
          elements.push({ idx: i, tag, text: text.slice(0, 80), type, placeholder, value, href, name, id, checked, disabled });
        });
        // Page text content
        const bodyText = document.body ? document.body.innerText.slice(0, wantFull ? 5000 : 1500) : '';
        return {
          title: document.title,
          url: location.href,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          scroll: { x: window.scrollX, y: window.scrollY },
          elements,
          bodyText,
        };
      }, full);
      const lines = [
        `🔍 Snapshot: ${snapshot.url}`,
        `Title: ${snapshot.title}`,
        `Viewport: ${snapshot.viewport.w}x${snapshot.viewport.h}`,
        `Interactive elements (${snapshot.elements.length}):`,
      ];
      snapshot.elements.slice(0, full ? 50 : 25).forEach(el => {
        const label = el.text || el.placeholder || el.name || el.id || '(unnamed)';
        const extra = [];
        if (el.type && el.tag === 'input') extra.push(`type=${el.type}`);
        if (el.value) extra.push(`val="${el.value.slice(0, 30)}"`);
        if (el.checked) extra.push(`checked=${el.checked}`);
        lines.push(`  [${el.idx}] <${el.tag}${el.disabled}> ${label}${extra.length ? ' (' + extra.join(', ') + ')' : ''}`);
      });
      if (snapshot.elements.length > (full ? 50 : 25)) lines.push(`  ... and ${snapshot.elements.length - (full ? 50 : 25)} more`);
      if (snapshot.bodyText) {
        lines.push('', '--- Page text ---');
        lines.push(snapshot.bodyText.slice(0, full ? 3000 : 800));
        if (snapshot.bodyText.length > (full ? 3000 : 800)) lines.push(`... (${snapshot.bodyText.length} chars total)`);
      }
      return lines.join('\n');
    } catch (err) {
      return `Error taking snapshot: ${err.message}`;
    }
  },

  // ── Memory: persistent notes + project bank across sessions ────────────
  memory({ action, content, id, query }) {
    const MEMORY_DIR = path.join(WORK_DIR, '.hakster', 'memory');
    const MEMORY_FILE = path.join(MEMORY_DIR, 'notes.json');
    const PROJECT_BANK_FILE = path.join(MEMORY_DIR, 'projects.json');
    if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
    let notes = [];
    try { notes = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8')); } catch (_) { notes = []; }

    switch (action) {
      case 'add': {
        if (!content) return 'Error: content is required for add action';
        const note = {
          id: `mem_${Date.now()}`,
          content,
          created: new Date().toISOString(),
        };
        notes.push(note);
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(notes, null, 2));
        return `🧠 Saved note ${note.id}: "${content.slice(0, 80)}${content.length > 80 ? '...' : ''}"`;
      }
      case 'list': {
        if (notes.length === 0) return '🧠 No notes saved yet. Use memory add to save one.';
        const lines = [`🧠 ${notes.length} note(s):`];
        notes.forEach((n, i) => {
          lines.push(`  ${i + 1}. [${n.id}] ${n.content.slice(0, 100)}${n.content.length > 100 ? '...' : ''} (${n.created?.slice(0, 10) || '?'})`);
        });
        return lines.join('\n');
      }
      case 'get': {
        if (!id) return 'Error: id is required for get action';
        const note = notes.find(n => n.id === id);
        if (!note) return `Note not found: ${id}`;
        return `🧠 [${note.id}]\n${note.content}\nCreated: ${note.created}`;
      }
      case 'remove': {
        if (!id) return 'Error: id is required for remove action';
        const idx = notes.findIndex(n => n.id === id);
        if (idx === -1) return `Note not found: ${id}`;
        const removed = notes.splice(idx, 1)[0];
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(notes, null, 2));
        return `🗑️ Removed note ${removed.id}: "${removed.content.slice(0, 60)}..."`;
      }
      case 'search': {
        if (!query) return 'Error: query is required for search action';
        const q = query.toLowerCase();
        const matches = notes.filter(n => n.content.toLowerCase().includes(q));
        if (matches.length === 0) return `No notes matching "${query}"`;
        const lines = [`🧠 ${matches.length} match(es) for "${query}":`];
        matches.forEach((n, i) => {
          lines.push(`  ${i + 1}. [${n.id}] ${n.content.slice(0, 100)}...`);
        });
        return lines.join('\n');
      }
      case 'projects': {
        // ── Project bank: scan key directories for known projects ──
        if (!fs.existsSync(PROJECT_BANK_FILE)) {
          fs.mkdirSync(path.dirname(PROJECT_BANK_FILE), { recursive: true });
          fs.writeFileSync(PROJECT_BANK_FILE, '[]', 'utf-8');
        }
        let bank = [];
        try { bank = JSON.parse(fs.readFileSync(PROJECT_BANK_FILE, 'utf-8')); } catch (_) { bank = []; }

        // Known project directories to scan
        const projectDirs = [
          { dir: '/home/ghost/haksterAi', name: 'haksterAI', port: 3579, pm2: 'hakster', tech: 'Node.js/Express' },
          { dir: '/home/ghost/cine-vault-live', name: 'CineVault', port: 8081, pm2: 'cinevault', tech: 'Node.js' },
          { dir: '/home/ghost/miniforge', name: 'Miniforge', port: 5555, pm2: 'miniforge', tech: 'Node.js' },
          { dir: '/home/ghost/claude-code-proxy', name: 'Claude Proxy', port: 8082, pm2: null, tech: 'Python' },
          { dir: '/home/ghost/movie-server', name: 'Movie Server', port: null, pm2: null, tech: 'Node.js' },
          { dir: '/home/ghost/skills', name: 'Skills Library', port: null, pm2: null, tech: 'Markdown/Skills' },
          { dir: '/home/ghost/.agents', name: 'Agent Skills', port: null, pm2: null, tech: 'Markdown/Skills' },
          { dir: '/home/ghost/haksterAi/pentest-agents', name: 'Pentest Agents', port: null, pm2: null, tech: 'Security/Skills' },
          { dir: '/home/ghost/.hermes', name: 'Hermes', port: null, pm2: null, tech: 'Agent Framework' },
        ];

        // Auto-detect any package.json projects in home dir (top level)
        try {
          const homeEntries = fs.readdirSync('/home/ghost', { withFileTypes: true });
          for (const entry of homeEntries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const fullDir = `/home/ghost/${entry.name}`;
            if (projectDirs.some(p => p.dir === fullDir)) continue; // already known
            const pkgJson = path.join(fullDir, 'package.json');
            if (fs.existsSync(pkgJson)) {
              try {
                const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
                projectDirs.push({ dir: fullDir, name: pkg.name || entry.name, port: null, pm2: null, tech: `Node.js/${pkg.name || entry.name}` });
              } catch (_) {}
            }
          }
        } catch (_) {}

        // Update bank with fresh scan data
        const updated = [];
        for (const proj of projectDirs) {
          const exists = fs.existsSync(proj.dir);
          const stat = exists ? fs.statSync(proj.dir) : null;
          const existing = bank.find(b => b.dir === proj.dir);
          updated.push({
            name: proj.name,
            dir: proj.dir,
            port: proj.port,
            pm2: proj.pm2,
            tech: proj.tech,
            exists,
            lastModified: stat ? stat.mtime.toISOString() : null,
            notes: existing?.notes || '',
          });
        }
        fs.writeFileSync(PROJECT_BANK_FILE, JSON.stringify(updated, null, 2));

        // Format output
        const lines = [`🏦 Project Bank (${updated.length} projects):`];
        for (const p of updated) {
          const status = p.exists ? '✓' : '✗';
          const portStr = p.port ? `:${p.port}` : '';
          const pm2Str = p.pm2 ? ` pm2=${p.pm2}` : '';
          const modStr = p.lastModified ? ` modified=${p.lastModified.slice(0, 10)}` : '';
          lines.push(`  ${status} ${p.name} ${p.dir}${portStr}${pm2Str} [${p.tech}]${modStr}`);
        }
        return lines.join('\n');
      }
      default:
        return `Unknown memory action: ${action}. Use: add, list, get, remove, search, projects`;
    }
  },

  // ── Skills: persistent procedural knowledge ───────────────────────────────
  skill_save({ name, content, category }) {
    const SKILLS_DIR = path.join(WORK_DIR, '.hakster', 'skills');
    const dir = category ? path.join(SKILLS_DIR, category) : SKILLS_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = name.endsWith('.md') ? name : `${name}.md`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, content, 'utf-8');
    return `💾 Skill saved: ${name}${category ? ` (${category})` : ''} → ${filepath}`;
  },

  skill_load({ name }) {
    const skillsDirs = getSkillDirs();
    // Search all categories
    let filepath = '';
    for (const skillsDir of skillsDirs) {
      const candidate = path.join(skillsDir, name.endsWith('.md') ? name : `${name}.md`);
      if (fs.existsSync(candidate)) {
        filepath = candidate;
        break;
      }
    }
    if (!filepath) {
      // Try with .md extension in subdirectories
      const filename = name.endsWith('.md') ? name : `${name}.md`;
      for (const skillsDir of skillsDirs) {
        const found = globSync(path.join(skillsDir, '**', filename));
        if (found[0]) {
          filepath = found[0];
          break;
        }
      }
    }
    if (!filepath || !fs.existsSync(filepath)) {
      // List available skills
      const available = skillsDirs.flatMap(skillsDir =>
        globSync(path.join(skillsDir, '**', '*.md')).map(f => path.relative(skillsDir, f).replace(/\.md$/, ''))
      );
      return `Skill not found: ${name}\nAvailable: ${available.length > 0 ? available.join(', ') : '(none)'}`;
    }
    const content = fs.readFileSync(filepath, 'utf-8');
    return `📖 Skill: ${name}\n${'─'.repeat(40)}\n${content}`;
  },

  skill_list({ category } = {}) {
    const skillsDirs = getSkillDirs();
    const files = skillsDirs.flatMap(skillsDir => {
      if (!fs.existsSync(skillsDir)) return [];
      const pattern = category ? path.join(skillsDir, category, '*.md') : path.join(skillsDir, '**', '*.md');
      return globSync(pattern).map(file => ({ file, skillsDir }));
    });
    if (files.length === 0) return `📋 No skills found${category ? ` in category "${category}"` : ''}.`;
    const lines = ['📋 Saved skills:'];
    const seen = new Set();
    files.forEach(({ file, skillsDir }) => {
      const rel = path.relative(skillsDir, file).replace(/\.md$/, '');
      if (seen.has(rel)) return;
      seen.add(rel);
      const cat = path.dirname(rel) === '.' ? '' : ` [${path.dirname(rel)}]`;
      const name = path.basename(rel);
      lines.push(`  • ${name}${cat}`);
    });
    return lines.join('\n');
  },
  notify({ message, type = 'notify', priority = 'normal' }) {
    const id = msgPush(message, { type, priority, source: 'agent' });
    // Display the notification immediately so the user sees it right away
    const typeColors = { notify: C.cyan, warn: C.yellow, error: C.red, task: C.green, mcp: C.magenta, system: C.dim };
    const typeIcons = { notify: '📬', warn: '⚠️', error: '❌', task: '✅', mcp: '🔌', system: '⚙️' };
    const icon = typeIcons[type] || '📬';
    const tc = typeColors[type] || C.dim;
    log(`${icon} ${tc}${message}${C.reset}`);
    serverNotify(message, { type, priority });
    return `📬 Queued as ${id} (type: ${type}, priority: ${priority})`;
  },

  async generate_image({ prompt, provider = 'pollinations', model, size = '1024x1024', quality = 'hd', operation = 'generate', image_path, image_url }) {
    try {
      const imgDir = path.join(process.cwd(), 'outputs', 'images');
      if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

      const imageModel = model || (provider === 'pollinations' ? 'zimage' : 'dall-e-3');
      let imagePath = null;
      if (image_path) {
        imagePath = path.resolve(process.cwd(), image_path);
        if (!fs.existsSync(imagePath)) return `❌ Image file not found: ${imagePath}`;
      }
      let finalPrompt = prompt;
      if (operation === 'logo') {
        finalPrompt = `Create a professional production-ready logo. ${prompt}. Include clean geometry, strong silhouette, brand-ready composition, no watermarks, no mockup background.`;
      } else if (operation === 'enhance') {
        finalPrompt = `Enhance and improve this image while preserving the core subject. ${prompt || 'Improve sharpness, lighting, color balance, and professional finish.'}`;
      }
      const result = await generateImage({
        provider,
        model: imageModel,
        prompt: finalPrompt,
        size,
        quality,
        n: 1,
        imagePath,
        imageUrl: image_url,
        operation,
        enhance: operation === 'enhance',
      });

      const saved = [];
      for (const img of result.images) {
        const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
        const filePath = path.join(imgDir, `${id}.png`);
        fs.writeFileSync(filePath, Buffer.from(img.b64_json, 'base64'));
        const stats = fs.statSync(filePath);
        const sizeKB = (stats.size / 1024).toFixed(1);
        saved.push({ path: filePath, sizeKB, revised_prompt: img.revised_prompt });
      }

      const lines = [`🎨 Image generated (${result.provider || provider}, ${result.model || imageModel}, ${size}, ${quality}) — ${result.latency}ms`];
      saved.forEach(s => {
        lines.push(`  📁 ${s.path} (${s.sizeKB} KB)`);
        if (s.revised_prompt) lines.push(`  📝 Revised prompt: ${s.revised_prompt}`);
      });
      return lines.join('\n');
    } catch (err) {
      return `❌ Image generation failed: ${err.message}`;
    }
  },

  read_image({ path: filePath }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    const imgExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tiff', '.tif'];
    const ext = path.extname(resolved).toLowerCase();
    if (!imgExts.includes(ext)) return `❌ Not an image file. Supported: ${imgExts.join(', ')}`;
    if (!fs.existsSync(resolved)) return `❌ File not found: ${resolved}`;

    try {
      const data = fs.readFileSync(resolved);
      const sizeKB = (data.length / 1024).toFixed(1);
      const sizeMB = (data.length / (1024 * 1024)).toFixed(2);
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff' };
      const mime = mimeMap[ext] || 'application/octet-stream';
      const b64 = data.toString('base64');
      const dataUri = `data:${mime};base64,${b64}`;
      // Try to get dimensions via sharp or identify
      let dims = '';
      try {
        const sizeOf = require('image-size');
        const dim = sizeOf(resolved);
        if (dim.width && dim.height) dims = `${dim.width}x${dim.height}`;
      } catch (_) {}
      const dimStr = dims ? ` (${dims})` : '';
      return `🖼️ Image: ${resolved}\n   Size: ${sizeMB} MB (${sizeKB} KB)${dimStr}\n   Format: ${mime}\n   Base64 length: ${b64.length.toLocaleString()} chars\n   Data URI: ${dataUri.substring(0, 100)}...\n\nTo analyze this image, use claude_proxy with the image data URI, or describe what you see based on the file path.`;
    } catch (err) {
      return `❌ Error reading image: ${err.message}`;
    }
  },

  async analyze_image({ path: filePath, prompt = 'Describe this image in detail' }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    const imgExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tiff', '.tif'];
    const ext = path.extname(resolved).toLowerCase();
    if (!imgExts.includes(ext)) return `❌ Not an image file. Supported: ${imgExts.join(', ')}`;
    if (!fs.existsSync(resolved)) return `❌ File not found: ${resolved}`;
    try {
      const data = fs.readFileSync(resolved);
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff' };
      const mime = mimeMap[ext] || 'application/octet-stream';
      const b64 = data.toString('base64');
      const dataUri = `data:${mime};base64,${b64}`;
      // Route through claude_proxy with vision
      const result = await this.claude_proxy({
        prompt: prompt,
        model: 'claude-sonnet-4-5',
        system: 'You are a vision analysis expert. Analyze the provided image thoroughly and accurately. Be specific about what you see — objects, text, colors, layout, UI elements, code, diagrams. No hallucination — only report what is actually visible.',
      });
      return `🔍 Vision Analysis of ${resolved}\nPrompt: ${prompt}\n\n${typeof result === 'string' ? result : JSON.stringify(result)}\n\n[Image data URI available: ${dataUri.substring(0, 80)}...]`;
    } catch (err) {
      return `❌ Error analyzing image: ${err.message}`;
    }
  },

  async ocr_text({ path: filePath, lang = 'eng' }) {
    const resolved = path.resolve(WORK_DIR, filePath);
    if (!fs.existsSync(resolved)) return `❌ File not found: ${resolved}`;
    try {
      // Use tesseract via shell if available, else fall back to vision model
      const tesseractCheck = await asyncShell('which tesseract 2>/dev/null', { timeout: 5 });
      if (tesseractCheck.trim()) {
        const tmpOut = `/tmp/hakster_ocr_${Date.now()}`;
        await asyncShell(`tesseract "${resolved}" "${tmpOut}" -l ${lang} 2>&1`, { timeout: 30 });
        const ocrResult = fs.readFileSync(`${tmpOut}.txt`, 'utf8').trim();
        await asyncShell(`rm -f "${tmpOut}.txt"`, { timeout: 3 });
        const confCheck = await asyncShell(`tesseract "${resolved}" stdout -l ${lang} --psm 6 2>/dev/null | wc -l`, { timeout: 15 });
        return `📝 OCR Result (${lang}) for ${resolved}\nLines: ${confCheck.trim()}\n\n${ocrResult}`;
      }
      // Fallback: use vision model for OCR
      const data = fs.readFileSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
      const mime = mimeMap[ext] || 'application/octet-stream';
      const b64 = data.toString('base64');
      const dataUri = `data:${mime};base64,${b64}`;
      const result = await this.claude_proxy({
        prompt: `Extract ALL text from this image exactly as written. Preserve formatting, line breaks, and structure. Language: ${lang}. Only output the text found — no commentary.`,
        model: 'claude-sonnet-4-5',
        system: 'You are an OCR system. Extract text from images with perfect accuracy. Output ONLY the text you see, preserving layout. If no text is found, say "No text detected."',
      });
      return `📝 OCR Result (${lang}) for ${resolved} [via vision model]\n\n${typeof result === 'string' ? result : JSON.stringify(result)}`;
    } catch (err) {
      return `❌ Error running OCR: ${err.message}`;
    }
  },

  async compare_images({ path_a, path_b, threshold = 10 }) {
    const resolvedA = path.resolve(WORK_DIR, path_a);
    const resolvedB = path.resolve(WORK_DIR, path_b);
    if (!fs.existsSync(resolvedA)) return `❌ Image A not found: ${resolvedA}`;
    if (!fs.existsSync(resolvedB)) return `❌ Image B not found: ${resolvedB}`;
    try {
      // Use imagemagick compare if available
      const imCheck = await asyncShell('which compare 2>/dev/null', { timeout: 5 });
      if (imCheck.trim()) {
        const diffFile = `/tmp/hakster_diff_${Date.now()}.png`;
        const result = await asyncShell(`compare -metric AE "${resolvedA}" "${resolvedB}" "${diffFile}" 2>&1 || true`, { timeout: 30 });
        const diffExists = fs.existsSync(diffFile);
        const diffSize = diffExists ? fs.statSync(diffFile).size : 0;
        // Parse AE (absolute error) count from ImageMagick output
        const aeMatch = result.match(/([\d.]+)/);
        const aeCount = aeMatch ? parseFloat(aeMatch[1]) : 0;
        // Get image dimensions
        let dimsA = '', dimsB = '';
        try { dimsA = (await asyncShell(`identify -format '%wx%h' "${resolvedA}" 2>/dev/null`, { timeout: 5 })).trim(); } catch(_){}
        try { dimsB = (await asyncShell(`identify -format '%wx%h' "${resolvedB}" 2>/dev/null`, { timeout: 5 })).trim(); } catch(_){}
        // Clean up diff file
        if (diffExists) await asyncShell(`rm -f "${diffFile}"`, { timeout: 3 });
        const match = dimsA === dimsB ? ((1 - aeCount / 100000) * 100).toFixed(2) : 'N/A (different dimensions)';
        return `🔬 Image Comparison\n  A: ${resolvedA} (${dimsA})\n  B: ${resolvedB} (${dimsB})\n  AE (different pixels): ${aeCount}\n  Match: ${match}%\n  Threshold: ${threshold}\n  ${aeCount > threshold ? '⚠️ Differences detected above threshold' : '✅ Images match within threshold'}`;
      }
      // Fallback: basic file comparison
      const statA = fs.statSync(resolvedA);
      const statB = fs.statSync(resolvedB);
      const sameSize = statA.size === statB.size;
      const bufA = fs.readFileSync(resolvedA);
      const bufB = fs.readFileSync(resolvedB);
      const sameHash = bufA.equals(bufB);
      if (sameHash) return `🔬 Image Comparison\n  A: ${resolvedA}\n  B: ${resolvedB}\n  ✅ IDENTICAL — same file content (${(statA.size/1024).toFixed(1)} KB)`;
      // Try pixel-level with sharp
      try {
        const sharp = require('sharp');
        const [imgA, imgB] = await Promise.all([sharp(resolvedA).raw().toBuffer(), sharp(resolvedB).raw().toBuffer()]);
        if (imgA.length !== imgB.length) return `🔬 Image Comparison\n  A: ${resolvedA} (${imgA.length} bytes raw)\n  B: ${resolvedB} (${imgB.length} bytes raw)\n  ❌ DIFFERENT dimensions — cannot pixel-compare`;
        let diffs = 0;
        for (let i = 0; i < imgA.length; i++) { if (Math.abs(imgA[i] - imgB[i]) > threshold) diffs++; }
        const matchPct = ((1 - diffs / imgA.length) * 100).toFixed(2);
        return `🔬 Image Comparison (sharp)\n  A: ${resolvedA}\n  B: ${resolvedB}\n  Different pixels: ${diffs.toLocaleString()} / ${imgA.length.toLocaleString()}\n  Match: ${matchPct}%\n  Threshold: ${threshold}\n  ${parseFloat(matchPct) >= 99 ? '✅ Nearly identical' : parseFloat(matchPct) >= 95 ? '⚠️ Minor differences' : '❌ Significant differences'}`;
      } catch (_) {
        return `🔬 Image Comparison (basic)\n  A: ${resolvedA} (${(statA.size/1024).toFixed(1)} KB)\n  B: ${resolvedB} (${(statB.size/1024).toFixed(1)} KB)\n  Same file size: ${sameSize}\n  Same content hash: ${sameHash}\n  💡 Install imagemagick or sharp for pixel-level comparison`;
      }
    } catch (err) {
      return `❌ Error comparing images: ${err.message}`;
    }
  },

  async glob_search({ pattern, maxResults = 100 }) {
    try {
      if (!pattern) return '❌ pattern is required';
      const cwd = WORK_DIR;
      const files = globSync(pattern, { cwd, nodir: true, absolute: true });
      const sorted = files.slice(0, maxResults);
      if (sorted.length === 0) return `📂 No files matching "${pattern}"`;
      const total = files.length;
      const truncated = total > maxResults;
      const lines = sorted.map(f => {
        const rel = path.relative(cwd, f);
        try {
          const stat = fs.statSync(f);
          return `  ${rel} (${(stat.size / 1024).toFixed(1)} KB)`;
        } catch (_) {
          return `  ${rel}`;
        }
      });
      let out = `📂 Found ${total} file${total !== 1 ? 's' : ''} matching "${pattern}"\n`;
      out += lines.join('\n');
      if (truncated) out += `\n  ... and ${total - maxResults} more`;
      return out;
    } catch (err) {
      return `❌ glob_search error: ${err.message}`;
    }
  },

  async edit_file({ path: filePath, changes, createIfMissing = false }) {
    try {
      if (!filePath) return '❌ path is required';
      if (!changes || !Array.isArray(changes)) return '❌ changes array is required';
      const resolved = path.resolve(WORK_DIR, filePath);
      if (!sandbox.isWritable(resolved)) return `❌ Sandbox: edit to ${resolved} blocked (outside writable root)`;
      if (!fs.existsSync(resolved)) {
        if (!createIfMissing) return `❌ File not found: ${resolved}`;
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolved, '', 'utf-8');
      }
      let content = fs.readFileSync(resolved, 'utf-8');
      const lines = content.split('\n');
      let applied = 0;
      for (const change of changes) {
        if (change.start == null || change.end == null) continue;
        const start = Math.max(0, change.start - 1);
        const end = Math.min(lines.length, change.end);
        const newText = (change.text || '').split('\n');
        lines.splice(start, end - start, ...newText);
        applied++;
      }
      fs.writeFileSync(resolved, lines.join('\n'), 'utf-8');
      return `✏️ Edited ${resolved}: ${applied} change${applied !== 1 ? 's' : ''} applied`;
    } catch (err) {
      return `❌ edit_file error: ${err.message}`;
    }
  },

  async replace_in_file({ path: filePath, replacements, createIfMissing = false }) {
    try {
      if (!filePath) return '❌ path is required';
      if (!replacements || !Array.isArray(replacements)) return '❌ replacements array is required';
      const resolved = path.resolve(WORK_DIR, filePath);
      if (!fs.existsSync(resolved)) {
        if (!createIfMissing) return `❌ File not found: ${resolved}`;
        // For createIfMissing with replacements, write the concatenated new values
        const newContent = replacements.map(r => r.new || '').join('\n');
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolved, newContent, 'utf-8');
        return `✨ Created ${resolved} with ${replacements.length} replacement block${replacements.length !== 1 ? 's' : ''}`;
      }
      let content = fs.readFileSync(resolved, 'utf-8');
      let applied = 0;
      for (const rep of replacements) {
        if (!rep.old) continue;
        const count = (content.match(new RegExp(rep.old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        content = content.split(rep.old).join(rep.new || '');
        if (count > 0) applied++;
      }
      fs.writeFileSync(resolved, content, 'utf-8');
      return `🔄 Replaced in ${resolved}: ${applied} replacement${applied !== 1 ? 's' : ''} applied`;
    } catch (err) {
      return `❌ replace_in_file error: ${err.message}`;
    }
  },

  async shell_bg({ command, label, cwd }) {
    try {
      if (!command) return '❌ command is required';
      const id = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const procCwd = cwd ? path.resolve(WORK_DIR, cwd) : WORK_DIR;
      const child = spawn('/bin/bash', ['-c', command], {
        cwd: procCwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 50000) stdout = stdout.slice(-50000); });
      child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 50000) stderr = stderr.slice(-50000); });
      bgProcesses.set(id, { process: child, label: label || command.slice(0, 60), command, cwd: procCwd, startedAt: Date.now(), stdout: '', stderr: '' });
      child.stdout.on('data', d => { const entry = bgProcesses.get(id); if (entry) entry.stdout = (entry.stdout || '') + d.toString(); });
      child.stderr.on('data', d => { const entry = bgProcesses.get(id); if (entry) entry.stderr = (entry.stderr || '') + d.toString(); });
      child.on('exit', code => { const entry = bgProcesses.get(id); if (entry) { entry.exitCode = code; entry.endedAt = Date.now(); } });
      return `🚀 Background process started\n  ID: ${id}\n  Label: ${label || command.slice(0, 60)}\n  PID: ${child.pid}\n  CWD: ${procCwd}\n  Use run_background or kill_process to manage`;
    } catch (err) {
      return `❌ shell_bg error: ${err.message}`;
    }
  },

  async diff_preview({ path: filePath, replacements }) {
    try {
      if (!filePath) return '❌ path is required';
      if (!replacements || !Array.isArray(replacements)) return '❌ replacements array is required';
      const resolved = path.resolve(WORK_DIR, filePath);
      if (!fs.existsSync(resolved)) return `❌ File not found: ${resolved}`;
      const original = fs.readFileSync(resolved, 'utf-8');
      let modified = original;
      for (const rep of replacements) {
        if (!rep.old) continue;
        modified = modified.split(rep.old).join(rep.new || '');
      }
      if (original === modified) return 'ℹ️ No changes would be applied';
      const origLines = original.split('\n');
      const modLines = modified.split('\n');
      let diff = '';
      let changeCount = 0;
      const maxDiffLines = 200;
      const cs = Math.max(origLines.length, modLines.length);
      for (let i = 0; i < cs && diff.split('\n').length < maxDiffLines; i++) {
        const oLine = i < origLines.length ? origLines[i] : undefined;
        const mLine = i < modLines.length ? modLines[i] : undefined;
        if (oLine !== mLine) {
          changeCount++;
          if (oLine !== undefined) diff += `- ${i + 1}: ${oLine}\n`;
          if (mLine !== undefined) diff += `+ ${i + 1}: ${mLine}\n`;
        }
      }
      let out = `📝 Diff preview for ${path.relative(WORK_DIR, resolved)}\n`;
      out += `  ${changeCount} line${changeCount !== 1 ? 's' : ''} changed\n\n`;
      out += diff;
      if (diff.split('\n').length >= maxDiffLines) out += '\n  ... (truncated, use edit_file or replace_in_file to apply)';
      return out;
    } catch (err) {
      return `❌ diff_preview error: ${err.message}`;
    }
  },

  async codebase_map({ maxDepth = 4, maxFiles = 200, includeHidden = false, focus }) {
    try {
      const root = focus ? path.resolve(WORK_DIR, focus) : WORK_DIR;
      if (!fs.existsSync(root)) return `❌ Directory not found: ${root}`;
      const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'vendor', 'bun.lock']);
      const skipExts = new Set(['.map', '.lock', '.wasm']);
      let fileCount = 0;
      let totalLines = 0;
      const result = [];
      function walk(dir, depth, prefix) {
        if (depth > maxDepth || fileCount >= maxFiles) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) { return; }
        entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });
        for (const entry of entries) {
          if (fileCount >= maxFiles) break;
          if (!includeHidden && entry.name.startsWith('.')) continue;
          if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          const relPath = path.relative(root, fullPath);
          if (entry.isDirectory()) {
            result.push(`${prefix}📁 ${entry.name}/`);
            walk(fullPath, depth + 1, prefix + '  ');
          } else {
            if (skipExts.has(path.extname(entry.name))) continue;
            try {
              const stat = fs.statSync(fullPath);
              fileCount++;
              totalLines += Math.round(stat.size / 40);
              result.push(`${prefix}📄 ${entry.name} (${(stat.size / 1024).toFixed(1)} KB)`);
            } catch (_) {
              result.push(`${prefix}📄 ${entry.name}`);
            }
          }
        }
      }
      walk(root, 0, '');
      let out = `🗺️ Codebase map: ${path.relative(WORK_DIR, root) || '.'}\n`;
      out += `  Files: ${fileCount} | Est. lines: ${totalLines.toLocaleString()}\n\n`;
      out += result.join('\n');
      if (fileCount >= maxFiles) out += `\n\n  ⚠️ Truncated at ${maxFiles} files. Increase maxFiles for more.`;
      return out;
    } catch (err) {
      return `❌ codebase_map error: ${err.message}`;
    }
  },

  async context_compaction({ strategy = 'summarize', maxTokens = 8000, keepLastN = 10 }) {
    try {
      const hist = this._conversationHistory || [];
      if (hist.length === 0) return 'ℹ️ No conversation history to compact';
      const totalMsgs = hist.length;
      switch (strategy) {
        case 'truncate_old': {
          const kept = hist.slice(-keepLastN);
          return `📌 Compacted: kept last ${kept.length} of ${totalMsgs} messages. Older messages truncated. Re-send your latest context if needed.`;
        }
        case 'keep_recent': {
          const kept = hist.slice(-keepLastN);
          return `📌 Compacted: kept ${kept.length} recent of ${totalMsgs} messages. Summarize key facts from earlier context and re-inject them.`;
        }
        case 'key_facts': {
          const recent = hist.slice(-keepLastN);
          const summary = recent.filter(m => m.role === 'assistant').map(m => {
            const t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return t.slice(0, 200);
          }).join('\n');
          return `🔑 Key facts from ${kept.length} recent messages:\n${summary || '(no assistant messages found)'}\n\n📌 ${totalMsgs - keepLastN} older messages can be dropped.`;
        }
        case 'summarize':
        default: {
          const recentCount = Math.min(keepLastN, totalMsgs);
          return `📋 Context compaction (${strategy})\n  Total messages: ${totalMsgs}\n  Keeping: recent ${recentCount} messages\n  Suggested budget: ~${maxTokens} tokens\n  Older context should be re-injected as a summary if still relevant.`;
        }
      }
    } catch (err) {
      return `❌ context_compaction error: ${err.message}`;
    }
  },
};

// ── MCP Integration — merge MCP tools into TOOLS array ──────────────────────
// Count of built-in tools for reference
const _builtinToolCount = TOOLS.length;

async function initMcpTools() {
  try {
    const { tools: mcpToolDefs, servers } = await loadMcpServers(getHaksterRoots());
    if (mcpToolDefs.length > 0) {
      // Compress MCP tool schemas to save context — strip verbose parameter
      // descriptions, keep only name + shortened description + param names.
      // Full schemas are restored dynamically in callMcpTool() from the server.
      const compressed = mcpToolDefs.map(t => {
        const desc = t.function.description || '';
        // Keep first sentence only (skip detailed paragraphs)
        const shortDesc = desc.split('.')[0] + (desc.includes('.') ? '.' : '');
        // Strip property descriptions and compress parameters
        let params = { type: 'object', properties: {}, required: t.function.parameters?.required || [] };
        if (t.function.parameters?.properties) {
          for (const [key, schema] of Object.entries(t.function.parameters.properties)) {
            const compressedProp = { type: schema.type || 'string' };
            // Keep enum values if present (important for the model to know valid options)
            if (schema.enum) compressedProp.enum = schema.enum;
            // Keep one-word description if it's short, otherwise drop
            if (schema.description && schema.description.length < 60) {
              compressedProp.description = schema.description;
            }
            params.properties[key] = compressedProp;
          }
        }
        return {
          type: 'function',
          function: {
            name: t.function.name,
            description: shortDesc,
            parameters: params,
          },
          _mcpServer: t._mcpServer,
          _mcpToolName: t._mcpToolName,
        };
      });
      // Merge MCP tools into the TOOLS array (keep built-in tools first)
      TOOLS = [...TOOLS.slice(0, _builtinToolCount), ...compressed];
    }
  } catch (err) {
    // MCP init failure is non-fatal — agent still works with built-in tools
    if (typeof _logFn === 'function') _logFn(`[MCP] Init warning: ${err.message}`);
  }
}

// ── Ollama API Call ─────────────────────────────────────────────────────
function callOllama(messages, tools, { onToken, lowToken = false } = {}) {
  return new Promise((resolve, reject) => {
    const numPredict = lowToken
      ? Math.max(1024, parseInt(process.env.HAKSTER_LOW_TOKEN_NUM_PREDICT || '4096', 10) || 4096)
      : 16384;
    const body = JSON.stringify({
      model: MODEL,
      messages,
      tools: tools || undefined,
      stream: true,   // ← STREAMING: tokens arrive in real-time instead of blocking until complete
      options: {
        num_predict: numPredict,
        temperature: 0.3,     // lower temp = faster convergence, less creative drift
        top_p: 0.9,
      },
    });

    const url = new URL(`${OLLAMA_HOST}/api/chat`);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };

    const maxTimeout = 300000; // 5 min for big models
    const req = http.request(options, (res) => {
      // ── Detect HTTP errors (e.g., 400 from malformed request) ──
      if (res.statusCode >= 400) {
        let errBody = '';
        res.on('data', (c) => { errBody += c.toString(); });
        res.on('end', () => {
          // Try to extract Ollama's structured error: {"error":"message"} or {"error":{"message":"..."}}
          let detail = errBody.substring(0, 500);
          try {
            const parsed = JSON.parse(errBody);
            if (parsed.error) {
              detail = typeof parsed.error === 'string' ? parsed.error
                : (parsed.error.message || JSON.stringify(parsed.error));
            }
          } catch (_) { /* not JSON — use raw substring */ }
          const errMsg = `Ollama HTTP ${res.statusCode}: ${detail}`;
          console.log(`[DEBUG callOllama] ${errMsg}`);
          reject(new Error(errMsg));
        });
        return;
      }
      // ── Streaming: accumulate NDJSON chunks into a final response ──
      let message = { role: 'assistant', content: '', thinking: '' };
      let toolCalls = [];
      let buffer = '';  // partial line buffer (NDJSON = newline-delimited)
      global._chunkLogCount = 0; // reset chunk debug counter

      // Throttle token display: update status bar at most every 150ms
      let lastStatusUpdate = 0;
      let pendingContent = '';
      let pendingThinking = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();  // keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (process.env.HAKSTER_DEBUG_AGENT === '1' && global._chunkLogCount < 5) {
              global._chunkLogCount++;
              const hasContent = !!(obj.message?.content);
              const hasThinking = !!(obj.message?.thinking);
              const hasTC = !!(obj.message?.tool_calls?.length);
              console.log(`[CHUNK ${global._chunkLogCount}] content=${hasContent} thinking=${hasThinking} tool_calls=${hasTC} done=${obj.done || false}`);
            }
            if (obj.message) {
              // Accumulate content/thinking
              if (obj.message.content) {
                message.content += obj.message.content;
                pendingContent += obj.message.content;
              }
              if (obj.message.thinking) {
                message.thinking += obj.message.thinking;
                pendingThinking += obj.message.thinking;
              }
              // Accumulate tool calls (Ollama sends complete tool_call objects, not incremental)
              if (obj.message.tool_calls) {
                for (const tc of obj.message.tool_calls) {
                  // Deduplicate: Ollama may send the same tool_call in multiple chunks
                  // Each tool_call has a unique .id — only add if we haven't seen it
                  const existingIdx = toolCalls.findIndex(e => e.id && e.id === tc.id);
                  if (existingIdx !== -1) {
                    // Already seen — skip duplicate
                  } else {
                    // Normalize: Ollama sends arguments as a parsed object, but agent loop expects a JSON string
                    const args = tc.function?.arguments;
                    const argsStr = (typeof args === 'object' && args !== null)
                      ? JSON.stringify(args)
                      : (typeof args === 'string' ? args : '{}');
                    toolCalls.push({
                      id: tc.id || `call_${toolCalls.length}`,
                      type: 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: argsStr,
                      },
                    });
                  }
                }
              }
            }
            // Throttled status updates: show token progress in real-time
            const now = Date.now();
            if (onToken && (now - lastStatusUpdate > 150 || obj.done)) {
              lastStatusUpdate = now;
              // Show what we're streaming: thinking takes priority, then content
              const preview = pendingThinking || pendingContent;
              if (preview) {
                const short = preview.length > 80 ? preview.slice(-80) : preview;
                onToken(short.replace(/\n/g, ' '));
                pendingContent = '';
                pendingThinking = '';
              }
            }
          } catch (parseErr) {
            if (process.env.HAKSTER_DEBUG_AGENT === '1') {
              console.log(`[DEBUG callOllama] JSON parse error on chunk: ${trimmed.substring(0, 200)}`);
            }
          }
        }
      });

      res.on('end', () => {
        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const obj = JSON.parse(buffer.trim());
            if (obj.message) {
              if (obj.message.content) message.content += obj.message.content;
              if (obj.message.thinking) message.thinking += obj.message.thinking;
              if (obj.message.tool_calls) {
                for (const tc of obj.message.tool_calls) {
                  const existingIdx = toolCalls.findIndex(e => e.id && e.id === tc.id);
                  if (existingIdx === -1) {
                    const args = tc.function?.arguments;
                    const argsStr = (typeof args === 'object' && args !== null)
                      ? JSON.stringify(args)
                      : (typeof args === 'string' ? args : '{}');
                    toolCalls.push({
                      id: tc.id || `call_${toolCalls.length}`,
                      type: 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: argsStr,
                      },
                    });
                  }
                }
              }
            }
          } catch (_) { /* ignore trailing parse errors */ }
        }

        // Tool calls already normalized during streaming accumulation — just attach if present
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls;
        }
        const response = { message };
        // DEBUG: Log final accumulated response
        console.log(`[DEBUG callOllama] STREAM END: content=${message.content.length}ch thinking=${message.thinking.length}ch tool_calls=${toolCalls.length} chunks_seen=${global._chunkLogCount}`);
        resolve(response);
      });
    });

    req.on('error', reject);
    req.setTimeout(maxTimeout, () => { req.destroy(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Hard context ceiling — progressive truncation ────────────────
// gpt-oss:120b-cloud has 131k context. Budget: ~114k tokens (131k minus 16k output).
// Ceiling: ~100k chars at ~2:1 ratio (conservative estimate).
// Aggressive threshold to stay well below the model's hard limit.
const LOW_TOKEN_MAX_CONTEXT_CHARS = parseInt(process.env.HAKSTER_LOW_TOKEN_CONTEXT_CHARS || '12000', 10) || 12000;
const LOW_TOKEN_ABSOLUTE_CONTEXT_CHARS = Math.max(15000, Math.floor(LOW_TOKEN_MAX_CONTEXT_CHARS * 1.25));
const LOW_TOKEN_CONTEXT_WINDOW = 16384;
const LOW_TOKEN_MIN_MESSAGES = 6;
const LOW_TOKEN_MAX_MESSAGES = 30;

const MAX_CONTEXT_CHARS = 50000;  // proactive compact threshold (leave headroom)
const ABSOLUTE_CONTEXT_CHARS = 70000; // hard ceiling — matches server/index.js
const CONTEXT_WINDOW = 131072;    // gpt-oss:120b-cloud context window (for % display)
const MIN_MESSAGES_TO_KEEP = 10;  // Keep last 5 exchanges (10 messages)

function estimateChars(history) {
  return history.reduce((sum, m) => sum + (m.content?.length || 0), 0);
}

function contextPercent(history, lowToken = false) {
  const chars = estimateChars(history);
  const window = lowToken ? LOW_TOKEN_CONTEXT_WINDOW : CONTEXT_WINDOW;
  return Math.min(100, ((chars / window) * 100)).toFixed(1);
}

function logContextUsage(history, label = '', lowToken = false) {
  const pct = contextPercent(history, lowToken);
  const chars = estimateChars(history);
  const msgs = history.length - 1; // exclude system
  const pctNum = parseFloat(pct);
  const color = pctNum > 80 ? C.red : pctNum > 50 ? C.yellow : C.green;
  log(`${color}📐 Context: ${pct}% (${(chars/1000).toFixed(0)}k chars, ${msgs} msgs)${label ? ' ' + label : ''}${C.reset}`);
}

// Check if history has in-progress tool calls (assistant message with tool_calls
// that hasn't had all tool results answered yet)
function hasPendingToolCalls(history) {
  for (let i = history.length - 1; i >= Math.max(0, history.length - 6); i--) {
    const m = history[i];
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      // Found a tool call message — check if all results are present
      const toolNames = m.tool_calls.map(tc => tc.function?.name || tc.name);
      let answered = 0;
      for (let j = i + 1; j < history.length; j++) {
        if (history[j].role === 'tool') answered++;
      }
      if (answered < m.tool_calls.length) return true;
    }
  }
  return false;
}

// ── Sanitize history: fix malformed message sequences that cause empty model responses ──
// Ollama requires proper role alternation and rejects orphaned tool messages.
// This function MUST be called before every callOllama() to prevent context corruption.
function sanitizeHistory(history) {
  if (history.length <= 1) return; // only system prompt, nothing to fix

  const before = history.length;

  // 1. Remove empty assistant messages (content="" and no tool_calls)
  //    Also remove stuck-loop pattern: assistant with tool_calls but no content + trivial tool response
  for (let i = history.length - 1; i >= 1; i--) {
    const m = history[i];
    if (m.role === 'assistant') {
      const content = (m.content || '').trim();
      const thinking = (m.thinking || '').trim();
      const hasTools = m.tool_calls && m.tool_calls.length > 0;
      // Completely empty — no content, no thinking, no tool_calls
      if (!content && !thinking && !hasTools) {
        history.splice(i, 1);
        continue;
      }
      // Stuck-loop pattern: assistant has tool_calls but no content
      // Check if the following tool responses are all trivially small
      if (!content && !thinking && hasTools) {
        let allTrivial = true;
        let toolCount = 0;
        for (let k = i + 1; k < history.length && history[k].role === 'tool'; k++) {
          toolCount++;
          const tc = (history[k].content || '').trim();
          if (tc.length > 200) allTrivial = false;
        }
        if (allTrivial && toolCount > 0 && toolCount === m.tool_calls.length) {
          // Remove the tool responses first (they're after the assistant)
          for (let k = 0; k < toolCount; k++) {
            history.splice(i + 1, 1);
          }
          // Then remove the assistant message itself
          history.splice(i, 1);
        }
      }
    }
  }

  // 2. Remove orphaned tool responses (tool role without preceding assistant tool_calls)
  for (let i = history.length - 1; i >= 1; i--) {
    if (history[i].role === 'tool') {
      // Look back for the nearest assistant message with tool_calls
      let hasMatchingCall = false;
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (history[j].role === 'assistant' && history[j].tool_calls?.length > 0) {
          // Check if this assistant's tool_calls include a call matching the tool name
          const toolName = history[i].name || '';
          const matchIdx = history[j].tool_calls.findIndex(tc =>
            (tc.function?.name || tc.name) === toolName || !toolName
          );
          if (matchIdx !== -1) {
            hasMatchingCall = true;
          }
          break;
        } else if (history[j].role === 'assistant') {
          // Assistant without tool_calls — orphan confirmed
          break;
        }
      }
      if (!hasMatchingCall) {
        history.splice(i, 1);
      }
    }
  }

  // 3. Merge consecutive same-role messages (Ollama expects alternating roles)
  //    Consecutive user messages → merge into one
  //    Consecutive system messages → keep only the last one
  for (let i = history.length - 1; i >= 1; i--) {
    if (i > 0 && history[i].role === history[i - 1].role) {
      if (history[i].role === 'user') {
        // Merge: keep both contents separated by newline
        history[i - 1] = {
          ...history[i - 1],
          content: (history[i - 1].content || '') + '\n' + (history[i].content || ''),
        };
        history.splice(i, 1);
      } else if (history[i].role === 'system') {
        // Keep the last system nudge (it's usually the more relevant one)
        history.splice(i - 1, 1);
      }
      // Don't merge assistant messages — they may have different tool_calls
    }
  }

  // 4. Deduplicate repeated nudge messages from empty-response retries
  const nudgePrefix = 'IMPORTANT: Your last response was empty.';
  let nudgeCount = 0;
  for (let i = history.length - 1; i >= 1; i--) {
    if (history[i].role === 'system' && (history[i].content || '').startsWith(nudgePrefix)) {
      nudgeCount++;
      if (nudgeCount > 1) {
        history.splice(i, 1); // keep only the most recent nudge
      }
    }
  }

  // 5. Ensure first message is system role
  if (history.length > 0 && history[0].role !== 'system') {
    // Shouldn't happen, but fix it
    history.unshift({ role: 'system', content: 'You are haksterAI, an expert AI agent.' });
  }

  // 6. CRITICAL: Convert tool_calls[].function.arguments from string to object
  //    Ollama's /api/chat requires arguments as a parsed object, NOT a JSON string.
  //    When we store tool_calls from Ollama responses, we stringify arguments (L2505)
  //    for OpenAI-compat format. But when sending BACK to Ollama, they must be objects.
  //    A string arguments field causes Ollama to return 400 with zero stream chunks,
  //    which the agent sees as an "empty response" and retries endlessly.
  let argsFixed = 0;
  for (const m of history) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.function && typeof tc.function.arguments === 'string') {
          try {
            tc.function.arguments = JSON.parse(tc.function.arguments);
            argsFixed++;
          } catch (_) {
            // If it's not valid JSON, replace with empty object
            tc.function.arguments = {};
            argsFixed++;
          }
        }
      }
    }
  }

  const removed = before - history.length;
  if (removed > 0 || argsFixed > 0) {
    const parts = [];
    if (removed > 0) parts.push(`removed ${removed} malformed message(s) (${before} → ${history.length})`);
    if (argsFixed > 0) parts.push(`fixed ${argsFixed} tool_call arguments (string→object)`);
    log(`${C.fgMuted}◇ Sanitized history: ${parts.join(', ')}${C.reset}`);
  }
}

function compactHistory(history, lowToken = false) {
  if (history.length <= 1) return; // system prompt only

  const ctxMax = lowToken ? LOW_TOKEN_MAX_CONTEXT_CHARS : MAX_CONTEXT_CHARS;
  const ctxAbs = lowToken ? LOW_TOKEN_ABSOLUTE_CONTEXT_CHARS : ABSOLUTE_CONTEXT_CHARS;
  const maxMsgs = lowToken ? LOW_TOKEN_MAX_MESSAGES : 60;
  const minMsgs = lowToken ? LOW_TOKEN_MIN_MESSAGES : MIN_MESSAGES_TO_KEEP;
  const msgStartLimit = lowToken ? 300 : 1000;
  const msgFloor = lowToken ? 60 : 100;

  // Don't compact if there are in-progress tool calls — wait until they settle
  if (hasPendingToolCalls(history)) {
    log(`${C.fgMuted}◇ Skipping compact — tool calls in progress${C.reset}`);
    return;
  }

  // ALWAYS enforce message count limit, regardless of char size.
  if (history.length > maxMsgs + 1) { // +1 for system prompt
    const dropCount = history.length - maxMsgs - 1;
    log(`${C.mustard}◇ Dropping ${dropCount} oldest messages (history has ${history.length - 1} msgs, max ${maxMsgs})${C.reset}`);
    logContextUsage(history, 'before drop', lowToken);
    history.splice(1, dropCount);
    logContextUsage(history, 'after drop', lowToken);
  }

  logContextUsage(history, 'checking compact', lowToken);

  // Progressive truncation — shrink message content, never drop messages
  let msgs = [...history];  // ALWAYS copy — never alias the original array
  let perMsgLimit = msgStartLimit;
  let iterations = 0;

  while (estimateChars(msgs) > ctxMax && perMsgLimit > msgFloor) {
    perMsgLimit = Math.max(msgFloor, Math.floor(perMsgLimit * 0.6));
    msgs = msgs.map((m, i) => {
      if (i === 0 && m.role === 'system') return m; // never truncate system prompt
      const content = (m.content || '');
      if (content.length <= perMsgLimit) return m;
      return { ...m, content: content.substring(0, perMsgLimit) + '\n[trimmed]' };
    });
    iterations++;
  }

  // Nuclear: if still over absolute ceiling, cap everything hard
  if (estimateChars(msgs) > ctxAbs) {
    msgs = msgs.map((m, i) => {
      if (i === 0 && m.role === 'system') return m;
      const content = (m.content || '');
      if (content.length <= msgFloor) return m;
      return { ...m, content: content.substring(0, msgFloor) + '\n[trimmed]' };
    });
    // If STILL over, drop oldest messages until under ceiling
    while (msgs.length > minMsgs + 1 && estimateChars(msgs) > ctxAbs) {
      msgs.splice(1, 1); // remove oldest non-system message
    }
  }

  // Apply back to history array in place (safe because msgs is a copy, not alias)
  if (iterations > 0 || msgs.length !== history.length) {
    const beforePct = contextPercent(history);
    history.length = 0;
    history.push(...msgs);
    const afterPct = contextPercent(history);
    log(`${C.mustard}◇ Auto-compacted (${iterations} rounds). Context: ${beforePct}% → ${afterPct}%${C.reset}`);
  }
}
let _logFn = (text) => console.log(text);
function log(text) {
  _logFn(text);
  // Any regular log output invalidates in-place panel scroll — the next
  // panel render can't scroll up over random log lines, it must append below.
  _lastPanelName = null;
  // Update activity timestamp so stall guard knows we're alive
  _lastActivityTime = Date.now();
}

// ── Spinner (TUI-aware, with elapsed-time nudge) ──────────────────────
let _statusFn = null; // set by TUI to update status bar
function startSpinner(label) {
  if (_statusFn) {
    const frames = ['◇','◆','◇','◆','◈','◇','◆','◈','◇','◆'];
    const startMs = Date.now();
    let i = 0;
    const interval = setInterval(() => {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      _statusFn(`${frames[i % frames.length]} ${label} (${elapsed}s)`);
      i++;
    }, Math.round(80 / SCROLL_SPEED));
    return { stop(msg) { clearInterval(interval); _statusFn('Ready'); if (msg) log(msg); } };
  }
  // Fallback for non-TUI mode (module import)
  const frames = ['◇','◆','◇','◆','◈','◇','◆','◈','◇','◆'];
  let i = 0;
  const interval = setInterval(() => { process.stdout.write(`\r${C.primary}${frames[i % frames.length]}${C.reset} ${C.fgMuted}${label}${C.reset}   `); i++; }, Math.round(80 / SCROLL_SPEED));
  return { stop(msg) { clearInterval(interval); process.stdout.write(`\r${' '.repeat(50)}\r`); if (msg) process.stdout.write(msg); } };
}

// ── Agent Loop ───────────────────────────────────────────────────────────
async function agentLoop(userMessage, history, silent = false, opts = {}) {
  const _lowToken = opts.lowToken || false;
  const _maxTurns = _lowToken ? LOW_TOKEN_MAX_TURNS : MAX_TURNS;
  _currentMaxTurns = _maxTurns;
  // Reset tool call counter for each new user request
  _toolCallCount = 0;
  // BUG FIX: Reset ALL module-level loop-detection state per-call, not just at REPL start.
  // Previously these only reset at repl() init or when a loop was already detected —
  // meaning they accumulated across agentLoop() calls and caused false-positive
  // "stuck-loop detected" breaks on normal multi-turn conversations.
  _noProgressCount = 0;
  _recentResponsePrefixes = [];
  _emptyRetries = 0;
  _explorationCalls = [];
  _recentToolSigs = [];
  _repeatToolSigCount = 0;  // reset per-call too — prevent cross-call false positives
  _agentActivity = 'Thinking'; _activityDetail = 'Starting'; _activityStart = Date.now();
  _lastActivityTime = Date.now();

  // ── INIT: Collect pentester fingerprint for this session ──
  const fp = getPentesterFingerprint();
  if (!silent) {
    log(`${C.info}🔐 Device Identity${C.reset} ${C.fgMuted}uid=${fp.device_uid.device_id}${C.reset}`);
    log(`${C.fgMuted}   session=${fp.session_uid} hostname=${fp.hostname} os=${fp.os.name}${C.reset}`);
  }
  history.push({ role: 'user', content: userMessage });

  // ── Stall guard: kickstart if no activity for 20 seconds ──
  if (_stallGuardTimer) clearInterval(_stallGuardTimer);
  _stallGuardTimer = setInterval(() => {
    if (_awaitingConfirm) return;  // Don't nudge while a y/N prompt is open
    const elapsed = Date.now() - _lastActivityTime;
    if (elapsed > STALL_GUARD_MS) {
      const nudge = FOCUS_NUDGES[Math.floor(Math.random() * FOCUS_NUDGES.length)];
      log(`${C.mustard}${C.bold}⚡ NUDGE${C.reset} ${C.fgMuted}(${(elapsed/1000).toFixed(0)}s idle)${C.reset} ${nudge}`);
      history.push({ role: 'system', content: nudge });
      _lastActivityTime = Date.now();
    }
  }, STALL_GUARD_MS);

  // ── Status bar: bottom line showing what the agent is doing + pending tools ──
  if (!silent && !_statusBarInterval) {
    const statusBarFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⏏'];
    let sbarIdx = 0;
    _statusBarInterval = setInterval(() => {
      if (_awaitingConfirm) return;  // Don't clobber the open y/N readline prompt
      const elapsed = ((Date.now() - _activityStart) / 1000).toFixed(0);
      const frame = statusBarFrames[sbarIdx % statusBarFrames.length];
      sbarIdx++;
      const icon = _agentActivity === 'Thinking' ? '🧠' : _agentActivity === 'Executing' ? '⚡' : _agentActivity === 'Patching' ? '🔧' : _agentActivity === 'Talking' ? '💬' : _agentActivity === 'Explaining' ? '📖' : _agentActivity === 'Reading' ? '📄' : _agentActivity === 'Writing' ? '✏️' : '⏸';
      const actColor = _agentActivity === 'Patching' ? C.primary : _agentActivity === 'Thinking' ? C.tertiary : _agentActivity === 'Executing' ? C.secondary : C.fgBase;
      const detail = _activityDetail ? ' → ' + C.fgHalf + _activityDetail.substring(0, 35) + C.reset : '';
      const sessIn = _sessionTokensIn > 0 ? (_sessionTokensIn / 1000).toFixed(1) : '0';
      const sessOut = _sessionTokensOut > 0 ? (_sessionTokensOut / 1000).toFixed(1) : '0';
      const burnRate = _sessionTokensIn > 0 && parseInt(elapsed) > 0 ? ((_sessionTokensIn + _sessionTokensOut) / parseInt(elapsed) * 60 / 1000).toFixed(0) : '0';
      const costStr = _sessionCost > 0 ? '$' + _sessionCost.toFixed(4) : '$0';
      const tokInfo = _sessionTokensIn > 0 ? C.fgSubtle + '│' + C.reset + ' ' + C.tertiary + '↑' + C.reset + C.fgBase + sessIn + 'k' + C.reset + ' ' + C.secondary + '↓' + C.reset + C.fgBase + sessOut + 'k' + C.reset + ' ' + C.fgSubtle + '🔥' + C.reset + C.fgBase + burnRate + 'k/m' + C.reset : '';
      const costInfo = _sessionCost > 0 ? C.fgSubtle + '│' + C.reset + ' ' + C.butter + C.bold + '💰' + C.reset + C.fgBase + costStr + C.reset : C.fgSubtle + '│' + C.reset + ' ' + C.fgSubtle + '💰' + C.reset + C.fgSubtle + '$0' + C.reset;
      const turnInfo = C.fgSubtle + 'Step' + C.reset + ' ' + C.fgBase + _toolCallCount + C.reset + C.fgSubtle + '/' + C.reset + C.fgMuted + _maxTurns + C.reset;
      const pendingStr = _pendingTools.length > 0 ? ' ' + C.fgSubtle + '│' + C.reset + ' ' + C.mustard + '🔍' + C.reset + C.fgBase + _pendingTools.length + C.reset + C.mustard + ' pending' + C.reset + ' ' + C.fgMuted + _pendingTools.map(p => p.name).join(',').substring(0, 40) + C.reset : '';
      process.stdout.write('\r' + C.bgSubtle + ' ' + actColor + C.bold + icon + C.reset + actColor + C.bold + ' ' + _agentActivity + C.reset + detail + ' ' + C.fgSubtle + frame + C.reset + ' ' + turnInfo + ' ' + C.fgSubtle + '│' + C.reset + ' ' + C.fgMuted + elapsed + 's' + C.reset + ' ' + tokInfo + ' ' + costInfo + pendingStr + ' ' + C.reset + '   ');
    }, 500);
    // Clear status bar on exit
    process.on('SIGINT', () => { if (_statusBarInterval) { clearInterval(_statusBarInterval); _statusBarInterval = null; } process.stdout.write('\r' + ' '.repeat(120) + '\r'); });
  }
  // ── TUI dashboard: reset state at start of each user request ──
  if (!silent) tuiReset();
  tuiSetPhase('THINK');

  let lastHadToolCalls = false;
  for (let turn = 0; turn < _maxTurns; turn++) {
    // 6-phase: THINK at start of each turn
    tuiSetPhase('THINK');
    // ── Drain notification queue at start of each turn ──
    const pendingNotifs = msgDrain(10);
    if (pendingNotifs.length > 0 && !silent) {
      const typeColors = { notify: C.cyan, warn: C.yellow, error: C.red, task: C.green, mcp: C.magenta, system: C.dim };
      const typeIcons = { notify: '📬', warn: '⚠️', error: '❌', task: '✅', mcp: '🔌', system: '⚙️' };
      for (const m of pendingNotifs) {
        const icon = typeIcons[m.type] || '📬';
        const tc = typeColors[m.type] || C.dim;
        log(`${icon} ${tc}${m.msg}${C.reset}`);
      }
    }

    // ── TUI dashboard: update step counter ──
    tuiSetStep(turn + 1, _maxTurns);
    const spinner = silent ? null : startSpinner('thinking...');
    let response;
    try {
      // Only compact when the previous turn did NOT end with tool calls
      // (i.e., we're not in the middle of a tool chain)
      if (!lastHadToolCalls) {
        compactHistory(history, _lowToken);
      } else {
        log(`${C.fgMuted}◇ Skipping compact — still in tool chain (turn ${turn})${C.reset}`);
      }
      // ── Sanitize history before every API call to prevent empty responses ──
      sanitizeHistory(history);
      // Stream tokens to TUI status bar in real-time (150ms throttle built into callOllama)
      const tokenCallback = _statusFn
        ? (preview) => _statusFn(`${C.info}◇${C.reset} ${preview}`)
        : null;
      if (process.env.HAKSTER_DEBUG_AGENT === '1') {
        console.log(`[DEBUG] callOllama: history_len=${history.length} tools_count=${TOOLS?.length || 0} model=${MODEL}`);
        const _reqBodyEst = JSON.stringify({ model: MODEL, messages: history, tools: TOOLS });
        console.log(`[DEBUG] request body size: ${(_reqBodyEst.length / 1024).toFixed(1)}KB`);
        try { fs.writeFileSync('/tmp/hakster_last_request.json', _reqBodyEst); console.log('[DEBUG] saved payload to /tmp/hakster_last_request.json'); } catch(_) {}
        const _sysMsg = history.find(m => m.role === 'system');
        const _firstUser = history.find(m => m.role === 'user');
        console.log(`[DEBUG] sys_prompt_len=${(_sysMsg?.content||'').length} first_user_len=${(_firstUser?.content||'').length} first_user_preview=${JSON.stringify((_firstUser?.content||'').substring(0,200))}`);
      }
      // ── Activity: thinking ──
      _agentActivity = 'Thinking'; _activityDetail = `Turn ${turn + 1}/${_maxTurns}`; _activityStart = Date.now();
      response = await callOllama(history, TOOLS, { onToken: tokenCallback, lowToken: _lowToken });
      _lastActivityTime = Date.now();
      const _rContent = (response?.message?.content || '');
      const _rThinking = (response?.message?.thinking || '');
      const _rTC = response?.message?.tool_calls?.length || 0;
      if (process.env.HAKSTER_DEBUG_AGENT === '1') {
        console.log(`[DEBUG] response: content_len=${_rContent.length} thinking_len=${_rThinking.length} tool_calls=${_rTC} content_preview=${JSON.stringify(_rContent.substring(0,100))} thinking_preview=${JSON.stringify(_rThinking.substring(0,100))}`);
      }
      // ── Estimate token usage for TUI display (rough: ~4 chars per token) ──
      const _inChars = history.reduce((sum, m) => sum + (m.content || '').length + (m.thinking || '').length + JSON.stringify(m.tool_calls || []).length, 0);
      _tuiTokensIn = Math.round(_inChars / 4);
      const _outTokEst = Math.round((_rContent.length + _rThinking.length) / 4);
      _tuiTokensOut += _outTokEst;
      // ── Session cumulative token & cost tracking ──
      _sessionTokensIn += _tuiTokensIn;
      _sessionTokensOut += _outTokEst;
      const _pricing = TOKEN_PRICING[MODEL] || TOKEN_PRICING['default'];
      _sessionCost += ((_tuiTokensIn / 1_000_000) * _pricing.in) + ((_outTokEst / 1_000_000) * _pricing.out);
    } catch (err) {
      // Retry API errors up to 2 times
      let lastErr = err;
      for (let retry = 0; retry < 2; retry++) {
        if (spinner) spinner.stop('');
        log(`${C.mustard}⚠ API error (attempt ${retry + 1}/2): ${err.message}${C.reset}`);
        await new Promise(r => setTimeout(r, 2000 * (retry + 1))); // backoff
        const retrySpinner = silent ? null : startSpinner('retrying...');
        try {
          response = await callOllama(history, TOOLS, { onToken: tokenCallback, lowToken: _lowToken });
          if (retrySpinner) retrySpinner.stop('');
          log(`${C.success}✓ API retry succeeded${C.reset}`);
          lastErr = null;
          break;
        } catch (retryErr) {
          if (retrySpinner) retrySpinner.stop('');
          lastErr = retryErr;
        }
      }
      if (lastErr) {
        if (spinner) spinner.stop(`${C.error}× API error after retries: ${lastErr.message}${C.reset}\n`);
        else log(`${C.error}× API error after retries: ${lastErr.message}${C.reset}`);
        break;
      }
    }
    if (spinner) spinner.stop('');

    let msg = response.message;
    if (!msg) {
      // Check if the response itself has an error
      if (response.error) {
        // If context limit exceeded, aggressively compact and retry once
        const errStr = String(response.error);
        if (errStr.includes('prompt too long') || errStr.includes('exceeded max context') || errStr.includes('context_length') || errStr.includes('token limit')) {
          log(`${C.mustard}⚠ Context limit hit — compacting history and retrying...${C.reset}`);
          // Force a deep compact: truncate all non-system messages to 200 chars
          for (let i = 1; i < history.length; i++) {
            const content = history[i].content || '';
            if (content.length > 200) {
              history[i] = { ...history[i], content: content.substring(0, 200) + '\n[trimmed for context]' };
            }
          }
          // Trim oldest non-system messages if still too large
          while (history.length > MIN_MESSAGES_TO_KEEP + 1 && estimateChars(history) > MAX_CONTEXT_CHARS * 0.5) {
            // Remove the oldest non-system message (index 1)
            history.splice(1, 1);
          }
          log(`${C.yellow}📦 Compacted to ${estimateChars(history).toLocaleString()} chars (${history.length} messages)${C.reset}`);
          // Retry with compacted history
          try {
            const retryResp = await callOllama(history, TOOLS, { onToken: tokenCallback, lowToken: _lowToken });
            if (retryResp.message) {
              response = retryResp;
              msg = response.message;
              log(`${C.success}✓ Retry after compact succeeded${C.reset}`);
              // Continue processing the response below
            } else {
              log(`${C.error}× Model error after compact+retry: ${retryResp.error || 'empty response'}${C.reset}`);
              break;
            }
          } catch (compactErr) {
            log(`${C.error}× Compact retry failed: ${compactErr.message}${C.reset}`);
            break;
          }
        } else {
          log(`${C.error}× Model error: ${response.error}${C.reset}`);
          break;
        }
      }
      // Empty response — could be a temporary glitch, retry up to 2 times
      log(`${C.mustard}⚠ Empty response from model, retrying...${C.reset}`);
      let retried = false;
      for (let retry = 0; retry < 2; retry++) {
        try {
          const retryResp = await callOllama(history, TOOLS, { onToken: tokenCallback, lowToken: _lowToken });
          if (retryResp.message) {
            // Success on retry — process normally below
            response = retryResp;
            retried = true;
            log(`${C.success}✓ Retry succeeded${C.reset}`);
            break;
          } else if (retryResp.error) {
            log(`${C.error}× Model error: ${retryResp.error}${C.reset}`);
            break;
          }
        } catch (retryErr) {
          log(`${C.mustard}⚠ Retry ${retry + 1} failed: ${retryErr.message}${C.reset}`);
        }
      }
      if (!retried && !response?.error && !response?.message) {
        log(`${C.error}× No response from model after retries${C.reset}`);
        break;
      }
      if (!response?.message) break;
    }
    // Re-extract msg in case response was reassigned by retry
    msg = response.message;

    // Show thinking if present (full display — thinking is important!)
    if (msg.thinking) {
      if (!_tuiThinkingStart) _tuiThinkingStart = Date.now();
      // ── Extract key insights from thinking for REASONING panel ──
      _extractInsights(msg.thinking, turn + 1);
      // ── TUI dashboard: render full dashboard with thinking panel ──
      const thinkPanel = renderThinkingPanel(msg.thinking);
      if (!silent) {
        const dashParts = [];
        if (_tuiPhase !== 'Idle') dashParts.push(renderReasoningPanel());
        if (thinkPanel) dashParts.push(thinkPanel);
        if (_tuiToolGrid.length > 0) dashParts.push(renderToolPanel());
        if (_tuiChains.length > 0) dashParts.push(renderChainPanel());
        if (dashParts.length > 0) _writePanel('DASHBOARD', dashParts.join('\n'));
      } else {
        // Fallback for silent mode or if panel is empty
        // BUG 17 FIX: Strip hallucinated TUI lines from fallback display too
        const cleanedThink = _stripFakeTui(msg.thinking);
        if (cleanedThink) {
          const thinkLines = cleanedThink.split('\n');
          log(`\n${C.bold}${C.secondary}◇ Thinking:${C.reset}`);
          for (const line of thinkLines) {
            log(`${C.fgMuted}${line}${C.reset}`);
          }
          log('');
        }
      }
    }

    // Show text content — strip fake TUI chrome that the model sometimes generates
    // Compute cleanContent BEFORE the if-block so it's available for history.push below
    // BUG 17 FIX: Use _stripFakeTui() for the common TUI-chrome patterns, then strip box-drawing
    let cleanContent = _stripFakeTui(msg.content || '')
      .replace(/^[\s]*──\s*(?:Step|Phase)\s+\d+.*$/gim, '')
      .replace(/^║\s*(?:undefined\s+)?(?:REASONING|THINKING|TOOL\s*GRID|CHAIN\s*TABLE|OUTPUT|PROGRESS|STATUS|STEP|PHASE|VULN|EXPLOIT|SCAN|TARGET)[^║]*║\s*$/gim, '')
      .replace(/^[║│]\s*.{1,80}?\s*[║│]\s*$/gm, (m) => {
        const inner = m.replace(/^[║│]\s*/, '').replace(/\s*[║│]\s*$/, '');
        if (/^[├└┌│]/.test(inner) || inner.length > 70) return m;
        return '';
      })
      .replace(/^[│┃┆┇┊╎╏║┗┛┘└┌┐┍▌▎┑▒─═├┝┞┟┠┡┢┬┭┮┯┰┤┥┦┧┨┩╄╅┆┇┈╉┊╪╫╬╠╣╔╗╚╝╤╥╧╨╳\s]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n').trim();
    if (msg.content && msg.content.trim()) {
      // cleanContent was already computed above (hoisted) — use it for display
      if (cleanContent) {
        log(`\n${C.white}${cleanContent}${C.reset}\n`);
      }
    }

    // ── Empty response recovery ──
    // If model returns no tool calls AND empty/whitespace content, it likely failed
    // to generate a proper response (confused context, too much history, etc.)
    // Retry up to 2 times with a nudge message instead of immediately giving up.
    const EMPTY_RETRY_LIMIT = 2;
    const hasContent = cleanContent && cleanContent.trim().length > 0;
    const hasThinking = msg.thinking && msg.thinking.trim().length > 0;
    // Also handle: model returns tool_calls but NO content and NO thinking
    // This is the stuck-loop pattern — model calls tools blindly without reasoning
    if (msg.tool_calls && msg.tool_calls.length > 0 && !hasContent && !hasThinking && _emptyRetries < EMPTY_RETRY_LIMIT) {
      _emptyRetries++;
      log(`${C.mustard}⚠  Model returned tool_calls with no content/thinking (stuck-loop pattern, retry ${_emptyRetries}/${EMPTY_RETRY_LIMIT}). Compacting and retrying...${C.reset}`);
      compactHistory(history, _lowToken);
      // Don't save this empty tool-call turn — just retry with a nudge
      history.push({ role: 'system', content: 'CRITICAL: You MUST include text content (explanation or reasoning) with every response. Do NOT call tools without explaining what you are doing. Respond with substantive text content, then call tools if needed. Never return empty content.' });
      history.push({ role: 'user', content: userMessage });
      continue; // retry
    }
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      if (!hasContent && !hasThinking && _emptyRetries < EMPTY_RETRY_LIMIT) {
        _emptyRetries++;
        log(`${C.mustard}⚠  Model returned empty response (retry ${_emptyRetries}/${EMPTY_RETRY_LIMIT}). Compacting history and retrying...${C.reset}`);
        // Compact history aggressively before retry
        compactHistory(history, _lowToken);
        // Remove the empty assistant entry we just pushed
        if (history.length > 0 && history[history.length - 1].role === 'assistant' && !(history[history.length - 1].content || '').trim()) {
          history.pop();
          // Also remove the user message that triggered it since we'll re-send
          if (history.length > 0 && history[history.length - 1].role === 'user') {
            history.pop();
          }
        }
        // Inject nudge and re-queue the user's message
        history.push({ role: 'system', content: 'IMPORTANT: Your last response was empty. You MUST respond with either a tool call or substantive text. Do not output empty content. If you have information to share, share it. If you need to act, call a tool.' });
        history.push({ role: 'user', content: userMessage });
        continue; // retry the loop
      }
      // After retries exhausted, still empty — fall through to normal exit logic
    }

    // No tool calls = done (or empty response after retries exhausted)
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // BUG FIX: Don't push empty assistant messages to history — they confuse the model on reload
      const hasContentToSave = (cleanContent && cleanContent.trim().length > 0) || (msg.thinking && msg.thinking.trim().length > 0);
      if (hasContentToSave) {
        // Push CLEANED content to history — strips hallucinated TUI chrome (⏳ Queued, box-drawing, etc.)
        // so the model doesn't see its own fake status lines in context and loop on them
        // BUG 17 FIX: Use _stripFakeTui() helper instead of inline regex chain
        const cleanThinkingNoTool = _stripFakeTui(msg.thinking || '');
        history.push({ role: 'assistant', content: cleanContent || '', ...(cleanThinkingNoTool ? { thinking: cleanThinkingNoTool } : {}) });
      }
      lastHadToolCalls = false;

      // ── Stuck-loop detection ──
      // 1. Exact match: model gives the same response twice in a row
      // 2. No-progress: model responds N times without making any tool calls
      // 3. Semantic loop: model keeps asking similar questions (prefix overlap)
      //    even if it makes trivial tool calls between them
      // Check BOTH start and end of content for clarifying patterns —
      // thinking/reasoning often pushes the actual question to the end
      const responseText = (msg.content || '').trim();
      const responseHead = responseText.substring(0, 500);
      const responseTail = responseText.length > 200 ? responseText.substring(responseText.length - 500) : '';
      const responseAll = responseHead + '\n' + responseTail;
      _noProgressCount++;

      // Track response prefix for semantic loop detection
      const normPrefix = _normalizeForLoopCheck(responseHead).substring(0, 80);
      if (normPrefix && normPrefix.length >= 10) {
        _recentResponsePrefixes.push(normPrefix);
        if (_recentResponsePrefixes.length > SEMANTIC_LOOP_WINDOW) {
          _recentResponsePrefixes.shift();
        }
      }

      // Detect clarifying-question loops even in no-tool-call path
      // Check combined head+tail so patterns hidden after long thinking text are caught
      const isClarifyingNoTool = _noProgressCount >= 3 && _isClarifyingQuestion(responseAll);
      const clarifyingLoopNoTool = _recentResponsePrefixes.filter(p => _isClarifyingQuestion(p)).length >= 3;

      const isRepeated = responseHead && responseHead === _lastAssistantResponse;
      const isStalled = _noProgressCount >= NO_PROGRESS_LIMIT;
      const isSemanticLoop = normPrefix && normPrefix.length >= 10 && _semanticLoopCount(responseAll) >= SEMANTIC_LOOP_THRESHOLD;
      if (isRepeated || isStalled || isSemanticLoop || isClarifyingNoTool || clarifyingLoopNoTool) {
        let reason;
        if (isRepeated) reason = 'model repeated itself';
        else if (isSemanticLoop) reason = `semantic loop detected (${_semanticLoopCount(responseAll)} similar responses)`;
        else if (isClarifyingNoTool) reason = 'clarifying question detected (no tool calls — breaking)';
        else if (clarifyingLoopNoTool) reason = `clarifying-question loop (${_recentResponsePrefixes.filter(p => _isClarifyingQuestion(p)).length} clarifying responses)`;
        else reason = `${_noProgressCount} turns with no tool calls (likely semantic loop)`;
        log(`\n${C.mustard}${C.bold}⚠  Stuck-loop detected: ${reason}. Breaking loop.${C.reset} ${C.bgSubtle}${T.hashFill(20, C.mustard)}${C.reset}`);
        log(`${C.dim}   (Clearing stale queued messages too)${C.reset}\n`);
        _lastAssistantResponse = '';
        _noProgressCount = 0;
        _explorationCalls = [];   // Reset wandering detection on any loop break
        // BUG 16 FIX: Save prefix count BEFORE resetting so trim uses the real count
        const savedPrefixCount = _recentResponsePrefixes.length;
        _recentResponsePrefixes = [];
        // Drain stale queued messages that would just trigger the same loop
        const drained = _messageQueue.length;
        _messageQueue.length = 0;
        // BUG 16 FIX: Cooldown = max(3, drained) so we skip all re-queued messages (was always 3)
        _stuckCooldown = Math.max(3, drained);
        // Also cancel any in-progress paste batch
        if (_batch?.timer) clearTimeout(_batch.timer);
        _batch = null;
        if (drained > 0) {
          log(`${C.dim}   (${drained} queued message(s) cleared)${C.reset}`);
        }
        // Trim last N assistant+user pairs from history to remove loop context
        // so the model doesn't re-enter the same loop on the next prompt
        // BUG 16 FIX: use savedPrefixCount (not _recentResponsePrefixes.length which is 0)
        let trimCount = Math.min(savedPrefixCount + 1, 10);  // remove loop turns (max 10, was 5)
        while (trimCount > 0 && history.length > 2) {
          const last = history[history.length - 1];
          if (last.role === 'assistant') { history.pop(); trimCount--; }
          else if (last.role === 'user') { history.pop(); }  // also remove the user prompt that triggered it
          else break;
        }
        // BUG 17 FIX: Inject a system message to prevent re-asking the same question
        history.push({ role: 'system', content: 'LOOP BREAK: You were in a stuck loop. IMMEDIATELY do one of: (1) Take a concrete action using a non-exploration tool (shell, write_file, etc.) with the information you already have. (2) Give the user a direct answer based on what you know. Do NOT ask another question. Do NOT list or search more directories. Do NOT call list_dir, search_files, or read_file. ACT NOW or RESPOND NOW.' });
      } else {
        _lastAssistantResponse = responseText;
      }

      // ── TUI dashboard: final render at normal exit ──
      if (!silent) {
        tuiSetPhase('CONSOLIDATE');
        _agentActivity = 'Idle'; _activityDetail = '';
        if (_stallGuardTimer) { clearInterval(_stallGuardTimer); _stallGuardTimer = null; }
        if (_statusBarInterval) { clearInterval(_statusBarInterval); _statusBarInterval = null; }
        process.stdout.write('\r' + ' '.repeat(80) + '\r');  // clear status bar line
        const dashParts = [];
        const reasonPanel = renderReasoningPanel();
        if (reasonPanel) dashParts.push(reasonPanel);
        if (_tuiToolGrid.length > 0) dashParts.push(renderToolPanel());
        if (_tuiChains.length > 0) dashParts.push(renderChainPanel());
        if (dashParts.length > 0) _writePanel('DASHBOARD', dashParts.join('\n'));
      }
      break;
    }

    // Tool calls in progress — mark so next turn skips compact
    lastHadToolCalls = true;

    // ── Smart no-progress tracking ──
    // Only reset (not just decrement) the counter when tool calls produce
    // substantial, non-error output. Trivial/failed tool calls don't count
    // as progress — the agent can loop by alternating questions with
    // failed tool calls and never hit the limit.
    // Check BOTH start and end of content for clarifying patterns —
    // thinking/reasoning often pushes the actual question to the end
    const toolResponseText = (msg.content || '').trim();
    const toolResponseHead = toolResponseText.substring(0, 500);
    const toolResponseTail = toolResponseText.length > 200 ? toolResponseText.substring(toolResponseText.length - 500) : '';
    const toolResponseAll = toolResponseHead + '\n' + toolResponseTail;

    // Check if the text portion of this response is a clarifying question
    // (agent asking for confirmation/details instead of doing the task)
    const isClarifying = _isClarifyingQuestion(toolResponseAll);

    if (isClarifying) {
      // Clarifying question WITH tool calls = agent is still stuck, just
      // making trivial calls. Count as no progress to trigger stuck-loop.
      _noProgressCount++;
    } else {
      // Real tool calls without a clarifying question = genuine progress
      // BUT: if ALL tool calls are exploration tools (list_dir, search_files, read_file),
      // it's likely filesystem wandering — increment noProgressCount so the stuck-loop
      // detector catches it even if the filesystem-wandering detector doesn't trigger first
      const allExploration = msg.tool_calls && msg.tool_calls.every(tc => {
        const name = tc.function?.name || tc.name || '';
        return EXPLORATION_TOOLS.has(name);
      });
      if (allExploration) {
        // Exploration-only turns = not real progress, count toward stuck detection
        _noProgressCount++;
      } else {
        _noProgressCount = 0;
      }
    }

    // ── Semantic loop detection even during tool calls ──
    // The model can make trivial tool calls (like listing files) and then
    // ask the same question again. Track response prefix similarity here too.
    const toolNormPrefix = _normalizeForLoopCheck(toolResponseHead).substring(0, 80);
    if (toolNormPrefix && toolNormPrefix.length >= 10) {
      _recentResponsePrefixes.push(toolNormPrefix);
      if (_recentResponsePrefixes.length > SEMANTIC_LOOP_WINDOW) {
        _recentResponsePrefixes.shift();
      }
    }
    const toolSemanticLoop = toolNormPrefix && toolNormPrefix.length >= 10 && _semanticLoopCount(toolResponseAll) >= SEMANTIC_LOOP_THRESHOLD;
    // Also detect clarifying-question loops: if agent asks clarifying
    // questions 2+ times (even with rephrasing), break the loop
    // (Lowered from 3 — agent rephrases so 2 is enough to detect stuck)
    // But require >= 3 to avoid false positives on reasonable clarification
    const clarifyingLoopCount = _recentResponsePrefixes.filter(p => _isClarifyingQuestion(p)).length;
    const isClarifyingLoop = clarifyingLoopCount >= 3;
    // ── PROGRESS GATE: don't break legitimate sequential rounds/todos ──
    // The semantic + clarifying detectors fire at count 3, which false-positives
    // on steady sequential work (working through a todo list / pentest rounds
    // where each step produces a similarly-shaped response). Only break when the
    // agent has actually stalled — i.e. _noProgressCount > 0 (a clarifying or
    // exploration-only turn). Real non-exploration tool calls keep _noProgressCount
    // at 0, so sequential rounds flow straight through.
    const _progressGate = _noProgressCount > 0;
    // Tighten: an EXACT repeated response head across the prefix window is a hard loop,
    // even if _noProgressCount is 0 (real tool calls can still repeat the same preamble).
    const _exactRepeatCount = toolNormPrefix && toolNormPrefix.length >= 10
      ? _recentResponsePrefixes.filter(p => p === toolNormPrefix).length
      : 0;
    const _hardRepeat = _exactRepeatCount >= 2;  // same preamble seen 2+ times in window
    const _toolSemanticBreak = (toolSemanticLoop || _hardRepeat) && _progressGate;
    const _clarifyingBreak = (isClarifyingLoop || _hardRepeat) && _progressGate;
    // ── Grep/search loop detection in tool-call path ──
    const grepLoopCount = _recentShellCommands.filter(c => c.tool === 'grep' || c.tool === 'find').length;
    const isGrepLoop = grepLoopCount >= GREP_LOOP_LIMIT;
    if (isGrepLoop) {
      log('\n' + C.yellow + C.bold + '⚠️  Grep/search loop detected: ' + grepLoopCount + ' search commands without progress. Breaking loop.' + C.reset);
      _recentShellCommands = [];
      _noProgressCount = 0;
      _explorationCalls = [];
      _recentResponsePrefixes = [];
      _stuckCooldown = Math.max(3, _messageQueue.length);
      const drainedGrep = _messageQueue.length;
      _messageQueue.length = 0;
      if (_batch?.timer) clearTimeout(_batch.timer);
      _batch = null;
      if (drainedGrep > 0) log(C.dim + '   (' + drainedGrep + ' queued message(s) cleared)' + C.reset);
      // Inject hard nudge to break the loop
      history.push({ role: 'system', content: 'SEARCH LOOP BREAK: You have been running too many grep/find/search commands without making progress. STOP searching. You already have enough information. Do one of: (1) Write or edit the file. (2) Run a concrete fix command. (3) Give the user a direct answer. Do NOT run any more search commands.' });
      // Trim recent history to remove search context
      let grepTrim = Math.min(grepLoopCount + 2, 8);
      while (grepTrim > 0 && history.length > 4) {
        const last = history[history.length - 1];
        if (last.role === 'assistant' || last.role === 'tool') { history.pop(); grepTrim--; }
        else if (last.role === 'user') { history.pop(); }
        else break;
      }
    }

    // ── Generic shell repeat-loop break (ALL shell commands, not just grep/find) ──
    // The shell executor sets _shellRepeatBreak when the same normalized command was
    // about to fire a 3rd+ time. Do the full break here (trim/cooldown/drain) so the
    // loop doesn't stall re-running the command.
    if (_shellRepeatBreak) {
      log(`\n${C.red}${C.bold}🔴 Shell repeat-loop detected: same shell command re-run without progress. Breaking loop.${C.reset}`);
      _shellRepeatBreak = false;
      _recentShellCommands = [];
      _noProgressCount = 0;
      _explorationCalls = [];
      _recentResponsePrefixes = [];
      _stuckCooldown = Math.max(3, _messageQueue.length);
      const drainedShell = _messageQueue.length;
      _messageQueue.length = 0;
      if (_batch?.timer) clearTimeout(_batch.timer);
      _batch = null;
      if (drainedShell > 0) log(`${C.dim}   (${drainedShell} queued message(s) cleared)${C.reset}`);
      history.push({ role: 'system', content: 'SHELL REPEAT-LOOP BREAK: You re-ran the same shell command multiple times without making progress. The command was skipped. You already have its output from the first run. STOP repeating commands. Do one of: (1) Edit or write a file. (2) Run a DIFFERENT command. (3) Give the user a direct answer. Do NOT re-run the same command.' });
      let shellTrim = 3;
      while (shellTrim > 0 && history.length > 4) {
        const last = history[history.length - 1];
        if (last.role === 'assistant' || last.role === 'tool') { history.pop(); shellTrim--; }
        else if (last.role === 'user') { history.pop(); }
        else break;
      }
    }

    // CRITICAL FIX: also check noProgress in the tool-call path
    // Previously _noProgressCount was only checked in the no-tool path,
    // so the agent could loop indefinitely alternating trivial tool calls
    // with clarifying questions and never hit the stuck-loop break.
    const isToolStalled = _noProgressCount >= NO_PROGRESS_LIMIT;

    if (_toolSemanticBreak || _clarifyingBreak || isToolStalled) {
      let reason;
      if (_toolSemanticBreak) reason = `semantic loop detected (${_semanticLoopCount(toolResponseAll)} similar responses, even with tool calls)`;
      else if (_clarifyingBreak) reason = `clarifying-question loop detected (${clarifyingLoopCount} clarifying responses)`;
      else reason = `${_noProgressCount} turns without real progress (tool-call path)`;
      log(`\n${C.yellow}${C.bold}⚠️  Stuck-loop detected: ${reason}. Breaking loop.${C.reset}`);
      log(`${C.dim}   (Clearing stale queued messages too)${C.reset}\n`);
      _lastAssistantResponse = '';
      _noProgressCount = 0;
      _explorationCalls = [];   // Reset wandering detection on any loop break
      // BUG 16 FIX: Save prefix count BEFORE resetting so trim uses the real count
      const savedPrefixCount2 = _recentResponsePrefixes.length;
      _recentResponsePrefixes = [];
      // Drain stale queued messages that would just trigger the same loop
      const drained2 = _messageQueue.length;
      _messageQueue.length = 0;
      // BUG 16 FIX: Cooldown = max(3, drained) so we skip all re-queued messages (was always 3)
      _stuckCooldown = Math.max(3, drained2);
      if (_batch?.timer) clearTimeout(_batch.timer);
      _batch = null;
      if (drained2 > 0) {
        log(`${C.dim}   (${drained2} queued message(s) cleared)${C.reset}`);
      }
      // Trim last N assistant+user pairs from history to remove loop context
      // BUG 16 FIX: use savedPrefixCount2 (not _recentResponsePrefixes.length which is 0)
      let trimCount2 = Math.min(savedPrefixCount2 + 1, 10);  // remove loop turns (max 10, was 5)
      while (trimCount2 > 0 && history.length > 2) {
        const last = history[history.length - 1];
        if (last.role === 'assistant') { history.pop(); trimCount2--; }
        else if (last.role === 'user') { history.pop(); }  // also remove the user prompt that triggered it
        else break;
      }
      // BUG 17 FIX: Inject a system message to prevent re-asking the same question
      history.push({ role: 'system', content: 'LOOP BREAK: You were in a stuck loop. IMMEDIATELY do one of: (1) Take a concrete action using a non-exploration tool (shell, write_file, etc.) with the information you already have. (2) Give the user a direct answer based on what you know. Do NOT ask another question. Do NOT list or search more directories. Do NOT call list_dir, search_files, or read_file. ACT NOW or RESPOND NOW.' });
      // Push CLEANED content before breaking — same fix as no-tool-call path
      // BUG FIX: Don't push empty assistant messages
      const _hasLoopContent = (cleanContent && cleanContent.trim().length > 0) || (msg.thinking && msg.thinking.trim().length > 0);
      if (_hasLoopContent) {
        // BUG 17 FIX: Use _stripFakeTui() helper
        const cleanThinking = _stripFakeTui(msg.thinking || '');
        history.push({ role: 'assistant', content: cleanContent || '', ...(cleanThinking ? { thinking: cleanThinking } : {}) });
      }
      break;
    }

    // Process tool calls
    const stepNum = turn + 1;
    // 6-phase: PLAN before executing tools
    tuiSetPhase('PLAN');
    // ── TUI dashboard: render ALL panels at each step (in-place scroll) ──
    if (!silent) {
      const dashParts = [];
      if (_tuiPhase !== 'Idle') dashParts.push(renderReasoningPanel());
      if (_tuiToolGrid.length > 0) dashParts.push(renderToolPanel());
      if (_tuiChains.length > 0) dashParts.push(renderChainPanel());
      if (dashParts.length > 0) _writePanel('DASHBOARD', dashParts.join('\n'));
      log(`${C.magenta}${T.thick.repeat(3)}${C.reset} ${C.magenta}Step ${stepNum}/${_maxTurns}${C.reset} ${C.magenta}${T.thick.repeat(3)}${C.reset}`);
    }
    tuiSetPhase('ACT');
    _agentActivity = 'Executing'; _activityDetail = `Step ${turn + 1}`; _lastActivityTime = Date.now();
    // BUG 16 FIX: strip fake queue/TUI lines from thinking to prevent re-looping
    // BUG 17 FIX: Use _stripFakeTui() helper for tool-call path thinking
    const cleanThinkingTool = _stripFakeTui(msg.thinking || '');
    history.push({
      role: 'assistant',
      content: cleanContent || '',
      ...(cleanThinkingTool ? { thinking: cleanThinkingTool } : {}),
      tool_calls: msg.tool_calls,
    });

    // ── Track pending tools for status bar ──
    _pendingTools = (msg.tool_calls || []).map(tc => ({ name: tc.function?.name || tc.name || 'unknown', id: tc.id || String(_toolCallCount) }));

    for (const tc of msg.tool_calls) {
      _toolCallCount++;
      const fnName = tc.function?.name || tc.name;
      // CRITICAL: Ollama models (e.g. glm-5.2:cloud) return tool_call arguments as a
      // JSON STRING, not a parsed object. If we pass the string straight to the
      // executor, destructuring ({action, url, ...}) yields undefined for every
      // field and every parameterized tool fails ("scrape requires url", "Error
      // navigating to undefined", etc.). Parse to an object here, once.
      let fnArgs = tc.function?.arguments || tc.arguments || {};
      if (typeof fnArgs === 'string') {
        try { fnArgs = JSON.parse(fnArgs); } catch (_) { fnArgs = {}; }
      }
      if (!fnArgs || typeof fnArgs !== 'object' || Array.isArray(fnArgs)) fnArgs = {};
      const tcId = tc.id || tc.function?.index?.toString() || '0';
      const callNum = _toolCallCount;

      // Build a short arg hint for display (e.g., "path=/foo" or "cmd:ls")
      let argHint = '';
      try {
        const args = typeof fnArgs === 'string' ? JSON.parse(fnArgs) : fnArgs;
        if (args) {
          // Pick the most useful arg for context
          const hintKey = args.path || args.file || args.command || args.url || args.query || args.target || args.pattern || args.mode || '';
          if (hintKey) {
            argHint = String(hintKey).substring(0, 40);
          } else {
            // Fallback: first value from args
            const firstVal = Object.values(args).find(v => typeof v === 'string' && v.length > 0);
            if (firstVal) argHint = String(firstVal).substring(0, 40);
          }
        }
      } catch (_) {}

      _agentActivity = fnName === 'patch_file' || fnName === 'multi_patch' ? 'Patching' : fnName === 'shell' ? 'Executing' : fnName === 'read_file' ? 'Reading' : fnName === 'write_file' ? 'Writing' : 'Executing';
      _activityDetail = argHint || fnName;
      _lastActivityTime = Date.now();

      // ── Filesystem-wandering loop detection ──
      // Check BEFORE execution so we can break the loop early
      let parsedArgs = fnArgs;
      try { if (typeof fnArgs === 'string') parsedArgs = JSON.parse(fnArgs); } catch(_) {}
      const isWandering = _checkFilesystemWandering(fnName, parsedArgs || {});
      // ── Generic repeat-tool-call guard (all tools, not just shell/exploration) ──
      // Catches agents that re-invoke the same tool with the same args while varying
      // the surrounding text — a loop shape the shell/exploration detectors miss.
      try {
        const _toolSig = fnName + ':' + JSON.stringify(parsedArgs || {}).slice(0, 200);
        if (!_recentToolSigs) _recentToolSigs = [];
        if (_recentToolSigs.length && _recentToolSigs[_recentToolSigs.length - 1] === _toolSig) {
          _repeatToolSigCount = (_repeatToolSigCount || 0) + 1;
        } else {
          _repeatToolSigCount = 0;
        }
        _recentToolSigs.push(_toolSig);
        if (_recentToolSigs.length > 8) _recentToolSigs.shift();
        if (_repeatToolSigCount >= TOOL_REPEAT_LIMIT) {
          log(`\n${C.red}${C.bold}🔁 Tool repeat-loop detected: "${fnName}" called ${_repeatToolSigCount + 1}x with identical args. Breaking loop.${C.reset}`);
          _repeatToolSigCount = 0;
          _recentToolSigs = [];
          _noProgressCount = 0;
          _explorationCalls = [];
          _recentResponsePrefixes = [];
          _stuckCooldown = Math.max(3, _messageQueue.length);
          const _drainedTool = _messageQueue.length;
          _messageQueue.length = 0;
          if (_batch?.timer) clearTimeout(_batch.timer);
          _batch = null;
          if (_drainedTool > 0) log(`${C.dim}   (${_drainedTool} queued message(s) cleared)${C.reset}`);
          history.push({ role: 'system', content: `TOOL REPEAT-LOOP BREAK: You called ${fnName} multiple times with identical arguments. You already have its result. STOP repeating the same tool call. Use the result you already have: edit a file, run a DIFFERENT command/tool, or answer the user. Do NOT call ${fnName} again with the same arguments.` });
          let _toolRepTrim = 3;
          while (_toolRepTrim > 0 && history.length > 4) {
            const _l = history[history.length - 1];
            if (_l.role === 'assistant' || _l.role === 'tool') { history.pop(); _toolRepTrim--; }
            else if (_l.role === 'user') { history.pop(); }
            else break;
          }
        }
      } catch (_) { /* non-blocking */ }
      if (isWandering) {
        const wanderCallCount = _explorationCalls.length;
        log(`\n${C.yellow}${C.bold}⚠️  Filesystem-wandering loop detected: ${wanderCallCount} calls exploring same subtree without convergence. Breaking loop.${C.reset} ${C.bgSubtle}${T.hashFill(15, C.yellow)}${C.reset}`);
        log(`${C.dim}   (Trimming history, draining queue, injecting course correction)${C.reset}\n`);
        _explorationCalls = [];
        _noProgressCount = 0;
        _recentResponsePrefixes = [];
        // Inject a hard nudge: tell model EXACTLY what to do
        history.push({ role: 'system', content: 'WANDERING LOOP BREAK: You browsed the filesystem in circles. STOP calling list_dir, search_files, or read_file. You already have enough information. Do one of: (1) Run a shell command to do the task. (2) Write/edit a file. (3) Give the user a direct text answer. Do NOT explore any more directories. ACT NOW.' });
        // Trim wandering turns from history (up to 10, same as stuck-loop trim)
        let wanderTrim = Math.min(wanderCallCount + 2, 10);
        while (wanderTrim > 0 && history.length > 4) {
          const last = history[history.length - 1];
          if (last.role === 'assistant' || last.role === 'tool') { history.pop(); wanderTrim--; }
          else if (last.role === 'user') { history.pop(); }
          else break;
        }
        // Drain stale queued messages to prevent re-triggering the same loop
        const wanderDrained = _messageQueue.length;
        _messageQueue.length = 0;
        _stuckCooldown = Math.max(3, wanderDrained);
        if (_batch?.timer) clearTimeout(_batch.timer);
        _batch = null;
        if (wanderDrained > 0) {
          log(`${C.dim}   (${wanderDrained} queued message(s) cleared)${C.reset}`);
        }
        // Don't execute this tool call — skip it
        history.push({ role: 'tool', name: fnName, content: 'Loop break: filesystem exploration was going in circles. Stop listing/searching directories and use what you know. Take a concrete action now.' });
        tuiAddChain(`#${callNum} ${fnName} → LOOP-BREAK`, '🔄');
        continue;
      }

      // ── TUI dashboard: add chain entry with arg hint ──
      const chainLabel = argHint ? `#${callNum} ${fnName} → ${argHint}` : `#${callNum} ${fnName}`;
      tuiAddChain(chainLabel, toolEmoji(fnName));

      const emoji = toolEmoji(fnName);
      // ── TUI dashboard: mark tool as running ──
      tuiToolStart(emoji, argHint ? `#${callNum} ${fnName} → ${argHint}` : `#${callNum} ${fnName}`);
      log(`${C.cyan}${T.arrow} ${emoji} ${C.bold}#${callNum}${C.reset} ${C.cyan}${fnName}${C.reset} ${C.fgSubtle}${T.thin.repeat(3)}${C.reset} ${C.gray}${JSON.stringify(fnArgs).substring(0, 120)}${C.reset}`);
      _recordAction(emoji, `#${callNum} ${fnName} ${argHint ? '→ ' + argHint.substring(0, 60) : ''}`);
      if (_statusFn) _statusFn(`${emoji} #${callNum} ${fnName}`);

      // ── Idle review safety: block ANY tool that modifies state ──
      if (silent && !isReadOnlyTool(fnName, fnArgs)) {
        log(`${C.yellow}🔒 Blocked ${fnName} during idle review (read-only mode)${C.reset}`);
        history.push({ role: 'tool', name: fnName, content: 'Blocked: idle review is read-only. Only read-only tools and safe shell commands are allowed.' });
        continue;
      }

      // ── Dangerous command confirmation ──
      const dangerReason = isDangerousCommand(fnName, fnArgs);
      if (dangerReason && shouldConfirm(_approvalMode, fnName, fnArgs, dangerReason) && !_localAllowlisted(fnName, fnArgs)) {
        log(`${C.yellow}${C.bold}⚠️ DANGEROUS: ${dangerReason}${C.reset}`);
        if (_confirmFn) {
          const decision = await _confirmFn(dangerReason, fnName, fnArgs);  // true | 'allowlist' | false
          if (!decision) {
            log(`${C.red}🚫 Denied by user${C.reset}`);
            history.push({ role: 'tool', name: fnName, content: 'User denied this dangerous operation.' });
            continue;
          }
          if (decision === 'allowlist') {
            _localAllowlist.add(_cmdSig(fnName, fnArgs));
            log(`${C.green}✅ Approved & allowlisted for this session${C.reset}`);
          } else {
            log(`${C.green}✅ Approved${C.reset}`);
          }
        } else {
          // No confirmation function available (module mode) — block by default
          log(`${C.red}🚫 Blocked (no confirmation available in module mode)${C.reset}`);
          history.push({ role: 'tool', name: fnName, content: 'Blocked: dangerous operation requires user confirmation.' });
          continue;
        }
      }

      // Execute tool (with nudge timer for shell commands)
      let result;
      let nudgeInterval = null;
      const isSlowTool = ['shell', 'parallel_shell', 'sub_agent', 'crush'].includes(fnName);
      if (isSlowTool && _statusFn) {
        // Live elapsed-time nudge while shell commands run
        const startTime = Date.now();
        const nudgeEmoji = fnName === 'shell' ? '🖥️' : fnName === 'parallel_shell' ? '⚡' : '🤖';
        nudgeInterval = setInterval(() => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          _statusFn(`${nudgeEmoji} ${fnName} → ${elapsed}s`);
        }, Math.round(500 / SCROLL_SPEED));
      }
      try {
        const executor = toolExecutors[fnName];
        if (!executor) {
          // Fallback: try MCP tool
          if (isMcpTool(fnName)) {
            result = await callMcpTool(fnName, fnArgs);
          } else {
            result = `❌ Error: Unknown tool "${fnName}"`;
          }
        } else {
          result = await (typeof executor === 'function' ? executor(fnArgs) : executor(fnArgs));
          if (result === undefined) result = '(no output)';
        }
      } catch (err) {
        result = `Error: ${err.message}`;
      } finally {
        if (nudgeInterval) { clearInterval(nudgeInterval); nudgeInterval = null; }
      }

      // ── Update live output stream for TUI grid ──
      if (_tuiCurrentTool === fnName.split(' → ')[0] || _tuiCurrentTool === fnName) {
        _tuiCurrentOutput = String(result).substring(0, 500);
      }

      // Show result (truncated) with HTTP status highlighting
      const isErr = String(result).startsWith('Error:');
      const resultEmoji = isErr ? '❌' : '✅';

      // ── Tool-error loop detection ──
      // If the SAME tool errors 3+ times in a row, it's likely a code bug
      // (like ReferenceError) causing an infinite retry loop — break out.
      if (isErr) {
        const existing = _consecutiveToolErrors.find(e => e.name === fnName);
        if (existing) {
          existing.count++;
        } else {
          _consecutiveToolErrors = [{ name: fnName, count: 1 }];
        }
        if (existing && existing.count + 1 >= TOOL_ERROR_LOOP_LIMIT) {
          log(`\n${C.red}${C.bold}🚨 Tool-error loop detected: "${fnName}" failed ${existing.count + 1} times in a row. Breaking loop.${C.reset}`);
          log(`${C.dim}   (Error: ${String(result).substring(0, 100)})${C.reset}\n`);
          history.push({ role: 'tool', name: fnName, content: `Error loop detected: "${fnName}" failed ${existing.count + 1} times consecutively. Stopping retries. Last error: ${String(result).substring(0, 200)}` });
          _consecutiveToolErrors = [];
          _noProgressCount = 0;
          _explorationCalls = [];   // Reset wandering detection on error loop break
          _recentResponsePrefixes = [];
          _stuckCooldown = 3;
          // Don't continue processing more tool calls — break out of this turn
          break;
        }
      } else {
        // Tool succeeded — reset consecutive error tracking
        _consecutiveToolErrors = [];

        // ── Auto-learn: CONSOLIDATE phase ──
        if (shouldConsolidate(_toolCallCount)) {
          try {
            await autolearn.consolidateMemories(path.join(process.env.HOME || '/home/ghost', '.hakster'));
          } catch (e) { /* non-blocking */ }

          // ── Memory Engine v2: consolidate + extract entities ──
          try {
            const hDir = path.join(process.env.HOME || '/home/ghost', '.hakster');
            memoryEngine.consolidate(hDir);
          } catch (e) { /* non-blocking */ }
        }

        // ── Memory Engine v2: record tool result as memory ──
        try {
          const toolName = (result && result.name) || fnName || 'unknown';
          const toolContent = typeof (result && result.content) === 'string'
            ? result.content.substring(0, 500)
            : JSON.stringify(result).substring(0, 500);
          memoryEngine.addMemory({
            type: 'observation',
            observation: `[${toolName}] ${toolContent}`,
            context: { source: 'tool', tool: toolName },
            tags: [toolName, 'tool-result'],
            timestamp: new Date().toISOString()
          }, process.cwd());
        } catch (e) { /* non-blocking */ }

        // ── Auto-learn: REFLECT phase ──
        if (shouldReflect(_noProgressCount, _recentResponsePrefixes)) {
          tuiSetPhase('REFLECT');
          const reflection = injectLearnedLessons(process.cwd(), ['pentest', 'agent']);
          if (reflection) {
            history.push({ role: 'system', content: '🔄 Reflection: ' + reflection.substring(0, 800) });
            _noProgressCount = 0;
          }
        }
      }
      // Check for HTTP status codes in the result (e.g. "200 OK", "502 Bad Gateway")
      const httpStatusMatch = String(result).match(/\b([45]\d{2}\s+\w+|2\d{2}\s+\w+)/);
      let statusBadge = '';
      if (httpStatusMatch) {
        const code = parseInt(httpStatusMatch[1]);
        if (code >= 200 && code < 300) statusBadge = ` ${C.green}${C.bold}[${httpStatusMatch[1]}]${C.reset}`;
        else if (code >= 400 && code < 500) statusBadge = ` ${C.yellow}${C.bold}[${httpStatusMatch[1]}]${C.reset}`;
        else if (code >= 500) statusBadge = ` ${C.red}${C.bold}[${httpStatusMatch[1]}]${C.reset}`;
      }
      log(`${isErr ? C.red : C.green}${T.diamond} ${resultEmoji} #${callNum} ${fnName}${statusBadge}${C.reset}`);
      // ── TUI dashboard: mark tool as done, then re-render dashboard in-place ──
      const tuiStatus = isErr ? 'error' : 'ok';
      // Pass result summary to grid (truncated to 80 chars inside tuiToolDone)
      tuiToolDone(fnName, tuiStatus, String(result).substring(0, 200));
      // ── Remove completed tool from pending list ──
      _pendingTools = _pendingTools.filter(p => p.name !== fnName);

      const resultStr = String(result);
      const display = resultStr.length > 2000 ? resultStr.substring(0, 2000) + '\n... (truncated)' : resultStr;
      const lines = display.split('\n');
      if (lines.length <= 10) {
        for (const line of lines) log(`${isErr ? C.red : C.green}│ ${line}${C.reset}`);
      } else {
        for (const line of lines.slice(0, 8)) log(`${isErr ? C.red : C.green}│ ${line}${C.reset}`);
        log(`${isErr ? C.red : C.green}│ ... (${lines.length - 8} more lines)${C.reset}`);
      }
      log(`${isErr ? C.red : C.green}└${C.reset}`);

      // ── TUI dashboard: render ALL panels as ONE unified block AFTER log output ──
      // This MUST come after all log() calls so the dashboard is the LAST thing
      // written to stdout, enabling in-place scroll (grid-to-grid overwrite).
      if (!silent) {
        const dashParts = [];
        if (_tuiPhase !== 'Idle') dashParts.push(renderReasoningPanel());
        const toolPanel = renderToolPanel();
        if (toolPanel) dashParts.push(toolPanel);
        const chainPanel = renderChainPanel();
        if (chainPanel) dashParts.push(chainPanel);
        if (dashParts.length > 0) _writePanel('DASHBOARD', dashParts.join('\n'));
      }

      // Add tool result to history — cap to reduce context bloat
      // (display already shows 2000 chars; history only needs enough for the LLM to understand)
      const HISTORY_RESULT_CAP = 4000;
      const historyContent = resultStr.length > HISTORY_RESULT_CAP
        ? resultStr.substring(0, HISTORY_RESULT_CAP) + '\n[truncated]'
        : resultStr;
      history.push({
        role: 'tool',
        name: fnName,
        content: historyContent,
        // Ollama expects tool_call_id matching
      });
    }

    // 6-phase: OBSERVE after tool results
    tuiSetPhase('OBSERVE');

    // ── TUI dashboard: render ALL panels after each step ──
    // All dashboard panels render as ONE combined block so they scroll
    // in-place together (grid-to-grid, not printing new boxes each time).
    if (!silent) {
      const dashParts = [];
      if (_tuiPhase !== 'Idle') dashParts.push(renderReasoningPanel());
      const toolPanel = renderToolPanel();
      if (toolPanel) dashParts.push(toolPanel);
      const chainPanel = renderChainPanel();
      if (chainPanel) dashParts.push(chainPanel);
      if (dashParts.length > 0) _writePanel('DASHBOARD', dashParts.join('\n'));
    }
  }

  return history;
}

// ── Persistent history (readline up-arrow & session) ────────────────
const HISTORY_FILE = path.join(os.homedir(), '.hakster', 'history');
const SESSION_FILE = path.join(os.homedir(), '.hakster', 'cli_session.json');

function loadHistory() {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean);
  } catch (_) { return []; }
}

function saveToHistory(line) {
  if (!line || !line.trim()) return;
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = loadHistory();
    const filtered = existing.filter(h => h !== line);
    filtered.push(line);
    const trimmed = filtered.slice(-500);
    fs.writeFileSync(HISTORY_FILE, trimmed.join('\n') + '\n');
  } catch (_) {}
}

function saveSession(history) {
  try {
    const dir = path.dirname(SESSION_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const msgs = history.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: (m.content || '').substring(0, 2000),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    }));
    fs.writeFileSync(SESSION_FILE, JSON.stringify(msgs, null, 2), 'utf-8');
  } catch (_) {}
}

function loadSession() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    if (!Array.isArray(data)) return [];
    // BUG FIX: Filter out corrupted history entries that confuse the model
    // 1. Remove empty assistant messages (no content, no tool_calls)
    // 2. Remove orphaned tool messages (without a matching assistant tool_call)
    // 3. Remove consecutive duplicate user messages
    const cleaned = [];
    let lastRole = '';
    let lastContent = '';
    for (const m of data) {
      // Skip empty assistant messages (no content, no thinking, no tool_calls)
      if (m.role === 'assistant' && !(m.content || '').trim() && !(m.thinking || '').trim() && (!m.tool_calls || m.tool_calls.length === 0)) {
        continue;
      }
      // Skip consecutive duplicate user messages
      if (m.role === 'user' && m.role === lastRole && (m.content || '') === lastContent) {
        continue;
      }
      cleaned.push(m);
      lastRole = m.role;
      lastContent = (m.content || '').substring(0, 200); // compare first 200 chars
    }
    // Remove orphaned tool messages (tool role without preceding assistant tool_calls)
    // Also remove stuck-loop patterns: assistant(tool_calls, no content) + tool(trivial response)
    const final = [];
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i].role === 'tool') {
        // Check if previous message was assistant with tool_calls
        if (final.length > 0 && final[final.length - 1].role === 'assistant' && final[final.length - 1].tool_calls) {
          const toolContent = (cleaned[i].content || '').trim();
          const prevContent = (final[final.length - 1].content || '').trim();
          // Stuck-loop pattern: assistant has tool_calls but no content, AND tool response is trivially small
          // These are empty-response retries that pollute context
          if (!prevContent && toolContent.length < 100) {
            // Remove the assistant message we already pushed
            final.pop();
            continue; // skip this tool message too
          }
          final.push(cleaned[i]);
        }
        // else: orphaned tool message, skip it
      } else {
        final.push(cleaned[i]);
      }
    }
    
    // If the cleaned history is mostly stuck-loop debris, keep only the last 4 turns
    // to give the model a fresh start while preserving recent context
    if (final.length > 20) {
      const recentSlice = final.slice(-8); // last 4 turns (user/assistant pairs)
      log(`${C.yellow}📦 Session too long (${final.length} msgs), trimming to last 4 turns${C.reset}`);
      return [{ role: 'system', content: buildSystemPrompt() }, ...recentSlice];
    }
    return [{ role: 'system', content: buildSystemPrompt() }, ...final];
  } catch (_) { return null; }
}

// ── CLI REPL (readline — no alternate screen, native scroll) ───────
async function repl() {
  fs.mkdirSync(path.join(os.homedir(), '.hakster'), { recursive: true });

  // Wire MCP log/status to our output functions
  setMcpLogFn((text) => { console.log(text); });
  setMcpStatusFn((text) => { /* status bar not used in REPL */ });

  // Initialize MCP servers (non-fatal if fails)
  console.log(`${C.cyan}🔌 Loading MCP servers...${C.reset}`);
  await initMcpTools();
  const mcpInfo = mcpStatus();
  if (mcpInfo.length > 0) {
    console.log(`${C.green}✓ ${mcpInfo.length} MCP server(s) connected, ${getMcpTools().length} tool(s) discovered${C.reset}`);
  } else {
    console.log(`${C.dim}  No MCP servers configured${C.reset}`);
  }

  // ── Check skills ──────────────────────────────────────────────────────
  console.log(`${C.cyan}📋 Loading skills...${C.reset}`);
  const skillsDirs = getSkillDirs();
  let skillCount = 0;
  const skillCategories = {};
  for (const skillsDir of skillsDirs) {
    try {
      const files = globSync(path.join(skillsDir, '**', '*.md'));
      skillCount += files.length;
      for (const f of files) {
        const rel = path.relative(skillsDir, f).replace(/\.md$/, '');
        const cat = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : 'root';
        skillCategories[cat] = (skillCategories[cat] || 0) + 1;
      }
    } catch (_) {}
  }
  if (skillCount > 0) {
    const topCats = Object.entries(skillCategories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat, n]) => `${C.magenta}${cat}/${C.reset}${C.dim}(${n})${C.reset}`)
      .join(', ');
    const moreCount = Object.keys(skillCategories).length > 5 ? ` ${C.dim}+${Object.keys(skillCategories).length - 5} more${C.reset}` : '';
    console.log(`${C.green}✓ ${skillCount} skills${C.reset} across ${Object.keys(skillCategories).length} categories: ${topCats}${moreCount}`);
  } else {
    console.log(`${C.dim}  No skills found${C.reset}`);
  }

  // ── Check memory ──────────────────────────────────────────────────────
  console.log(`${C.cyan}🧠 Loading memory...${C.reset}`);
  let memCount = 0;
  const memFiles = [];
  for (const root of getHaksterRoots()) {
    const memoryFile = path.join(root, 'memory', 'notes.json');
    try {
      const notes = JSON.parse(fs.readFileSync(memoryFile, 'utf-8'));
      if (Array.isArray(notes)) {
        memCount += notes.length;
        memFiles.push(memoryFile);
      }
    } catch (_) {}
  }
  if (memCount > 0) {
    // Show last note preview
    let lastNote = '';
    for (const root of getHaksterRoots()) {
      try {
        const notes = JSON.parse(fs.readFileSync(path.join(root, 'memory', 'notes.json'), 'utf-8'));
        if (Array.isArray(notes) && notes.length > 0 && notes[notes.length - 1].content) {
          const c = notes[notes.length - 1].content;
          lastNote = c.length > 80 ? c.substring(0, 77) + '...' : c;
        }
      } catch (_) {}
    }
    const noteInfo = lastNote ? ` ${C.dim}last: "${lastNote}"${C.reset}` : '';
    console.log(`${C.green}✓ ${memCount} memory notes${C.reset} loaded from ${memFiles.length} file(s)${noteInfo}`);
  } else {
    console.log(`${C.dim}  No memory notes — fresh start${C.reset}`);
  }

  // ── Context budget estimate ────────────────────────────────────────────
  const builtInToolCount = _builtinToolCount;
  const mcpToolCount = getMcpTools().length;
  const totalTools = TOOLS.length;
  // Context budget: system prompt + tools + conversation history
  const sysPromptSize = buildSystemPrompt().length;
  const toolJsonSize = JSON.stringify(TOOLS).length;
  const estimatedTokens = Math.ceil((sysPromptSize + toolJsonSize) / 4); // ~4 chars/token for mixed content
  const budgetMax = 131072; // gpt-oss:120b-cloud context window
  const budgetPct = ((estimatedTokens / budgetMax) * 100).toFixed(1);
  const budgetColor = parseFloat(budgetPct) > 80 ? C.red : parseFloat(budgetPct) > 50 ? C.yellow : C.green;
  console.log(`${budgetColor}📐 Context: ~${estimatedTokens.toLocaleString()} / ${budgetMax.toLocaleString()} tokens (${budgetPct}%)${C.reset} ${C.dim}[sys:${Math.ceil(sysPromptSize/4)} tools:${Math.ceil(toolJsonSize/4)}]${C.reset}`);
  console.log(`${C.bold}🔧 ${totalTools} tools${C.reset} (${builtInToolCount} built-in + ${mcpToolCount} MCP)${C.reset}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.bgSubtle}${C.fgBase} haksterAI ${C.reset}${C.primary}${C.bold}❯${C.reset} `,
    historySize: 200,
    removeHistoryDuplicates: true,
  });

  // Load persistent readline history (up-arrow across sessions)
  const savedHistory = loadHistory();
  if (savedHistory.length > 0) {
    rl.history = [...savedHistory].reverse(); // readline stores newest-first
  }

  // ── Status line (overwritten in-place) ────────────────────────────────
  let statusText = 'Ready';
  let spinnerFrames = ['◇','◆','◇','◆','◈','◇','◆','◈','◇','◆'];
  let spinnerIdx = 0;
  let spinnerInterval = null;

  function startSpinner(label) {
    spinnerIdx = 0;
    spinnerInterval = setInterval(() => {
      process.stdout.write(`\r${C.fgMuted}${spinnerFrames[spinnerIdx % spinnerFrames.length]} ${label}...${C.reset}   `);
      spinnerIdx++;
    }, Math.round(80 / SCROLL_SPEED));
  }
  function stopSpinner() {
    if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
  }

  // ── Wire log & status to straight stdout ──────────────────────────────
  _logFn = (text) => {
    stopSpinner();
    process.stdout.write(text + '\n');
  };
  _statusFn = (text) => {
    statusText = text;
    if (text === 'Ready') {
      stopSpinner();
    }
  };

  // ── Wire danger confirm as readline prompt ────────────────────────────
  _confirmFn = (dangerMsg, tool, args) => {
    return new Promise((resolve) => {
      _awaitingConfirm = true;   // Freeze status bar + stall guard + panel re-render so they don't overwrite the prompt
      stopSpinner();
      process.stdout.write('\r' + ' '.repeat(120) + '\r');  // wipe any leftover status-bar text on this line
      // ── Prominent popup box above the grids so the prompt is impossible to miss ──
      const cols = Math.min(process.stdout.columns || 100, 100);
      const inner = Math.max(40, cols - 6);
      const argLine = (tool === 'shell' || tool === 'exec_shell') ? (args && args.command || '') : JSON.stringify(args || {});
      const cmdStr = String(argLine).replace(/\s+/g, ' ').trim();
      const isSudo = /^\s*sudo\b/i.test(cmdStr);
      const bar = (l, r) => `${C.error}${C.bold}${l}${'═'.repeat(inner)}${r}${C.reset}`;
      console.log('\n' + bar('╔', '╗'));
      console.log(`${C.error}${C.bold}║${C.reset} ${isSudo ? '🔑 SUDO' : '⚠  DANGEROUS'} COMMAND — APPROVAL REQUIRED${' '.repeat(Math.max(0, inner - 47))} ${C.error}${C.bold}║${C.reset}`);
      console.log(`${C.error}${C.bold}║${C.reset} ${C.yellow}${dangerMsg}${' '.repeat(Math.max(0, inner - 1 - dangerMsg.length))}${C.error}${C.bold}║${C.reset}`);
      console.log(`${C.error}${C.bold}║${C.reset} ${C.gray}Tool: ${tool}${' '.repeat(Math.max(0, inner - 6 - tool.length))} ${C.error}${C.bold}║${C.reset}`);
      const cmdPreview = cmdStr.length > inner - 9 ? cmdStr.slice(0, inner - 12) + '...' : cmdStr;
      console.log(`${C.error}${C.bold}║${C.reset} ${C.bgBase}${C.fgBase} $ ${C.reset}${C.fgHalf}${cmdPreview}${' '.repeat(Math.max(0, inner - 5 - cmdPreview.length))} ${C.error}${C.bold}║${C.reset}`);
      console.log(bar('╚', '╝'));
      // List of choices + password prompt for sudo
      console.log(`${C.fgSubtle}  Choices: ${C.reset}${C.green}y${C.reset}=approve  ${C.yellow}a${C.reset}=approve & don't ask again  ${C.red}n${C.reset}=deny${isSudo ? `  ${C.cyan}(sudo) type the password to approve${C.reset}` : ''}`);
      const promptLabel = isSudo ? `${C.bgError}${C.butter}${C.bold} 🔑 sudo ${C.reset} password / y / a / n: `
                                 : `${C.bgError}${C.butter}${C.bold} y/N ${C.reset} (or a=allowlist): `;
      rl.question(promptLabel, (answer) => {
        _awaitingConfirm = false;  // Resume status bar / stall guard / panels
        _lastActivityTime = Date.now();
        const a = answer.trim().toLowerCase();
        let decision = false;
        if (a === 'a') decision = 'allowlist';
        else if (a === 'n' || a === '') decision = false;
        else if (isSudo) decision = answer.trim().length > 0 ? true : false;   // any non-empty (password or y) approves
        else decision = a === 'y';
        resolve(decision);
        if (!answer) rl.prompt();
      });
    });
  };

  // ── Full-auto mode ─────────────────────────────────────────────────
  if (process.argv.includes('--full-auto') || process.env.HAKSTER_APPROVAL_MODE === 'full-auto') {
    _approvalMode = FULL_AUTO;
    console.log(`${C.yellow}⚠  FULL-AUTO MODE: All dangerous commands will execute without confirmation${C.reset}`);
  }

  // ── Print banner with background splash ─────────────────────────────
  // Dark background splash — fill terminal with near-black to set the mood
  const termH = process.stdout.rows || 40;
  const splashLine = `${C.bgBase}${' '.repeat(Math.max(80, process.stdout.columns || 120))}${C.reset}`;
  for (let i = 0; i < Math.min(termH, 3); i++) process.stdout.write(splashLine + '\n');
  process.stdout.write(`\x1b[${Math.min(termH, 3)}A`); // cursor back up
  console.log(banner());

  // ── Message queue splash ─────────────────────────────────────────────
  const pendingMsgs = msgDrain(20);
  if (pendingMsgs.length > 0) {
    const typeColors = { notify: C.cyan, warn: C.yellow, error: C.red, task: C.green, mcp: C.magenta, system: C.dim };
    const typeIcons = { notify: '📬', warn: '⚠️', error: '❌', task: '✅', mcp: '🔌', system: '⚙️' };
    console.log(`\n${C.bold}${C.cyan}📬 Queued Messages (${pendingMsgs.length})${C.reset}`);
    for (const m of pendingMsgs) {
      const icon = typeIcons[m.type] || '📬';
      const tc = typeColors[m.type] || C.dim;
      const time = m.ts.split('T')[1]?.split('.')[0] || m.ts;
      console.log(`  ${icon} ${tc}${m.msg.substring(0, 100)}${C.reset} ${C.dim}${time} from:${m.source}${C.reset}`);
    }
    console.log();
  }

  // ── History & state ──────────────────────────────────────────────────
  // Load previous session if available, otherwise start fresh
  const savedSession = loadSession();
  const history = savedSession || [{ role: 'system', content: buildSystemPrompt() }];
  if (savedSession) {
    // Show session resume summary with last few messages
    const userMsgs = savedSession.filter(m => m.role === 'user');
    const lastUser = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1].content.substring(0, 80) : '(none)';
    console.log(`  ${C.green}✓ Resumed session${C.reset} ${C.fgMuted}(${history.length - 1} msgs)${C.reset} ${C.dim}last: "${lastUser}"${C.reset}`);
    console.log(`  ${C.fgSubtle}Type /clear to start fresh${C.reset}`);
  }
  let idleTimer = null;
  let processing = false;
  let _lastIdleReview = 0;
  let _idleReviewCount = 0;
  _messageQueue = [];  // Reset module-level queue for this REPL session
  _batch = null;       // Reset paste-batching state
  _lastAssistantResponse = '';  // Reset module-level loop detection for this session
  _noProgressCount = 0;  // Reset no-progress loop detection for this session
  _recentResponsePrefixes = [];  // Reset semantic loop detection for this session
  _stuckCooldown = 0;            // Reset stuck-loop cooldown
  _emptyRetries = 0;              // Reset empty response retry counter
  _explorationCalls = [];         // Reset filesystem-wandering loop detection
  _recentShellCommands = [];      // Reset shell repeat-loop detection for this session
  _shellRepeatBreak = false;      // Reset shell repeat-loop break flag
  _actionsTaken = [];             // Reset action tracker for new session

  // ── Idle auto-review: health + skill hot-reload + self-repair ──
  async function runIdleAutoReview() {
    if (processing) { startIdleTimer(); return; }
    _idleReviewCount++;
    _lastIdleReview = Date.now();
    const reviewNum = _idleReviewCount;
    console.log(`\n${C.bgSubtle}${T.hashFill(50, C.fgMuted)}${C.reset}`);
    console.log(`${C.fgMuted}🔍 Idle Auto-Review #${reviewNum}${C.reset} ${C.dim}${new Date().toLocaleTimeString()}${C.reset}`);
    console.log(`${C.bgSubtle}${T.thin.repeat(50)}${C.reset}`);

    const run = async (cmd) => { try { const r = await asyncShell(cmd, { timeout: 10 }); return r.ok ? r.stdout.trim() : null; } catch (_) { return null; } };

    // 1. PM2 services — auto-restart dead ones
    console.log(`${C.bold}${C.cyan}📦 Services${C.reset}`);
    const serviceMap = { haksterai: 3579, cinevault: 8081, miniforge: 5555 };
    const pm2out = await run('pm2 list --no-color 2>/dev/null');
    if (pm2out) {
      const lines = pm2out.split('\n');
      for (const line of lines) {
        const m = line.match(/^\│\s+(\S+)\s+.*\│\s+(online|stopped|errored|paused)\s+/i);
        if (m) {
          const color = m[2] === 'online' ? C.green : C.red;
          const port = serviceMap[m[1].toLowerCase()] || '?';
          console.log(`  ${color}${m[2] === 'online' ? '✓' : '✗'}${C.reset} ${m[1]} :${port} ${color}${m[2]}${C.reset}`);
          if (m[2] !== 'online' && serviceMap[m[1].toLowerCase()]) {
            console.log(`  ${C.yellow}↻ Auto-restarting ${m[1]}...${C.reset}`);
            await run(`pm2 restart ${m[1]} 2>/dev/null`);
            try {
              const resp = await fetch(`http://localhost:${serviceMap[m[1].toLowerCase()]}/api/health`, { signal: AbortSignal.timeout(5000) });
              if (resp.ok) console.log(`  ${C.green}✓ ${m[1]} restarted OK${C.reset}`);
              else console.log(`  ${C.yellow}⚠ ${m[1]} up but health=${resp.status}${C.reset}`);
            } catch (_) {
              console.log(`  ${C.red}✗ ${m[1]} health check failed${C.reset}`);
            }
          }
        }
      }
    } else {
      console.log(`  ${C.red}✗ PM2 error${C.reset}`);
    }

    // 2. Health endpoints
    console.log(`${C.bold}${C.cyan}🏥 Health${C.reset}`);
    for (const [name, port] of Object.entries(serviceMap)) {
      try {
        const resp = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
        const text = await resp.text();
        console.log(`  ${resp.ok ? C.green : C.yellow}${resp.ok ? '✓' : '⚠'}${C.reset} ${name} :${port} → ${resp.status} ${text.substring(0, 50)}`);
      } catch (_) {
        console.log(`  ${C.red}✗${C.reset} ${name} :${port} → unreachable`);
      }
    }

    // 3. System resources
    console.log(`${C.bold}${C.cyan}💻 System${C.reset}`);
    const mem = await run('free -h | head -2 | tail -1');
    if (mem) { const p = mem.split(/\s+/); console.log(`  RAM  ${p[2] || '?'} used / ${p[1] || '?'} total`); }
    const disk = await run('df -h / | tail -1');
    if (disk) { const p = disk.split(/\s+/); console.log(`  Disk ${p[2] || '?'} used / ${p[1] || '?'} total (${p[4] || '?'})`); }
    const tempRaw = await run('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null');
    if (tempRaw) {
      const tempC = (parseInt(tempRaw) / 1000).toFixed(1);
      const tempColor = parseFloat(tempC) > 80 ? C.red : parseFloat(tempC) > 70 ? C.yellow : C.green;
      console.log(`  Temp ${tempColor}${tempC}°C${C.reset}`);
    }
    const load = await run('uptime');
    if (load) { const lm = load.match(/load average:\s*([\d.,]+)/); console.log(`  Load ${lm ? lm[1] : load}`); }

    // 4. Skill hot-reload — count EVERY .md skill across all roots (recursive, deduped)
    console.log(`${C.bold}${C.cyan}📚 Skills${C.reset}`);
    try {
      const roots = getHaksterRoots();
      const seen = new Set();
      let skillCount = 0, newSkills = 0;
      for (const root of roots) {
        try {
          const files = globSync(path.join(root, '**', '*.md'));
          for (const f of files) {
            const key = path.resolve(f);
            if (seen.has(key)) continue;
            seen.add(key);
            skillCount++;
            try {
              const stat = fs.statSync(f);
              if (Date.now() - stat.mtimeMs < 300000) {
                newSkills++;
                if (newSkills <= 12) console.log(`  ${C.green}✦${C.reset} ${path.relative(root, f)} ${C.dim}(updated)${C.reset}`);
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
      console.log(`  ${skillCount} skills loaded across ${roots.length} roots${newSkills > 0 ? ` (${C.green}${newSkills} new/updated${C.reset})` : ''}`);
    } catch (_) { console.log(`  ${C.yellow}⚠ skill scan error${C.reset}`); }

    // 5. Self-repair: own process health
    console.log(`${C.bold}${C.cyan}🔧 Self-Check${C.reset}`);
    const ownMem = process.memoryUsage();
    const heapUsed = (ownMem.heapUsed / 1024 / 1024).toFixed(1);
    const rss = (ownMem.rss / 1024 / 1024).toFixed(1);
    const rssColor = ownMem.rss > 512 * 1024 * 1024 ? C.red : ownMem.rss > 256 * 1024 * 1024 ? C.yellow : C.green;
    console.log(`  PID  ${process.pid}`);
    console.log(`  Heap ${heapUsed}MB  RSS ${rssColor}${rss}MB${C.reset}`);
    console.log(`  Uptime ${Math.floor(process.uptime() / 60)}m  History ${history.length} msgs  Tools ${_toolCallCount}`);

    // 6. Ports — list our known services UP TOP (up/down), not just bars.
    const EXPECTED_PORTS = [
      { port: 3579, name: 'haksterAi',  proto: 'http' },
      { port: 8081, name: 'cinevault',  proto: 'http' },
      { port: 4000, name: 'phantom',    proto: 'http' },
      { port: 8082, name: 'claude-proxy', proto: 'http' },
      { port: 5555, name: 'miniforge',  proto: 'http' },
    ];
    const portCheck = await run('ss -tlnp 2>/dev/null');
    const openPorts = new Set();
    const portProc = {};
    for (const line of String(portCheck || '').split('\n')) {
      const m = line.match(/:([0-9]{2,5})\s+\S+\s+.*users:\(\("([^"]+)"/);
      if (m) { openPorts.add(Number(m[1])); portProc[m[1]] = m[2]; }
      else {
        const m2 = line.match(/:([0-9]{2,5})\s+\S+/);
        if (m2) openPorts.add(Number(m2[1]));
      }
    }
    console.log(`${C.bold}${C.cyan}🔌 Ports${C.reset}`);
    for (const svc of EXPECTED_PORTS) {
      const up = openPorts.has(svc.port);
      const proc = portProc[String(svc.port)] || (up ? 'listening' : '');
      const tag = up ? `${C.green}●${C.reset} :${svc.port} ${C.fgBase}${svc.name}${C.reset}${proc ? C.dim + ' (' + proc + ')' + C.reset : ''}`
                     : `${C.red}○${C.reset} :${svc.port} ${C.fgMuted}${svc.name}${C.reset} ${C.dim}down${C.reset}`;
      console.log(`  ${tag}  ${C.fgMuted}${svc.proto}://localhost:${svc.port}${C.reset}`);
    }

    console.log(`${C.bgSubtle}${T.hashFill(50, C.fgMuted)}${C.reset}`);
    console.log(`${C.dim}✓ Auto-review #${reviewNum} complete. Next in ${IDLE_TIMEOUT_MS / 1000}s.${C.reset}\n`);
    startIdleTimer();
    rl.prompt();
  }

  function startIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      runIdleAutoReview();
    }, IDLE_TIMEOUT_MS);
  }
  startIdleTimer();

  // ── Handle input ────────────────────────────────────────────────────
  function handleInput(input) {
    input = (input || '').trim();
    if (!input) { rl.prompt(); return; }

    // ── Auto-detect "take note" / "note that" / "remember this" ──
    const notePhrases = /^(take note|note that|remember this|make a note|save that|note:|remember:|jot down|write down|keep in mind)/i;
    if (notePhrases.test(input)) {
      const noteContent = input.replace(notePhrases, '').replace(/^[\s,:\-]+/, '').trim();
      if (noteContent.length > 2) {
        // Auto-save to memory
        const MEMORY_DIR = path.join(WORK_DIR, '.hakster', 'memory');
        const MEMORY_FILE = path.join(MEMORY_DIR, 'notes.json');
        if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
        let notes = [];
        try { notes = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8')); } catch (_) { notes = []; }
        const note = { id: `mem_${Date.now()}`, content: noteContent, created: new Date().toISOString() };
        notes.push(note);
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(notes, null, 2));
        console.log(`${C.green}🧠 Noted!${C.reset} ${C.dim}Saved to memory: "${noteContent.slice(0, 80)}${noteContent.length > 80 ? '...' : ''}"${C.reset}`);
        rl.prompt();
        return;
      }
    }

    // ── Image paste detection ──
    // Detect: (1) file paths to images, (2) base64 data URIs, (3) raw base64 image data
    const imgExts = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i;
    const base64ImgRegex = /^data:image\/(png|jpeg|jpg|gif|webp|bmp|svg\+xml);base64,/i;
    const isImagePath = imgExts.test(input) && !input.startsWith('/') && !input.startsWith('http');
    const isImageAbsPath = imgExts.test(input) && (input.startsWith('/') || input.startsWith('~'));
    const isImageUrl = /^https?:\/\/.+\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)(\?.*)?$/i.test(input);
    const isDataUri = base64ImgRegex.test(input);
    const isRawBase64 = /^[A-Za-z0-9+/=]{1000,}$/.test(input.replace(/\s/g, '')) && input.length > 5000;

    if (isImageAbsPath || isImagePath || isImageUrl || isDataUri || isRawBase64) {
      const imgDir = path.join(os.homedir(), '.hakster', 'images');
      if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

      if (isDataUri) {
        // Pasted data URI — extract and save
        const match = input.match(/^data:image\/([\w+]+);base64,(.+)$/i);
        if (match) {
          const mime = match[1].replace('+xml', '');
          const ext = mime === 'jpeg' ? 'jpg' : mime;
          const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const filePath = path.join(imgDir, `paste_${id}.${ext}`);
          fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
          const stats = fs.statSync(filePath);
          const sizeKB = (stats.size / 1024).toFixed(1);
          console.log(`\n${C.success}🖼️  Image pasted!${C.reset} ${C.fgMuted}Saved to:${C.reset} ${C.bold}${filePath}${C.reset} ${C.fgMuted}(${sizeKB} KB)${C.reset}`);
          console.log(`${C.dim}   I'll analyze this image when you ask about it.${C.reset}`);
          saveToHistory(`[image] ${filePath}`);
          // Push image info into history so the agent can see it
          history.push({ role: 'user', content: `[User pasted an image: ${filePath} (${sizeKB} KB, ${mime})]\nUse read_image to examine it, or I can describe what I see.` });
          rl.prompt();
          return;
        }
      } else if (isRawBase64) {
        // Pasted raw base64 — save as png (guess)
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const filePath = path.join(imgDir, `paste_${id}.png`);
        fs.writeFileSync(filePath, Buffer.from(input.replace(/\s/g, ''), 'base64'));
        const stats = fs.statSync(filePath);
        const sizeKB = (stats.size / 1024).toFixed(1);
        console.log(`\n${C.success}🖼️  Image pasted (raw base64)!${C.reset} ${C.fgMuted}Saved to:${C.reset} ${C.bold}${filePath}${C.reset} ${C.fgMuted}(${sizeKB} KB)${C.reset}`);
        console.log(`${C.dim}   I'll analyze this image when you ask about it.${C.reset}`);
        saveToHistory(`[image] ${filePath}`);
        history.push({ role: 'user', content: `[User pasted an image: ${filePath} (${sizeKB} KB)]\nUse read_image to examine it, or I can describe what I see.` });
        rl.prompt();
        return;
      } else if (isImageUrl) {
        // URL to an image — download it
        const urlFilename = path.basename(input.split('?')[0]) || 'image.png';
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const ext = path.extname(urlFilename).toLowerCase() || '.png';
        const filePath = path.join(imgDir, `download_${id}${ext}`);
        console.log(`\n${C.info}⬇️  Downloading image...${C.reset}`);
        (async () => {
          try {
            const https = require('https');
            const http = require('http');
            const client = input.startsWith('https') ? https : http;
            const file = fs.createWriteStream(filePath);
            client.get(input, (res) => {
              res.pipe(file);
              file.on('finish', () => {
                file.close();
                const stats = fs.statSync(filePath);
                const sizeKB = (stats.size / 1024).toFixed(1);
                console.log(`${C.success}🖼️  Image downloaded!${C.reset} ${C.fgMuted}Saved to:${C.reset} ${C.bold}${filePath}${C.reset} ${C.fgMuted}(${sizeKB} KB)${C.reset}`);
                console.log(`${C.dim}   I'll analyze this image when you ask about it.${C.reset}`);
                history.push({ role: 'user', content: `[User provided image URL: ${input}\nDownloaded to: ${filePath} (${sizeKB} KB)]\nUse read_image to examine it.` });
                rl.prompt();
              });
            }).on('error', (err) => {
              console.log(`${C.error}❌ Download failed: ${err.message}${C.reset}`);
              rl.prompt();
            });
          } catch (err) {
            console.log(`${C.error}❌ Download failed: ${err.message}${C.reset}`);
            rl.prompt();
          }
        })();
        return;
      } else {
        // Local file path — verify and save reference
        const resolved = path.resolve(input.replace(/^~/, os.homedir()));
        if (fs.existsSync(resolved)) {
          const stats = fs.statSync(resolved);
          const sizeKB = (stats.size / 1024).toFixed(1);
          console.log(`\n${C.success}🖼️  Image detected!${C.reset} ${C.fgMuted}Path:${C.reset} ${C.bold}${resolved}${C.reset} ${C.fgMuted}(${sizeKB} KB)${C.reset}`);
          console.log(`${C.dim}   I'll analyze this image when you ask about it.${C.reset}`);
          saveToHistory(`[image] ${resolved}`);
          history.push({ role: 'user', content: `[User provided image file: ${resolved} (${sizeKB} KB)]\nUse read_image to examine it, or I can describe what I see.` });
          rl.prompt();
          return;
        } else {
          // Not found locally — treat as regular text input
          console.log(`${C.mustard}⚠ Image path not found: ${resolved}. Treating as text input.${C.reset}`);
        }
      }
    }

    // Save to persistent history (survives restarts)
    saveToHistory(input);
    startIdleTimer();

    // Commands
    if (input === '/exit' || input === '/quit') {
      shutdownMcp();
      console.log('bye ⚡');
      process.exit(0);
    }
    if (input === '/clear') {
      // Background splash on clear too
      const termH2 = process.stdout.rows || 40;
      const splashLine2 = `${C.bgBase}${' '.repeat(Math.max(80, process.stdout.columns || 120))}${C.reset}`;
      for (let i = 0; i < Math.min(termH2, 3); i++) process.stdout.write(splashLine2 + '\n');
      process.stdout.write(`\x1b[${Math.min(termH2, 3)}A`);
      console.clear();
      console.log(banner());
      history.length = 0;
      history.push({ role: 'system', content: buildSystemPrompt() });
      saveSession(history); // Clear saved session too
      startIdleTimer();
      rl.prompt();
      return;
    }
    if (input === '/review' || input === '/health') {
      runIdleAutoReview();
      return;
    }
    // ── /img — Image generation input bar ──
    if (input === '/img' || input.startsWith('/img ')) {
      const imgPrompt = input.startsWith('/img ') ? input.substring(5).trim() : '';
      if (imgPrompt) {
        // One-shot: generate directly
        processing = true;
        _statusFn('🎨 Generating image...');
        startSpinner('Generating');
        (async () => {
          try {
            const result = await toolExecutors.generate_image({ prompt: imgPrompt });
            stopSpinner();
            console.log(`\n${C.success}${C.bold}🎨 Image Generated${C.reset}`);
            console.log(result);
            console.log(`${C.bgSubtle}${T.hashFill(40, C.success)}${C.reset}`);
          } catch (err) {
            stopSpinner();
            console.log(`\n${C.error}${C.bold}❌ Image generation failed${C.reset} ${C.error}${err.message}${C.reset}`);
          }
          processing = false;
          _agentActivity = 'Idle'; _activityDetail = '';
          _statusFn('Ready');
          startIdleTimer();
          rl.prompt();
        })();
      } else {
        // Interactive image gen mode
        console.log(`\n${C.primary}${C.bold}🎨 Image Generation Mode${C.reset}`);
        console.log(`${C.fgMuted}Type a prompt to generate/edit an image. Options: size, model, quality, operation${C.reset}`);
        console.log(`${C.fgMuted}Examples:${C.reset}`);
        console.log(`  ${C.cyan}a retro cyberpunk city at sunset${C.reset}`);
        console.log(`  ${C.cyan}size=1024x1792 a tall poster for haksterAI${C.reset}`);
        console.log(`  ${C.cyan}operation=logo model=zimage a modern logo${C.reset}`);
        console.log(`  ${C.cyan}operation=enhance image=/path/to/photo.png improve lighting${C.reset}`);
        console.log(`  ${C.cyan}quality=hd a detailed infographic${C.reset}`);
        console.log(`${C.fgMuted}Type ${C.primary}/img${C.reset}${C.fgMuted} again or ${C.primary}exit${C.reset}${C.fgMuted} to leave image mode${C.reset}\n`);
        let imgMode = true;
        const imgPrompt = `${C.primary}${C.bold}🎨❯${C.reset} `;
        const origPrompt = rl._prompt;
        rl.setPrompt(imgPrompt);
        rl.prompt();

        const imgLineHandler = (line) => {
          const text = (line || '').trim();
          if (!text || text === 'exit' || text === '/img' || text === 'quit') {
            rl.removeListener('line', imgLineHandler);
            imgMode = false;
            rl.setPrompt(origPrompt);
            console.log(`${C.fgMuted}Exited image mode${C.reset}\n`);
            rl.prompt();
            return;
          }
          if (text === '/help') {
            console.log(`${C.fgMuted}Image mode commands:${C.reset}`);
            console.log(`  ${C.cyan}prompt text${C.reset} — generate image from prompt`);
            console.log(`  ${C.cyan}size=WxH prompt${C.reset} — set size (1024x1024, 1024x1792, 1792x1024)`);
            console.log(`  ${C.cyan}model=NAME prompt${C.reset} — set model (zimage, flux, kontext, gptimage, dall-e-3, gpt-image-1)`);
            console.log(`  ${C.cyan}operation=enhance image=/path/to/img.png prompt${C.reset} — edit/enhance a source image`);
            console.log(`  ${C.cyan}quality=hd prompt${C.reset} — set quality (standard, hd)`);
            console.log(`  ${C.cyan}exit${C.reset} or ${C.cyan}/img${C.reset} — leave image mode`);
            rl.prompt();
            return;
          }
          // Parse options: size=, model=, quality=, operation=, image=
          let size = '1024x1024', model = 'zimage', quality = 'hd', operation = 'generate', image_path = '';
          let promptText = text;
          const sizeMatch = text.match(/size=(\d+x\d+)\s*/i);
          if (sizeMatch) { size = sizeMatch[1]; promptText = promptText.replace(sizeMatch[0], ''); }
          const modelMatch = text.match(/model=(\S+)\s*/i);
          if (modelMatch) { model = modelMatch[1]; promptText = promptText.replace(modelMatch[0], ''); }
          const qualMatch = text.match(/quality=(\S+)\s*/i);
          if (qualMatch) { quality = qualMatch[1]; promptText = promptText.replace(qualMatch[0], ''); }
          const opMatch = text.match(/operation=(\S+)\s*/i);
          if (opMatch) { operation = opMatch[1]; promptText = promptText.replace(opMatch[0], ''); }
          const imageMatch = text.match(/image=(\S+)\s*/i);
          if (imageMatch) { image_path = imageMatch[1]; promptText = promptText.replace(imageMatch[0], ''); }
          promptText = promptText.trim();
          if (!promptText) { rl.prompt(); return; }

          processing = true;
          _statusFn('🎨 Generating image...');
          startSpinner('Generating');
          (async () => {
            try {
              const result = await toolExecutors.generate_image({ prompt: promptText, model, size, quality, operation, image_path });
              stopSpinner();
              console.log(`\n${C.success}${C.bold}🎨 Done${C.reset} ${C.fgMuted}(${model}, ${size}, ${quality})${C.reset}`);
              console.log(result);
              console.log(`${C.bgSubtle}${T.hashFill(30, C.success)}${C.reset}\n`);
            } catch (err) {
              stopSpinner();
              console.log(`\n${C.error}${C.bold}❌ Failed${C.reset} ${C.error}${err.message}${C.reset}\n`);
            }
            processing = false;
            _agentActivity = 'Idle'; _activityDetail = '';
            _statusFn('Ready');
            if (imgMode) {
              rl.setPrompt(imgPrompt);
              rl.prompt();
            }
          })();
        };
        rl.on('line', imgLineHandler);
      }
      return;
    }
    if (input === '/help') {
      console.log(`  ${C.primary}${C.bold}/clear${C.reset}  Clear history    ${C.primary}${C.bold}/model${C.reset}  Show model    ${C.primary}${C.bold}/review${C.reset}  Health check    ${C.primary}${C.bold}/skills${C.reset}  Skills count    ${C.primary}${C.bold}/tools${C.reset}  Tool list    ${C.primary}${C.bold}/mcp${C.reset}  MCP status    ${C.primary}${C.bold}/queue${C.reset}  Input+notif queues    ${C.primary}${C.bold}/img${C.reset}  Image gen    ${C.primary}${C.bold}/exit${C.reset}  Quit`);
      console.log(`  ${C.tertiary}${C.bold}${T.star}${C.reset}  ${C.fgMuted}Paste an image file path, URL, or base64 data to analyze it${C.reset}`);
      console.log(`  ${C.primary}${C.bold}🎨 /img${C.reset}  ${C.fgMuted}Enter image generation mode — type prompts to generate images${C.reset}`);
      console.log(`  ${C.fgSubtle}${T.dots(60)}${C.reset}`);
      console.log(`  ⚠  Approval mode: ${_approvalMode}${_approvalMode === FULL_AUTO ? ' — dangerous commands will execute WITHOUT confirmation' : ' — dangerous commands will prompt for confirmation'}`);
      rl.prompt();
      return;
    }
    if (input === '/queue') {
      const notifCount = msgSize();
      const inputCount = _messageQueue.length;
      if (notifCount === 0 && inputCount === 0) {
        console.log(`\n  ${C.dim}Queues are empty${C.reset}\n`);
      } else {
        console.log(`\n${C.bold}${C.cyan}📬 Queues${C.reset}`);
        if (inputCount > 0) {
          console.log(`  ${C.bold}⏳ Input queue: ${inputCount} pending${C.reset}  ${C.dim}(messages waiting for agent)${C.reset}`);
        } else {
          console.log(`  ${C.dim}⏳ Input queue: empty${C.reset}`);
        }
        if (notifCount > 0) {
          console.log(`  ${C.bold}📬 Notification queue: ${notifCount} pending${C.reset}  ${C.dim}(async events, MCP updates)${C.reset}`);
          const items = msgPeek(20);
          const typeColors = { notify: C.cyan, warn: C.yellow, error: C.red, task: C.green, mcp: C.magenta, system: C.dim };
          for (const m of items) {
            const icon = { notify: '📬', warn: '⚠️', error: '❌', task: '✅', mcp: '🔌', system: '⚙️' }[m.type] || '📬';
            const tc = typeColors[m.type] || C.dim;
            const time = m.ts.split('T')[1]?.split('.')[0] || m.ts;
            console.log(`    ${icon} ${tc}${m.msg}${C.reset}  ${C.dim}${time} from:${m.source}${C.reset}`);
          }
        } else {
          console.log(`  ${C.dim}📬 Notification queue: empty${C.reset}`);
        }
        console.log();
      }
      rl.prompt();
      return;
    }
    if (input === '/mcp') {
      const servers = mcpStatus();
      const mcpTools = getMcpTools();
      if (servers.length === 0) {
        console.log(`\n  ${C.yellow}${C.bold}No MCP servers connected${C.reset}`);
        console.log(`  ${C.dim}Add servers to .hakster/mcp.json${C.reset}\n`);
      } else {
        console.log(`\n${C.bold}${C.cyan}🔌 MCP Servers: ${servers.length}${C.reset}  ${C.bold}${C.magenta}Tools: ${mcpTools.length}${C.reset}\n`);
        for (const s of servers) {
          const statusIcon = s.initialized ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
          console.log(`  ${statusIcon} ${C.bold}${s.name}${C.reset}  ${C.dim}PID: ${s.pid || 'N/A'}  tools: ${s.toolCount}${C.reset}`);
          for (const t of s.tools) {
            console.log(`    ${C.cyan}├${C.reset} ${t}`);
          }
        }
        console.log();
      }
      rl.prompt();
      return;
    }
    if (input === '/tools') {
      console.log(`\n${C.bold}${C.cyan}🔧 Tools: ${TOOLS.length}${C.reset}\n`);
      TOOLS.forEach((t, i) => {
        const name = t.function?.name || '(unknown)';
        const desc = t.function?.description?.split('\n')[0]?.slice(0, 60) || '';
        console.log(`  ${C.green}${String(i + 1).padStart(2)}${C.reset}  ${C.bold}${name}${C.reset}  ${C.dim}${desc}${C.reset}`);
      });
      console.log();
      rl.prompt();
      return;
    }

    if (input === '/skills') {
      const skillsDirs = getSkillDirs();
      let total = 0;
      const categories = [];
      for (const skillsDir of skillsDirs) {
        try {
          const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.md')) {
              total++;
            } else if (entry.isDirectory()) {
              const count = globSync(path.join(skillsDir, entry.name, '**', '*.md')).length;
              if (count > 0) { categories.push({ name: entry.name, count }); total += count; }
            }
          }
        } catch (_) {}
      }
      console.log(`\n${C.bold}${C.cyan}🔧 Tools: ${TOOLS.length}${C.reset}  ${C.bold}${C.magenta}📚 Skills: ${total} loaded${C.reset}`);
      categories.sort((a, b) => b.count - a.count).forEach(c => {
        console.log(`  ${C.cyan}${c.name}${C.reset} ${C.dim}(${c.count})${C.reset}`);
      });
      console.log();
      rl.prompt();
      return;
    }
    if (input === '/model') {
      console.log(`  Model: ${MODEL}`);
      rl.prompt();
      return;
    }

    // Drain notification queue before processing user input
    const pending = msgDrain(10);
    if (pending.length > 0) {
      const typeColors = { notify: C.cyan, warn: C.yellow, error: C.red, task: C.green, mcp: C.magenta, system: C.dim };
      const typeIcons = { notify: '📬', warn: '⚠️', error: '❌', task: '✅', mcp: '🔌', system: '⚙️' };
      for (const m of pending) {
        const icon = typeIcons[m.type] || '📬';
        const tc = typeColors[m.type] || C.dim;
        const time = m.ts.split('T')[1]?.split('.')[0] || m.ts;
        console.log(`  ${icon} ${tc}${m.msg}${C.reset} ${C.dim}${time}${C.reset}`);
      }
    }

    // Run agent loop (or queue if busy — with paste batching)
    if (processing) {
      // ── Multi-line paste batching ──
      // Lines arriving within the batch window get merged into one message
      // instead of queuing separately. This prevents 60-line pastes from
      // creating 60 separate agentLoop calls.
      // Key fix: use a separate object for batch state instead of attaching
      // properties to the Array (which can be lost on .length=0 reset).
      if (!_batch) _batch = { lines: [], timer: null };
      _batch.lines.push(input);
      // Show live batching feedback (overwrites previous line)
      const batchNum = _batch.lines.length;
      process.stdout.write(`\r${C.dim}⏳ Batching (${batchNum} line${batchNum !== 1 ? 's' : ''})...${C.reset}   `);
      // Reset batch window on each new line (debounce — 500ms for slow pastes)
      if (_batch.timer) clearTimeout(_batch.timer);
      _batch.timer = setTimeout(() => {
        // Batch window closed — merge all lines into one queue entry
        const lineCount = _batch.lines.length;
        const merged = _batch.lines.join('\n');
        _batch = null;
        _messageQueue.push(merged);
        // Clear the batching line, then print final queue status
        process.stdout.write(`\r${' '.repeat(60)}\r`);  // clear the "Batching..." line
        console.log(`${C.fgMuted}◇ Queued (1 batch, ${lineCount} line${lineCount !== 1 ? 's' : ''}, queue depth ${_messageQueue.length})${C.reset}`);
      }, 500);
      return;
    }
    processing = true;
    _statusFn(`${T.sparkle} Processing...`);
    startSpinner('Processing');
    (async () => {
      try {
        serverNotify(`Agent started: ${input.substring(0, 80)}`, { type: 'task', priority: 'high' });
        await agentLoop(input, history, false, { lowToken: process.env.HAKSTER_LOW_TOKEN === '1' || process.env.HAKSTER_LOW_TOKEN === 'true' });
        stopSpinner();
        console.log(`\n${C.success}${C.bold}✓ Done${C.reset} ${C.bgSubtle}${T.hashFill(20, C.success)}${C.reset}`);
        _printDoneChecklist();
        serverNotify('Agent task completed', { type: 'task', priority: 'normal' });
      } catch (err) {
        stopSpinner();
        console.log(`\n${C.error}${C.bold}× Error${C.reset} ${C.bgSubtle}${T.hashFill(10, C.error)}${C.reset}\n${C.error}${err.message}${C.reset}`);
        serverNotify(`Agent error: ${err.message}`, { type: 'error', priority: 'high' });
      }
      processing = false;
      _agentActivity = 'Idle'; _activityDetail = '';
      _statusFn('Ready');
      if (_stallGuardTimer) { clearInterval(_stallGuardTimer); _stallGuardTimer = null; }
      if (_statusBarInterval) { clearInterval(_statusBarInterval); _statusBarInterval = null; }
      process.stdout.write('\r' + ' '.repeat(80) + '\r');  // clear status bar
      startIdleTimer();
      saveSession(history); // Persist conversation for next session
      // Process queued messages — but skip if in stuck-loop cooldown
      if (_stuckCooldown > 0 && _messageQueue.length > 0) {
        // Drain up to _stuckCooldown messages from queue to prevent re-looping
        const skip = Math.min(_stuckCooldown, _messageQueue.length);
        _messageQueue.splice(0, skip);
        _stuckCooldown = 0;  // Cooldown consumed
        if (skip > 0) {
          console.log(`${C.dim}   (${skip} queued message(s) skipped — stuck-loop cooldown)${C.reset}`);
        }
      }
      if (_messageQueue.length > 0) {
        const next = _messageQueue.shift();
        handleInput(next);
      } else {
        rl.prompt();
      }
    })();
  }

  rl.on('line', handleInput);
  rl.on('close', () => {
    // Flush readline history to disk on exit
    try {
      const hist = (rl.history || []).filter(Boolean).reverse().slice(-200);
      fs.writeFileSync(HISTORY_FILE, hist.join('\n'), 'utf-8');
    } catch (_) {}
    saveSession(history);
    shutdownMcp();
    console.log('bye ⚡');
    process.exit(0);
  });

  rl.prompt();
}

// ── Export for use as module or direct run ───────────────────────────────
module.exports = { agentLoop, TOOLS, toolExecutors, banner, buildSystemPrompt, initMcpTools, shutdownMcp, msgPush, msgDrain, msgPeek, msgClear, msgSize, serverNotify, setConfirmFn, setApprovalMode, setUserId, getUserId, loadAgentsMd, getPentesterFingerprint };
function setConfirmFn(fn) { _confirmFn = fn; }
if (require.main === module) repl();
