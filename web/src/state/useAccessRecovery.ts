import { useCallback, useEffect, useRef, useState } from 'react';
import type { JoinFailure, XmppClient } from '../xmpp/types';
import { useRoomStore } from './room';

/**
 * Join failures that mean "the server does not know you may enter this room" (ADR-020): after a MongooseIM
 * restart the rooms are unloaded and only geo_service may load them, so the join is refused until the client
 * locates again.
 */
export const ACCESS_FAILURES: ReadonlySet<JoinFailure> = new Set<JoinFailure>([
  'registration-required',
  'not-allowed',
]);

export type RecoveryPhase = 'idle' | 'recovering' | 'exhausted';

/** Structurally the same as geo's RefreshOutcome; state/ does not import geo/. */
type RefreshOutcome = 'assigned' | 'failed' | 'superseded';

/**
 * One automatic recovery per desired room: on an access failure, ask geo_service again (refresh) and join
 * again once. A second access failure before a successful join is `exhausted`: the UI offers a manual retry
 * (`recover`), never a loop.
 */
export function useAccessRecovery(o: {
  client: XmppClient;
  desired: string | null;
  nick: string;
  refresh: () => Promise<RefreshOutcome>;
}): { phase: RecoveryPhase; recover: () => void } {
  const { client, desired, nick, refresh } = o;
  const [phase, setPhase] = useState<RecoveryPhase>('idle');
  const roomJid = useRoomStore((s) => s.roomJid);
  const status = useRoomStore((s) => s.status);
  const reason = useRoomStore((s) => s.failure?.reason ?? null);

  const attempts = useRef(0);
  const phaseRef = useRef<RecoveryPhase>('idle');
  const lastDesired = useRef<string | null>(null);
  const mounted = useRef(false);
  // Latest props for the async continuation (the refresh promise outlives renders).
  const latest = useRef({ client, desired, nick, refresh });
  latest.current = { client, desired, nick, refresh };

  const changePhase = useCallback((next: RecoveryPhase): void => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    (jid: string): void => {
      attempts.current = 1;
      changePhase('recovering');
      void latest.current.refresh().then((outcome) => {
        if (!mounted.current) return;
        const stillHere = latest.current.desired === jid;
        const store = useRoomStore.getState();
        if (outcome === 'assigned' && stillHere && store.roomJid === jid && store.status === 'failed') {
          latest.current.client.joinRoom(jid, latest.current.nick);
          changePhase('idle');
          return;
        }
        // Failed or superseded: nothing was rejoined, so the next access failure may try again. Reset even when
        // `desired` already went null: the assigner's fail() clears the room before this continuation runs, and
        // its own retry brings the same room back (ADR-020). A different room resets attempts anyway.
        attempts.current = 0;
        changePhase('idle');
      });
    },
    [changePhase],
  );

  useEffect(() => {
    // A different (non-null) room starts afresh; moving to "no room" and back to the same one does not.
    if (desired !== null && desired !== lastDesired.current) {
      lastDesired.current = desired;
      attempts.current = 0;
      if (phaseRef.current !== 'idle') changePhase('idle');
    }
    if (desired === null || roomJid !== desired) return;
    if (status === 'joined') {
      attempts.current = 0;
      if (phaseRef.current !== 'idle') changePhase('idle');
      return;
    }
    if (status !== 'failed' || reason === null || !ACCESS_FAILURES.has(reason)) return;
    if (phaseRef.current === 'recovering') return;
    if (attempts.current === 0) run(desired);
    else if (phaseRef.current !== 'exhausted') changePhase('exhausted');
  }, [desired, roomJid, status, reason, run, changePhase]);

  const recover = useCallback((): void => {
    const jid = latest.current.desired;
    if (jid === null || phaseRef.current === 'recovering') return;
    run(jid);
  }, [run]);

  return { phase, recover };
}
