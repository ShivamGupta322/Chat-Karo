-module(geo_config).

-export([http_listen/0, parse_port/1, parse_ip/1]).
-export_type([listen/0]).

-type listen() :: #{ip := inet:ip4_address(), port := inet:port_number()}.

%% The only function in the code base that reads the application environment.
-spec http_listen() -> {ok, listen()} | {error, {bad_config, http_ip | http_port}}.
http_listen() ->
    case parse_ip(application:get_env(geo_service, http_ip, undefined)) of
        {ok, Ip} ->
            case parse_port(application:get_env(geo_service, http_port, undefined)) of
                {ok, Port} -> {ok, #{ip => Ip, port => Port}};
                error -> {error, {bad_config, http_port}}
            end;
        error ->
            {error, {bad_config, http_ip}}
    end.

%% Integer, or a non-empty string/binary of ASCII digits, in 0..65535. Port 0 (ephemeral) is accepted
%% for the CT suite, but it would fail the container healthcheck, which probes a fixed port.
-spec parse_port(term()) -> {ok, inet:port_number()} | error.
parse_port(Port) when is_integer(Port), Port >= 0, Port =< 65535 ->
    {ok, Port};
parse_port(Bin) when is_binary(Bin) ->
    parse_port(binary_to_list(Bin));
parse_port([_ | _] = Str) ->
    case lists:all(fun is_digit/1, Str) of
        true -> parse_port(list_to_integer(Str));
        false -> error
    end;
parse_port(_) ->
    error.

%% IPv4 dotted quad only (string or binary).
-spec parse_ip(term()) -> {ok, inet:ip4_address()} | error.
parse_ip(Bin) when is_binary(Bin) ->
    parse_ip(binary_to_list(Bin));
parse_ip([_ | _] = Str) ->
    case lists:all(fun(C) -> is_integer(C) andalso C >= 0 andalso C =< 255 end, Str) of
        true ->
            case inet:parse_ipv4strict_address(Str) of
                {ok, Ip} -> {ok, Ip};
                {error, _} -> error
            end;
        false ->
            error
    end;
parse_ip(_) ->
    error.

-spec is_digit(term()) -> boolean().
is_digit(C) -> is_integer(C) andalso C >= $0 andalso C =< $9.
