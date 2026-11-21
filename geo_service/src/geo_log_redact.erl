%% Logger primary filter that replaces known secrets (the MongoDB password, the MongooseIM admin
%% password, the JWT secret) with [REDACTED], plus two patterns for secrets that are minted at
%% run time and so cannot be listed up front: XMPP passwords ("xp1_" + 32 characters) and
%% JWT-shaped strings.
%%
%% Coordinates (ADR-018) get a backstop too: a map value under a key named lat, lng, lon,
%% latitude, longitude or accuracy (binary any case, or atom) is masked, and so are the values of
%% those keys inside raw JSON text and inside pre-formatted map text (<<"lat">> => 1.5), with the
%% key kept. This does NOT cover a coordinate that is not next to a coordinate-named key: bare floats
%% anywhere in a term (stack arguments [57.6, 10.4, block], exception reasons {badarg, 57.6},
%% tuples, lists), JSON already escaped into a formatted string, or a body split across TCP
%% packets; the guarded handler (geo_http_locate) is the guarantee,
%% this is only a net.
%%
%% The driver, httpc and OTP crash reports (poolboy, supervisor, mc_server)
%% can carry the worker options or request headers. The filter walks the event message through
%% tuples, lists (improper too), maps and binaries. No logging in here.
%%
%% The filter fails closed: if redaction itself raises, that event's message is replaced by a fixed,
%% value-free placeholder (level and time kept) instead of letting logger remove the filter (which
%% would leave every later event unredacted). The placeholder makes such a bug visible in the logs.
%%
%% Only `msg` is redacted, never `meta`: the default formatter template prints no arbitrary meta.
%% A formatter template that prints meta fields would NOT be covered by this filter.
-module(geo_log_redact).

-export([filter/2, install/1, uninstall/0, args/1]).
-export_type([args/0]).

-define(FILTER_ID, geo_redact).
-define(MASK, <<"[REDACTED]">>).
-define(FAILED, <<"[REDACTED: log redaction failed, event dropped]">>).
-define(COORD_KEYS, "lat|lng|lon|latitude|longitude|accuracy").
%% {Regex, Replacement}. The first two replace the whole match; the coordinate patterns keep the
%% key (group 1) and mask the value.
-define(PATTERNS, [
    {"xp1_[A-Za-z0-9_-]{32}", ?MASK},
    {"eyJ[A-Za-z0-9_-]{5,}\\.eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{20,}", ?MASK},
    %% raw JSON bytes: "lat" : 57.6   or   "lat": "57.6"
    {"(?i)(\"(?:" ?COORD_KEYS ")\"\\s*:\\s*)(\"[^\"]*\"|[^,}\\]\\s]*)", <<"\\1[REDACTED]">>},
    %% pre-formatted ~p of a map: <<"lat">> => 57.6
    {"(?i)(<<\"(?:" ?COORD_KEYS ")\">>\\s*=>\\s*)([^,}\\s]*)", <<"\\1[REDACTED]">>}
]).

-type args() :: #{secrets := [binary()], patterns := [{re:mp(), binary()}]}.

-spec filter(logger:log_event(), args()) -> logger:filter_return().
filter(#{msg := Msg} = Event, #{secrets := Secrets0} = Args) ->
    Secrets = [S || S <- Secrets0, is_binary(S), S =/= <<>>],
    %% Deliberate catch-all, not let-it-crash: logger REMOVES a primary filter that raises, and
    %% every later event would then go out unredacted. So a crash here replaces this one event's
    %% message with a fixed placeholder (fail closed, but visible) and the filter stays installed.
    %% No logger call happens in here, so this cannot recurse.
    try
        Event#{msg := redact_msg(Msg, Args#{secrets := Secrets})}
    catch
        _:_ -> Event#{msg := {string, ?FAILED}}
    end;
filter(Event, _Args) ->
    Event.

%% The filter is always installed: the patterns apply even when there are no static secrets.
-spec install([binary()]) -> ok.
install(Secrets) ->
    ok = uninstall(),
    ok = logger:add_primary_filter(?FILTER_ID, {fun ?MODULE:filter/2, args(Secrets)}).

-spec args([binary()]) -> args().
args(Secrets) ->
    Patterns = [{compile(P), Replacement} || {P, Replacement} <- ?PATTERNS],
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
        fun({MP, Replacement}, Acc) ->
            re:replace(Acc, MP, Replacement, [global, {return, binary}])
        end,
        Static,
        Patterns
    );
redact([H | _] = List, Args) when is_integer(H) ->
    redact_chars(List, Args);
redact(List, Args) when is_list(List) ->
    redact_list(List, Args);
redact(Tuple, Args) when is_tuple(Tuple) ->
    list_to_tuple(redact_list(tuple_to_list(Tuple), Args));
redact(Map, Args) when is_map(Map) ->
    maps:from_list([redact_pair(K, V, Args) || {K, V} <- maps:to_list(Map)]);
redact(Other, _Args) ->
    Other.

-spec redact_pair(term(), term(), args()) -> {term(), term()}.
redact_pair(K, V, Args) ->
    case is_coord_key(K) of
        true -> {K, ?MASK};
        false -> {redact(K, Args), redact(V, Args)}
    end.

-spec is_coord_key(term()) -> boolean().
is_coord_key(K) when is_atom(K) -> is_coord_key(atom_to_binary(K));
is_coord_key(K) when is_binary(K), byte_size(K) =< 9 ->
    %% Keys are arbitrary terms from log events; string:lowercase/1 raises on invalid UTF-8.
    lists:member(geo_ascii:lower(K), [
        <<"lat">>, <<"lng">>, <<"lon">>, <<"latitude">>, <<"longitude">>, <<"accuracy">>
    ]);
is_coord_key(_) ->
    false.

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
