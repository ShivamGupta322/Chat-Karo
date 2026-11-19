import { useMemo } from "react";
import { AppHeader } from "../components/AppHeader";
import { AreaPanel } from "../components/AreaPanel";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { Composer } from "../components/Composer";
import { HistoryStatus } from "../components/HistoryStatus";
import { MessageList } from "../components/MessageList";
import { OccupantList } from "../components/OccupantList";
import { DevLocationPicker, roomJidForCell, useArea } from "../geo";
import { useRoomStore } from "../state/room";
import { selectSessionJid, useSessionStore } from "../state/session";
import { useAreaRoom } from "../state/useAreaRoom";
import {
  AREA_TEXT,
  CONNECTION_TEXT,
  HISTORY_TEXT,
  describeJoinFailure,
} from "../ui/text";
import { localpartOf, useXmppClient } from "../xmpp";

export function Chat({ mucDomain }: { mucDomain: string }): React.JSX.Element {
  const client = useXmppClient();
  const connection = useSessionStore((s) => s.connection);
  const room = useRoomStore();
  const jid = selectSessionJid(connection) ?? "";
  const area = useArea();

  // TEMPORARY (Phase 3): the client picks the room from the cell; geo_service /api/locate will replace this.
  const cell = area.state.status === "located" ? area.state.cell : null;
  const desiredRoomJid = useMemo(
    () => (cell === null ? null : roomJidForCell(cell, mucDomain)),
    [cell, mucDomain],
  );
  const { retry } = useAreaRoom(client, desiredRoomJid, localpartOf(jid));

  // Never show another room's data: until the store has switched to the desired room, show nothing of it.
  const current = room.roomJid !== null && room.roomJid === desiredRoomJid;
  const joined = current && room.status === "joined";
  const label = cell === null ? "" : AREA_TEXT.areaLabel(cell.geohash);
  const reconnecting = connection.status === "reconnecting";

  let statusLine: React.ReactNode = null;
  if (desiredRoomJid !== null && !current) {
    statusLine = reconnecting
      ? CONNECTION_TEXT.roomReconnecting
      : AREA_TEXT.joining(label);
  } else if (current) {
    if (room.status === "joining") statusLine = AREA_TEXT.joining(label);
    else if (room.status === "joined") {
      statusLine = (
        <>
          You're in <strong className="font-semibold text-ink">{label}</strong>{" "}
          as {room.nick ?? ""}
        </>
      );
    } else if (room.status === "failed" && room.failure) {
      statusLine = describeJoinFailure(room.failure.reason);
    } else if (room.status === "left") statusLine = "You left the room";
    else if (room.status === "reconnecting")
      statusLine = CONNECTION_TEXT.roomReconnecting;
  }

  const emptyText = joined
    ? room.history.loading
      ? HISTORY_TEXT.emptyLoading
      : "No messages yet. Say hello!"
    : desiredRoomJid === null
      ? AREA_TEXT.emptyNoArea
      : current && (room.status === "failed" || room.status === "left")
        ? ""
        : current && room.status === "reconnecting"
          ? CONNECTION_TEXT.roomReconnectingEmpty
          : AREA_TEXT.emptyJoining;

  return (
    <div className="flex min-h-dvh flex-col md:h-dvh">
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
      <main className="mx-auto grid w-full max-w-5xl gap-3 p-3 sm:p-4 md:min-h-0 md:flex-1 md:grid-cols-[1fr_16rem] md:grid-rows-[minmax(0,1fr)] md:items-stretch">
        <div className="grid min-w-0 gap-3 md:flex md:min-h-0 md:flex-col">
          <AreaPanel
            area={area.state}
            onShare={area.start}
            onSwitchArea={area.commitMove}
            devHint={import.meta.env.DEV}
          />
          {import.meta.env.DEV && <DevLocationPicker override={area.dev} />}

          <p role="status" className="m-0 text-sm text-ink-muted">
            {statusLine}
            {current && (room.status === "failed" || room.status === "left") && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={retry}
                  className="rounded-lg border border-field bg-surface px-3 py-1 text-sm font-medium text-ink hover:bg-surface-sunken"
                >
                  {AREA_TEXT.rejoin}
                </button>
              </>
            )}
          </p>

          <section
            aria-label="Chat"
            className="min-w-0 rounded-2xl border border-line bg-surface shadow-sm md:flex md:min-h-0 md:flex-1 md:flex-col"
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
              items={current ? room.timeline : []}
              busy={current && room.history.loading}
              earlier={
                joined &&
                room.history.canLoadEarlier &&
                !room.history.loading &&
                !room.history.failed
                  ? {
                      status: room.history.earlier,
                      onLoad: () => {
                        if (room.roomJid !== null) client.loadEarlier(room.roomJid);
                      },
                    }
                  : null
              }
              emptyText={emptyText}
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
        <div className="min-w-0 md:min-h-0 md:overflow-y-auto">
          <OccupantList
            occupants={current ? room.occupants : []}
            selfNick={room.nick}
          />
        </div>
      </main>
    </div>
  );
}
