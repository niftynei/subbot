# syntax=docker/dockerfile:1

FROM node:22-alpine AS web-build
WORKDIR /src/web

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
ARG VITE_GOOGLE_CLIENT_ID
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
RUN test -n "$VITE_GOOGLE_CLIENT_ID" || (echo "VITE_GOOGLE_CLIENT_ID build arg is required" && exit 1)
RUN npm run build

FROM golang:1.25-alpine AS go-build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/subbot ./cmd/server

FROM alpine:3.22
RUN addgroup -S subbot && adduser -S -G subbot subbot

WORKDIR /app
COPY --from=go-build /out/subbot /app/subbot
COPY --from=web-build /src/web/dist /app/web/dist

ENV PORT=8080
ENV STATIC_DIR=/app/web/dist

USER subbot
EXPOSE 8080
CMD ["/app/subbot"]
