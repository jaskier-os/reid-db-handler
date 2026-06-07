FROM node:20-alpine

WORKDIR /app

# Install Python + pip for FAISS server subprocess
RUN apk add --no-cache python3 py3-pip

# Install pinned Python deps for the FAISS subprocess
COPY requirements.txt ./
RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt && \
    rm -rf /root/.cache /tmp/*

# Copy package files
COPY package*.json ./

# Install dependencies from the lockfile
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start the application
CMD ["node", "src/index.js"]
