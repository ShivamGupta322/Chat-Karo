import { useState, type FormEvent } from 'react';
import type { RoomState } from '../state/room';
import { toRoomJid } from '../ui/addresses';
import { describeAddressError, describeJoinFailure } from '../ui/text';
import { normalizeNick } from '../xmpp';

export interface RoomFormProps {
  defaultRoom: string;
  defaultNick: string;
  mucDomain: string;
  status: RoomState['status'];
  onJoin: (roomJid: string, nick: string) => void;
  onLeave: () => void;
}

const INPUT =
  'w-full min-w-0 rounded-lg border border-field bg-surface px-3 py-2 text-ink disabled:bg-surface-sunken';

export function RoomForm({
  defaultRoom,
  defaultNick,
  mucDomain,
  status,
  onJoin,
  onLeave,
}: RoomFormProps): React.JSX.Element {
  const [room, setRoom] = useState(defaultRoom);
  const [nick, setNick] = useState(defaultNick);
  const [error, setError] = useState<string | null>(null);
  const active = status === 'joining' || status === 'joined';

  const handle = (e: FormEvent): void => {
    e.preventDefault();
    const res = toRoomJid(room, mucDomain);
    if (!res.ok) {
      setError(describeAddressError('room', res.error, mucDomain));
      return;
    }
    const n = normalizeNick(nick);
    if (n === null) {
      setError(describeJoinFailure('invalid-nick'));
      return;
    }
    setError(null);
    onJoin(res.jid, n);
  };

  return (
    <form
      onSubmit={handle}
      className="grid gap-3 rounded-2xl border border-line bg-surface p-3 shadow-sm sm:p-4"
      aria-labelledby="room-form-h"
    >
      <h2 id="room-form-h" className="m-0 text-sm font-semibold">
        Room (dev)
      </h2>
      <div className="grid gap-3 sm:flex sm:flex-wrap sm:items-start">
        <div className="grid min-w-0 gap-1 text-sm sm:min-w-32 sm:flex-1">
          <label htmlFor="room-name" className="font-medium">
            Room
          </label>
          <input
            id="room-name"
            className={INPUT}
            value={room}
            disabled={active}
            aria-describedby="room-hint"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => {
              setRoom(e.target.value);
            }}
          />
          <span id="room-hint" className="text-xs text-ink-muted">
            Room name, e.g. lobby
          </span>
        </div>
        <div className="grid min-w-0 gap-1 text-sm sm:min-w-32 sm:flex-1">
          <label htmlFor="room-nick" className="font-medium">
            Your name
          </label>
          <input
            id="room-nick"
            className={INPUT}
            value={nick}
            disabled={active}
            aria-describedby="nick-hint"
            onChange={(e) => {
              setNick(e.target.value);
            }}
          />
          <span id="nick-hint" className="text-xs text-ink-muted">
            Shown to others in the room
          </span>
        </div>
        <div className="sm:pt-6">
          {active ? (
            <button
              key="leave"
              type="button"
              onClick={(e) => {
                e.preventDefault();
                onLeave();
              }}
              className="rounded-lg border border-field bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-sunken"
            >
              Leave
            </button>
          ) : (
            <button
              key="join"
              type="submit"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-strong"
            >
              Join
            </button>
          )}
        </div>
      </div>
      {error !== null && (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
