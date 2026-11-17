# PostgreSQL 16 (same Alpine base as before, so existing data volumes stay compatible) + pgvector for RAG.
FROM postgres:16-alpine
ARG PGVECTOR_VERSION=v0.8.1
RUN apk add --no-cache --virtual .build-deps build-base clang21 llvm21 git \
 && git clone --depth 1 --branch ${PGVECTOR_VERSION} https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && cd /tmp/pgvector && make OPTFLAGS="" && make install \
 && cd / && rm -rf /tmp/pgvector && apk del .build-deps
