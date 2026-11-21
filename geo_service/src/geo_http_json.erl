%% Reads a small JSON-object request body with the checks every JSON endpoint needs: content
%% type, size cap (before and while reading) and decoding. Never logs the body.
-module(geo_http_json).

-export([read_json_object/2]).

-type failure() ::
    {error, 400 | 413 | 415, Code :: binary(), Message :: binary(), cowboy_req:req()}.

-spec read_json_object(cowboy_req:req(), pos_integer()) ->
    {ok, map(), cowboy_req:req()} | failure().
read_json_object(Req, MaxBytes) ->
    case check_content_type(Req) of
        ok -> check_length(Req, MaxBytes);
        error -> fail(415, <<"unsupported_media_type">>, <<"Send application/json.">>, Req)
    end.

-spec check_length(cowboy_req:req(), pos_integer()) -> {ok, map(), cowboy_req:req()} | failure().
check_length(Req, MaxBytes) ->
    case cowboy_req:body_length(Req) of
        Len when is_integer(Len), Len > MaxBytes -> too_large(Req);
        _ -> read(Req, MaxBytes)
    end.

%% One byte more than the cap is requested so that "exactly the cap" is distinguishable from
%% "more than the cap" (a chunked body reports `more` until it has seen the end).
-spec read(cowboy_req:req(), pos_integer()) -> {ok, map(), cowboy_req:req()} | failure().
read(Req0, MaxBytes) ->
    case cowboy_req:read_body(Req0, #{length => MaxBytes + 1, period => 5000}) of
        {ok, Body, Req} when byte_size(Body) =< MaxBytes -> decode(Body, Req);
        {ok, _Body, Req} -> too_large(Req);
        {more, _Body, Req} -> too_large(Req)
    end.

-spec decode(binary(), cowboy_req:req()) -> {ok, map(), cowboy_req:req()} | failure().
decode(Body, Req) ->
    try json:decode(Body) of
        Map when is_map(Map) -> {ok, Map, Req};
        _ -> invalid_json(Req)
    catch
        error:_ -> invalid_json(Req)
    end.

%% application/json, with an optional charset that must be utf-8.
-spec check_content_type(cowboy_req:req()) -> ok | error.
check_content_type(Req) ->
    try cowboy_req:parse_header(<<"content-type">>, Req) of
        {<<"application">>, <<"json">>, Params} -> check_params(Params);
        _ -> error
    catch
        _:_ -> error
    end.

-spec check_params([{binary(), binary()}]) -> ok | error.
check_params([]) ->
    ok;
check_params([{<<"charset">>, Charset}]) ->
    case string:lowercase(Charset) of
        <<"utf-8">> -> ok;
        _ -> error
    end;
check_params(_) ->
    error.

-spec too_large(cowboy_req:req()) -> failure().
too_large(Req) ->
    fail(413, <<"payload_too_large">>, <<"The request body is too large.">>, Req).

-spec invalid_json(cowboy_req:req()) -> failure().
invalid_json(Req) ->
    fail(400, <<"invalid_json">>, <<"The body must be a JSON object.">>, Req).

-spec fail(400 | 413 | 415, binary(), binary(), cowboy_req:req()) -> failure().
fail(Status, Code, Message, Req) ->
    {error, Status, Code, Message, Req}.
