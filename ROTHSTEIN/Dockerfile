FROM node:20-slim

WORKDIR /app

# Copy package files first for Docker layer caching
COPY ROTHSTEIN/package.json ROTHSTEIN/package-lock.json ./
RUN npm ci --production=false

# Copy source and build
COPY ROTHSTEIN/tsconfig.json ./
COPY ROTHSTEIN/src/ ./src/
COPY ROTHSTEIN/dashboard/ ./dashboard/
RUN npx tsc

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 3334

# Run
CMD ["node", "dist/index.js"]
