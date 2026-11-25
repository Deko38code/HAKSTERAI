/* Web-tool counting for the ◔ Usage panel.
 *
 * Owner 2026-11-24: "we need to add web tool usage in the usage panel in right
 * of our cli just for our count". The panel already counts every tool call; this
 * is the subset that actually reached out to the web (search, fetch, scrape,
 * crawl), counted from the same streamed `tool_call_start` events the transcript
 * renders — a real count of calls made, never an estimate (§10).
 *
 * Kept as a pure function so the name matching is pinned by a test instead of
 * eyeballed in a terminal: the CLI's own tools arrive bare (`web_search`), MCP
 * tools arrive as `mcp__<server>__<tool>` (`mcp__hakster__hakster_scrape`), and
 * a server rename must not silently stop the count.
 */

/** Bare tool names that mean "this call went to the web". */
const WEB_TOOLS = new Set([
  // The CLI's own research tools. All three spellings count, because all three
  // really run: the short XML names (`<tool name="web">`, `<tool name="fetch">`),
  // the `hak_*` aliases, and the JSON tool-definition names sent on the
  // claude-cli lane. Only the last pair was matched before, so a session that
  // searched the web through the CLI itself counted 0 (owner, 2026-11-25:
  // "our web tool counter in cli aint registering count").
  'web',
  'fetch',
  'hak_web',
  'hak_fetch',
  'search_web',
  'fetch_url',
  'web_search',
  'websearch',
  'web_fetch',
  'webfetch',
  // Firecrawl family (cli/tools.js proxies these through /api/agent/firecrawl)
  'firecrawl',
  'firecrawl_scrape',
  'firecrawl_search',
  'firecrawl_crawl',
  'firecrawl_map',
  'firecrawl_extract',
  // Hakster scraper service
  'hakster_scrape',
  'hakster_scrape_status',
  // Stealth / bypass fetchers — each one pulls a real page over the network.
  'stealth_navigate',
  'cloudscraper_fetch',
  'get_page_content',
  'squad_browser_bridge',
]);

/** Browser-automation verbs that never touch the network. Everything else a
 *  browser tool does is driving a live page, which is web usage. */
const BROWSER_LOCAL_ONLY = new Set([
  'browser_close',
  'browser_resize',
  'browser_tabs',
  'browser_console_messages',
]);

/** The tool's bare name: `mcp__hakster__hakster_scrape` → `hakster_scrape`. */
export function bareToolName(name) {
  const raw = String(name == null ? '' : name).trim().toLowerCase();
  if (!raw) return '';
  const parts = raw.split('__');
  return parts[parts.length - 1] || raw;
}

/** True when a tool call is a web search / fetch / scrape / crawl / browse. */
export function isWebTool(name) {
  const bare = bareToolName(name);
  if (!bare) return false;
  if (WEB_TOOLS.has(bare)) return true;
  // Browser automation (Playwright, the hakster bridge) counts as web usage —
  // it loads and drives real pages (owner, 2026-11-25: "playwright is a web
  // tool right"). The local lifecycle verbs above are the only exceptions,
  // because they never leave the machine.
  if (/^browser_/.test(bare)) return !BROWSER_LOCAL_ONLY.has(bare);
  // A renamed or namespaced variant of a crawl/scrape still counts: the verb is
  // what makes it web usage, not the exact prefix it was registered under.
  return /^(?:firecrawl|web)_(?:search|fetch|scrape|crawl|map|extract)$/.test(bare)
    || /^(?:scrape|crawl)_/.test(bare);
}

/** How many of the given tool calls (`{ name }`) went to the web. */
export function countWebCalls(tools) {
  if (!Array.isArray(tools)) return 0;
  let n = 0;
  for (const call of tools) {
    if (call && isWebTool(call.name)) n += 1;
  }
  return n;
}

/** How many web calls a list of transcript messages made in total. */
export function countWebCallsInMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    if (m && Array.isArray(m.tools)) n += countWebCalls(m.tools);
  }
  return n;
}
