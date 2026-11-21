%% Creates a pseudonymous session (ADR-017): reserve the nickname, register a random-localpart
%% XMPP account with a random password through the MongooseIM admin API, activate the profile,
%% issue a JWT. Runs in the calling (Cowboy request) process: blocking up to the admin client's
%% timeouts is fine, and there is no shared state to serialise on. The unique nickname index is
%% the only arbiter of concurrent claims.
%%
%% Rollback order: if registering fails the account might still exist (a timeout can hide a
%% success), so a best-effort removeUser runs, EXCEPT after "exists" (that account is somebody
%% else's and is never removed) and after a 401 (refused before it ran). Both steps ignore
%% their result; a profile that could not be deleted expires through the expiresAt_ttl index.
%% If MongooseIM hangs or is slow, a late registration can commit after we gave up, leaving an
%% orphan account (no profile, unknown password): accepted, reconciled later (ADR-017). A
%% refused connection runs nothing and leaves no orphan.
%%
%% renew/3 (ADR-019) swaps a returning device's {jid, xmpp_password} for a fresh JWT. The order
%% matters: the shape check and the ACTIVE profile come first, so junk and deleted accounts
%% never cost a MongooseIM SCRAM check; only then the admin checkPassword. Nothing is logged on
%% success. The caller (geo_http_session_renew) wraps the call in its sanitising try/catch.
%%
%% Neither the password nor the token is ever logged, and no logger call receives the result.
-module(geo_session).

-export([create/2, renew/3, parse_credentials/3, new_localpart/0, new_password/0]).
-export_type([result/0, renew_result/0]).

-type result() :: #{
    nickname := binary(),
    jid := binary(),
    xmpp_password := binary(),
    token := binary(),
    expires_in := pos_integer()
}.

-type renew_result() :: #{nickname := binary(), token := binary(), expires_in := pos_integer()}.

-spec create(Nickname :: term(), geo_config:session_cfg()) ->
    {ok, result()} | {error, invalid_nickname | nickname_taken | unavailable | internal}.
create(Nickname, Cfg) ->
    case geo_nickname:validate(Nickname) of
        {ok, Nick} -> reserve(Nick, Cfg);
        {error, invalid} -> {error, invalid_nickname};
        %% Indistinguishable from a taken name.
        {error, reserved} -> {error, nickname_taken}
    end.

-spec renew(Jid :: term(), Password :: term(), geo_config:session_cfg()) ->
    {ok, renew_result()} | {error, invalid_credentials | unavailable | internal}.
