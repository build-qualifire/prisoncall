FROM node:18-alpine

WORKDIR /app

# No npm install needed — zero external dependencies.
COPY package.json server.js ./

EXPOSE 3000

# Drop to non-root user for security.
USER node

CMD ["node", "server.js"]
