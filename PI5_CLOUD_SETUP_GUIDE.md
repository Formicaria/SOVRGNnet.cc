# Decentralized Discord on Raspberry Pi 5 with Cloud Storage
## Complete All-in-One Setup Guide

This guide walks you through deploying Decentralized Discord on a Raspberry Pi 5 using cloud-based storage (PlanetScale for database, NFT.storage for IPFS files). No local SSD/HDD required.

**Total Setup Time:** 30-45 minutes  
**Total Cost:** $0/month (free tier) or $20-30/month (paid tiers)  
**Hardware Required:** Raspberry Pi 5 (8GB RAM recommended), microSD card (64GB+), power supply

---

## Table of Contents

1. [Prerequisites & Hardware Setup](#prerequisites--hardware-setup)
2. [Step 1: Install Ubuntu Server on Pi 5](#step-1-install-ubuntu-server-on-pi-5)
3. [Step 2: Set Up Cloud Services](#step-2-set-up-cloud-services)
4. [Step 3: Configure Environment Variables](#step-3-configure-environment-variables)
5. [Step 4: Install Docker & Deploy](#step-4-install-docker--deploy)
6. [Step 5: Access Your Application](#step-5-access-your-application)
7. [Step 6: Configure Network Access](#step-6-configure-network-access)
8. [Maintenance & Monitoring](#maintenance--monitoring)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites & Hardware Setup

### What You Need

- **Raspberry Pi 5** (8GB RAM model recommended)
- **microSD Card** (64GB or larger)
- **Power Supply** (27W USB-C recommended)
- **Ethernet Cable** (WiFi works but Ethernet is more reliable)
- **Computer with SD card reader** (for initial setup)
- **Internet Connection** (for cloud services and Docker)

### Optional but Recommended

- Cooling case or heatsink for Pi 5
- External USB 3.0 hub (for future expansion)
- UPS or battery backup (for 24/7 reliability)

### Cloud Service Accounts (Free)

- **PlanetScale** account (planetscale.com) - for MySQL database
- **NFT.storage** account (nft.storage) - for IPFS file storage
- **Cloudflare** account (cloudflare.com) - for DNS and tunneling

---

## Step 1: Install Ubuntu Server on Pi 5

### 1.1 Download Ubuntu Server

1. Visit [ubuntu.com/download/raspberry-pi](https://ubuntu.com/download/raspberry-pi)
2. Download **Ubuntu Server 24.04 LTS ARM64** (not the desktop version)
3. Save the `.img.xz` file to your computer

### 1.2 Flash to microSD Card

**Using Balena Etcher (Recommended):**

1. Download Balena Etcher from [balena.io/etcher](https://www.balena.io/etcher/)
2. Open Balena Etcher
3. Click "Flash from file" and select the Ubuntu `.img.xz` file
4. Click "Select target" and choose your microSD card
5. Click "Flash" and wait 5-10 minutes

**Alternative: Using dd command (Linux/Mac):**

```bash
# Find your microSD card
diskutil list

# Unmount the card (replace diskX with your disk)
diskutil unmountDisk /dev/diskX

# Flash the image
xzcat ubuntu-24.04-preinstalled-server-arm64+raspi.img.xz | sudo dd of=/dev/diskX bs=4m
```

### 1.3 Boot Raspberry Pi 5

1. Insert the flashed microSD card into Pi 5
2. Connect Ethernet cable
3. Connect power supply
4. Wait 2-3 minutes for first boot
5. The Pi will expand the filesystem automatically

### 1.4 SSH into Pi 5

Find your Pi's IP address from your router, then:

```bash
ssh ubuntu@<pi-ip-address>
```

**Default credentials:**
- Username: `ubuntu`
- Password: `ubuntu`

Change the password on first login:

```bash
passwd
```

---

## Step 2: Set Up Cloud Services

### 2.1 Set Up PlanetScale (MySQL Database)

**PlanetScale** provides a free MySQL-compatible database perfect for your needs.

**Steps:**

1. Go to [planetscale.com](https://www.planetscale.com) and create a free account
2. Click "Create a database"
3. Name it: `decentralized-discord`
4. Choose region closest to you
5. Click "Create database"
6. Wait for database to initialize (2-3 minutes)
7. Click "Connect" button
8. Select "Node.js" from the dropdown
9. Copy the connection string - it looks like:
   ```
   mysql://user:password@aws.connect.psdb.cloud:3306/decentralized-discord?sslaccept=strict
   ```
10. Save this connection string - you'll need it later

**Important:** Keep this connection string secret! It contains your database password.

### 2.2 Set Up NFT.storage (IPFS File Storage)

**NFT.storage** provides free IPFS storage perfect for file sharing and soundboard clips.

**Steps:**

1. Go to [nft.storage](https://nft.storage) and sign up
2. Click "API Keys" in the left menu
3. Click "New Key"
4. Name it: `decentralized-discord`
5. Click "Create"
6. Copy the API key (long string starting with `ey...`)
7. Save this API key - you'll need it later

**Free tier includes:** 1TB storage, perfect for testing and small deployments

### 2.3 Set Up Cloudflare (Optional but Recommended)

**Cloudflare** provides free DNS, DDoS protection, and tunneling.

**Steps:**

1. Go to [cloudflare.com](https://www.cloudflare.com) and create a free account
2. Click "Add a site"
3. Enter your domain name (or get a free domain from [freenom.com](https://www.freenom.com))
4. Choose the free plan
5. Follow Cloudflare's instructions to update your domain's nameservers
6. Once verified, you can use Cloudflare Tunnel for easy access

**Note:** You can skip this for now and access your app locally. Set it up later for public access.

---

## Step 3: Configure Environment Variables

### 3.1 SSH into Pi 5

```bash
ssh ubuntu@<pi-ip-address>
```

### 3.2 Download the Project

```bash
# Clone the repository
git clone https://github.com/your-username/decentralized-discord.git
cd decentralized-discord

# Or if you downloaded as ZIP
unzip decentralized-discord.zip
cd decentralized-discord
```

### 3.3 Create Environment Configuration

Create a `.env` file with your cloud service credentials:

```bash
# Copy the template
cp docker.env.template .env

# Edit the file
nano .env
```

**Paste and edit these values:**

```bash
# ===== DATABASE CONFIGURATION =====
# From PlanetScale connection string
# Extract: mysql://USER:PASSWORD@HOST:3306/DATABASE?sslaccept=strict
DATABASE_URL=mysql://USER:PASSWORD@aws.connect.psdb.cloud:3306/decentralized-discord?sslaccept=strict

# Generate with: openssl rand -base64 32
JWT_SECRET=your-generated-secret-here

# ===== MANUS OAUTH (if using Manus auth) =====
VITE_APP_ID=your-manus-app-id
OAUTH_SERVER_URL=https://api.manus.im
VITE_OAUTH_PORTAL_URL=https://auth.manus.im
OWNER_OPEN_ID=your-manus-user-id
OWNER_NAME=Your Name
BUILT_IN_FORGE_API_URL=https://api.manus.im
BUILT_IN_FORGE_API_KEY=your-forge-api-key
VITE_FRONTEND_FORGE_API_KEY=your-frontend-forge-api-key
VITE_FRONTEND_FORGE_API_URL=https://api.manus.im

# ===== APP CONFIGURATION =====
VITE_APP_TITLE=Decentralized Discord
VITE_APP_LOGO=https://your-domain.com/logo.png
VITE_ANALYTICS_ENDPOINT=https://analytics.your-domain.com
VITE_ANALYTICS_WEBSITE_ID=your-analytics-id

# ===== MATRIX CONFIGURATION =====
MATRIX_HOMESERVER_URL=http://matrix:8008
MATRIX_SERVER_NAME=matrix.your-domain.com

# ===== IPFS CONFIGURATION =====
# From NFT.storage API key
IPFS_API_URL=http://ipfs:5001
NFT_STORAGE_API_KEY=your-nft-storage-api-key

# ===== WEB3 CONFIGURATION =====
REACT_APP_WALLET_CONNECT_PROJECT_ID=your-wallet-connect-project-id

# ===== NODE ENVIRONMENT =====
NODE_ENV=production
```

**To save and exit nano:** Press `Ctrl+X`, then `Y`, then `Enter`

### 3.4 Generate JWT Secret

If you haven't generated a JWT secret yet:

```bash
openssl rand -base64 32
```

Copy the output and paste it as your `JWT_SECRET` in the `.env` file.

---

## Step 4: Install Docker & Deploy

### 4.1 Update System

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y git curl wget
```

### 4.2 Install Docker

```bash
# Download Docker installation script
curl -fsSL https://get.docker.com -o get-docker.sh

# Run the script
sudo sh get-docker.sh

# Add your user to docker group
sudo usermod -aG docker $USER

# Apply group changes
newgrp docker
```

### 4.3 Install Docker Compose

```bash
# Download Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose

# Make it executable
sudo chmod +x /usr/local/bin/docker-compose

# Verify installation
docker-compose --version
```

### 4.4 Make Scripts Executable

```bash
chmod +x scripts/setup-docker.sh
chmod +x scripts/backup.sh
chmod +x scripts/restore.sh
```

### 4.5 Update docker-compose.yml for Cloud Storage

Edit the `docker-compose.yml` to remove the local MySQL service and use PlanetScale instead:

```bash
nano docker-compose.yml
```

**Find the `db:` service section and replace it with:**

```yaml
  # Using PlanetScale cloud database instead of local MySQL
  # No local database service needed
```

**Or keep the local services but they won't store data persistently. For production, use cloud services.**

### 4.6 Build and Start Services

```bash
# Build the application image (takes 10-15 minutes on Pi 5)
docker-compose build app

# Start all services
docker-compose up -d

# Check status
docker-compose ps
```

**Expected output:**

```
NAME                                   STATUS
decentralized-discord-app              Up (healthy)
decentralized-discord-matrix           Up
decentralized-discord-ipfs             Up
decentralized-discord-nginx            Up
```

### 4.7 Verify Services are Running

```bash
# Check application logs
docker-compose logs -f app

# Test Matrix homeserver
curl http://localhost:8008/_matrix/client/versions

# Test IPFS
curl http://localhost:5001/api/v0/version
```

---

## Step 5: Access Your Application

### 5.1 Local Access

From your computer on the same network:

```
http://<pi-ip-address>:3000
```

**Find your Pi's IP:**

```bash
# On Pi
hostname -I

# Or from your computer
ping raspberrypi.local
```

### 5.2 Test the Application

1. Open browser to `http://<pi-ip-address>:3000`
2. You should see the Decentralized Discord home page
3. Click "Connect Wallet" to test Web3 integration
4. Try creating a server and channel
5. Send a test message

### 5.3 View Application Logs

```bash
# Real-time logs
docker-compose logs -f app

# Last 50 lines
docker-compose logs --tail=50 app

# Specific service
docker-compose logs -f matrix
docker-compose logs -f ipfs
```

---

## Step 6: Configure Network Access

### Option A: Local Network Only (Easiest for Testing)

Your app is already accessible from any computer on your home network at:

```
http://<pi-ip-address>:3000
```

### Option B: Cloudflare Tunnel (Recommended for Public Access)

**Cloudflare Tunnel** lets you access your app from anywhere without port forwarding.

**Steps:**

1. Install Cloudflare CLI on Pi:
   ```bash
   wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
   chmod +x cloudflared-linux-arm64
   sudo mv cloudflared-linux-arm64 /usr/local/bin/cloudflared
   ```

2. Authenticate:
   ```bash
   cloudflared tunnel login
   ```
   This opens a browser to authenticate with Cloudflare.

3. Create tunnel:
   ```bash
   cloudflared tunnel create discord
   ```

4. Configure tunnel (edit `~/.cloudflared/config.yml`):
   ```yaml
   tunnel: discord
   credentials-file: /home/ubuntu/.cloudflared/<tunnel-id>.json
   
   ingress:
     - hostname: discord.your-domain.com
       service: http://localhost:3000
     - service: http_status:404
   ```

5. Route domain to tunnel:
   ```bash
   cloudflared tunnel route dns discord discord.your-domain.com
   ```

6. Start tunnel:
   ```bash
   cloudflared tunnel run discord
   ```

7. Keep it running (use systemd for permanent):
   ```bash
   sudo cloudflared service install
   sudo systemctl start cloudflared
   sudo systemctl enable cloudflared
   ```

Now access at: `https://discord.your-domain.com`

### Option C: Port Forwarding (Advanced)

1. Log into your router settings
2. Find "Port Forwarding" section
3. Forward port 80/443 to Pi's local IP on port 3000
4. Point your domain to your public IP
5. Access at: `http://your-domain.com`

**Note:** This exposes your home IP and requires dynamic DNS if your IP changes.

---

## Maintenance & Monitoring

### Daily Checks

```bash
# Check if services are running
docker-compose ps

# Check resource usage
docker stats

# Check disk space
df -h
```

### Weekly Tasks

```bash
# View logs for errors
docker-compose logs --tail=100

# Check for updates
docker-compose pull

# Restart services
docker-compose restart
```

### Monthly Tasks

```bash
# Create backup
./scripts/backup.sh

# Clean up old Docker data
docker system prune -a

# Update Ubuntu packages
sudo apt update && sudo apt upgrade -y
```

### Monitor Resource Usage

```bash
# Real-time monitoring
docker stats

# Check memory
free -h

# Check disk
df -h

# Check CPU
top
```

**Pi 5 typical usage:**
- CPU: 10-30% under normal load
- Memory: 1-2GB of 8GB
- Disk: Depends on IPFS usage (limited by NFT.storage)

### Set Up Automatic Backups

```bash
# Edit crontab
crontab -e

# Add this line to run backup daily at 2 AM
0 2 * * * cd /home/ubuntu/decentralized-discord && ./scripts/backup.sh
```

---

## Troubleshooting

### Services Won't Start

**Problem:** `docker-compose up -d` fails or services show "Exit"

**Solution:**

```bash
# Check logs
docker-compose logs

# Restart Docker daemon
sudo systemctl restart docker

# Try again
docker-compose up -d
```

### Database Connection Error

**Problem:** "Cannot connect to database" error

**Solution:**

1. Verify PlanetScale connection string in `.env`
2. Check if PlanetScale service is online
3. Test connection:
   ```bash
   docker-compose exec app mysql -u user -p -h aws.connect.psdb.cloud -e "SHOW DATABASES;"
   ```

### Out of Memory

**Problem:** App crashes with "Out of memory" error

**Solution:**

```bash
# Check memory usage
free -h

# Reduce container limits in docker-compose.yml
# Or add swap space
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

### Can't Access from Browser

**Problem:** `http://<pi-ip>:3000` doesn't load

**Solution:**

```bash
# Check if app is running
docker-compose ps

# Check if port is listening
sudo netstat -tlnp | grep 3000

# Test locally on Pi
curl http://localhost:3000

# Check firewall
sudo ufw status
sudo ufw allow 3000/tcp
```

### Slow Performance

**Problem:** App is slow or unresponsive

**Solution:**

```bash
# Check resource usage
docker stats

# Check network
ping 8.8.8.8

# Check disk I/O
iostat -x 1

# Restart services
docker-compose restart
```

### IPFS Connection Issues

**Problem:** "Cannot connect to IPFS" error

**Solution:**

```bash
# Check IPFS status
docker-compose exec ipfs ipfs id

# Check IPFS peers
docker-compose exec ipfs ipfs swarm peers

# Restart IPFS
docker-compose restart ipfs
```

### Matrix Homeserver Issues

**Problem:** Matrix federation not working

**Solution:**

```bash
# Check Matrix status
curl http://localhost:8008/_matrix/client/versions

# Check Matrix logs
docker-compose logs matrix

# Restart Matrix
docker-compose restart matrix
```

---

## Useful Commands Reference

### Docker Commands

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose down

# Restart services
docker-compose restart

# View logs
docker-compose logs -f app

# Execute command in container
docker-compose exec app bash

# Check status
docker-compose ps

# View resource usage
docker stats
```

### System Commands

```bash
# Check Pi IP
hostname -I

# Check disk space
df -h

# Check memory
free -h

# Check temperature
vcgencmd measure_temp

# Check uptime
uptime

# Restart Pi
sudo reboot

# Shutdown Pi
sudo shutdown -h now
```

### Backup & Restore

```bash
# Create backup
./scripts/backup.sh

# List backups
ls -lh ./backups/

# Restore from backup
./scripts/restore.sh discord_backup_20260219_120000
```

---

## Next Steps

### 1. Customize Your Instance

- Update `VITE_APP_TITLE` and `VITE_APP_LOGO` in `.env`
- Configure Matrix server name
- Set up custom domain

### 2. Invite Users

- Share your domain/IP with friends
- They can create accounts and join servers
- Create channels and start chatting

### 3. Scale Up

- Monitor usage and performance
- Upgrade cloud services if needed
- Consider adding local storage later

### 4. Secure Your Instance

- Set up SSL/HTTPS with Cloudflare
- Enable firewall rules
- Regular backups
- Keep software updated

---

## Support & Resources

- **Documentation:** See README.md in project root
- **Docker Docs:** https://docs.docker.com
- **PlanetScale Docs:** https://planetscale.com/docs
- **NFT.storage Docs:** https://nft.storage/docs
- **Cloudflare Docs:** https://developers.cloudflare.com
- **Matrix Docs:** https://spec.matrix.org
- **IPFS Docs:** https://docs.ipfs.io

---

## FAQ

**Q: Do I need a domain name?**  
A: No, you can access locally at `http://<pi-ip>:3000`. A domain is only needed for public access.

**Q: How much does this cost?**  
A: Free tier is $0/month. Paid tiers start at $20-30/month for more storage/performance.

**Q: Can I use this for production?**  
A: Yes, but start with free tier to test. Upgrade to paid services for production workloads.

**Q: What if my internet goes down?**  
A: Your app stops working because it needs cloud services. Local-only mode coming soon.

**Q: Can I migrate to a different server later?**  
A: Yes! Use `./scripts/backup.sh` to backup everything, then `./scripts/restore.sh` on new server.

**Q: How many users can this handle?**  
A: Pi 5 can handle 50-100 concurrent users. Scale up with more powerful hardware.

---

**Last Updated:** February 2026  
**Version:** 1.0  
**Author:** Manus AI
