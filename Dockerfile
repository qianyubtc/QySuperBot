FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data SEED_DEMO=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir /app/data && chown node:node /app/data
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server/apps/server/src/main.js"]
