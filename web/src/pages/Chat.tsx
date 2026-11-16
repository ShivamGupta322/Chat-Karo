import { Composer } from '../components/Composer';
import { ConnectionStatus } from '../components/ConnectionStatus';
import { MessageList } from '../components/MessageList';
import { OccupantList } from '../components/OccupantList';
import { RoomForm } from '../components/RoomForm';
import { describeJoinFailure } from '../components/describe';
import { useRoomStore } from '../state/room';
import { useSessionStore } from '../state/session';
import { localpartOf, useXmppClient } from '../xmpp';

export function Chat({ mucDomain }: { mucDomain: string }): React.JSX.Element {
  const client = useXmppClient();
  const connection = useSessionStore((s) => s.connection);
  const room = useRoomStore();
  const jid = connection.status === 'connected' ? connection.jid : '';
  const joined = room.status === 'joined' && room.roomJid !== null;

  return (
    <main className="mx-auto grid max-w-3xl gap-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">chatErl</h1>
        <ConnectionStatus state={connection} />
        <button
          type="button"
          onClick={() => {
            client.disconnect();
          }}
          className="rounded border border-slate-400 px-3 py-1.5 text-sm"
        >
          Disconnect
        </button>
      </header>

      <RoomForm
        defaultRoomJid={`lobby@${mucDomain}`}
        defaultNick={localpartOf(jid)}
        mucDomain={mucDomain}
        status={room.status}
        onJoin={(roomJid, nick) => {
          client.joinRoom(roomJid, nick);
        }}
        onLeave={() => {
          if (room.roomJid !== null) client.leaveRoom(room.roomJid);
        }}
      />

      <p role="status" className="text-sm text-slate-600">
        {room.status === 'joining' && `Joining ${room.roomJid ?? ''}...`}
        {room.status === 'joined' && `In ${room.roomJid ?? ''} as ${room.nick ?? ''}`}
        {room.status === 'failed' && room.failure && describeJoinFailure(room.failure.reason)}
        {room.status === 'left' && 'You left the room'}
      </p>

      <div className="grid gap-3 md:grid-cols-[1fr_12rem]">
        <div className="grid min-w-0 gap-2">
          <MessageList items={room.timeline} selfNick={room.nick} />
          <Composer
            disabled={!joined}
            onSend={(body) =>
              room.roomJid === null
                ? { ok: false, error: 'not-joined' }
                : client.sendGroupchat(room.roomJid, body)
            }
          />
        </div>
        <div className="min-w-0">
          <OccupantList occupants={room.occupants} selfNick={room.nick} />
        </div>
      </div>
    </main>
  );
}
