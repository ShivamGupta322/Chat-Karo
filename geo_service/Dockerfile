# syntax=docker/dockerfile:1
FROM erlang:28.4.2 AS build
WORKDIR /src
COPY rebar.config rebar.lock ./
RUN rebar3 as prod compile --deps_only
COPY config ./config
COPY src ./src
RUN rebar3 as prod release

FROM erlang:28.4.2-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /usr/sbin/nologin geo
COPY --from=build --chown=geo:geo /src/_build/prod/rel/geo_service /opt/geo_service
# No crash dumps: they can contain app env, which hold the Mongo password.
ENV ERL_CRASH_DUMP_SECONDS=0
USER geo
EXPOSE 8080
CMD ["/opt/geo_service/bin/geo_service", "foreground"]
