import { AppHeader } from "../components/AppHeader";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { Composer } from "../components/Composer";
import { HistoryStatus } from "../components/HistoryStatus";
import { MessageList } from "../components/MessageList";
import { OccupantList } from "../components/OccupantList";
import { RoomForm } from "../components/RoomForm";
import { useRoomStore } from "../state/room";
import { selectSessionJid, useSessionStore } from "../state/session";
import { roomLabel } from "../ui/addresses";
import { CONNECTION_TEXT, HISTORY_TEXT, describeJoinFailure } from "../ui/text";
import { localpartOf, useXmppClient } from "../xmpp";

export function Chat({ mucDomain }: { mucDomain: string }): React.JSX.Element {
  const client = useXmppClient();
  const connection = useSessionStore((s) => s.connection);
  const room = useRoomStore();
  const jid = selectSessionJid(connection) ?? "";
  const joined = room.status === "joined" && room.roomJid !== null;
  const label = room.roomJid === null ? "" : roomLabel(room.roomJid);

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader
        connection={connection}
        onSignOut={() => {
          client.disconnect();
        }}
      />
      {connection.status === "reconnecting" && (
        <ConnectionBanner
          state={connection}
          onRetryNow={() => {
            client.wake("user");
          }}
        />
      )}
      <main className="mx-auto grid w-full max-w-5xl gap-3 p-3 sm:p-4 md:grid-cols-[1fr_16rem] md:items-start">
        <div className="grid min-w-0 gap-3">
          <RoomForm
            defaultRoom="lobby"
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

          <p role="status" className="m-0 text-sm text-ink-muted">
            {room.status === "joining" && (
              <>
                Joining{" "}
                <strong className="font-semibold text-ink">{label}</strong>…
              </>
            )}
            {room.status === "joined" && (
              <>
                You're in{" "}
                <strong className="font-semibold text-ink">{label}</strong> as{" "}
                {room.nick ?? ""}
              </>
            )}
            {room.status === "failed" &&
              room.failure &&
              describeJoinFailure(room.failure.reason)}
            {room.status === "left" && "You left the room"}
            {room.status === "reconnecting" && CONNECTION_TEXT.roomReconnecting}
          </p>

          <section
            aria-label="Chat"
            className="min-w-0 rounded-2xl border border-line bg-surface shadow-sm"
          >
            {joined && (
              <HistoryStatus
                history={room.history}
                onRetry={() => {
                  if (room.roomJid !== null) client.retryHistory(room.roomJid);
                }}
              />
            )}
            <MessageList
              items={room.timeline}
              busy={room.history.loading}
              emptyText={
                joined
                  ? room.history.loading
                    ? HISTORY_TEXT.emptyLoading
                    : "No messages yet. Say hello!"
                  : room.status === "reconnecting"
                    ? CONNECTION_TEXT.roomReconnectingEmpty
                    : "Join a room to start chatting."
              }
            />
            <div className="border-t border-line p-3 sm:p-4">
              <Composer
                disabled={!joined}
                onSend={(body) =>
                  room.roomJid === null
                    ? { ok: false, error: "not-joined" }
                    : client.sendGroupchat(room.roomJid, body)
                }
              />
            </div>
          </section>
        </div>
        <div className="min-w-0">
          <OccupantList occupants={room.occupants} selfNick={room.nick} />
        </div>
      </main>
    </div>
  );
}
