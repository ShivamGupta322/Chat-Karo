export interface SocketCloseInput {
  code: number;
  reason: string;
  wasClean: boolean;
  visibility: DocumentVisibilityState;
  hiddenForMs: number | null;
  msSinceVisible: number | null;
}

export interface SocketCloseLog {
  code: number;
  reason: string;
  wasClean: boolean;
  hidden: boolean;
  hiddenForMs: number | null;
  /** Ms since the last hidden to visible transition (a frozen tab delivers its close late), or null. */
  msSinceVisible: number | null;
}

/** The diagnostic record for an unexpected WebSocket close. Nothing else may be added (privacy). */
export function describeSocketClose(i: SocketCloseInput): SocketCloseLog {
  return {
    code: i.code,
    // The server's close reason is free text; a WebSocket close reason is at most 123 bytes anyway.
    reason: i.reason.slice(0, 123),
    wasClean: i.wasClean,
    hidden: i.visibility === 'hidden',
    hiddenForMs: i.hiddenForMs,
    msSinceVisible: i.msSinceVisible,
  };
}
