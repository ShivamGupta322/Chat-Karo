%% Which cell room a user is currently a member of, plus a per-user lock (ADR-021).
%%
%% Rooms are members-only, so "a user is in at most one cell room" means geo_service must revoke
%% the previous room's membership when the user moves. MongooseIM 6.2.1 cannot be asked "which
%% rooms is this user a member of", so geo_service keeps that mapping itself: an ETS table, owned
%% by this supervised gen_server, with rows {UserJid, Current, Pending}. Pending are rooms whose
%% revoke failed and is retried on the user's next locate.
%%
%% The same process serialises /api/locate per user: acquire/2 grants a lock (FIFO, at most 4
%% waiters per user, the holder is monitored so a crash releases it). Different users never
%% block each other. All I/O (the admin API calls) is done by the request process; handle_call
%% does only map and ETS work.
%%
%% Privacy: this process's state and messages hold user-to-room links. Nothing here logs
%% either, format_status/1 reduces the state to counts, and every callback converts an
%% unexpected failure into a bare atom exit so that no exit reason can embed a JID or a room.
%% The table is lost on a restart (ADR-021: at most one stale membership per user who moves
%% afterwards; slice 3f-3 closes that).
-module(geo_membership).
-behaviour(gen_server).

-export([start_link/0]).
-export([acquire/2, release/1, settle/2, requeue/2, current/1]).
-export([settle_entry/2, requeue_entry/3]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, format_status/1]).
-export_type([entry/0]).

-define(TABLE, geo_membership).
-define(MAX_WAITERS, 4).
-define(MAX_PENDING, 16).
-define(MIN_CALL_MS, 250).

-type entry() :: #{current := binary(), pending := [binary()]}.
-type lock() :: {pid(), reference(), queue:queue({gen_server:from(), pid()})}.
-type state() :: #{locks := #{binary() => lock()}, monitors := #{reference() => binary()}}.

%%% API ------------------------------------------------------------------------------------

-spec start_link() -> gen_server:start_ret().
start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

%% Wait for the user's lock until Deadline (monotonic ms) minus a margin. Any failure to get it
%% is `busy`; a waiter that gave up is removed again.
-spec acquire(UserJid :: binary(), Deadline :: integer()) -> ok | {error, busy}.
acquire(UserJid, Deadline) ->
    Timeout = Deadline - erlang:monotonic_time(millisecond) - ?MIN_CALL_MS,
    case Timeout =< 0 of
        true ->
            {error, busy};
        false ->
            try gen_server:call(?MODULE, {acquire, UserJid, self()}, Timeout) of
                ok -> ok;
                {error, busy} -> {error, busy}
            catch
                exit:{timeout, _} ->
                    gen_server:cast(?MODULE, {cancel, UserJid, self()}),
                    {error, busy};
                exit:_ ->
                    {error, busy}
            end
    end.

%% Ignored unless the calling process holds the user's lock.
-spec release(UserJid :: binary()) -> ok.
release(UserJid) ->
    gen_server:cast(?MODULE, {release, UserJid, self()}).

%% Record Room as the user's current room; returns the rooms to revoke (old current and
%% pending, minus Room).
-spec settle(UserJid :: binary(), Room :: binary()) -> {ok, [binary()]} | {error, unavailable}.
settle(UserJid, Room) ->
    try gen_server:call(?MODULE, {settle, UserJid, Room}) of
        {ok, Revoke} when is_list(Revoke) -> {ok, Revoke};
        _ -> {error, unavailable}
    catch
        exit:_ -> {error, unavailable}
    end.

%% Put rooms whose revoke failed back on the user's pending list.
-spec requeue(UserJid :: binary(), Rooms :: [binary()]) -> ok | {error, unavailable}.
requeue(UserJid, Rooms) ->
    try gen_server:call(?MODULE, {requeue, UserJid, Rooms}) of
        ok -> ok;
        _ -> {error, unavailable}
    catch
        exit:_ -> {error, unavailable}
    end.

