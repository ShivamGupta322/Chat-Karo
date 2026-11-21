%% A raw-socket HTTP/1.1 client for the CT suites that need control over headers (duplicates
%% allowed), content-length versus chunked bodies, and the method. Always sends
%% connection: close, so a reply that is sent without reading the body is still delivered.
-module(geo_ct_http).

-export([request/4, request/5, chunked/1]).

-type response() :: {Status :: non_neg_integer(), #{binary() => binary()}, Body :: binary()}.
-export_type([response/0]).

-spec request(string(), string(), [{string(), string() | binary()}], iodata()) -> response().
request(Method, Target, Headers, Body) ->
    request(ranch:get_port(geo_http), Method, Target, Headers, Body).

-spec request(inet:port_number(), string(), string(), [{string(), string() | binary()}], iodata()) ->
    response().
request(Port, Method, Target, Headers, Body) ->
    Request = iolist_to_binary([
        Method,
        " ",
        Target,
        " HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n",
        [[Name, ": ", Value, "\r\n"] || {Name, Value} <- Headers],
        "\r\n",
        Body
    ]),
    {ok, Socket} = gen_tcp:connect({127, 0, 0, 1}, Port, [binary, {active, false}], 5000),
    %% The server may answer and close before it has read a large body: a send error is then
    %% fine, the response is still in the socket.
    _ = gen_tcp:send(Socket, Request),
    Response = recv_all(Socket, <<>>),
    gen_tcp:close(Socket),
    parse_response(Response).

-spec chunked(binary()) -> iodata().
chunked(Data) ->
    [integer_to_binary(byte_size(Data), 16), "\r\n", Data, "\r\n0\r\n\r\n"].

recv_all(Socket, Acc) ->
    case gen_tcp:recv(Socket, 0, 20000) of
        {ok, Data} -> recv_all(Socket, <<Acc/binary, Data/binary>>);
        {error, closed} -> Acc;
        {error, econnreset} when Acc =/= <<>> -> Acc;
        {error, Reason} -> ct:fail({recv_failed, Reason})
    end.

parse_response(Response) ->
    [Head, Body] = binary:split(Response, <<"\r\n\r\n">>),
    [StatusLine | HeaderLines] = binary:split(Head, <<"\r\n">>, [global]),
    <<"HTTP/1.1 ", Code:3/binary, _/binary>> = StatusLine,
    Headers = maps:from_list([
        begin
            [Name, Value] = binary:split(Line, <<": ">>),
            {string:lowercase(Name), Value}
        end
     || Line <- HeaderLines
    ]),
    {binary_to_integer(Code), Headers, Body}.
