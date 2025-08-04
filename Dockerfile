FROM node:24-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with verbose logging to help debug
RUN npm ci

# Copy the rest of the application code
COPY . .

# Expose the port
EXPOSE 3000


# Command to run your application
CMD ["npm", "run", "dev"]
