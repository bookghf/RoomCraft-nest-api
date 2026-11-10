# syntax=docker/dockerfile:1
#
# RoomCraft API (NestJS) as a container, e.g. for ECS or Cloud Run.
#   docker build -t roomcraft-api-nest .
#   docker run -p 8080:8080 --env-file .env roomcraft-api-nest

# ---- Build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- Run ----
FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY seed ./seed
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
