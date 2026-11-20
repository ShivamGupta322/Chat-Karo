%% Logger primary filter that replaces known secrets (the MongoDB password) with [REDACTED].
%% The driver and OTP crash reports (poolboy, supervisor, mc_server) can carry the worker
%% options, which include the password. The filter walks the event message through tuples,
%% lists (improper too), maps and binaries. No logging in here.
-module(geo_log_redact).

-export([filter/2, install/1, uninstall/0]).

-define(FILTER_ID, geo_redact).
-define(MASK, <<"[REDACTED]">>).

-spec filter(logger:log_event(), [binary()]) -> logger:filter_return().
filter(#{msg := Msg} = Event, Secrets0) ->
    Secrets = [S || S <- Secrets0, is_binary(S), S =/= <<>>],
    case Secrets of
        [] -> Event;
        _ -> Event#{msg := redact_msg(Msg, Secrets)}
    end;
filter(Event, _Secrets) ->
    Event.

-spec install([binary()]) -> ok.
install(Secrets) ->
    ok = uninstall(),
    case Secrets of
        [] ->
            ok;
        _ ->
            ok = logger:add_primary_filter(?FILTER_ID, {fun ?MODULE:filter/2, Secrets})
    end.

-spec uninstall() -> ok.
uninstall() ->
    _ = logger:remove_primary_filter(?FILTER_ID),
    ok.

-spec redact_msg(term(), [binary()]) -> term().
redact_msg({report, Report}, Secrets) -> {report, redact(Report, Secrets)};
redact_msg({string, String}, Secrets) -> {string, redact(String, Secrets)};
redact_msg({Format, Args}, Secrets) -> {Format, redact(Args, Secrets)};
redact_msg(Other, Secrets) -> redact(Other, Secrets).

-spec redact(term(), [binary()]) -> term().
redact(Bin, Secrets) when is_binary(Bin) ->
    lists:foldl(fun(S, Acc) -> binary:replace(Acc, S, ?MASK, [global]) end, Bin, Secrets);
redact([H | _] = List, Secrets) when is_integer(H) ->
    redact_chars(List, Secrets);
redact(List, Secrets) when is_list(List) ->
    redact_list(List, Secrets);
redact(Tuple, Secrets) when is_tuple(Tuple) ->
    list_to_tuple(redact_list(tuple_to_list(Tuple), Secrets));
redact(Map, Secrets) when is_map(Map) ->
    maps:from_list([{redact(K, Secrets), redact(V, Secrets)} || {K, V} <- maps:to_list(Map)]);
redact(Other, _Secrets) ->
    Other.

%% A list that starts with an integer might be a char list; redact it as text when it is one,
%% otherwise walk it like any other list.
-spec redact_chars(nonempty_maybe_improper_list(), [binary()]) -> term().
redact_chars(List, Secrets) ->
    case is_byte_list(List) of
        true ->
            Bin = list_to_binary(List),
            case redact(Bin, Secrets) of
                Bin -> List;
                Redacted -> binary_to_list(Redacted)
            end;
        false ->
            redact_list(List, Secrets)
    end.

-spec is_byte_list(term()) -> boolean().
is_byte_list([]) -> true;
is_byte_list([C | T]) when is_integer(C), C >= 0, C =< 255 -> is_byte_list(T);
is_byte_list(_) -> false.

%% Walks list cells without re-checking each tail as a char list; the tail of an improper list
%% is redacted as an ordinary term.
-spec redact_list(maybe_improper_list(), [binary()]) -> maybe_improper_list().
redact_list([], _Secrets) -> [];
redact_list([H | T], Secrets) -> [redact(H, Secrets) | redact_list(T, Secrets)];
redact_list(Tail, Secrets) -> redact(Tail, Secrets).
