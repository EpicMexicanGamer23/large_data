FROM node:18-alpine
EXPOSE 3000
WORKDIR /usr/src/app
COPY package.json .
RUN npm install
COPY . .
ENV POLL_INTERVAL=5000
ENV PORT=3000
ENTRYPOINT ["npm", "start"]
