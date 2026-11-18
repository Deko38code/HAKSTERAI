'use strict';
/**
 * Secret redaction for build logs.
 *
 * Build output is stored so failures can be diagnosed later, which also means
 * it is stored at rest. Anything that looks like a credential is replaced
 * before the line is written — not masked at display time, because display
 * filters are easy to forget and the file would already hold the value.
 *
 * The rule set is deliberately blunt: a false positive costs one unreadable
 * log line, a false negative costs a leaked key.
 */

const RULES = [
  // provider key shapes
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}\b/g, '[REDACTED_STRIPE_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_GOOGLE_KEY]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_TELEGRAM_TOKEN]'],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  // key=value / key: value for credential-ish names
  [/\b(api[_-]?key|secret|token|passwd|password|passphrase|authorization|bearer)\b(\s*[:=]\s*)(["']?)([^\s"',}]{6,})\3/gi,
    (m, name, sep, q) => `${name}${sep}${q}[REDACTED]${q}`],
  // long opaque hex (>=32) — almost always a key or a signed value
  [/\b[0-9a-f]{32,}\b/gi, '[REDACTED_HEX]'],
  // env dumps
  [/^([A-Z0-9_]{3,})=(.*)$/gm, (m, name, value) => {
    if (!/(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|DSN|AUTH)/.test(name)) return m;
    return `${name}=[REDACTED]`;
  }],
];

function redactLine(line) {
  let out = String(line);
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

function redactLines(lines, max = 400) {
  return (lines || []).slice(-max).map(redactLine);
}

module.exports = { redactLine, redactLines };
