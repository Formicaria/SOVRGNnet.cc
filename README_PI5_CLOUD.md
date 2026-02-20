# Decentralized Discord - Raspberry Pi 5 with Cloud Storage

Welcome! This is the complete setup guide for running Decentralized Discord on a Raspberry Pi 5 using cloud-based storage services.

## 📖 Documentation Overview

This package includes multiple guides tailored for different needs:

| Document | Purpose | Read Time |
|----------|---------|-----------|
| **PI5_CLOUD_SETUP_GUIDE.md** | Complete step-by-step setup guide with all details | 20-30 min |
| **PI5_QUICK_REFERENCE.md** | Quick reference card with commands and tips | 5 min |
| **DOCKER_DEPLOYMENT.md** | Detailed Docker and networking information | 15-20 min |
| **DOCKER_QUICKSTART.md** | Fast setup for experienced users | 10 min |
| **README_PI5_CLOUD.md** | This file - overview and getting started | 5 min |

## 🚀 Quick Start (5 Minutes)

If you're experienced with Linux and Docker, here's the TL;DR:

```bash
# 1. Flash Ubuntu Server 24.04 LTS ARM64 to microSD
# 2. SSH into Pi
ssh ubuntu@<pi-ip>

# 3. Clone project
git clone https://github.com/your-username/decentralized-discord.git
cd decentralized-discord

# 4. Set up cloud services (get credentials from PlanetScale + NFT.storage)
cp docker.env.template .env
nano .env  # Add DATABASE_URL, NFT_STORAGE_API_KEY, JWT_SECRET

# 5. Run automated setup
chmod +x scripts/setup-pi5-cloud.sh
./scripts/setup-pi5-cloud.sh

# 6. Access at http://<pi-ip>:3000
```

## 📋 What You'll Need

### Hardware
- Raspberry Pi 5 (8GB RAM recommended)
- microSD card (64GB+)
- Power supply (27W USB-C)
- Ethernet cable (recommended)

### Cloud Services (All Free Tier)
- **PlanetScale** - MySQL database (5GB free)
- **NFT.storage** - IPFS file storage (1TB free)
- **Cloudflare** - DNS & tunneling (optional, free)

### Accounts
- GitHub (to clone the project)
- PlanetScale (planetscale.com)
- NFT.storage (nft.storage)

## 🎯 What This Setup Provides

### ✅ Included
- Full Decentralized Discord application
- Matrix protocol for federated messaging
- Web3 wallet integration (RainbowKit)
- IPFS file storage
- Docker containerization
- Nginx reverse proxy
- Automated backup/restore scripts

### ☁️ Cloud-Based (No Local Storage Needed)
- MySQL database on PlanetScale
- IPFS file pinning on NFT.storage
- No SSD/HDD required for Pi 5
- Automatic backups
- Scalable storage

### 🔐 Security Features
- End-to-end encryption support
- JWT-based sessions
- OAuth integration
- Wallet-based authentication

## 📊 Resource Usage

**Typical Pi 5 Usage:**
- CPU: 10-30% under normal load
- Memory: 1-2GB of 8GB
- Disk: ~5GB for local services
- Network: 1-10 Mbps (depends on users)

**Cloud Storage:**
- Database: 5GB free (PlanetScale)
- Files: 1TB free (NFT.storage)

## 🔧 Installation Methods

### Method 1: Automated Setup (Recommended)
```bash
./scripts/setup-pi5-cloud.sh
```
Handles everything automatically. Takes 30-45 minutes.

### Method 2: Manual Step-by-Step
Follow **PI5_CLOUD_SETUP_GUIDE.md** for detailed instructions.

### Method 3: Docker Compose Direct
```bash
docker-compose -f docker-compose-cloud.yml up -d
```
Requires manual environment setup.

## 🌐 Network Access

### Local Network (Default)
Access from any computer on your home network:
```
http://<pi-ip>:3000
```

### Public Access (Cloudflare Tunnel)
```bash
# Install and set up Cloudflare Tunnel
cloudflared tunnel create discord
cloudflared tunnel route dns discord your-domain.com
cloudflared tunnel run discord
```
Access at: `https://your-domain.com`

### Public Access (Port Forwarding)
Configure port forwarding on your router to expose port 3000.

## 📚 Next Steps

1. **Read the Setup Guide**
   - Start with **PI5_CLOUD_SETUP_GUIDE.md**
   - It has all the details you need

2. **Run the Setup Script**
   - Execute `./scripts/setup-pi5-cloud.sh`
   - Follow the prompts
   - Takes about 30-45 minutes

