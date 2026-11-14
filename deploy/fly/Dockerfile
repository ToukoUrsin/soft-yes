# Soft Yes as one small machine: the API, the built page and a snapshot of the Cala cache.
# Build from the repo root: see deploy/publish.sh.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY deploy/fly/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY softyes softyes
COPY web/dist web/dist
COPY deploy/fly/seed.db seed.db
CMD ["sh", "-c", "python -m softyes.seed && exec uvicorn softyes.api:app --host 0.0.0.0 --port 8080 --proxy-headers --forwarded-allow-ips='*'"]