%% Read in the caller (the table is protected, reads are public).
-spec current(UserJid :: binary()) -> {ok, binary()} | none.
current(UserJid) ->
    try ets:lookup(?TABLE, UserJid) of
        [{UserJid, Current, _Pending}] -> {ok, Current};
        _ -> none
    catch
        error:badarg -> none
    end.

%%% Pure entry logic -----------------------------------------------------------------------

-spec settle_entry(entry() | none, Room :: binary()) -> {entry(), Revoke :: [binary()]}.
settle_entry(none, Room) ->
    {#{current => Room, pending => []}, []};
settle_entry(#{current := Room, pending := Pending}, Room) ->
    {#{current => Room, pending => []}, Pending};
settle_entry(#{current := Old, pending := Pending}, Room) ->
    {#{current => Room, pending => []}, dedupe([Old | Pending]) -- [Room]}.

%% Rooms other than the current one and not already pending are appended; the newest Cap stay.
-spec requeue_entry(entry(), [binary()], Cap :: pos_integer()) ->
    {entry(), Dropped :: non_neg_integer()}.
requeue_entry(#{current := Current, pending := Pending} = Entry, Rooms, Cap) ->
    New = [R || R <- dedupe(Rooms), R =/= Current, not lists:member(R, Pending)],
    All = Pending ++ New,
    Dropped = max(0, length(All) - Cap),
    {Entry#{pending := lists:nthtail(Dropped, All)}, Dropped}.

-spec dedupe([binary()]) -> [binary()].
dedupe(List) ->
    dedupe(List, []).

-spec dedupe([binary()], [binary()]) -> [binary()].
dedupe([], Acc) ->
    lists:reverse(Acc);
dedupe([H | T], Acc) ->
    case lists:member(H, Acc) of
        true -> dedupe(T, Acc);
        false -> dedupe(T, [H | Acc])
    end.

%%% gen_server -----------------------------------------------------------------------------

-spec init([]) -> {ok, state()}.
init([]) ->
    ?TABLE = ets:new(?TABLE, [protected, named_table, set, {read_concurrency, true}]),
    {ok, #{locks => #{}, monitors => #{}}}.

-spec handle_call(term(), gen_server:from(), state()) ->
    {reply, term(), state()} | {noreply, state()}.
handle_call({acquire, User, Pid}, From, State) ->
    guarded(fun() -> do_acquire(User, Pid, From, State) end);
handle_call({settle, User, Room}, _From, State) ->
    guarded(fun() ->
        {Entry, Revoke} = settle_entry(lookup(User), Room),
        true = insert(User, Entry),
        {reply, {ok, Revoke}, State}
    end);
handle_call({requeue, User, Rooms}, _From, State) ->
    guarded(fun() -> {reply, do_requeue(User, Rooms), State} end);
handle_call(_Request, _From, State) ->
    {reply, {error, unavailable}, State}.

-spec handle_cast(term(), state()) -> {noreply, state()}.
handle_cast({release, User, Pid}, State) ->
    guarded(fun() -> {noreply, do_release(User, Pid, State)} end);
handle_cast({cancel, User, Pid}, State) ->
    guarded(fun() -> {noreply, do_cancel(User, Pid, State)} end);
handle_cast(_Msg, State) ->
    {noreply, State}.

-spec handle_info(term(), state()) -> {noreply, state()}.
handle_info({'DOWN', MRef, process, _Pid, _Reason}, #{monitors := Monitors} = State) ->
    guarded(fun() ->
        case maps:find(MRef, Monitors) of
            {ok, User} ->
                {noreply, pass_lock(User, State#{monitors := maps:remove(MRef, Monitors)})};
            error ->
                {noreply, State}
        end
    end);
handle_info(_Info, State) ->
    {noreply, State}.

%% Counts only: the real state, the last message and the exit reason hold user-to-room links
%% and would otherwise be printed in a crash report.
-spec format_status(map()) -> map().
format_status(Status) ->
    Counts =
        case Status of
            #{state := #{locks := Locks}} -> maps:size(Locks);
            _ -> 0
        end,
    Redacted = maps:map(
        fun
            (message, _) -> redacted;
            (reason, _) -> redacted;
            (log, _) -> [];
            (_, V) -> V
        end,
        Status
    ),
    Redacted#{state => #{rows => rows(), locks => Counts}}.

%%% Internals ------------------------------------------------------------------------------

%% Any unexpected failure becomes a bare atom: an exit reason carrying the arguments or the
%% stack would embed a user JID and a room (never logged, see the module comment).
-spec guarded(fun(() -> Result)) -> Result when Result :: term().
guarded(Fun) ->
    try
        Fun()
    catch
        _:_ -> exit(membership_failed)
    end.

-spec rows() -> non_neg_integer().
rows() ->
    case ets:info(?TABLE, size) of
        N when is_integer(N) -> N;
        _ -> 0
    end.

-spec lookup(binary()) -> entry() | none.
lookup(User) ->
    case ets:lookup(?TABLE, User) of
        [{User, Current, Pending}] -> #{current => Current, pending => Pending};
        [] -> none
    end.

-spec insert(binary(), entry()) -> true.
insert(User, #{current := Current, pending := Pending}) ->
    ets:insert(?TABLE, {User, Current, Pending}).

-spec do_requeue(binary(), [binary()]) -> ok | {error, unavailable}.
do_requeue(User, Rooms) ->
    case lookup(User) of
        none ->
            {error, unavailable};
        Entry ->
            {New, Dropped} = requeue_entry(Entry, Rooms, ?MAX_PENDING),
            true = insert(User, New),
            case Dropped of
                0 -> ok;
                _ -> logger:warning(#{event => membership_pending_dropped, count => Dropped})
            end,
            ok
    end.

-spec do_acquire(binary(), pid(), gen_server:from(), state()) ->
    {reply, ok | {error, busy}, state()} | {noreply, state()}.
do_acquire(User, Pid, From, #{locks := Locks, monitors := Monitors} = State) ->
    case maps:find(User, Locks) of
        error ->
            MRef = erlang:monitor(process, Pid),
            Lock = {Pid, MRef, queue:new()},
            {reply, ok, State#{
                locks := Locks#{User => Lock}, monitors := Monitors#{MRef => User}
            }};
        {ok, {Holder, MRef, Queue}} ->
            case queue:len(Queue) >= ?MAX_WAITERS of
                true ->
                    {reply, {error, busy}, State};
                false ->
                    Lock = {Holder, MRef, queue:in({From, Pid}, Queue)},
                    {noreply, State#{locks := Locks#{User => Lock}}}
            end
    end.

-spec do_release(binary(), pid(), state()) -> state().
do_release(User, Pid, #{locks := Locks, monitors := Monitors} = State) ->
    case maps:find(User, Locks) of
        {ok, {Pid, MRef, _Queue}} ->
            erlang:demonitor(MRef, [flush]),
            pass_lock(User, State#{monitors := maps:remove(MRef, Monitors)});
        _ ->
            State
    end.

%% A waiter that gave up leaves the queue; if it was granted the lock in the meantime it
%% releases it.
-spec do_cancel(binary(), pid(), state()) -> state().
do_cancel(User, Pid, #{locks := Locks} = State) ->
    case maps:find(User, Locks) of
        {ok, {Pid, _MRef, _Queue}} ->
            do_release(User, Pid, State);
        {ok, {Holder, MRef, Queue}} ->
            Kept = queue:filter(fun({_From, P}) -> P =/= Pid end, Queue),
            State#{locks := Locks#{User => {Holder, MRef, Kept}}};
        error ->
            State
    end.

%% The lock of User is free (its monitor is already gone): hand it to the next waiter or drop it.
-spec pass_lock(binary(), state()) -> state().
pass_lock(User, #{locks := Locks, monitors := Monitors} = State) ->
    {_Holder, _OldRef, Queue} = maps:get(User, Locks),
    case queue:out(Queue) of
        {empty, _} ->
            State#{locks := maps:remove(User, Locks)};
        {{value, {From, Pid}}, Rest} ->
            MRef = erlang:monitor(process, Pid),
            gen_server:reply(From, ok),
            State#{
                locks := Locks#{User => {Pid, MRef, Rest}},
                monitors := Monitors#{MRef => User}
            }
    end.
