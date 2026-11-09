FROM node:22-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
