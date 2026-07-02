FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV DIREXIO_AGENT_SERVICE_HOST=0.0.0.0
ENV DIREXIO_AGENT_SERVICE_PORT=8797

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 8797

# The deployed product-agent container runs agent-service by default. ai-gateway
# is a hosted Direxio service and should be run separately by Direxio operators.
CMD ["node", "dist/bin/agent-service.js"]
