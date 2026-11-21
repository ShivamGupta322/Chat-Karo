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
%% Neither the password nor the token is ever logged, and no logger call receives the result.
-module(geo_session).

-export([create/2, new_localpart/0, new_password/0]).
-export_type([result/0]).

-type result() :: #{
    nickname := binary(),
    jid := binary(),
    xmpp_password := binary(),
    token := binary(),
    expires_in := pos_integer()
}.

-spec create(Nickname :: term(), geo_config:session_cfg()) ->
    {ok, result()} | {error, invalid_nickname | nickname_taken | unavailable | internal}.
create(Nickname, Cfg) ->
    case geo_nickname:validate(Nickname) of
        {ok, Nick} -> reserve(Nick, Cfg);
        {error, invalid} -> {error, invalid_nickname};
        %% Indistinguishable from a taken name.
        {error, reserved} -> {error, nickname_taken}
    end.

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
