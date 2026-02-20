#!/bin/bash

# Decentralized Discord - Restore Script
# Restores data from backup for migration or disaster recovery

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

if [ $# -eq 0 ]; then
    echo -e "${RED}Usage: $0 <backup_name_or_path>${NC}"
    echo ""
    echo "Examples:"
    echo "  $0 discord_backup_20260219_120000"
    echo "  $0 ./backups/discord_backup_20260219_120000.tar.gz"
    echo ""
    echo "Available backups:"
    ls -lh ./backups/*.tar.gz 2>/dev/null || echo "No backups found"
    exit 1
fi

BACKUP_SOURCE="$1"
BACKUP_DIR="./backups"

# Handle both directory and tar.gz formats
if [[ "$BACKUP_SOURCE" == *.tar.gz ]]; then
    echo -e "${YELLOW}Extracting backup archive...${NC}"
    BACKUP_NAME=$(basename "$BACKUP_SOURCE" .tar.gz)
    tar xzf "$BACKUP_SOURCE" -C "$BACKUP_DIR"
    BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
else
    BACKUP_NAME="$BACKUP_SOURCE"
    BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Decentralized Discord - Restore Script${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}Restoring from backup: $BACKUP_NAME${NC}"

# Check if backup exists
if [ ! -d "$BACKUP_PATH" ]; then
    echo -e "${RED}Error: Backup not found at $BACKUP_PATH${NC}"
    exit 1
fi

# Check if backup info exists
if [ ! -f "$BACKUP_PATH/BACKUP_INFO.txt" ]; then
    echo -e "${RED}Error: Invalid backup format (missing BACKUP_INFO.txt)${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Backup found${NC}"
cat "$BACKUP_PATH/BACKUP_INFO.txt"
echo ""

# Confirm restore
read -p "$(echo -e ${YELLOW}Proceed with restore? This will overwrite existing data. \(y/n\)${NC}) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Restore cancelled${NC}"
    exit 1
fi

# Stop running services
echo -e "${YELLOW}Stopping services...${NC}"
docker-compose down || true

# Restore configuration files
echo -e "${YELLOW}Restoring configuration files...${NC}"
if [ -f "$BACKUP_PATH/.env.backup" ]; then
    cp "$BACKUP_PATH/.env.backup" .env
    echo -e "${GREEN}✓ .env restored${NC}"
fi

# Remove old volumes
echo -e "${YELLOW}Removing old volumes...${NC}"
docker volume rm decentralized-discord_db_data || true
docker volume rm decentralized-discord_ipfs_data || true
docker volume rm decentralized-discord_matrix_data || true

# Create fresh volumes
echo -e "${YELLOW}Creating new volumes...${NC}"
docker volume create decentralized-discord_db_data
docker volume create decentralized-discord_ipfs_data
docker volume create decentralized-discord_matrix_data

# Restore database
echo -e "${YELLOW}Restoring MySQL database...${NC}"
docker-compose up -d db
echo -e "${YELLOW}Waiting for database to be ready...${NC}"
sleep 15

docker-compose exec -T db mysql -u root -p"$(grep DB_ROOT_PASSWORD .env | cut -d '=' -f2)" < "$BACKUP_PATH/database.sql"
echo -e "${GREEN}✓ Database restored${NC}"

# Restore IPFS data
echo -e "${YELLOW}Restoring IPFS data...${NC}"
docker run --rm -v decentralized-discord_ipfs_data:/ipfs_data -v "$BACKUP_PATH":/backup alpine tar xzf /backup/ipfs_data.tar.gz -C /ipfs_data
echo -e "${GREEN}✓ IPFS data restored${NC}"

# Restore Matrix data
echo -e "${YELLOW}Restoring Matrix data...${NC}"
docker run --rm -v decentralized-discord_matrix_data:/matrix_data -v "$BACKUP_PATH":/backup alpine tar xzf /backup/matrix_data.tar.gz -C /matrix_data
echo -e "${GREEN}✓ Matrix data restored${NC}"

# Start all services
echo -e "${YELLOW}Starting services...${NC}"
docker-compose up -d

# Wait for services to be ready
echo -e "${YELLOW}Waiting for services to be ready...${NC}"
sleep 10

# Check service health
echo -e "${YELLOW}Checking service health...${NC}"
docker-compose ps

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Restore Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${GREEN}Services are running at:${NC}"
echo "  - Application: http://localhost:3000"
echo "  - Matrix: http://localhost:8008"
echo "  - IPFS: http://localhost:5001"
echo ""
echo -e "${YELLOW}Post-restore steps:${NC}"
echo "1. Review .env file for any configuration changes needed"
echo "2. Update DNS records to point to this server"
echo "3. Update firewall rules if migrating to new network"
echo "4. Test application at http://localhost:3000"
echo "5. Configure SSL/HTTPS if needed"
echo ""
echo -e "${YELLOW}Useful commands:${NC}"
echo "  - View logs: docker-compose logs -f app"
echo "  - Verify data: docker-compose exec db mysql -u root -p -e 'SHOW DATABASES;'"
echo ""
