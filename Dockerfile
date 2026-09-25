FROM oven/bun:1.4.2-slim

ENV TDM_DATA_DIR=/data \
    TDM_HOST=0.0.0.0 \
    TDM_PORT=8080 \
    TDM_NO_BROWSER=1

WORKDIR /app

COPY package.json bun.lock ./
# Build-time packages compile dashboard/ into web/ below and are pruned
# afterwards, so the runtime image only carries what the miner needs.
RUN bun install --frozen-lockfile --ignore-scripts \
    && useradd --create-home --uid 10001 miner \
    && mkdir -p /data /home/miner \
    && chown miner:miner /data /home/miner

ENV HOME=/home/miner

COPY --chown=miner:miner src ./src
COPY --chown=miner:miner web ./web
COPY --chown=miner:miner dashboard ./dashboard
COPY --chown=miner:miner scripts ./scripts

# The server hands out plain static files, so the React bundle is rebuilt here
# from dashboard/ instead of trusting whatever copy came with the context.
RUN bun run build \
    && bun install --frozen-lockfile --production --ignore-scripts

USER miner
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "--eval", "const port = process.env.TDM_PORT ?? '8080'; const res = await fetch(`http://127.0.0.1:${port}/healthz`); if (!res.ok) process.exit(1)"]

CMD ["flock", "-n", "-F", "/data/lock.file", "bun", "src/main.ts", "-vv"]
