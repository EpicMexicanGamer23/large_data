FROM node:22-alpine
WORKDIR /usr/src/app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
EXPOSE 3000
ENTRYPOINT ["npm", "start"]