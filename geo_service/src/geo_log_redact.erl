%% Logger primary filter that replaces known secrets (the MongoDB password, the MongooseIM admin
%% password, the JWT secret) with [REDACTED], plus two patterns for secrets that are minted at
%% run time and so cannot be listed up front: XMPP passwords ("xp1_" + 32 characters) and
%% JWT-shaped strings. The driver, httpc and OTP crash reports (poolboy, supervisor, mc_server)
%% can carry the worker options or request headers. The filter walks the event message through
%% tuples, lists (improper too), maps and binaries. No logging in here.
-module(geo_log_redact).

-export([filter/2, install/1, uninstall/0, args/1]).
-export_type([args/0]).

-define(FILTER_ID, geo_redact).
-define(MASK, <<"[REDACTED]">>).
-define(PATTERNS, [
    "xp1_[A-Za-z0-9_-]{32}",
    "eyJ[A-Za-z0-9_-]{5,}\\.eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{20,}"
]).

-type args() :: #{secrets := [binary()], patterns := [re:mp()]}.

-spec filter(logger:log_event(), args()) -> logger:filter_return().
filter(#{msg := Msg} = Event, #{secrets := Secrets0} = Args) ->
    Secrets = [S || S <- Secrets0, is_binary(S), S =/= <<>>],
    Event#{msg := redact_msg(Msg, Args#{secrets := Secrets})};
filter(Event, _Args) ->
    Event.

%% The filter is always installed: the patterns apply even when there are no static secrets.
-spec install([binary()]) -> ok.
install(Secrets) ->
    ok = uninstall(),
    ok = logger:add_primary_filter(?FILTER_ID, {fun ?MODULE:filter/2, args(Secrets)}).

-spec args([binary()]) -> args().
args(Secrets) ->
    Patterns = [compile(P) || P <- ?PATTERNS],
    #{secrets => Secrets, patterns => Patterns}.

-spec uninstall() -> ok.
uninstall() ->
    _ = logger:remove_primary_filter(?FILTER_ID),
    ok.

-spec redact_msg(term(), args()) -> term().
redact_msg({report, Report}, Args) -> {report, redact(Report, Args)};
redact_msg({string, String}, Args) -> {string, redact(String, Args)};
redact_msg({Format, FArgs}, Args) -> {Format, redact(FArgs, Args)};
redact_msg(Other, Args) -> redact(Other, Args).

-spec redact(term(), args()) -> term().
redact(Bin, #{secrets := Secrets, patterns := Patterns}) when is_binary(Bin) ->
    Static = lists:foldl(fun(S, Acc) -> binary:replace(Acc, S, ?MASK, [global]) end, Bin, Secrets),
    lists:foldl(
        fun(P, Acc) -> re:replace(Acc, P, ?MASK, [global, {return, binary}]) end, Static, Patterns
    );
redact([H | _] = List, Args) when is_integer(H) ->
    redact_chars(List, Args);
redact(List, Args) when is_list(List) ->
    redact_list(List, Args);
redact(Tuple, Args) when is_tuple(Tuple) ->
    list_to_tuple(redact_list(tuple_to_list(Tuple), Args));
redact(Map, Args) when is_map(Map) ->
    maps:from_list([{redact(K, Args), redact(V, Args)} || {K, V} <- maps:to_list(Map)]);
redact(Other, _Args) ->
    Other.

%% A list that starts with an integer might be a char list; redact it as text when it is one,
%% otherwise walk it like any other list.
-spec redact_chars(nonempty_maybe_improper_list(), args()) -> term().
redact_chars(List, Args) ->
    case is_byte_list(List) of
        true ->
            Bin = list_to_binary(List),
            case redact(Bin, Args) of
                Bin -> List;
                Redacted -> binary_to_list(Redacted)
            end;
        false ->
            redact_list(List, Args)
    end.

-spec is_byte_list(term()) -> boolean().
is_byte_list([]) -> true;
is_byte_list([C | T]) when is_integer(C), C >= 0, C =< 255 -> is_byte_list(T);
is_byte_list(_) -> false.

%% Walks list cells without re-checking each tail as a char list; the tail of an improper list
%% is redacted as an ordinary term.
-spec redact_list(maybe_improper_list(), args()) -> maybe_improper_list().
redact_list([], _Args) -> [];
redact_list([H | T], Args) -> [redact(H, Args) | redact_list(T, Args)];
redact_list(Tail, Args) -> redact(Tail, Args).

-spec compile(string()) -> re:mp().
compile(Pattern) ->
    {ok, MP} = re:compile(Pattern),
    MP.
