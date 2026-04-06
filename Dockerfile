FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/api/package.json packages/api/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/cli/package.json packages/cli/
RUN npm install --workspace=packages/api
COPY packages/api packages/api
COPY tsconfig.base.json .
RUN npm run build --workspace=packages/api

# Pre-download the ONNX cross-encoder model during build so it's cached in the image.
# This avoids a ~30MB download on first recall in production.
# Cache dir set explicitly so it works in non-root build contexts.
ENV TRANSFORMERS_CACHE=/app/.model-cache
RUN node -e "import('@xenova/transformers').then(({pipeline,env})=>{env.cacheDir='/app/.model-cache';return pipeline('text-classification','Xenova/ms-marco-MiniLM-L-6-v2',{quantized:true})}).then(()=>console.log('Model cached')).catch(e=>console.warn('Model pre-cache skipped:',e.message))"

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/packages/api/dist ./dist
COPY --from=builder /app/packages/api/package.json .
COPY --from=builder /app/node_modules ./node_modules
COPY packages/api/src/db/schema.sql ./src/db/schema.sql

# Copy cached ONNX model from builder stage (optional, skip if not cached)
COPY --from=builder /app/.model-cache /app/.model-cache

RUN addgroup --system app && adduser --system --ingroup app app
RUN chown -R app:app /app

ENV NODE_ENV=production
ENV PORT=3141
ENV TRANSFORMERS_CACHE=/app/.model-cache
EXPOSE 3141

USER app
CMD ["node", "dist/index.js"]
