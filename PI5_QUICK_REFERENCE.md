# Pi 5 + Cloud Storage - Quick Reference Card

## 🚀 30-Minute Quick Start

### Prerequisites
- Raspberry Pi 5 (8GB RAM)
- microSD card (64GB+)
- Internet connection
- Free accounts: PlanetScale, NFT.storage

### Step 1: Install Ubuntu (5 min)
```bash
# Download Ubuntu Server 24.04 LTS ARM64
# Flash to microSD with Balena Etcher
# Insert into Pi 5 and power on
# SSH: ssh ubuntu@<pi-ip>
```

### Step 2: Set Up Cloud Services (5 min)

**PlanetScale (Database):**
1. Sign up at planetscale.com
2. Create database: `decentralized-discord`
3. Get connection string: `mysql://user:pass@host/db`

**NFT.storage (IPFS):**
1. Sign up at nft.storage
2. Create API key in "API Keys" section
3. Copy the key (starts with `ey...`)

### Step 3: Clone & Configure (5 min)
```bash
# Clone project
git clone https://github.com/your-username/decentralized-discord.git
cd decentralized-discord

# Copy template
cp docker.env.template .env

# Edit .env with your credentials
nano .env

# Required values:
# DATABASE_URL=mysql://...
# NFT_STORAGE_API_KEY=ey...
# JWT_SECRET=<generate: openssl rand -base64 32>
```

### Step 4: Install Docker (10 min)
```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
newgrp docker

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Make scripts executable
chmod +x scripts/*.sh
```

### Step 5: Deploy (5 min)
```bash
# Build and start
docker-compose -f docker-compose-cloud.yml build app
docker-compose -f docker-compose-cloud.yml up -d

# Check status
docker-compose -f docker-compose-cloud.yml ps

# View logs
docker-compose -f docker-compose-cloud.yml logs -f app
```

### Step 6: Access
```
http://<pi-ip>:3000
```

---

## 📋 Essential Commands

### Service Management
```bash
# Start services
docker-compose -f docker-compose-cloud.yml up -d

# Stop services
docker-compose -f docker-compose-cloud.yml down

# Restart services
docker-compose -f docker-compose-cloud.yml restart

# Check status
docker-compose -f docker-compose-cloud.yml ps

# View logs
docker-compose -f docker-compose-cloud.yml logs -f app
```

### System Info
```bash
# Pi IP address
hostname -I

# Disk space
df -h

# Memory usage
free -h

# CPU temperature
vcgencmd measure_temp

# Resource usage
docker stats
```

### Troubleshooting
```bash
# Check if port 3000 is open
sudo netstat -tlnp | grep 3000

# Test database connection
docker-compose -f docker-compose-cloud.yml exec app mysql -u user -p -h host -e "SHOW DATABASES;"

# Test IPFS
curl http://localhost:5001/api/v0/version

# Test Matrix
curl http://localhost:8008/_matrix/client/versions

# Restart Docker daemon
sudo systemctl restart docker
```

---

## 🔧 Environment Variables Cheat Sheet

| Variable | Source | Example |
|----------|--------|---------|
| `DATABASE_URL` | PlanetScale | `mysql://user:pass@aws.connect.psdb.cloud:3306/db?sslaccept=strict` |
| `NFT_STORAGE_API_KEY` | NFT.storage | `eyJhbGc...` |
| `JWT_SECRET` | Generate | `openssl rand -base64 32` |
| `VITE_APP_ID` | Manus | `your-app-id` |
| `OWNER_OPEN_ID` | Manus | `your-user-id` |
| `OWNER_NAME` | You | `Your Name` |
| `MATRIX_SERVER_NAME` | Your domain | `matrix.example.com` |
| `REACT_APP_WALLET_CONNECT_PROJECT_ID` | WalletConnect | `your-project-id` |

---

## 📊 Resource Usage

**Typical Pi 5 Usage:**
- CPU: 10-30%
- Memory: 1-2GB of 8GB
- Network: 1-10 Mbps (depends on users)
- Disk: Local services only (~5GB)

**Cloud Storage:**
- PlanetScale: 5GB free, scales as needed
- NFT.storage: 1TB free, scales as needed

---

## 🌐 Network Access

### Local Only (Default)
```
http://<pi-ip>:3000
```

### Cloudflare Tunnel (Recommended)
```bash
# Install cloudflared
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
chmod +x cloudflared-linux-arm64
sudo mv cloudflared-linux-arm64 /usr/local/bin/cloudflared

# Login
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create discord

# Route domain
cloudflared tunnel route dns discord your-domain.com

# Run
cloudflared tunnel run discord
```

Access at: `https://your-domain.com`

---

## 🔐 Security Checklist

- [ ] Change default Ubuntu password
- [ ] Set strong database password
- [ ] Keep NFT.storage API key secret
- [ ] Enable firewall: `sudo ufw enable`
- [ ] Allow only needed ports: `sudo ufw allow 3000/tcp`
- [ ] Keep system updated: `sudo apt update && sudo apt upgrade`
- [ ] Regular backups: `./scripts/backup.sh`
- [ ] Monitor logs: `docker-compose logs`

---

## 📈 Scaling Up

When you outgrow free tier:

1. **Upgrade PlanetScale** - More storage/performance
2. **Upgrade NFT.storage** - More file storage
3. **Add local storage** - SSD/HDD for IPFS
4. **Upgrade Pi** - Move to mini PC or server
5. **Add CDN** - Cloudflare for caching

---

## 🆘 Common Issues & Fixes

| Issue | Fix |
|-------|-----|
| Can't connect to database | Check DATABASE_URL in .env |
| App won't start | `docker-compose logs app` |
| Out of memory | Add swap or reduce container limits |
| Can't access from browser | Check firewall: `sudo ufw allow 3000` |
| Slow performance | Check `docker stats` |
| IPFS not working | Restart: `docker-compose restart ipfs` |

---

## 📚 Full Documentation

- **Complete Setup Guide:** `PI5_CLOUD_SETUP_GUIDE.md`
- **Docker Guide:** `DOCKER_DEPLOYMENT.md`
- **Quick Start:** `DOCKER_QUICKSTART.md`

---

## 💡 Pro Tips

1. **Use Ethernet** - More stable than WiFi
2. **Keep Pi cool** - Use heatsink or case
3. **Monitor regularly** - Check logs weekly
4. **Backup often** - Run `./scripts/backup.sh` weekly
5. **Test before deploying** - Test locally first
6. **Keep updated** - Update Docker and OS monthly
7. **Document changes** - Keep notes of config changes

---

**Last Updated:** February 2026  
**Version:** 1.0
