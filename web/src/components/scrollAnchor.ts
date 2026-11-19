export interface ScrollSnapshot {
  /** key of the first rendered row before the update, null when the list was empty */
  firstKey: string | null;
  /** that row's offsetTop before the update */
  firstTop: number;
}

/**
 * Returns the scrollTop to apply after a render, or null to leave it alone. Pure: no DOM access.
 * 1. An earlier page just landed and the old first row is no longer first: keep that row where it was.
 *    This wins over stick-to-bottom for this render, and also absorbs the earlier block's own height change.
 * 2. Otherwise, when stuck to the bottom, follow the bottom.
 * 3. Otherwise leave the scroll position alone.
 */
export function nextScrollTop(a: {
  prev: ScrollSnapshot;
  firstKeyNow: string | null;
  /** current offsetTop of the row whose key is prev.firstKey, null if it is gone */
  prevKeyTopNow: number | null;
  earlierJustLoaded: boolean;
  stick: boolean;
  scrollTop: number;
  scrollHeight: number;
}): number | null {
  if (
    a.earlierJustLoaded &&
    a.prev.firstKey !== null &&
    a.firstKeyNow !== a.prev.firstKey &&
    a.prevKeyTopNow !== null
  ) {
    return a.scrollTop + (a.prevKeyTopNow - a.prev.firstTop);
  }
  if (a.stick) return a.scrollHeight;
  return null;
}
