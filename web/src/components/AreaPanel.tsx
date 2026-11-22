import { useLayoutEffect, useRef } from 'react';
import type { AreaState, AssignFailure, RoomAssignment } from '../geo';
import { AREA_TEXT } from '../ui/text';

export interface AreaPanelProps {
  area: AreaState;
  assignment: RoomAssignment;
  onShare: () => void;
  onSwitchArea: () => void;
  onRetryAssign: () => void;
  /** Shown with the denied message; only the dev build offers test locations. */
  devHint?: boolean;
}

const PRIMARY =
  'rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-strong';
const SECONDARY =
  'rounded-lg border border-field bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-sunken';

/** The message, whether to offer an action, and which one. No state exposes anything but an area code. */
type Action = 'share' | 'try-again' | 'switch' | 'retry-assign' | null;

function describeFailure(reason: AssignFailure): { text: string; action: Action } {
  switch (reason) {
    case 'unavailable':
      return { text: AREA_TEXT.locateUnavailable, action: 'retry-assign' };
    case 'offline':
      return { text: AREA_TEXT.locateOffline, action: 'retry-assign' };
    case 'bad-response':
      return { text: AREA_TEXT.locateBadResponse, action: 'retry-assign' };
    // The IdentityNotice banner offers Start over; a retry here could not help.
    case 'identity-invalid':
      return { text: AREA_TEXT.locateIdentityInvalid, action: null };
  }
}

function describe(
  area: AreaState,
  assignment: RoomAssignment,
  devHint: boolean,
): { text: string; action: Action } {
  switch (area.status) {
    case 'checking':
      return { text: AREA_TEXT.checking, action: null };
    case 'idle':
      return { text: AREA_TEXT.idle, action: 'share' };
    case 'requesting':
      return { text: AREA_TEXT.requesting, action: null };
    case 'denied':
      return {
        text: devHint ? `${AREA_TEXT.denied} ${AREA_TEXT.deniedDevHint}` : AREA_TEXT.denied,
        action: 'try-again',
      };
    case 'unavailable':
      return { text: AREA_TEXT.unavailable, action: 'try-again' };
    case 'timeout':
      return { text: AREA_TEXT.timeout, action: 'try-again' };
    case 'unsupported':
      return { text: AREA_TEXT.unsupported, action: null };
    case 'insecure-context':
      return { text: AREA_TEXT.insecure, action: null };
    case 'located':
      if (assignment.status === 'failed') return describeFailure(assignment.reason);
      if (assignment.status === 'assigning') {
        return { text: AREA_TEXT.assigning(AREA_TEXT.areaLabel(area.cell.geohash)), action: null };
      }
      return area.moved
        ? { text: AREA_TEXT.moved, action: 'switch' }
        : { text: '', action: null };
  }
}

export function AreaPanel({
  area,
  assignment,
  onShare,
  onSwitchArea,
  onRetryAssign,
  devHint = false,
}: AreaPanelProps): React.JSX.Element {
  const panelRef = useRef<HTMLElement>(null);
  const actionFocused = useRef(false);
  const { text, action } = describe(area, assignment, devHint);
  const hadAction = useRef(false);

  // When the focused action button goes away (e.g. after tapping "Share my location"), keep keyboard users here.
  useLayoutEffect(() => {
    if (hadAction.current && action === null && actionFocused.current) {
      panelRef.current?.focus({ preventScroll: true });
      actionFocused.current = false;
    }
    hadAction.current = action !== null;
  }, [action]);

  const track = {
    onFocus: () => {
      actionFocused.current = true;
    },
    onBlur: (e: React.FocusEvent<HTMLButtonElement>) => {
      // A blur caused by the button being removed must not forget that it had focus.
      if (e.currentTarget.isConnected) actionFocused.current = false;
    },
  };

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby="area-h"
      className="grid gap-2 rounded-2xl border border-line bg-surface p-3 shadow-sm sm:p-4"
    >
      <h2 id="area-h" className="m-0 text-sm font-semibold">
        {AREA_TEXT.heading}
      </h2>
      {area.status === 'located' && (
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm">
          <strong className="font-semibold">{AREA_TEXT.areaLabel(area.cell.geohash)}</strong>
          {area.source === 'dev-pin' && (
            <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
              {AREA_TEXT.testSpotBadge}
            </span>
          )}
        </p>
      )}
      <div role="status" className="m-0 text-sm text-ink-muted">
        {text}
      </div>
      {action !== null && (
        <div>
          {/* One button for every action, so focus survives share -> try again. */}
          <button
            type="button"
            className={action === 'switch' ? SECONDARY : PRIMARY}
            onClick={
              action === 'switch' ? onSwitchArea : action === 'retry-assign' ? onRetryAssign : onShare
            }
            {...track}
          >
            {action === 'share'
              ? AREA_TEXT.share
              : action === 'try-again'
                ? AREA_TEXT.tryAgain
                : action === 'retry-assign'
                  ? AREA_TEXT.retryAssign
                  : AREA_TEXT.switchArea}
          </button>
        </div>
      )}
    </section>
  );
}
