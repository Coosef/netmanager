FROM node:20-alpine AS development

WORKDIR /app
COPY package*.json ./
# TD-1 — strict, lockfile-pinned install (matches the production builder).
# The lockfile is regenerated from package.json with peer deps respected;
# the previous `--legacy-peer-deps` install pulled an incompatible @types
# tree and produced ~150 phantom TopologyV2 tsc errors.
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine AS production
COPY --from=builder /app/dist /usr/share/nginx/html
# Custom nginx config — SPA fallback, dev path 404, security headers,
# `listen 3000` (host upstream `frontend:3000` aynı kalır).
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
