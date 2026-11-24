/* Tests for the ◔ Usage panel's web-call counter.
 *
 * The panel row is only as honest as this count, so the name matching is pinned
 * here: the CLI's bare names, the MCP `mcp__server__tool` form, renamed scrape/
 * crawl variants, and the tools that must NOT count (browser automation, plain
 * shell, file reads).
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

test('non-web tools never count', () => {
  for (const name of [
    'bash',
    'read_file',
    'write_file',
    'glob_search',
    'search_files',
    'mcp__playwright__browser_navigate',
    'browser_click',
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
