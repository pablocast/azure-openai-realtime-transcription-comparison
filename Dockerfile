# --- Stage 1: build the React SPA ---
FROM node:20-alpine AS web
WORKDIR /web
COPY web/frontend/package.json web/frontend/package-lock.json ./
RUN npm ci
COPY web/frontend/ ./
RUN npm run build

# --- Stage 2: Python runtime ---
FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

# Backend deps
COPY web/backend/requirements.txt /app/web/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/web/backend/requirements.txt

# App source: backend, prompts (src/), and built SPA from stage 1
COPY web/backend/ /app/web/backend/
COPY src/ /app/src/
COPY --from=web /web/dist /app/web/frontend/dist

EXPOSE 8080

# gunicorn serves the Flask app (object `app` in web/backend/server.py)
CMD ["gunicorn", \
     "--bind", "0.0.0.0:8080", \
     "--workers", "2", \
     "--threads", "8", \
     "--timeout", "60", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "--log-level", "info", \
     "--chdir", "/app/web/backend", \
     "server:app"]
