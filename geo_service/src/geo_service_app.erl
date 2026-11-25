-module(geo_service_app).
-behaviour(application).

-export([start/2, stop/1]).

-spec start(application:start_type(), term()) -> {ok, pid()} | {error, term()}.
start(_Type, _Args) ->
    maybe
        {ok, Listen} ?= geo_config:http_listen(),
        {ok, Mongo} ?= geo_config:mongo(),
        {ok, Session} ?= geo_config:session(),
        %% The redaction filter must be in place before anything that holds the password starts.
        ok = geo_log_redact:install(secrets(Mongo, Session)),
        ok ?= geo_xmpp_admin:start_http_profile(),
        %% The filter stays installed if the supervisor fails to start: the application
        %% controller logs the exit reason after this returns, and it could carry the password.
        %% It is uninstalled in stop/1 only.
        geo_service_sup:start_link(#{listen => Listen, mongo => Mongo, session => Session})
    else
        {error, {bad_config, Key}} = Failure ->
            %% Key name only: never log the configured value.
            logger:error(#{event => bad_config, key => Key}),
            Failure;
        {error, httpc_profile} = Failure ->
            logger:error(#{event => httpc_profile_failed}),
            Failure
    end.

-spec stop(term()) -> ok.
stop(_State) ->
    _ = inets:stop(httpc, geo_xmpp_admin),
    geo_log_redact:uninstall().

%% The mongo password, the MongooseIM admin password (and its base64 form in the Basic header)
%% and the JWT secret. Run-time secrets (XMPP passwords, tokens) are caught by patterns.
-spec secrets(geo_config:mongo(), geo_config:session_cfg()) -> [binary()].
secrets(Mongo, #{jwt_secret := JwtSecret, admin := #{password := AdminPassword, basic_b64 := Basic}}) ->
    mongo_secrets(Mongo) ++ [AdminPassword, Basic, JwtSecret].

-spec mongo_secrets(geo_config:mongo()) -> [binary()].
mongo_secrets(#{auth := #{password := Password}}) -> [Password];
mongo_secrets(#{auth := none}) -> [].
