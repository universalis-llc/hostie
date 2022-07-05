FROM node:18-alpine

RUN apk add --no-cache jq

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./
COPY pnpm*.yaml ./

RUN corepack enable
RUN pnpm install --prod

COPY index.js ./
COPY src ./src

CMD [ "pnpm", "run", "start" ]

HEALTHCHECK --start-period=10s --interval=5s --timeout=2s CMD sh -c "nc -z 127.0.0.1 $(jq .http.port config.json); echo $?"
