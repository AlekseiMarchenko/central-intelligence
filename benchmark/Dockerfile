# Stage 1: Build CI API
FROM node:22-slim AS ci-builder
WORKDIR /ci
COPY central-intelligence/package.json central-intelligence/package-lock.json* ./
COPY central-intelligence/packages/api/package.json packages/api/
COPY central-intelligence/packages/mcp-server/package.json packages/mcp-server/
COPY central-intelligence/packages/cli/package.json packages/cli/
RUN npm install --workspace=packages/api
COPY central-intelligence/packages/api packages/api
COPY central-intelligence/tsconfig.base.json .
RUN npm run build --workspace=packages/api

# Pre-cache ONNX cross-encoder model (~1.1GB quantized)
# bge-reranker-v2-m3: +14% nDCG@10 over MiniLM, 8K context
ENV TRANSFORMERS_CACHE=/ci/.model-cache
RUN node -e "import('@xenova/transformers').then(({pipeline,env})=>{env.cacheDir='/ci/.model-cache';return pipeline('text-classification','onnx-community/bge-reranker-v2-m3-ONNX',{quantized:true})}).then(()=>console.log('Model cached')).catch(e=>console.warn('Skip:',e.message))"

# Stage 2: Build lifebench-eval
FROM node:22-slim AS lb-builder
WORKDIR /lb
COPY lifebench-eval/package.json lifebench-eval/package-lock.json* ./
RUN npm install
COPY lifebench-eval/tsconfig.json .
COPY lifebench-eval/src src
RUN npx tsc

# Stage 3: Runtime
FROM node:22-slim

# Install Postgres 17 + pgvector, git, python3
RUN apt-get update && apt-get install -y --no-install-recommends \
    gnupg curl ca-certificates lsb-release git python3 python3-pip python3-venv \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends \
    postgresql-17 postgresql-17-pgvector \
  && rm -rf /var/lib/apt/lists/*

# Python deps for LongMemEval evaluate_qa.py
RUN python3 -m venv /opt/lme-venv \
  && /opt/lme-venv/bin/pip install --no-cache-dir openai tqdm backoff numpy nltk

# CI API runtime
WORKDIR /app/ci
COPY --from=ci-builder /ci/packages/api/dist ./dist
COPY --from=ci-builder /ci/packages/api/package.json .
COPY --from=ci-builder /ci/node_modules ./node_modules
COPY central-intelligence/packages/api/src/db/schema.sql ./src/db/schema.sql
COPY --from=ci-builder /ci/.model-cache /app/.model-cache

# Lifebench runtime
WORKDIR /app/lifebench
COPY --from=lb-builder /lb/dist ./dist
COPY --from=lb-builder /lb/node_modules ./node_modules
COPY lifebench-eval/package.json .

# Entrypoint
COPY central-intelligence/benchmark/benchmark-entrypoint.sh /app/benchmark-entrypoint.sh
RUN chmod +x /app/benchmark-entrypoint.sh

ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE=/app/.model-cache
ENV PORT=3141
ENV PGDATA=/data/pgdata
ENV DATABASE_URL=postgres://ci_bench:ci_bench@localhost:5432/ci_bench

WORKDIR /app
CMD ["sleep", "infinity"]
