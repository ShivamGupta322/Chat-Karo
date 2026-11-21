-module(geo_http).

-export([child_spec/2, dispatch/1]).

%% The Cowboy listener is embedded with ranch:child_spec/5 so that it lives under
%% geo_service_sup (cowboy:start_clear/3 would start it under ranch's own supervisor).
-spec child_spec(geo_config:listen(), geo_config:session_cfg()) -> supervisor:child_spec().
child_spec(#{ip := Ip, port := Port}, SessionCfg) ->
    TransOpts = #{
        socket_opts => [{ip, Ip}, {port, Port}],
        connection_type => supervisor
    },
    ProtoOpts = #{
        env => #{dispatch => dispatch(SessionCfg)},
        connection_type => supervisor
    },
    ranch:child_spec(geo_http, ranch_tcp, TransOpts, cowboy_clear, ProtoOpts).

-spec dispatch(geo_config:session_cfg()) -> cowboy_router:dispatch_rules().
dispatch(#{jwt_secret := JwtSecret, muc_domain := MucDomain} = SessionCfg) ->
    %% Least privilege: the locate handler gets the JWT key and the MUC domain, not the admin credentials.
    LocateCfg = #{jwt_secret => JwtSecret, muc_domain => MucDomain},
    cowboy_router:compile([
        {'_', [
            {"/api/health", geo_http_health, []},
            {"/api/ready", geo_http_ready, []},
            {"/api/session", geo_http_session, SessionCfg},
            {"/api/locate", geo_http_locate, LocateCfg},
            {'_', geo_http_not_found, []}
        ]}
    ]).
