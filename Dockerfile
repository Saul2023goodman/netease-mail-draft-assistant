FROM node:20-bookworm

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
RUN npm install --omit=dev
RUN npx playwright install --with-deps chromium

COPY . .

CMD ["npm", "start"]
