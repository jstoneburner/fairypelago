ARG NODE_VERSION=24.4.1

FROM node:${NODE_VERSION}-alpine

ENV NODE_ENV production

WORKDIR /usr/src/app

# Copy manifests first so Docker invalidates the npm install layer only when
# dependencies change, not on every source file change.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

RUN mkdir -p logs storage && chown node:node logs storage

USER node
COPY . .
CMD npm start