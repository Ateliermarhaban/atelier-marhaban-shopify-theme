# Lichte, stabiele Node-runtime voor de connector.
FROM node:20-alpine

WORKDIR /app

# Eerst alleen de manifesten kopiëren voor betere build-caching.
COPY package.json ./
RUN npm install --omit=dev

# Daarna de rest van de broncode.
COPY . .

# De service luistert op PORT (default 3000) voor Shopify-webhooks
# en draait de Odoo->Shopify-poller in hetzelfde proces.
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
