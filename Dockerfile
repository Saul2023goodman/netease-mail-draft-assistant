FROM node:20-bookworm

WORKDIR /app
ENV NODE_ENV=production

COPY . .

CMD ["npm", "start"]
