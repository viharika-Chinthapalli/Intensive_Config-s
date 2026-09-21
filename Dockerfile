# Fallback if Railpack still mis-detects; Railway can use Dockerfile builder.
FROM node:20-bookworm-slim

WORKDIR /app

COPY batch-tracker-ui/package.json batch-tracker-ui/package-lock.json ./batch-tracker-ui/
RUN npm ci --prefix batch-tracker-ui

COPY batch-tracker-ui ./batch-tracker-ui
RUN npm run build --prefix batch-tracker-ui \
  && test -f batch-tracker-ui/client/dist/index.html

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start", "--prefix", "batch-tracker-ui"]
