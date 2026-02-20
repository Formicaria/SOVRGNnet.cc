#!/bin/bash

# Decentralized Discord - Pi 5 + Cloud Storage Setup Script
# This script automates the setup for Raspberry Pi 5 with cloud-based storage
# Supports: PlanetScale (database), NFT.storage (IPFS), Cloudflare (DNS)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Functions
print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

# Start
print_header "Decentralized Discord - Pi 5 + Cloud Setup"

# Check if running on ARM64
if [[ $(uname -m) != "aarch64" ]]; then
    print_warning "This script is optimized for ARM64 (Raspberry Pi 5)"
    print_warning "Your system is: $(uname -m)"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Update system
print_header "Step 1: Updating System"
sudo apt update
sudo apt upgrade -y
sudo apt install -y git curl wget
print_success "System updated"

# Install Docker
print_header "Step 2: Installing Docker"
if ! command -v docker &> /dev/null; then
    print_warning "Docker not found. Installing..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    print_success "Docker installed"
else
    print_success "Docker already installed"
fi

# Install Docker Compose
print_header "Step 3: Installing Docker Compose"
if ! command -v docker-compose &> /dev/null; then
    print_warning "Docker Compose not found. Installing..."
    sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
    print_success "Docker Compose installed"
else
    print_success "Docker Compose already installed"
fi

# Create directories
print_header "Step 4: Creating Directories"
mkdir -p ./scripts
mkdir -p ./ssl
mkdir -p ./logs
mkdir -p ./nginx
print_success "Directories created"

# Check for .env file
print_header "Step 5: Environment Configuration"
if [ ! -f ".env" ]; then
    print_warning "Creating .env file from template..."
    cp docker.env.template .env
    echo ""
    echo -e "${YELLOW}IMPORTANT: Edit .env with your cloud service credentials${NC}"
    echo ""
    echo -e "${YELLOW}Required values:${NC}"
    echo "  1. DATABASE_URL - From PlanetScale"
    echo "     Format: mysql://user:password@aws.connect.psdb.cloud:3306/db?sslaccept=strict"
    echo ""
    echo "  2. NFT_STORAGE_API_KEY - From NFT.storage"
    echo "     Format: eyJhbGc... (long string)"
    echo ""
    echo "  3. JWT_SECRET - Generate with: openssl rand -base64 32"
    echo ""
    echo "  4. Other values - Manus OAuth, Web3, etc."
    echo ""
    read -p "Press Enter after editing .env file with nano..."
    nano .env
else
    print_success ".env file already exists"
fi

# Generate JWT secret if missing
print_header "Step 6: Generating Secrets"
if ! grep -q "JWT_SECRET=" .env || grep "JWT_SECRET=your_jwt_secret_here" .env > /dev/null; then
    print_warning "Generating JWT_SECRET..."
    JWT_SECRET=$(openssl rand -base64 32)
    sed -i "s/JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
    print_success "JWT_SECRET generated"
fi

# Make scripts executable
print_header "Step 7: Making Scripts Executable"
chmod +x scripts/*.sh
print_success "Scripts are executable"

# Create init database script
print_header "Step 8: Creating Database Initialization Script"
if [ ! -f "./scripts/init-db.sql" ]; then
    cat > ./scripts/init-db.sql << 'EOF'
-- Initial database setup for cloud-based deployment
-- Note: Using PlanetScale, so this is minimal
CREATE DATABASE IF NOT EXISTS decentralized_discord;
USE decentralized_discord;
EOF
    print_success "Database init script created"
fi

# Pull Docker images
print_header "Step 9: Pulling Docker Images"
print_warning "This may take 5-10 minutes..."
docker-compose -f docker-compose-cloud.yml pull

# Build application image
print_header "Step 10: Building Application Image"
print_warning "Building Docker image (this takes 10-15 minutes on Pi 5)..."
print_warning "Please be patient..."
docker-compose -f docker-compose-cloud.yml build app

# Create volumes
print_header "Step 11: Creating Docker Volumes"
docker volume create decentralized-discord_matrix_data || true
docker volume create decentralized-discord_ipfs_data || true
docker volume create decentralized-discord_ipfs_export || true
docker volume create decentralized-discord_nginx_cache || true
print_success "Volumes created"

# Start services
print_header "Step 12: Starting Services"
print_warning "Starting Docker services..."
docker-compose -f docker-compose-cloud.yml up -d

# Wait for services to be ready
print_header "Step 13: Waiting for Services"
print_warning "Waiting 15 seconds for services to initialize..."
sleep 15

# Check service health
print_header "Step 14: Checking Service Health"
docker-compose -f docker-compose-cloud.yml ps

# Display access information
echo ""
print_header "Setup Complete!"
echo ""
echo -e "${GREEN}Your Decentralized Discord is running!${NC}"
echo ""
echo -e "${BLUE}Access Information:${NC}"
echo "  Application: http://$(hostname -I | awk '{print $1}'):3000"
echo "  Matrix: http://$(hostname -I | awk '{print $1}'):8008"
echo "  IPFS: http://$(hostname -I | awk '{print $1}'):5001"
echo ""
echo -e "${BLUE}Cloud Services:${NC}"
echo "  Database: PlanetScale (check .env for connection details)"
echo "  File Storage: NFT.storage (check .env for API key)"
echo ""
echo -e "${BLUE}Next Steps:${NC}"
echo "  1. Open browser to http://$(hostname -I | awk '{print $1}'):3000"
echo "  2. Test the application"
echo "  3. Create a server and channel"
echo "  4. Invite friends to join"
echo ""
echo -e "${BLUE}Useful Commands:${NC}"
echo "  View logs: docker-compose -f docker-compose-cloud.yml logs -f app"
echo "  Stop services: docker-compose -f docker-compose-cloud.yml down"
echo "  Restart services: docker-compose -f docker-compose-cloud.yml restart"
echo "  Check status: docker-compose -f docker-compose-cloud.yml ps"
echo ""
echo -e "${BLUE}For Public Access:${NC}"
echo "  1. Set up Cloudflare Tunnel (see PI5_CLOUD_SETUP_GUIDE.md)"
echo "  2. Or use port forwarding on your router"
echo "  3. Or access locally on your home network"
echo ""
echo -e "${YELLOW}Important:${NC}"
echo "  - Keep your .env file secret (contains passwords)"
echo "  - Regular backups: ./scripts/backup.sh"
echo "  - Monitor resources: docker stats"
echo "  - Check logs for errors: docker-compose logs"
echo ""
echo -e "${GREEN}Documentation:${NC}"
echo "  - Full Guide: PI5_CLOUD_SETUP_GUIDE.md"
echo "  - Quick Reference: PI5_QUICK_REFERENCE.md"
echo "  - Docker Guide: DOCKER_DEPLOYMENT.md"
echo ""
print_success "Setup script completed successfully!"
