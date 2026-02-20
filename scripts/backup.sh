#!/bin/bash

# Decentralized Discord - Backup Script
# Creates backups of all data for migration or disaster recovery

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="discord_backup_${TIMESTAMP}"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Decentralized Discord - Backup Script${NC}"
echo -e "${GREEN}========================================${NC}"

# Create backup directory
mkdir -p "$BACKUP_DIR"

echo -e "${YELLOW}Starting backup at $(date)${NC}"
echo -e "${YELLOW}Backup location: $BACKUP_DIR/$BACKUP_NAME${NC}"

# Create backup subdirectory
mkdir -p "$BACKUP_DIR/$BACKUP_NAME"

# Backup MySQL database
echo -e "${YELLOW}Backing up MySQL database...${NC}"
docker-compose exec -T db mysqldump -u root -p"$(grep DB_ROOT_PASSWORD .env | cut -d '=' -f2)" --all-databases > "$BACKUP_DIR/$BACKUP_NAME/database.sql"
echo -e "${GREEN}✓ Database backed up${NC}"

# Backup IPFS data
echo -e "${YELLOW}Backing up IPFS data...${NC}"
docker run --rm -v decentralized-discord_ipfs_data:/ipfs_data -v "$(pwd)/$BACKUP_DIR/$BACKUP_NAME":/backup alpine tar czf /backup/ipfs_data.tar.gz -C /ipfs_data .
echo -e "${GREEN}✓ IPFS data backed up${NC}"

# Backup Matrix data
echo -e "${YELLOW}Backing up Matrix data...${NC}"
docker run --rm -v decentralized-discord_matrix_data:/matrix_data -v "$(pwd)/$BACKUP_DIR/$BACKUP_NAME":/backup alpine tar czf /backup/matrix_data.tar.gz -C /matrix_data .
echo -e "${GREEN}✓ Matrix data backed up${NC}"

# Backup configuration files
echo -e "${YELLOW}Backing up configuration files...${NC}"
cp .env "$BACKUP_DIR/$BACKUP_NAME/.env.backup"
cp docker-compose.yml "$BACKUP_DIR/$BACKUP_NAME/docker-compose.yml.backup"
cp Dockerfile "$BACKUP_DIR/$BACKUP_NAME/Dockerfile.backup"
echo -e "${GREEN}✓ Configuration files backed up${NC}"

# Create backup metadata
echo -e "${YELLOW}Creating backup metadata...${NC}"
cat > "$BACKUP_DIR/$BACKUP_NAME/BACKUP_INFO.txt" << EOF
Decentralized Discord Backup
========================================
Backup Date: $(date)
Backup Name: $BACKUP_NAME
System: $(uname -a)
Docker Version: $(docker --version)
Docker Compose Version: $(docker-compose --version)

Contents:
- database.sql: MySQL database dump
- ipfs_data.tar.gz: IPFS node data
- matrix_data.tar.gz: Matrix homeserver data
- .env.backup: Environment configuration
- docker-compose.yml.backup: Docker Compose configuration
- Dockerfile.backup: Application Dockerfile

Restore Instructions:
1. Extract this backup archive
2. Copy files to new system
3. Run: ./scripts/restore.sh $BACKUP_NAME
4. Update .env with new configuration if needed
5. Run: docker-compose up -d

For migration to mini PC:
1. Transfer this backup to the new system
2. Install Docker and Docker Compose
3. Run the restore script
4. Update DNS/firewall rules
5. Done!
EOF

# Create compressed archive
echo -e "${YELLOW}Creating compressed archive...${NC}"
cd "$BACKUP_DIR"
tar czf "${BACKUP_NAME}.tar.gz" "$BACKUP_NAME"
cd - > /dev/null

# Calculate backup size
BACKUP_SIZE=$(du -sh "$BACKUP_DIR/${BACKUP_NAME}.tar.gz" | cut -f1)

# Display summary
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Backup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${GREEN}Backup Summary:${NC}"
echo "  - Name: $BACKUP_NAME"
echo "  - Location: $BACKUP_DIR/$BACKUP_NAME.tar.gz"
echo "  - Size: $BACKUP_SIZE"
echo "  - Timestamp: $TIMESTAMP"
echo ""
echo -e "${YELLOW}Files included:${NC}"
echo "  ✓ MySQL database dump"
echo "  ✓ IPFS node data"
echo "  ✓ Matrix homeserver data"
echo "  ✓ Configuration files"
echo "  ✓ Backup metadata"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Transfer backup to safe location: scp -r $BACKUP_DIR/${BACKUP_NAME}.tar.gz user@backup-server:/path/"
echo "2. For migration: Transfer to new system and run ./scripts/restore.sh"
echo "3. Keep encrypted backups off-site"
echo ""
echo -e "${GREEN}Backup path: $(pwd)/$BACKUP_DIR/${BACKUP_NAME}.tar.gz${NC}"
