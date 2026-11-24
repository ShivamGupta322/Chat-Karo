import { useLayoutEffect, useRef, type ReactNode } from "react";
import { AppHeader } from "../components/AppHeader";
import { AreaPanel } from "../components/AreaPanel";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { Composer } from "../components/Composer";
import { HistoryStatus } from "../components/HistoryStatus";
import { MessageList } from "../components/MessageList";
import { OccupantList } from "../components/OccupantList";
import { DevLocationPicker, useArea, useRoomAssignment } from "../geo";
import { useRoomStore } from "../state/room";
import { useSessionStore } from "../state/session";
import { ACCESS_FAILURES, useAccessRecovery } from "../state/useAccessRecovery";
import { useAreaRoom } from "../state/useAreaRoom";
import {
  AREA_TEXT,
  CONNECTION_TEXT,
  HISTORY_TEXT,
  describeJoinFailure,
} from "../ui/text";
import { useXmppClient } from "../xmpp";

export function Chat({
  mapTileUrl,
  nickname,
  onSignOut,
  banner,
}: {
  mapTileUrl: string | null;
  /** The profile nickname: shown in the header and used as the MUC nick. */
  nickname: string;
  onSignOut: () => void;
  banner?: ReactNode;
}): React.JSX.Element {
  const client = useXmppClient();
  const connection = useSessionStore((s) => s.connection);
  const room = useRoomStore();
  const area = useArea();

  // geo_service picks the room for the committed cell (ADR-019 D3); the previous room is kept until it answers.
  const cell = area.state.status === "located" ? area.state.cell : null;
  const {
    assignment,
    retry: retryAssign,
    refresh,
  } = useRoomAssignment(cell);
  // A string: useAreaRoom's effect deps compare it by value, so it is stable per room.
  const desiredRoomJid = assignment.room?.jid ?? null;
  const { retry } = useAreaRoom(client, desiredRoomJid, nickname);
  // A refused join (e.g. after a MongooseIM restart) locates once more and rejoins, once (ADR-020).
  const { phase, recover } = useAccessRecovery({
    client,
    desired: desiredRoomJid,
    nick: nickname,
    refresh,
  });
  const recovering = phase === "recovering";

  // Never show another room's data: until the store has switched to the desired room, show nothing of it.
  const current = room.roomJid !== null && room.roomJid === desiredRoomJid;
  const joined = current && room.status === "joined";
  // The room's own cell, so the label stays correct while a switch is pending.
  const label = assignment.room ? AREA_TEXT.areaLabel(assignment.room.cell) : "";
  const reconnecting = connection.status === "reconnecting";
  const accessDenied =
    current &&
    room.status === "failed" &&
    room.failure !== null &&
    ACCESS_FAILURES.has(room.failure.reason) &&
    phase === "exhausted";

  let statusLine: React.ReactNode = null;
  if (recovering) {
    statusLine = AREA_TEXT.joining(label);
  } else if (desiredRoomJid !== null && !current) {
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
      statusLine = accessDenied
        ? AREA_TEXT.accessDenied
        : describeJoinFailure(room.failure.reason);
    } else if (room.status === "left") statusLine = AREA_TEXT.left;
    else if (room.status === "reconnecting")
      statusLine = CONNECTION_TEXT.roomReconnecting;
  }

  const showRejoin =
    !recovering && current && (room.status === "failed" || room.status === "left");
  const statusRef = useRef<HTMLParagraphElement>(null);
  const rejoinFocused = useRef(false);
  const hadRejoin = useRef(false);
  // When "Join again" goes away while it has focus (retry -> joining), keep keyboard users on the status line.
  useLayoutEffect(() => {
    if (hadRejoin.current && !showRejoin && rejoinFocused.current) {
      statusRef.current?.focus({ preventScroll: true });
      rejoinFocused.current = false;
    }
    hadRejoin.current = showRejoin;
  }, [showRejoin]);

  const emptyText = joined
    ? room.history.loading
      ? HISTORY_TEXT.emptyLoading
      : "No messages yet. Say hello!"
    : assignment.status === "none"
      ? AREA_TEXT.emptyNoArea
      : assignment.status === "assigning" && assignment.room === null
        ? AREA_TEXT.emptyJoining
        : assignment.status === "failed"
          ? AREA_TEXT.emptyUnassigned
          : current && (room.status === "failed" || room.status === "left")
            ? ""
            : current && room.status === "reconnecting"
              ? CONNECTION_TEXT.roomReconnectingEmpty
              : AREA_TEXT.emptyJoining;

  return (
    <div className="flex min-h-dvh flex-col md:h-dvh">
      <AppHeader connection={connection} name={nickname} onSignOut={onSignOut} />
      {connection.status === "reconnecting" && (
        <ConnectionBanner
          state={connection}
          onRetryNow={() => {
            client.wake("user");
          }}
        />
      )}
      {banner}
      <main className="mx-auto grid w-full max-w-5xl gap-3 p-3 sm:p-4 md:min-h-0 md:flex-1 md:grid-cols-[1fr_16rem] md:grid-rows-[minmax(0,1fr)] md:items-stretch">
        <div className="grid min-w-0 gap-3 md:flex md:min-h-0 md:flex-col">
          <AreaPanel
            area={area.state}
            assignment={assignment}
            onRetryAssign={retryAssign}
            onShare={area.start}
            onSwitchArea={area.commitMove}
            devHint={import.meta.env.DEV}
          />
          {import.meta.env.DEV && <DevLocationPicker override={area.dev} mapTileUrl={mapTileUrl} />}

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p
              ref={statusRef}
              tabIndex={-1}
              role="status"
              className="m-0 text-sm text-ink-muted"
            >
              {statusLine}
            </p>
            {showRejoin && (
              <button
                type="button"
                onClick={accessDenied ? recover : retry}
                onFocus={() => {
                  rejoinFocused.current = true;
                }}
                onBlur={(e) => {
                  // A blur caused by the button being removed must not forget that it had focus.
                  if (e.currentTarget.isConnected) rejoinFocused.current = false;
                }}
                className="rounded-lg border border-field bg-surface px-3 py-1 text-sm font-medium text-ink hover:bg-surface-sunken"
              >
                {accessDenied ? AREA_TEXT.accessRetry : AREA_TEXT.rejoin}
              </button>
            )}
          </div>

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
