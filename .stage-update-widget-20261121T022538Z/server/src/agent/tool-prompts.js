'use strict';
/**
 * Per-tool behavioral prompts (G1.1 fill) — mirrors Claude Code per-tool prompt files.
 * Weak models pick the wrong tool or emit wrong args when the only guidance is a
 * one-line description. These compact contracts are injected into the system prompt
 * ONLY for tools that exist, keeping them cheap.
 */
const TOOL_PROMPTS = {
  read_file: `Read files BEFORE editing or claiming anything about them. For big files pass offset/limit instead of guessing. Never edit a file you have not read this session.`,
  edit_file: `Surgical edits only. Match the file's existing style and quoting. If the target line may have changed, re-read first. Never reformat whole files — change only the lines you need.`,
  write_file: `Full overwrite. Read the file first unless creating new. For >100-line rewrites prefer several small edit_file calls so history stays reviewable.`,
  apply_patch: `Give a 1-line reason per hunk. Never mix unrelated changes into one patch; separate hunks, separate turns.`,
  exec_shell: `One command, one purpose. ALWAYS use absolute paths, never assume cwd. Pipe through head/tail/timeout to bound output; never run anything that streams forever. Check exit codes before claiming success.`,
  shell_bg: `Long-running servers/watchers: start under PM2 (pm2 start=name) or nohup, never a bare blocking command. Verify with a curl/health check before reporting success.`,
  search_files: `Search with tight patterns + globs (exclude node_modules/.git/data or logs). Escalate from exact to fuzzy only after an exact search misses.`,
  glob_search: `Prefer glob over shell ls/find. Pair with search_files: first locate the file, then read the narrow range.`,
  list_dir: `Use to orient, not to browse. If you need file contents, read_file with offset/limit beats dumping a directory.`,
  update_todo: `Call BEFORE starting work and after completing each step. Keep ≤10 live items, exact one-line texts, statuses pending|in_progress|done|blocked. One in_progress item max; insert new items as you get instructions. This list is re-read every turn — it IS your memory of the plan.`,
  sub_agent: `Delegate ONLY independent, self-contained subtasks. Write each assignment with every requirement the subtask needs — subagents read NO parent context except what you include in the goal. Never trust a subagent's claim you can verify with a tool. Cap: 3 concurrent; each 4min max.`,
  spawn_agent: `Same contract as sub_agent. Pass agent_type when the task matches a roster role. One goal per agent; merge findings yourself.`,
  web_search: `Use when speed matters less than grounding — check multiple sources before stating facts. Prefer primary sources (docs, registries). Cite URLs in your final answer.`,
  web_fetch: `Static pages only — for JS-heavy pages use firecrawl_scrape. Extract exactly what you need, do not paste entire pages into context.`,
  save_memory: `Save durable facts only (decisions, runbook steps, ports, conventions). Never store tokens, playlist URLs, cookies, or user identifiers. One fact per key so updates stay surgical.`,
  recall_memory: `Recall BEFORE re-diagnosing anything environmental (ports, services, prior failures). If recall returns stale data, verify with a live command before acting.`,
  firecrawl_scrape: `For JS-rendered sites and structured extraction. Always pass the narrowest URL; avoid scraping pages you already have cached results for.`,
  browser_snapshot: `Prefer observe/snapshot over screenshots; screenshot only to judge appearance. Re-observe after navigations — refs die on re-render.`,
  guardian: `Every destructive command (rm -rf, systemctl stop, git push --force, pm2 delete on a healthy app) requires an explicit guardian pass. State blast radius in one line first.`,
  codebase_index: `Call before edits in an unfamiliar repo, after file:line goes stale, and when the project map may be outdated. Cheaper than re-grepping the tree by hand.`,
  git_commit: `Requires a run of passing checks (syntax/test/smoke) IN THIS SESSION — never claim those results without having run them. Commit messages: imperative, ≤72 chars, no markdown.`,
};

function injectToolPrompts(tools, sysPrompt) {
  try {
    const names = new Set((tools || []).map(t => t.function && t.function.name).filter(Boolean));
    const lines = [];
    for (const [name, text] of Object.entries(TOOL_PROMPTS)) {
      if (names.has(name)) lines.push(`### ${name}\n${text}`);
    }
    if (!lines.length) return sysPrompt;
    return sysPrompt + '\n\n═══ TOOL CONTRACTS (how to use your tools correctly) ═══\n'
      + lines.join('\n') + '\n═══ END TOOL CONTRACTS ═══';
  } catch (_) {
    return sysPrompt;
  }
}

module.exports = { TOOL_PROMPTS, injectToolPrompts };