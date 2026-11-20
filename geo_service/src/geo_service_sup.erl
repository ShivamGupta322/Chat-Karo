-module(geo_service_sup).
-behaviour(supervisor).

-export([start_link/1]).
-export([init/1]).

-spec start_link(geo_config:listen()) -> supervisor:startlink_ret().
start_link(Listen) ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, Listen).

-spec init(geo_config:listen()) -> {ok, {supervisor:sup_flags(), [supervisor:child_spec()]}}.
init(Listen) ->
    SupFlags = #{strategy => one_for_one, intensity => 5, period => 10},
    %% Slice 3a: only the HTTP listener. The other children from docs/ARCHITECTURE.md
    %% (mongo pool, rate limiter, room supervisor, registry) arrive in later slices.
    Children = [geo_http:child_spec(Listen)],
    {ok, {SupFlags, Children}}.
