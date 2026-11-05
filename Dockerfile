# Sadak Sense: single container (API + fleet console + driver app). SQLite via Node's built-in driver.
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DB_FILE=/app/data/sadak.db
RUN npm test
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--no-warnings", "server/index.js"]
