# One image serves the editor page, Discord sign-in and the API.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Builds web/app.css from web/src/app.css with Tailwind (needs the dev dependencies, which the final image doesn't ship).
FROM node:22-alpine AS css
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./web
RUN npm run build:css

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY db ./db
COPY web ./web
COPY --from=css /app/web/app.css ./web/app.css
COPY seed ./seed
# Run as the unprivileged "node" user, never root.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server/server.js"]
