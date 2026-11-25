/* Tests for the ◔ Usage panel's web-call counter.
 *
 * The panel row is only as honest as this count, so the name matching is pinned
 * here: the CLI's bare names in every spelling it emits (`web`, `hak_web`,
 * `search_web`), the MCP `mcp__server__tool` form, browser automation, renamed
 * scrape/crawl variants, and the tools that must NOT count (plain shell, file
 * reads, and the browser's local lifecycle verbs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bareToolName,
  isWebTool,
  countWebCalls,
  countWebCallsInMessages,
} from '../src/utils/web-usage.js';

test('bareToolName strips the MCP namespace', () => {
  assert.equal(bareToolName('mcp__hakster__hakster_scrape'), 'hakster_scrape');
  assert.equal(bareToolName('web_search'), 'web_search');
  assert.equal(bareToolName(null), '');
});

test('the CLI and MCP web tools count', () => {
  for (const name of [
    'web_search',
    'web_fetch',
    'firecrawl',
    'firecrawl_scrape',
    'firecrawl_search',
    'hakster_scrape',
    'mcp__hakster__hakster_scrape',
    'mcp__firecrawl__firecrawl_search',
    'firecrawl_crawl',
    'scrape_page',
  ]) {
    assert.equal(isWebTool(name), true, `${name} should count as web usage`);
  }
});

test("the CLI's own spellings count, not just the JSON names", () => {
  // These are the names the CLI really emits — the short XML parser names, the
  // hak_* aliases and the JSON tool definitions. A session that searched the web
  // through the CLI counted 0 while only web_search/web_fetch were matched
  // (owner, 2026-11-25: "our web tool counter in cli aint registering count").
  for (const name of ['web', 'fetch', 'hak_web', 'hak_fetch', 'search_web', 'fetch_url']) {
    assert.equal(isWebTool(name), true, `${name} should count as web usage`);
  }
});

test('browser automation counts as web usage', () => {
  // Owner, 2026-11-25: "playwright is a web tool right" — driving a real page is
  // web usage, and the count must register it.
  for (const name of [
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_take_screenshot',
    'mcp__playwright__browser_navigate',
    'mcp__hakster__browser_navigate',
    'stealth_navigate',
    'cloudscraper_fetch',
    'get_page_content',
  ]) {
    assert.equal(isWebTool(name), true, `${name} should count as web usage`);
  }
  // …but the local lifecycle verbs never leave the machine, so they must not.
  for (const name of ['browser_close', 'browser_resize', 'browser_tabs', 'browser_console_messages']) {
    assert.equal(isWebTool(name), false, `${name} must not count as web usage`);
  }
});

test('non-web tools never count', () => {
  for (const name of [
    'bash',
    'read_file',
    'write_file',
    'glob_search',
    'search_files',
    'run_command',
    'run',
    'read',
    'search',
    'update_todo',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isWebTool(name), false, `${String(name)} must not count as web usage`);
  }
});

test('countWebCalls counts only web calls, tolerating junk rows', () => {
  const tools = [
    { name: 'web_search' },
    { name: 'bash' },
    null,
    { name: 'mcp__hakster__hakster_scrape' },
    { name: 'firecrawl_scrape' },
    { notAName: true },
  ];
  assert.equal(countWebCalls(tools), 3);
  assert.equal(countWebCalls(null), 0);
});

test('countWebCallsInMessages sums web calls across every turn', () => {
  const messages = [
    { role: 'user', tools: [] },
    { role: 'assistant', tools: [{ name: 'web_fetch' }, { name: 'bash' }] },
    { role: 'assistant', tools: [{ name: 'web_search' }, { name: 'web_search' }] },
    { role: 'assistant' },
    null,
  ];
  assert.equal(countWebCallsInMessages(messages), 3);
  assert.equal(countWebCallsInMessages(undefined), 0);
});
