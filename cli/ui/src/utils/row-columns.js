/* row-columns — how a catalog row splits its width between name and detail.
 *
 * Pure and on its own so it can be pinned by a test. It exists because the same
 * defect has now been fixed twice by hand: a name clipped (`● clau…`) while
 * columns of empty space sat beside it. The rule, kept in one place:
 *
 *   - a name that fits beside at least two columns of detail is NEVER clipped —
 *     the detail is the thing that shortens;
 *   - only a genuinely long name falls back to a half split;
 *   - label + space + detail never exceed the body width, so a row can never
 *     shear the popout's right border or push the scroll gutter off the line.
 */
export const MIN_DETAIL = 2; // columns of detail worth keeping before the name gives way
export const MIN_LABEL = 8;

/** Widths for one row: { labelW, valueW }. `valueW` is 0 when there is no
 *  detail to draw (compact mode, a row with none, or a body too narrow for
 *  both — in which case the name wins, because the name is what identifies the
 *  row). */
export function splitRowColumns(labelText, detailText, bodyW) {
  const body = Math.max(8, Math.trunc(Number(bodyW) || 0));
  const label = String(labelText == null ? '' : labelText);
  const detail = String(detailText == null ? '' : detailText);
  if (!detail) return { labelW: body, valueW: 0 };

  if (label.length + 1 + MIN_DETAIL <= body) {
    return { labelW: label.length, valueW: Math.min(detail.length, body - label.length - 1) };
  }

  const valueW = Math.min(detail.length, Math.max(0, Math.floor(body / 2)));
  const labelW = body - (valueW ? valueW + 1 : 0);
  if (labelW >= MIN_LABEL) return { labelW, valueW };
  return { labelW: body, valueW: 0 };
}
