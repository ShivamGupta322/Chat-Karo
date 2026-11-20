%% Replacement for the driver's mc_pool_sup (ADR-016 quirk 9). Registered under the same name
%% because mc_pool_sup:start_pool/2 calls supervisor:start_child(mc_pool_sup, ...) by name and
%% mongoc:connect/3 then finds it already started.
%%
%% The driver's own spec makes worker_pool TRANSIENT. When Mongo goes away poolboy crashes and
%% the supervisor retries in a tight loop, while mc_server has already abandoned that pool and
%% later starts a new one; the retried pool becomes an orphan holding pool_size connections.
%% With TEMPORARY children mc_server alone owns each pool's lifecycle.
-module(geo_mongo_pool_sup).
-behaviour(supervisor).

-export([start_link/0]).
-export([init/1]).

-spec start_link() -> supervisor:startlink_ret().
start_link() ->
    supervisor:start_link({local, mc_pool_sup}, ?MODULE, []).

-spec init([]) -> {ok, {supervisor:sup_flags(), [supervisor:child_spec()]}}.
init([]) ->
    SupFlags = #{strategy => simple_one_for_one, intensity => 1000, period => 3600},
    Child = #{
        id => worker_pool,
        start => {poolboy, start_link, []},
        restart => temporary,
        shutdown => 5000,
        type => worker,
        modules => [poolboy]
    },
    {ok, {SupFlags, [Child]}}.
