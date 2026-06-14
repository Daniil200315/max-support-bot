FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# финальный образ без build tools
FROM node:22-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY bot.js ./

RUN mkdir -p /app/data

CMD ["node", "bot.js"]
