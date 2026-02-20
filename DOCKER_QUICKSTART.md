# Docker Quick Start Guide

Get your Decentralized Discord running on Raspberry Pi 5 in 30 minutes!

## TL;DR - Quick Setup

```bash
# 1. Clone/download the project
git clone <repo-url>
cd decentralized-discord

# 2. Make scripts executable
chmod +x scripts/*.sh

# 3. Run setup
./scripts/setup-docker.sh

# 4. Edit configuration
nano .env

# 5. Start services
docker-compose up -d

# 6. Access at http://localhost:3000
```

## Detailed Steps

### Prerequisites

- Raspberry Pi 5 (8GB RAM recommended)
- Ubuntu Server 24.04 LTS ARM64
- SSH access to the Pi
- External SSD (optional but recommended)

### 1. SSH into Your Pi

```bash
ssh ubuntu@<your-pi-ip>
```

### 2. Download Project

**Option A: Using Git**
```bash
git clone https://github.com/your-username/decentralized-discord.git
cd decentralized-discord
```

**Option B: Manual Download**
```bash
# Download ZIP and extract
unzip decentralized-discord.zip
cd decentralized-discord
```

### 3. Run Automated Setup

```bash
chmod +x scripts/setup-docker.sh
./scripts/setup-docker.sh
```

This will:
- ✅ Install Docker & Docker Compose
- ✅ Create directories and volumes
- ✅ Generate JWT secret
- ✅ Build application image (10-15 min)
- ✅ Start all services

### 4. Configure Environment

```bash
nano .env
```

**Minimum required settings:**

```bash
DB_ROOT_PASSWORD=ChangeMe123!
DB_PASSWORD=ChangeMe456!
VITE_APP_ID=your-manus-app-id
OWNER_OPEN_ID=your-manus-user-id
OWNER_NAME=Your Name
REACT_APP_WALLET_CONNECT_PROJECT_ID=your-wallet-connect-id
```

### 5. Start Services

```bash
docker-compose up -d
```

### 6. Verify Services

```bash
docker-compose ps
```

Should show all services as "Up":
- decentralized-discord-app
- decentralized-discord-db
- decentralized-discord-matrix
- decentralized-discord-ipfs
- decentralized-discord-nginx

### 7. Access Application

Open browser and go to: **http://localhost:3000**

## Common Commands

```bash
# View logs
docker-compose logs -f app

# Stop services
docker-compose down

# Restart services
docker-compose restart

# Create backup
./scripts/backup.sh

# Restore from backup
./scripts/restore.sh discord_backup_20260219_120000

# Check service status
docker-compose ps

# View resource usage
docker stats
```

## Accessing from Outside Your Network

### Option 1: Dynamic DNS (Easiest)

1. Sign up at [DuckDNS](https://www.duckdns.org)
2. Get your domain: `yourname.duckdns.org`
3. Install on Pi:
   ```bash
   sudo apt install ddclient
   ```
4. Configure with your token
5. Access at: `http://yourname.duckdns.org`

### Option 2: Port Forwarding

1. Log into router settings
2. Forward port 80 to Pi's local IP (port 3000)
3. Point domain to your public IP
4. Access at: `http://your-domain.com`

## Troubleshooting

### Services won't start

```bash
# Check Docker daemon
sudo systemctl status docker

# View detailed logs
docker-compose logs

# Restart Docker
sudo systemctl restart docker
```

### Out of memory

```bash
# Check memory
free -h

# Reduce container limits in docker-compose.yml
# Or add swap space
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

### Database connection error

```bash
# Wait a bit longer for database to start
sleep 30
docker-compose restart app
```

### Can't access from browser

```bash
# Check if app is running
docker-compose ps

# Check logs
docker-compose logs app

# Test locally
curl http://localhost:3000
```

## Next Steps

1. **Configure SSL/HTTPS** - See DOCKER_DEPLOYMENT.md
2. **Set up backups** - Run `./scripts/backup.sh` regularly
3. **Monitor performance** - Use `docker stats`
4. **Plan migration** - Keep backups for easy migration to mini PC later

## Migration to Mini PC

When ready to upgrade:

```bash
# On Pi: Create backup
./scripts/backup.sh

# Transfer backup to mini PC
scp ./backups/discord_backup_*.tar.gz user@mini-pc:/home/user/

# On mini PC: Restore
./scripts/restore.sh discord_backup_20260219_120000
```

See DOCKER_DEPLOYMENT.md for full migration guide.

## Support

- Full documentation: `DOCKER_DEPLOYMENT.md`
- Logs: `docker-compose logs`
- Issues: Check GitHub repository

---

**Enjoy your decentralized Discord! 🚀**
