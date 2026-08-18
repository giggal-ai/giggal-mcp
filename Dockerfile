# Self-hostable Giggal.ai MCP server (stdio transport).
#
# Build:  docker build -t giggal-mcp .
# Run:    docker run -i --rm -e GIGGAL_API_KEY=tp_live_... giggal-mcp
#
# It calls the public Giggal.ai API with your own Developer API key, so it
# needs no database, OAuth, or backend secret.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# stdio MCP server — provide GIGGAL_API_KEY at runtime.
ENTRYPOINT ["node", "dist/local/index.js"]
