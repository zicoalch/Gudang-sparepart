# Gudang Sparepart — standalone
# Build: docker build -t gudang-sparepart .
# Run:   docker run -p 3000:3000 -v gudang-data:/app/data gudang-sparepart
#        (PORT dan DB_PATH bisa di-override lewat environment)
FROM node:24-alpine

WORKDIR /app

# Install dependencies dulu (layer cache) — butuh package-lock.json
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Kode aplikasi (data/ TIDAK ikut — database dibuat saat runtime)
COPY server.js ./
COPY public ./public

# Port default 3000; platform hosting (Render/Railway) meng-override lewat $PORT
ENV PORT=3000
ENV DB_PATH=/app/data/gudang.db

EXPOSE 3000

CMD ["node", "server.js"]
