FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TDM_DATA_DIR=/data \
    TDM_HOST=0.0.0.0 \
    TDM_PORT=8080 \
    TDM_NO_BROWSER=1

WORKDIR /app

COPY requirements-headless.txt .
RUN pip install --no-cache-dir -r requirements-headless.txt \
    && useradd --create-home --uid 10001 miner \
    && mkdir /data \
    && chown miner:miner /data

COPY --chown=miner:miner *.py ./
COPY --chown=miner:miner lang ./lang
COPY --chown=miner:miner web ./web

USER miner
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2)"

CMD ["python", "main.py"]
