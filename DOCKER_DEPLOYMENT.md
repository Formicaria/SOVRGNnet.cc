# Decentralized Discord - Docker Deployment & Migration Guide

This guide covers deploying Decentralized Discord on a Raspberry Pi 5 with easy migration to a mini PC later.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Initial Setup on Raspberry Pi 5](#initial-setup-on-raspberry-pi-5)
3. [Configuration](#configuration)
4. [Running the Application](#running-the-application)
5. [Backup & Migration](#backup--migration)
6. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Hardware Requirements

**Raspberry Pi 5:**
- 8GB RAM (minimum 4GB, but 8GB recommended)
- 64GB microSD card or external SSD (1TB+ recommended for IPFS)
- Power supply (27W recommended)
- Cooling case or heatsink
- Ethernet connection (WiFi works but Ethernet is more reliable)

**Mini PC (for later migration):**
- 4GB+ RAM
- 100GB+ storage
- Any modern Linux distribution

### Software Requirements

- Ubuntu Server 24.04 LTS (ARM64 for Pi 5)
- Docker 24.0+
- Docker Compose 2.0+
- Git (optional, for cloning repository)

---

## Initial Setup on Raspberry Pi 5

### Step 1: Install Ubuntu Server on Raspberry Pi 5

1. Download Ubuntu Server 24.04 LTS ARM64 from [ubuntu.com/download/raspberry-pi](https://ubuntu.com/download/raspberry-pi)
2. Flash to microSD card using Balena Etcher or similar tool
3. Insert microSD card into Pi 5 and power on
4. Wait 5-10 minutes for first boot
5. SSH into the Pi: `ssh ubuntu@<pi-ip-address>`
6. Default password: `ubuntu` (change on first login)

### Step 2: Update System

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y git curl wget
```

### Step 3: Clone Repository

```bash
git clone https://github.com/your-username/decentralized-discord.git
cd decentralized-discord
```

Or if you downloaded the code manually:

```bash
# Extract the downloaded files
unzip decentralized-discord.zip
cd decentralized-discord
```

### Step 4: Make Scripts Executable

```bash
chmod +x scripts/setup-docker.sh
chmod +x scripts/backup.sh
chmod +x scripts/restore.sh
```

### Step 5: Run Setup Script

```bash
./scripts/setup-docker.sh
```

This script will:
- Install Docker and Docker Compose
- Create necessary directories
- Generate JWT secret
- Build the application image (takes 10-15 minutes)
- Start all services

---

## Configuration

### Environment Variables

Edit `.env` file with your configuration:

```bash
nano .env
```

**Required variables:**

| Variable | Description | Example |
|----------|-------------|---------|
| `DB_ROOT_PASSWORD` | MySQL root password | `SecurePassword123!` |
| `DB_PASSWORD` | MySQL discord user password | `DiscordPassword456!` |
| `JWT_SECRET` | Session signing secret | Auto-generated |
| `VITE_APP_ID` | Manus OAuth app ID | `your-app-id` |
| `OWNER_OPEN_ID` | Your Manus user ID | `user-id` |
| `OWNER_NAME` | Your name | `John Doe` |
| `REACT_APP_WALLET_CONNECT_PROJECT_ID` | WalletConnect project ID | `your-project-id` |
| `MATRIX_SERVER_NAME` | Matrix homeserver domain | `matrix.example.com` |
| `DOMAIN` | Your domain name | `example.com` |

**Optional variables:**

```bash
# Matrix configuration
MATRIX_HOMESERVER_URL=http://matrix:8008
MATRIX_SERVER_NAME=matrix.your-domain.com

# IPFS configuration
IPFS_API_URL=http://ipfs:5001

# SSL/HTTPS
SSL_CERT_PATH=/etc/nginx/ssl/cert.pem
SSL_KEY_PATH=/etc/nginx/ssl/key.pem
```

### Generate Secrets

Generate a strong JWT secret:

```bash
openssl rand -base64 32
```

Copy the output to `JWT_SECRET` in `.env`.

---

## Running the Application

### Start Services

```bash
docker-compose up -d
```

### Check Status

```bash
docker-compose ps
```

Expected output:

```
NAME                                   STATUS
decentralized-discord-app              Up (healthy)
decentralized-discord-db               Up (healthy)
decentralized-discord-matrix           Up
decentralized-discord-ipfs             Up
decentralized-discord-nginx            Up
```

### View Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f app
docker-compose logs -f db
docker-compose logs -f matrix
```

### Access Services

| Service | URL | Port |
|---------|-----|------|
| Application | http://localhost:3000 | 3000 |
| Matrix | http://localhost:8008 | 8008 |
| IPFS | http://localhost:5001 | 5001 |
| MySQL | localhost:3306 | 3306 |

### Stop Services

```bash
docker-compose down
```

### Restart Services

```bash
docker-compose restart
```

---

## Backup & Migration

### Creating Backups

Backup all data regularly:

```bash
./scripts/backup.sh
```

This creates a compressed archive in `./backups/` containing:
- MySQL database dump
- IPFS node data
- Matrix homeserver data
- Configuration files

### Backup Schedule

Set up automatic daily backups using cron:

```bash
# Edit crontab
crontab -e

# Add this line to run backup daily at 2 AM
0 2 * * * cd /home/ubuntu/decentralized-discord && ./scripts/backup.sh
```

### Transferring Backups

Transfer backups to safe location:

```bash
# To external drive
cp -r ./backups/* /mnt/external-drive/

# Via SCP to another server
scp -r ./backups/discord_backup_*.tar.gz user@backup-server:/backups/

# Via rsync (incremental)
rsync -avz ./backups/ user@backup-server:/backups/
```

### Migrating to Mini PC

#### On Raspberry Pi 5 (source):

```bash
# Create final backup
./scripts/backup.sh

# Transfer backup to mini PC
scp ./backups/discord_backup_*.tar.gz user@mini-pc:/home/user/
```

#### On Mini PC (destination):

```bash
# Install Docker and Docker Compose (same as Pi setup)
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Clone repository or copy files
git clone <repository-url>
cd decentralized-discord

# Make scripts executable
chmod +x scripts/*.sh

# Restore from backup
./scripts/restore.sh discord_backup_20260219_120000
```

#### Post-Migration:

1. **Update DNS records** to point to mini PC's IP address
2. **Update firewall rules** if on different network
3. **Update SSL certificates** if using custom domain
4. **Test application** at http://localhost:3000
5. **Keep Pi as backup** or repurpose it

---

## Network Configuration

### Accessing from Outside Your Network

#### Option 1: Dynamic DNS (Easiest)

1. Sign up for dynamic DNS service (e.g., DuckDNS, No-IP)
2. Install dynamic DNS client on Pi:
   ```bash
   sudo apt install ddclient
   ```
3. Configure with your service credentials
4. Access via: `http://your-domain.duckdns.org`

#### Option 2: Static IP + Port Forwarding

1. Assign static IP to Pi in router
2. Port forward 80/443 to Pi's IP in router settings
3. Point domain to your public IP
4. Access via: `http://your-domain.com`

#### Option 3: Reverse SSH Tunnel (Most Secure)

```bash
# On Pi, create tunnel to remote server
ssh -R 80:localhost:3000 user@remote-server

# Access via remote server
http://remote-server:80
```

### Firewall Configuration

```bash
# Allow SSH
sudo ufw allow 22/tcp

# Allow HTTP
sudo ufw allow 80/tcp

# Allow HTTPS
sudo ufw allow 443/tcp

# Allow Matrix
sudo ufw allow 8008/tcp

# Allow IPFS
sudo ufw allow 5001/tcp
sudo ufw allow 4001/tcp
sudo ufw allow 4001/udp

# Enable firewall
sudo ufw enable
```

---

## SSL/HTTPS Configuration

### Using Let's Encrypt (Recommended)

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Get certificate
sudo certbot certonly --standalone -d your-domain.com

# Update nginx.conf with certificate paths
# Restart nginx
docker-compose restart nginx
```

### Using Self-Signed Certificate (Testing)

```bash
# Generate self-signed certificate
mkdir -p ./ssl
openssl req -x509 -newkey rsa:4096 -keyout ./ssl/key.pem -out ./ssl/cert.pem -days 365 -nodes

# Update docker-compose.yml to use certificates
```

---

## Performance Optimization for Raspberry Pi 5

### Memory Optimization

```bash
# Limit service memory usage in docker-compose.yml
services:
  app:
    deploy:
      resources:
        limits:
          memory: 1G
  db:
    deploy:
      resources:
        limits:
          memory: 1.5G
```

### Storage Optimization

```bash
# Clean up old Docker images and containers
docker system prune -a

# Limit IPFS storage
docker exec ipfs ipfs config Datastore.StorageMax 50GB
```

### Network Optimization

```bash
# Use Ethernet instead of WiFi
# Reduce Matrix federation traffic (configure in Matrix settings)
# Use CDN for static assets
```

---

## Troubleshooting

### Services Not Starting

```bash
# Check Docker daemon
sudo systemctl status docker

# View detailed logs
docker-compose logs

# Restart Docker
sudo systemctl restart docker
```

### Database Connection Issues

```bash
# Check database is running
docker-compose ps db

# Test database connection
docker-compose exec db mysql -u root -p -e "SHOW DATABASES;"

# Check database logs
docker-compose logs db
```

### Out of Memory

```bash
# Check memory usage
free -h
docker stats

# Reduce container memory limits
# Stop non-essential services
# Increase swap space
```

### Disk Space Issues

```bash
# Check disk usage
df -h

# Clean up Docker
docker system prune -a

# Move IPFS data to external drive
# Reduce database retention
```

### Matrix Homeserver Issues

```bash
# Check Matrix logs
docker-compose logs matrix

# Verify Matrix is accessible
curl http://localhost:8008/_matrix/client/versions

# Restart Matrix
docker-compose restart matrix
```

### IPFS Connection Issues

```bash
# Check IPFS status
docker-compose exec ipfs ipfs id

# View IPFS peers
docker-compose exec ipfs ipfs swarm peers

# Restart IPFS
docker-compose restart ipfs
```

---

## Maintenance

### Regular Tasks

**Daily:**
- Monitor disk space: `df -h`
- Check service health: `docker-compose ps`

**Weekly:**
- Create backup: `./scripts/backup.sh`
- Review logs: `docker-compose logs`

**Monthly:**
- Update Docker images: `docker-compose pull`
- Clean up old data: `docker system prune`
- Test backup restore: `./scripts/restore.sh`

### Updates

```bash
# Update Docker images
docker-compose pull

# Rebuild application
docker-compose build

# Restart services
docker-compose up -d
```

---

## Support & Resources

- **Documentation:** See `README.md`
- **Issues:** Report on GitHub
- **Matrix Community:** Join `#decentralized-discord:matrix.org`
- **IPFS Help:** https://docs.ipfs.io
- **Docker Help:** https://docs.docker.com

---

## License

This project is licensed under the MIT License. See LICENSE file for details.
