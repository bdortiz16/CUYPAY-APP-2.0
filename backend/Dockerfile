# syntax=docker/dockerfile:1
# Imagen de producción del backend CuyPay.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
RUN addgroup -S cuypay && adduser -S cuypay -G cuypay
COPY --from=build --chown=cuypay:cuypay /app/node_modules ./node_modules
COPY --from=build --chown=cuypay:cuypay /app/dist ./dist
COPY --chown=cuypay:cuypay package.json ./
USER cuypay
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "dist/src/index.js"]
