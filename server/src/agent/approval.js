// haksterAi Approval Mode Module
// Controls whether dangerous commands require confirmation or bypass automatically.
// Modes: 'suggest' (default, confirm dangerous), 'auto-edit' (auto-approve file ops, confirm dangerous shell), 'full-auto' (never confirm)

const SUGGEST  = 'suggest';
const AUTO_EDIT = 'auto-edit';
const FULL_AUTO = 'full-auto';

const VALID_MODES = new Set([SUGGEST, AUTO_EDIT, FULL_AUTO]);

const SHELL_TOOLS = new Set(['shell', 'exec_shell', 'shell_bg', 'parallel_shell', 'run_background']);
const FILE_TOOLS = new Set(['write_file', 'edit_file', 'replace_in_file', 'apply_patch', 'patch_file', 'multi_patch', 'insert_lines', 'delete_lines', 'replace_regex', 'append_file']);

function shouldConfirm(approvalMode, toolName, args, dangerReason) {
  if (approvalMode === FULL_AUTO) return false;
  if (approvalMode === AUTO_EDIT) {
    // In auto-edit mode, auto-approve file operations
    if (FILE_TOOLS.has(toolName)) return false;
    // Confirm dangerous shell commands
    if (SHELL_TOOLS.has(toolName) && dangerReason) return true;
    // Auto-approve non-dangerous shell commands
    if (SHELL_TOOLS.has(toolName)) return false;
    // Confirm anything else flagged as dangerous
    return !!dangerReason;
  }
  // SUGGEST mode: confirm anything dangerous
  return true;
}

function validateMode(mode) {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid approval mode: "${mode}". Must be one of: ${[...VALID_MODES].join(', ')}`);
  }
  return mode;
}

module.exports = { SUGGEST, AUTO_EDIT, FULL_AUTO, VALID_MODES, SHELL_TOOLS, FILE_TOOLS, shouldConfirm, validateMode };
