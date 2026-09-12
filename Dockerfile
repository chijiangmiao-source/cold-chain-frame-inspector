# ---- 构建静态页面 ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- 运行页面（nginx 静态服务） ----
FROM nginx:alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

# ---- 一次性验收：单元测试 + 端到端测试 ----
FROM mcr.microsoft.com/playwright:v1.47.2-jammy AS verify
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV BASE_URL=http://web:80
CMD ["sh", "-c", "node scripts/wait-for-web.mjs && npm run verify"]