3. **Access Your App**
   - Open `http://<pi-ip>:3000`
   - Create a server
   - Invite friends

4. **Configure Public Access** (Optional)
   - Set up Cloudflare Tunnel for public access
   - Or use port forwarding
   - See **PI5_CLOUD_SETUP_GUIDE.md** for details

## 🆘 Troubleshooting

### Can't SSH into Pi
```bash
# Find Pi's IP from your router
# Or use: ping raspberrypi.local
ssh ubuntu@<pi-ip>
```

### Docker won't install
```bash
# Make sure you're on Ubuntu Server 24.04 LTS ARM64
uname -a  # Should show aarch64

# Try manual installation
sudo apt install docker.io docker-compose
```

### Can't access the app
```bash
# Check if services are running
docker-compose -f docker-compose-cloud.yml ps

# Check logs
docker-compose -f docker-compose-cloud.yml logs app

# Check firewall
sudo ufw status
sudo ufw allow 3000/tcp
```

### Database connection error
```bash
# Verify DATABASE_URL in .env is correct
# Test connection:
docker-compose -f docker-compose-cloud.yml exec app \
  mysql -u user -p -h host -e "SHOW DATABASES;"
```

See **PI5_CLOUD_SETUP_GUIDE.md** for more troubleshooting.

## 📖 Documentation Files

### Setup Guides
- **PI5_CLOUD_SETUP_GUIDE.md** - Complete step-by-step guide (RECOMMENDED)
- **PI5_QUICK_REFERENCE.md** - Quick reference card
- **DOCKER_QUICKSTART.md** - Quick start for experienced users

### Technical Documentation
- **DOCKER_DEPLOYMENT.md** - Docker and networking details
- **README.md** - General project documentation

### Configuration Files
- **docker-compose-cloud.yml** - Docker Compose for cloud setup
- **docker.env.template** - Environment variables template
- **nginx.conf** - Nginx reverse proxy configuration

### Scripts
- **scripts/setup-pi5-cloud.sh** - Automated setup script
- **scripts/backup.sh** - Backup data
- **scripts/restore.sh** - Restore from backup

## 💡 Pro Tips

1. **Use Ethernet** - More stable than WiFi for 24/7 operation
2. **Keep Pi Cool** - Use heatsink or cooling case
3. **Monitor Regularly** - Check logs weekly
4. **Backup Often** - Run `./scripts/backup.sh` weekly
5. **Keep Updated** - Update Docker and OS monthly
6. **Document Changes** - Keep notes of configuration changes
7. **Test Locally** - Test features before deploying

## 🔐 Security Best Practices

- [ ] Change default Ubuntu password
- [ ] Keep `.env` file secret (contains passwords)
- [ ] Use strong database passwords
- [ ] Enable firewall: `sudo ufw enable`
- [ ] Allow only needed ports
- [ ] Keep system updated
- [ ] Regular backups
- [ ] Monitor logs for errors
- [ ] Use HTTPS/SSL for public access
- [ ] Limit API access

## 📈 Scaling Up

When you outgrow the free tier:

1. **Upgrade PlanetScale** - More storage/performance
2. **Upgrade NFT.storage** - More file storage
3. **Add local storage** - SSD/HDD for IPFS
4. **Upgrade Pi** - Move to mini PC or server
5. **Add CDN** - Cloudflare for caching

## 🤝 Getting Help

- **Documentation** - Check the guides in this package
- **Logs** - `docker-compose logs app`
- **Community** - Join Matrix community
- **Issues** - Report on GitHub

## 📞 Support Resources

- **Docker Docs:** https://docs.docker.com
- **PlanetScale Docs:** https://planetscale.com/docs
- **NFT.storage Docs:** https://nft.storage/docs
- **Cloudflare Docs:** https://developers.cloudflare.com
- **Matrix Docs:** https://spec.matrix.org
- **IPFS Docs:** https://docs.ipfs.io
- **Raspberry Pi Docs:** https://www.raspberrypi.com/documentation

## 📝 License

This project is licensed under the MIT License. See LICENSE file for details.

## 🎉 Ready to Get Started?

1. **Read:** PI5_CLOUD_SETUP_GUIDE.md
2. **Run:** `./scripts/setup-pi5-cloud.sh`
3. **Access:** `http://<pi-ip>:3000`
4. **Enjoy:** Your decentralized Discord!

---

**Last Updated:** February 2026  
**Version:** 1.0  
**Author:** Manus AI

**Questions?** Check the documentation files or see the troubleshooting section above.
