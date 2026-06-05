FROM node:20-alpine

WORKDIR /app
ENV VERCEL_STORE_PATH=/var/vercel-blob-store

COPY ./dist/server.cjs /app/server.cjs

EXPOSE 3000
CMD ["node", "/app/server.cjs"]
