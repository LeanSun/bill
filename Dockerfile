# 轻账 · 站点 + 同步后端，一个进程两件事
FROM node:22-alpine

WORKDIR /app
COPY . .

# 数据目录挂卷，否则容器一重建数据就没了
ENV PORT=8787 \
    HOST=0.0.0.0 \
    LEDGER_DATA=/data
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8787
CMD ["node", "server/server.js"]
