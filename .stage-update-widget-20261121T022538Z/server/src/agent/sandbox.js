// haksterAi Sandbox Module
// Restricts file writes to a specified directory tree (--writable-root).
// Read-only access outside the writable root.
// Phase 1: Path-based restriction in-process.

const path = require('path');

let _writableRoots = [];  // Array of resolved absolute paths
let _enabled = false;

function initialize(writableRoots) {
  if (!writableRoots || !Array.isArray(writableRoots) || writableRoots.length === 0) {
    _enabled = false;
    _writableRoots = [];
    return;
  }
  _writableRoots = writableRoots.map(r => path.resolve(r));
  _enabled = true;
}

function isEnabled() {
  return _enabled;
}

function getWritableRoots() {
  return _writableRoots;
}

/**
 * Check if a file path is within any writable root.
 */
function isWritable(filePath) {
  if (!_enabled) return true;  // Not restricted
  const resolved = path.resolve(filePath);
  return _writableRoots.some(root => {
    const rel = path.relative(root, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * Check if a file path is read-only (outside writable roots).
 */
function isReadOnly(filePath) {
  if (!_enabled) return false;
  return !isWritable(filePath);
}

/**
 * Validate a write operation. Throws if blocked.
 */
function validateWrite(filePath, toolName) {
  if (!_enabled) return true;
  if (!isWritable(filePath)) {
    throw new Error(`Sandbox: ${toolName || 'write'} blocked — path "${filePath}" is outside writable roots [${_writableRoots.join(', ')}]. Use --writable-root to allow.`);
  }
  return true;
}

/**
 * Check if a shell command would write outside writable roots.
 * Basic heuristic: detect file write patterns in the command.
 */
function validateShellCommand(command) {
  if (!_enabled) return { allowed: true };
  if (!command || typeof command !== 'string') return { allowed: true };

  // Detect common file-write patterns that target paths outside writable roots
  // This is a heuristic — not a full shell parser
  const writePatterns = [
    /\b(?:>|>>)\s*([^\s|&;]+)/g,      // Redirect to file
    /\btee\s+([^\s|&;]+)/g,            // tee command
    /\bdd\s+.*of=([^\s]+)/g,           // dd output
    /\bmkfs\b/g,                        // filesystem creation
    /\bmount\b/g,                       // mount
  ];

  for (const pattern of writePatterns) {
    let match;
    while ((match = pattern.exec(command)) !== null) {
      const targetPath = match[1];
      if (targetPath && !isWritable(targetPath) && !targetPath.startsWith('/dev/')) {
        return { allowed: false, reason: `Sandbox: shell command writes to read-only path "${targetPath}"` };
      }
    }
  }

  return { allowed: true };
}

module.exports = {
  initialize,
  isEnabled,
  getWritableRoots,
  isWritable,
  isReadOnly,
  validateWrite,
  validateShellCommand,
};