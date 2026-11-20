%% Owns everything the mongodb driver needs at runtime. The driver application is only
%% included (never started), so its service processes live here instead of under mc_super_sup.
%% rest_for_one: the ETS owners and the pool supervisor must outlive the topology, the topology
%% must outlive the probe that pings it. mc_server / mc_monitor stay unsupervised by the driver
%% (ADR-016 quirk 7); the topology child is their parent link.
-module(geo_mongo_sup).
-behaviour(supervisor).

-export([start_link/1]).
-export([init/1]).

-spec start_link(geo_config:mongo()) -> supervisor:startlink_ret().
start_link(Mongo) ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, Mongo).

-spec init(geo_config:mongo()) -> {ok, {supervisor:sup_flags(), [supervisor:child_spec()]}}.
init(Mongo) ->
    SupFlags = #{strategy => rest_for_one, intensity => 5, period => 10},
    Children = [
        worker(mongo_id_server),
        worker(mc_worker_pid_info),
        #{
            id => geo_mongo_pool_sup,
            start => {geo_mongo_pool_sup, start_link, []},
            restart => permanent,
            shutdown => infinity,
            type => supervisor,
            modules => [geo_mongo_pool_sup]
        },
        geo_mongo:child_spec(Mongo),
        worker(geo_mongo_probe)
    ],
    {ok, {SupFlags, Children}}.

-spec worker(module()) -> supervisor:child_spec().
worker(Module) ->
    #{
        id => Module,
        start => {Module, start_link, []},
        restart => permanent,
        shutdown => 5000,
        type => worker,
        modules => [Module]
    }.