renew(Jid, Password, #{xmpp_domain := Domain} = Cfg) ->
    case parse_credentials(Jid, Password, Domain) of
        {ok, Localpart} -> renew_profile(Localpart, Jid, Password, Cfg);
        error -> {error, invalid_credentials}
    end.

-spec renew_profile(binary(), binary(), binary(), geo_config:session_cfg()) ->
    {ok, renew_result()} | {error, invalid_credentials | unavailable | internal}.
renew_profile(Localpart, Jid, Password, Cfg) ->
    case geo_store:get_profile(Localpart) of
        {ok, #{state := active, nickname := Nickname}} ->
            renew_check(Localpart, Nickname, Jid, Password, Cfg);
        {ok, _Pending} ->
            {error, invalid_credentials};
        not_found ->
            {error, invalid_credentials};
        {error, mongo_unavailable} ->
            {error, unavailable};
        {error, bad_document} ->
            {error, internal}
    end.

-spec renew_check(binary(), binary(), binary(), binary(), geo_config:session_cfg()) ->
    {ok, renew_result()} | {error, invalid_credentials | unavailable | internal}.
renew_check(Localpart, Nickname, Jid, Password, #{jwt_secret := Secret, admin := Admin}) ->
    case geo_xmpp_admin:check_password(Admin, Jid, Password) of
        ok ->
            {Token, ExpiresIn} = geo_auth:issue(Localpart, Secret, erlang:system_time(second)),
            {ok, #{nickname => Nickname, token => Token, expires_in => ExpiresIn}};
        {error, invalid} ->
            {error, invalid_credentials};
        {error, unavailable} ->
            {error, unavailable};
        {error, _UnauthorizedOrBadResponse} ->
            {error, internal}
    end.

%% Total on any term. The jid must be exactly u + 32 lowercase hex + @ + the XMPP domain (no
%% resource, no case folding) and the password exactly xp1_ + 32 base64url characters, i.e. the
%% shapes this service generates. Returns the localpart.
-spec parse_credentials(term(), term(), XmppDomain :: binary()) -> {ok, binary()} | error.
parse_credentials(Jid, Password, Domain) when is_binary(Jid), is_binary(Password) ->
    DomainSize = byte_size(Domain),
    case Jid of
        <<Localpart:33/binary, "@", Rest/binary>> when byte_size(Rest) =:= DomainSize ->
            case
                Rest =:= Domain andalso valid_localpart(Localpart) andalso valid_password(Password)
            of
                true -> {ok, Localpart};
                false -> error
            end;
        _ ->
            error
    end;
parse_credentials(_Jid, _Password, _Domain) ->
    error.

-spec valid_localpart(binary()) -> boolean().
valid_localpart(<<$u, Hex:32/binary>>) -> all_bytes(fun is_lower_hex/1, Hex);
valid_localpart(_) -> false.

-spec valid_password(binary()) -> boolean().
valid_password(<<"xp1_", Rest:32/binary>>) -> all_bytes(fun is_b64url/1, Rest);
valid_password(_) -> false.

-spec all_bytes(fun((byte()) -> boolean()), binary()) -> boolean().
all_bytes(Pred, Bin) -> lists:all(Pred, binary_to_list(Bin)).

-spec is_lower_hex(byte()) -> boolean().
is_lower_hex(C) -> (C >= $0 andalso C =< $9) orelse (C >= $a andalso C =< $f).

-spec is_b64url(byte()) -> boolean().
is_b64url(C) ->
    (C >= $A andalso C =< $Z) orelse (C >= $a andalso C =< $z) orelse (C >= $0 andalso C =< $9) orelse
        C =:= $- orelse C =:= $_.

%% u + 32 lowercase hex: node-prep safe, and never derived from the nickname.
-spec new_localpart() -> binary().
new_localpart() ->
    <<$u, (binary:encode_hex(crypto:strong_rand_bytes(16), lowercase))/binary>>.

%% The "xp1_" prefix lets the log filter redact it by pattern.
-spec new_password() -> binary().
new_password() ->
    Random = base64:encode(crypto:strong_rand_bytes(24), #{mode => urlsafe, padding => false}),
    <<"xp1_", Random/binary>>.

-spec reserve(binary(), geo_config:session_cfg()) ->
    {ok, result()} | {error, nickname_taken | unavailable | internal}.
reserve(Nick, Cfg) ->
    Localpart = new_localpart(),
    Password = new_password(),
    case geo_store:create_pending_profile(Localpart, Nick, os:timestamp()) of
        ok -> register(Nick, Localpart, Password, Cfg);
        {error, nickname_taken} -> {error, nickname_taken};
        {error, mongo_unavailable} -> {error, unavailable};
        {error, write_failed} -> {error, internal}
    end.

-spec register(binary(), binary(), binary(), geo_config:session_cfg()) ->
    {ok, result()} | {error, unavailable | internal}.
register(Nick, Localpart, Password, #{xmpp_domain := Domain, admin := Admin} = Cfg) ->
    case geo_xmpp_admin:register_user(Admin, Domain, Localpart, Password) of
        ok ->
            activate(Nick, Localpart, Password, Cfg);
        {error, exists} ->
            %% Never remove an account we did not create.
            _ = geo_store:delete_profile(Localpart),
            {error, internal};
        {error, unauthorized} ->
            %% A 401 means the request was refused before it ran: no account to remove.
            _ = geo_store:delete_profile(Localpart),
            {error, internal};
        {error, Reason} ->
            _ = geo_xmpp_admin:remove_user(Admin, Domain, Localpart),
            _ = geo_store:delete_profile(Localpart),
            case Reason of
                unavailable -> {error, unavailable};
                _ -> {error, internal}
            end
    end.

-spec activate(binary(), binary(), binary(), geo_config:session_cfg()) ->
    {ok, result()} | {error, unavailable}.
activate(Nick, Localpart, Password, #{jwt_secret := Secret, xmpp_domain := Domain, admin := Admin}) ->
    case geo_store:activate_profile(Localpart) of
        ok ->
            {Token, ExpiresIn} = geo_auth:issue(Localpart, Secret, erlang:system_time(second)),
            logger:info(#{event => session_created, localpart => Localpart}),
            {ok, #{
                nickname => Nick,
                jid => <<Localpart/binary, "@", Domain/binary>>,
                xmpp_password => Password,
                token => Token,
                expires_in => ExpiresIn
            }};
        {error, _} ->
            _ = geo_xmpp_admin:remove_user(Admin, Domain, Localpart),
            _ = geo_store:delete_profile(Localpart),
            logger:warning(#{event => session_rollback, localpart => Localpart, step => activate}),
            {error, unavailable}
    end.
