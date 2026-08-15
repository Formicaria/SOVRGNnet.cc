#!/bin/bash

# SOVRGNnet - Docker Setup Script for Raspberry Pi 5
# This script sets up Docker and deploys the application

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}SOVRGNnet - Docker Setup${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if running on ARM64
if [[ $(uname -m) != "aarch64" ]]; then
    echo -e "${YELLOW}Warning: This script is optimized for ARM64 (Raspberry Pi 5).${NC}"
    echo -e "${YELLOW}Your system is: $(uname -m)${NC}"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}Docker not found. Installing Docker...${NC}"
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    echo -e "${GREEN}Docker installed successfully${NC}"
else
    echo -e "${GREEN}✓ Docker is installed${NC}"
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo -e "${YELLOW}Docker Compose not found. Installing Docker Compose...${NC}"
    sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
    echo -e "${GREEN}Docker Compose installed successfully${NC}"
else
    echo -e "${GREEN}✓ Docker Compose is installed${NC}"
fi

# Create necessary directories
echo -e "${YELLOW}Creating directories...${NC}"
mkdir -p ./scripts
mkdir -p ./ssl
mkdir -p ./logs
mkdir -p ./nginx

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}Creating .env file from template...${NC}"
    cp docker.env.template .env
    echo -e "${YELLOW}Please edit .env with your configuration${NC}"
    echo -e "${YELLOW}Required variables:${NC}"
    echo "  - DB_ROOT_PASSWORD"
    echo "  - DB_PASSWORD"
    echo "  - JWT_SECRET (generate: openssl rand -base64 32)"
    echo "  - REACT_APP_WALLET_CONNECT_PROJECT_ID"
    echo ""
    read -p "Press Enter after editing .env file..."
else
    echo -e "${GREEN}✓ .env file exists${NC}"
fi

# Create init database script if it doesn't exist
if [ ! -f "./scripts/init-db.sql" ]; then
    echo -e "${YELLOW}Creating database initialization script...${NC}"
    cat > ./scripts/init-db.sql << 'EOF'
-- Initial database setup
CREATE DATABASE IF NOT EXISTS sovrgnnet;
USE sovrgnnet;

-- Grant permissions
GRANT ALL PRIVILEGES ON sovrgnnet.* TO 'sovrgn'@'%';
FLUSH PRIVILEGES;
EOF
    echo -e "${GREEN}✓ Database initialization script created${NC}"
fi

# Generate JWT secret if not present in .env
if ! grep -q "JWT_SECRET=" .env || grep "JWT_SECRET=your_jwt_secret_here" .env > /dev/null; then
    echo -e "${YELLOW}Generating JWT_SECRET...${NC}"
    JWT_SECRET=$(openssl rand -base64 32)
    sed -i "s/JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
    echo -e "${GREEN}✓ JWT_SECRET generated${NC}"
fi

# Pull latest images
echo -e "${YELLOW}Pulling Docker images...${NC}"
docker-compose pull

# Build the application image
echo -e "${YELLOW}Building application image (this may take 10-15 minutes on Pi5)...${NC}"
docker-compose build --no-cache app

# Create volumes
echo -e "${YELLOW}Creating Docker volumes...${NC}"
docker volume create sovrgnnet_db_data || true
docker volume create sovrgnnet_matrix_data || true
docker volume create sovrgnnet_ipfs_data || true

# Start services
echo -e "${YELLOW}Starting services...${NC}"
docker-compose up -d

# Wait for services to be ready
echo -e "${YELLOW}Waiting for services to be ready...${NC}"
sleep 10

# Check service health
echo -e "${YELLOW}Checking service health...${NC}"
docker-compose ps

# Display access information
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Setup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${GREEN}Services are running at:${NC}"
echo "  - Application: http://localhost:3000"
echo "  - Matrix: http://localhost:8008"
echo "  - IPFS: http://localhost:5001"
echo "  - Database: localhost:3306"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Access the application at http://localhost:3000"
echo "2. Configure your domain and SSL certificates"
echo "3. Set up reverse proxy (Nginx) for HTTPS"
echo "4. Configure firewall rules to expose ports"
echo ""
echo -e "${YELLOW}Useful commands:${NC}"
echo "  - View logs: docker-compose logs -f app"
echo "  - Stop services: docker-compose down"
echo "  - Restart services: docker-compose restart"
echo "  - Backup data: ./scripts/backup.sh"
echo ""
echo -e "${GREEN}For migration to mini PC later, use: ./scripts/backup.sh${NC}"
