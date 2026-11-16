import { useState, type FormEvent } from 'react';
import { isValidRoomJid, normalizeNick } from '../xmpp';
import type { RoomState } from '../state/room';

export interface RoomFormProps {
  defaultRoomJid: string;
  defaultNick: string;
  mucDomain: string;
  status: RoomState['status'];
  onJoin: (roomJid: string, nick: string) => void;
  onLeave: () => void;
}

export function RoomForm({
  defaultRoomJid,
  defaultNick,
  mucDomain,
  status,
  onJoin,
  onLeave,
}: RoomFormProps): React.JSX.Element {
  const [roomJid, setRoomJid] = useState(defaultRoomJid);
  const [nick, setNick] = useState(defaultNick);
  const [error, setError] = useState<string | null>(null);
  const active = status === 'joining' || status === 'joined';

  const handle = (e: FormEvent): void => {
    e.preventDefault();
    const room = roomJid.trim();
    const n = normalizeNick(nick);
    if (!isValidRoomJid(room, mucDomain)) {
      setError(`Room must look like name@${mucDomain} (lowercase)`);
      return;
    }
    if (n === null) {
      setError('Nickname must be 1-32 characters with no control characters');
      return;
    }
    setError(null);
    onJoin(room, n);
  };

  return (
    <form onSubmit={handle} className="flex flex-wrap items-end gap-2" aria-label="Room">
      <label className="grid min-w-40 flex-1 gap-1 text-sm">
        Room JID
        <input
          className="rounded border border-slate-300 px-2 py-1.5"
          value={roomJid}
          disabled={active}
          onChange={(e) => {
            setRoomJid(e.target.value);
          }}
        />
      </label>
      <label className="grid min-w-32 gap-1 text-sm">
        Nickname
        <input
          className="rounded border border-slate-300 px-2 py-1.5"
          value={nick}
          disabled={active}
          onChange={(e) => {
            setNick(e.target.value);
          }}
        />
      </label>
      {active ? (
        <button
          key="leave"
          type="button"
          onClick={(e) => {
            e.preventDefault();
            onLeave();
          }}
          className="rounded border border-slate-400 px-3 py-1.5"
        >
          Leave
        </button>
      ) : (
        <button key="join" type="submit" className="rounded bg-blue-600 px-3 py-1.5 text-white">
          Join
        </button>
      )}
      {error !== null && (
        <p role="alert" className="w-full text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}
