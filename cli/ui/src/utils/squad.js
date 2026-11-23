/* The sub-agent roster, derived from the server's own mcp-status payload.
 *
 * Kept out of the view so it can be unit-tested without a renderer: a peer is
 * listed only because the server reported it, and a tool is shown only because
 * the server said the server has it.
 */
const PEER_PATTERN = /agent|squad|subagent|codex|kiro|phantom|hermes|claude-code|hivemind|miniforge|serena|stealth|bounty/i;

/* What mcpStatus() actually reports per server: `initialized` (a child process
 * answered the handshake), `lazy` (registered with its tools, spawns on the
 * first call) and `toolCount`. A tool count alone does NOT mean connected — a
 * lazy server lists its tools from a probe — so "up" is initialized and
 * nothing else. */
const RANK = { live: 0, lazy: 1, down: 2 };

/** Build the peer list from an mcp-status payload. */
export function peersFromMcp(mcp) {
  const servers = mcp && Array.isArray(mcp.servers) ? mcp.servers : [];
  return servers
    .filter((s) => s && s.name && PEER_PATTERN.test(s.name))
    .map((s) => {
      const state = s.initialized ? 'live' : s.lazy ? 'lazy' : 'down';
      return {
        name: s.name,
        tools: Array.isArray(s.tools) ? s.tools : [],
        up: state === 'live',
        lazy: !!s.lazy,
        state,
      };
    })
    .sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name));
}

