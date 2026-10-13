import React, { useEffect, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { TextAttributes } from '@opentui/core';
import { getDangerPassword, isSudoCommand } from '../utils/danger-password.js';

/* ApprovalPrompt — the gate the server parks a run behind.
 *
 * This is the one place in the TUI that draws something the user MUST answer.
 * The server has already stopped and is holding the stream open against a
 * five-minute timer that auto-denies, so unlike every other panel here this one
 * is not decorative and cannot be dismissed with a glance.
 *
 * It owns its own keys, like DockAd does, because the answer is the whole point
 * of its existence and routing it through the parent's shortcut layer would put
 * it behind the composer's focus check. App suppresses its own shortcut layer
 * while this is mounted, so `y` here can never also toggle ads.
 *
 * Three answers, because two are not enough once the consequences differ:
 *   y — allow for this session
 *   a — allow and persist it to the server's allowlist
 *   n / esc — deny
 * The text CLI sends neither `permanent` nor a session scope, and so allowlists
 * forever on a single yes; asking which one you meant is the improvement.
 *
 * A sudo command is a stricter case. When an approval password is configured the
 * literal password is required, entered masked — approving elevated execution
 * with a bare `y` would make the password setting decorative. A wrong password
 * does not deny the request, it just refuses that attempt, because denying on a
 * typo would let a mistyped character destroy the run. Without a password
 * configured, a sudo command still demands an explicit `y` rather than any
 * keystroke, which is at least as strict as the CLI's behaviour.
 */
export default function ApprovalPrompt({ width = 80, request, onAnswer }) {
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);

  const command = (request && request.command) || '';
  const toolCallId = request && request.toolCallId;
  const sudo = isSudoCommand(command);
  const dangerPassword = getDangerPassword();
  const needsPassword = sudo && !!dangerPassword;

  // A new request is a new question: never leave a half-typed password or a
  // stale "wrong password" note in front of the next one.
  useEffect(() => {
    setPassword('');
    setWrong(false);
  }, [toolCallId]);

  // OpenTUI's <input> has no `mask` prop, so the field is drawn from asterisks
  // and its keys are handled here. Without this the sudo approval password
  // would be echoed in plaintext, which defeats the point of the gate. The
  // password is only ever compared in this component; the server is told a
  // boolean, never the secret.
  function submitPassword(value) {
    if (value === dangerPassword) {
      onAnswer(true, { permanent: false });
    } else {
      // Clear the field rather than leaving the failed attempt in it: a
      // near-miss secret sitting on screen is both a shoulder-surfing leak and
      // a nuisance to retype around.
      setPassword('');
      setWrong(true);
    }
  }

  useKeyboard((key) => {
    if (!request) return;

    if (key.name === 'escape') {
      onAnswer(false, { permanent: false });
      return;
    }
    // While a password is being typed every printable key belongs to the
    // masked field; only escape (above) is ours.
    if (needsPassword) {
      const name = key.name ? String(key.name) : '';
      if (name === 'return') {
        submitPassword(password);
      } else if (name === 'backspace' || name === 'delete') {
        if (wrong) setWrong(false);
        setPassword((prev) => prev.slice(0, -1));
      } else if (name.length === 1) {
        if (wrong) setWrong(false);
        setPassword((prev) => prev + name);
      }
      return;
    }

    const k = key.name ? String(key.name).toLowerCase() : '';
    if (k === 'y') onAnswer(true, { permanent: false });
    else if (k === 'n') onAnswer(false, { permanent: false });
    // Not offered for a sudo command on purpose, and not honoured either: a
    // permanent allowlist entry for elevated execution is precisely what the
    // password gate exists to prevent, so the key must not be stricter on the
    // screen than it is in the handler.
    else if (k === 'a' && !sudo) onAnswer(true, { permanent: true });
  });

  if (!request) return null;

  const inner = Math.max(8, (width || 80) - 4);

  return (
    <box
      style={{
        width,
        flexDirection: 'column',
        border: true,
        borderStyle: 'rounded',
        borderColor: sudo ? 'red' : 'yellow',
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box style={{ width: inner, justifyContent: 'space-between' }}>
        <text fg={sudo ? 'red' : 'yellow'} attributes={TextAttributes.BOLD}>
          {sudo ? 'sudo approval required' : 'approval required'}
        </text>
        <text fg="gray">{request.toolName}</text>
      </box>

      <text fg="gray">{request.reason}</text>
      {command ? (
        <text>
          <span fg="gray">{'$ '}</span>
          {String(command).slice(0, Math.max(8, inner - 2))}
        </text>
      ) : null}

      {needsPassword ? (
        <>
          <box style={{ width: inner, flexDirection: 'row' }}>
            <text fg="yellow" attributes={TextAttributes.BOLD}>{'password '}</text>
            <text fg={password ? 'white' : 'gray'}>
              {password ? '*'.repeat(password.length) : 'the agent approval password'}
            </text>
          </box>
          {wrong ? (
            <text fg="red">wrong password — try again, or esc to deny</text>
          ) : null}
          <text fg="gray">enter approves · esc denies</text>
        </>
      ) : (
        <text>
          <span fg="green" attributes={TextAttributes.BOLD}>y</span>
          <span fg="gray">{' allow this session  · '}</span>
          {!sudo ? (
            <>
              <span fg="cyan" attributes={TextAttributes.BOLD}>a</span>
              <span fg="gray">{' allow always  · '}</span>
            </>
          ) : null}
          <span fg="red" attributes={TextAttributes.BOLD}>n</span>
          <span fg="gray">{' deny'}</span>
        </text>
      )}
    </box>
  );
}