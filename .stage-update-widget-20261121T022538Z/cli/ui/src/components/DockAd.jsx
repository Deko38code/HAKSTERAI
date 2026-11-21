import React, { useEffect, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { TextAttributes } from '@opentui/core';
import client from '../../../src/ads/ad-client.js';
import { getInlineAdLayout, wrapToLines } from '../../../src/ads/inline-ad-layout.js';

/* DockAd — the sponsored slot, in its collapsed and expanded form.
 *
 * Freebuff draws this with an `arm` of either 'control' (one line, always the
 * same) or 'expandable' (a chord opens a panel). Both arms are here, because
 * the interesting part is not the extra rows — it is that expanding must not
 * change what was billed. The ad is fetched and its impression acknowledged
 * exactly once per held answer, by ad-cache, no matter how many times the panel
 * is toggled. This component only decides how a fitted ad looks; it never
 * decides when to ask or when to bill.
 *
 * Click handling lives here rather than in the parent because the ad object
 * does: the parent flips `expanded`, but only this component knows which
 * creative is on screen and therefore which impression the receipt belongs to.
 * Without an `impUrl` there is nothing to bill, so a click on one is refused
 * rather than reported.
 */
export default function DockAd({
  width = 80,
  placementId,
  enabled = true,
  focused = false,
  expanded = false,
}) {
  const [ad, setAd] = useState(null);
  // 'loading' rather than 'idle': claiming there is no ad before the first
  // request has been made is a lie the operator sees for a frame.
  const [state, setState] = useState('loading'); // loading | filled | none | off
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setState('off');
      return;
    }
    let cancelled = false;
    setState('loading');
    client
      .getPlacementAd(placementId, { width, shell: process.env.SHELL || null })
      .then((fetched) => {
        if (cancelled) return;
        if (fetched) {
          setAd(fetched);
          setState('filled');
          // Safe to call on every mount: ad-cache's once-per-held-answer rule is
          // module-level, so a remount cannot double-count an impression. The
          // migration to OpenTUI dropped this call, which silently stopped the
          // impression receipt reaching /api/ads/impression.
          client.ackImpression(fetched);
        } else {
          setAd(null);
          setState('none');
        }
      })
      .catch(() => {
        if (cancelled) return;
        setAd(null);
        setState('none');
      });
    return () => {
      cancelled = true;
    };
  }, [placementId, enabled, width]);

  // Enter is the click receipt, and it only fires while this slot holds focus —
  // otherwise every Enter meant for the composer would bill an advertiser.
  useKeyboard((key) => {
    if (!focused || !ad) return;
    if (key.name === 'return') {
      if (ad.impUrl) {
        setOpened(true);
        client.recordClick(ad);
      }
    }
  });

  if (!enabled || state === 'off') {
    return null;
  }

  if (state === 'loading') {
    return (
      <box style={{ width, paddingLeft: 1, paddingRight: 1 }}>
        <text fg="gray">{'…'}</text>
      </box>
    );
  }

  if (!ad) {
    return (
      <box style={{ width, paddingLeft: 1, paddingRight: 1 }}>
        <text fg="gray">{'—'}</text>
      </box>
    );
  }

  const { title, description, label } = getInlineAdLayout(ad, width);

  if (!expanded) {
    return (
      <box style={{ width, flexDirection: 'row', paddingLeft: 1, paddingRight: 1 }}>
        <text fg={focused ? 'cyan' : 'gray'} attributes={TextAttributes.BOLD}>
          {focused ? '▸ ' : '  '}
        </text>
        <text fg="white">{title}</text>
        {description ? <text fg="gray">{` — ${description}`}</text> : null}
        {label ? <text fg="cyan">{` ${label}`}</text> : null}
        {focused ? <text fg="gray">{'  enter open'}</text> : null}
      </box>
    );
  }

  // The expanded panel word-wraps the body rather than trusting it: an
  // advertiser's copy can contain a URL longer than the terminal, and an
  // unwrapped one pushes the border off-screen.
  const bodyWidth = Math.max(8, width - 6);
  const bodyLines = wrapToLines(ad.adText || description, bodyWidth, 3);

  return (
    <box
      style={{
        width,
        flexDirection: 'column',
        border: true,
        borderStyle: 'rounded',
        borderColor: focused ? 'cyan' : 'gray',
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <text fg="cyan" attributes={TextAttributes.BOLD}>{title}</text>
        {label ? <text fg="gray">{label}</text> : null}
      </box>
      {bodyLines.map((line, i) => (
        <text key={`body-${i}`} fg="white">{line}</text>
      ))}
      {ad.impUrl ? (
        <text fg="cyan">{ad.impUrl}</text>
      ) : null}
      <text fg="gray">{focused ? '^O collapse · enter visit' : '^O collapse'}</text>
    </box>
  );
}