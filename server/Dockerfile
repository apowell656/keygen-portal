FROM node:22-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/index.mjs server/mail.mjs server/provision.mjs ./
COPY src/promo/email.html /app/src/promo/email.html
ENV PORT=8081
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8081
CMD ["node", "index.mjs"]
