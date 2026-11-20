-module(geo_service_app).
-behaviour(application).

-export([start/2, stop/1]).

-spec start(application:start_type(), term()) -> {ok, pid()} | {error, term()}.
start(_Type, _Args) ->
    case geo_config:http_listen() of
        {ok, Listen} ->
            geo_service_sup:start_link(Listen);
        {error, {bad_config, Key}} = Error ->
            %% Key name only: never log the configured value.
            logger:error(#{event => bad_config, key => Key}),
            Error
    end.

-spec stop(term()) -> ok.
stop(_State) ->
    ok.
