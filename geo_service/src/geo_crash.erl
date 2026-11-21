%% Crash summaries that cannot carry user data (ADR-018). A handler that has just decoded
%% coordinates must not log its exception verbatim: the reason can hold the decoded map
%% ({badmatch, #{<<"lat">> => ...}}) and the first stack frame holds the call arguments. Pure.
%%
%% Kept: the class, the reason when it is an atom (or the leading atom of a tagged tuple), and the
%% top frames as {Module, Function, Arity, Line}. Dropped: every argument value, every other part
%% of the reason, and error_info.
-module(geo_crash).

-export([summary/3]).
-export_type([frame/0, summary/0]).

-define(FRAMES, 5).

-type frame() :: {module() | unknown, atom() | unknown, arity(), pos_integer() | undefined}.
-type summary() :: #{class := error | exit | throw, reason := atom(), where := [frame()]}.

-spec summary(error | exit | throw, term(), list()) -> summary().
summary(Class, Reason, Stack) ->
    #{class => Class, reason => reason(Reason), where => where(Stack)}.

-spec reason(term()) -> atom().
reason(Reason) when is_atom(Reason) ->
    Reason;
reason(Reason) when is_tuple(Reason), tuple_size(Reason) >= 1, is_atom(element(1, Reason)) ->
    element(1, Reason);
reason(_) ->
    term.

-spec where(term()) -> [frame()].
where(Stack) when is_list(Stack) ->
    [frame(Entry) || Entry <- take(?FRAMES, Stack)];
where(_) ->
    [].

%% Stack is not guaranteed to be a proper list.
-spec take(non_neg_integer(), term()) -> list().
take(0, _) -> [];
take(N, [H | T]) -> [H | take(N - 1, T)];
take(_, _) -> [].

-spec frame(term()) -> frame().
frame({M, F, Args, Info}) when is_atom(M), is_atom(F), is_list(Args) ->
    {M, F, arity_of(Args), line(Info)};
frame({M, F, Arity, Info}) when is_atom(M), is_atom(F), is_integer(Arity), Arity >= 0 ->
    {M, F, Arity, line(Info)};
frame(_) ->
    {unknown, unknown, 0, undefined}.

-spec arity_of(list()) -> arity().
arity_of(Args) ->
    case is_proper(Args) of
        true -> length(Args);
        false -> 0
    end.

-spec is_proper(term()) -> boolean().
is_proper([]) -> true;
is_proper([_ | T]) -> is_proper(T);
is_proper(_) -> false.

-spec line(term()) -> pos_integer() | undefined.
line(Info) when is_list(Info) ->
    case lists:keyfind(line, 1, Info) of
        {line, Line} when is_integer(Line), Line > 0 -> Line;
        _ -> undefined
    end;
line(_) ->
    undefined.
