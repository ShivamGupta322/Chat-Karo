-module(geo_service_sup).
-behaviour(supervisor).

-export([start_link/1]).
-export([init/1]).

-type args() :: #{
    listen := geo_config:listen(),
    mongo := geo_config:mongo(),
    session := geo_config:session_cfg()
}.

-spec start_link(args()) -> supervisor:startlink_ret().
start_link(Args) ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, Args).

-spec init(args()) -> {ok, {supervisor:sup_flags(), [supervisor:child_spec()]}}.
init(#{listen := Listen, mongo := Mongo, session := Session}) ->
    SupFlags = #{strategy => one_for_one, intensity => 5, period => 10},
    %% The other children from docs/ARCHITECTURE.md (rate limiter, room supervisor, registry)
    %% arrive in later slices.
    Children = [
        #{
            id => geo_mongo_sup,
            start => {geo_mongo_sup, start_link, [Mongo]},
            restart => permanent,
            shutdown => infinity,
            type => supervisor,
            modules => [geo_mongo_sup]
        },
        %% ETS owner + per-user lock for "one cell-room membership per user" (ADR-021). Before
        %% geo_http so the table exists when the first locate arrives.
        #{
            id => geo_membership,
            start => {geo_membership, start_link, []},
            restart => permanent,
            shutdown => 5000,
            type => worker
        },
        geo_http:child_spec(Listen, Session)
    ],
    {ok, {SupFlags, Children}}.
