FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json server.mjs catalog.json ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node media ./media
COPY --chown=node:node scripts/export.mjs ./scripts/export.mjs
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=8785 DATA_DIR=/app/data
EXPOSE 8785
CMD ["node", "server.mjs"]
