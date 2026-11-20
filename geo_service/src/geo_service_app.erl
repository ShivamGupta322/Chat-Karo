-module(geo_service_app).
-behaviour(application).

-export([start/2, stop/1]).

-spec start(application:start_type(), term()) -> {ok, pid()} | {error, term()}.
start(_Type, _Args) ->
    maybe
        {ok, Listen} ?= geo_config:http_listen(),
        {ok, Mongo} ?= geo_config:mongo(),
        %% The redaction filter must be in place before anything that holds the password starts.
        ok = geo_log_redact:install(secrets(Mongo)),
        %% The filter stays installed if the supervisor fails to start: the application
        %% controller logs the exit reason after this returns, and it could carry the password.
        %% It is uninstalled in stop/1 only.
        geo_service_sup:start_link(#{listen => Listen, mongo => Mongo})
    else
        {error, {bad_config, Key}} = Failure ->
            %% Key name only: never log the configured value.
            logger:error(#{event => bad_config, key => Key}),
            Failure
    end.

-spec stop(term()) -> ok.
stop(_State) ->
    geo_log_redact:uninstall().

-spec secrets(geo_config:mongo()) -> [binary()].
secrets(#{auth := #{password := Password}}) -> [Password];
secrets(#{auth := none}) -> [].
