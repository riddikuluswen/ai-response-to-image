FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173 \
    INTERNAL_BASE_URL=http://127.0.0.1:5173

EXPOSE 5173

CMD ["npm", "run", "start"]
