# Supabase + Raspberry Pi 5 Setup Guide

Complete guide to deploy Decentralized Discord on Raspberry Pi 5 using Supabase for cloud-hosted PostgreSQL database and file storage.

## Why Supabase?

- ✅ PostgreSQL database (reliable, powerful)
- ✅ 500MB free storage
- ✅ Real-time subscriptions (perfect for chat)
- ✅ Built-in file storage (backup for IPFS)
- ✅ REST API (if needed)
- ✅ Easy to scale later
- ✅ No credit card required for free tier

## Step 1: Create Supabase Account & Project

### 1.1 Sign Up

1. Go to [https://supabase.com](https://supabase.com)
2. Click "Start your project for free"
3. Sign up with email or GitHub
4. Verify your email

### 1.2 Create New Project

1. Click "New Project"
2. Enter project name: `decentralized-discord`
3. Create a strong database password (save this!)
4. Select region closest to you
5. Click "Create new project"

⏳ **Wait 2-3 minutes for project to initialize**

### 1.3 Get Connection String

1. Go to **Project Settings** (bottom left)
2. Click **Database** tab
3. Find **Connection String** section
4. Copy the **PostgreSQL** connection string (URI format)

It should look like:
```
postgresql://postgres:YOUR_PASSWORD@db.xyz.supabase.co:5432/postgres
```

**Save this somewhere safe!** You'll need it in the next steps.

---

## Step 2: Update Your Local Environment

### 2.1 Update .env File

Create or update `.env` file in project root:

```bash
# Database
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@db.xyz.supabase.co:5432/postgres"

# Matrix (keep existing)
VITE_MATRIX_HOMESERVER_URL="http://matrix:8008"

# IPFS (keep existing)
VITE_IPFS_GATEWAY="https://gateway.pinata.cloud/ipfs"
VITE_IPFS_API_URL="http://localhost:5001"

# Web3 (keep existing)
VITE_WALLET_CONNECT_PROJECT_ID="your-wallet-connect-id"

# Supabase (new)
VITE_SUPABASE_URL="https://xyz.supabase.co"
VITE_SUPABASE_ANON_KEY="your-anon-key"
```

### 2.2 Get Supabase API Keys

1. Go back to Supabase dashboard
2. Click **Settings** → **API**
3. Copy:
   - **Project URL** → `VITE_SUPABASE_URL`
   - **anon public** → `VITE_SUPABASE_ANON_KEY`

---

## Step 3: Update Database Schema for PostgreSQL

### 3.1 Check Current Schema

Your current schema uses MySQL syntax. Drizzle ORM will handle most conversions automatically, but let's verify:

```bash
# Check schema
cat drizzle/schema.ts
```

### 3.2 Push Schema to Supabase

```bash
# Generate migrations and push to Supabase
pnpm db:push

# You may see warnings about AUTO_INCREMENT
# Drizzle will convert to SERIAL automatically
```

If you get errors, they're likely about MySQL-specific features. Drizzle will handle conversion automatically.

### 3.3 Verify Tables in Supabase

1. Go to Supabase dashboard
2. Click **SQL Editor**
3. Run this query to verify tables:

```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public';
```

You should see all 9 tables:
- users
- servers
- channels
- messages
- file_shares
- soundboard_clips
- nft_subscriptions
- server_members
- user_profiles

---

## Step 4: Update docker-compose-cloud.yml for Supabase

### 4.1 Remove Local MySQL Service

Edit `docker-compose-cloud.yml` and remove the MySQL service since Supabase hosts it:

```yaml
# OLD (remove this section):
# services:
#   db:
#     image: mysql:8
#     environment:
#       MYSQL_ROOT_PASSWORD: root
#       MYSQL_DATABASE: discord
#     ports:
#       - "3306:3306"
#     volumes:
#       - db-data:/var/lib/mysql

# NEW - Keep only app service
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      DATABASE_URL: ${DATABASE_URL}
      VITE_MATRIX_HOMESERVER_URL: ${VITE_MATRIX_HOMESERVER_URL}
      VITE_IPFS_GATEWAY: ${VITE_IPFS_GATEWAY}
      VITE_IPFS_API_URL: ${VITE_IPFS_API_URL}
      VITE_WALLET_CONNECT_PROJECT_ID: ${VITE_WALLET_CONNECT_PROJECT_ID}
      VITE_SUPABASE_URL: ${VITE_SUPABASE_URL}
      VITE_SUPABASE_ANON_KEY: ${VITE_SUPABASE_ANON_KEY}
    depends_on:
      - matrix
      - ipfs
    networks:
      - discord-network

  matrix:
    image: matrixdotorg/synapse:latest
    # ... rest of matrix config

  ipfs:
    image: ipfs/go-ipfs:latest
    # ... rest of ipfs config

networks:
  discord-network:
    driver: bridge
```

### 4.2 Create docker-compose-supabase.yml

Create a new file optimized for Supabase:

```yaml
version: '3.8'

services:
  app:
    build: .
    container_name: discord-app
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      DATABASE_URL: ${DATABASE_URL}
      VITE_MATRIX_HOMESERVER_URL: ${VITE_MATRIX_HOMESERVER_URL}
      VITE_IPFS_GATEWAY: ${VITE_IPFS_GATEWAY}
      VITE_IPFS_API_URL: ${VITE_IPFS_API_URL}
      VITE_WALLET_CONNECT_PROJECT_ID: ${VITE_WALLET_CONNECT_PROJECT_ID}
      VITE_SUPABASE_URL: ${VITE_SUPABASE_URL}
      VITE_SUPABASE_ANON_KEY: ${VITE_SUPABASE_ANON_KEY}
    depends_on:
      - matrix
      - ipfs
    networks:
      - discord-network
    restart: unless-stopped

  matrix:
    image: matrixdotorg/synapse:latest
    container_name: discord-matrix
    ports:
      - "8008:8008"
      - "8448:8448"
    environment:
      SYNAPSE_SERVER_NAME: matrix.local
      SYNAPSE_REPORT_STATS: "no"
    volumes:
      - matrix-data:/data
    networks:
      - discord-network
    restart: unless-stopped

  ipfs:
    image: ipfs/go-ipfs:latest
    container_name: discord-ipfs
    ports:
      - "4001:4001"
      - "5001:5001"
      - "8080:8080"
    volumes:
      - ipfs-data:/data/ipfs
    networks:
      - discord-network
    restart: unless-stopped

volumes:
  matrix-data:
  ipfs-data:

networks:
  discord-network:
    driver: bridge
```

---

## Step 5: Deploy to Pi 5

### 5.1 Copy Files to Pi 5

On your local machine:

```bash
# Copy project to Pi 5
scp -r decentralized-discord/ pi@your-pi-ip:/home/pi/

# SSH into Pi
ssh pi@your-pi-ip
```

### 5.2 Install Docker on Pi 5

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add pi user to docker group
sudo usermod -aG docker pi

# Install Docker Compose
sudo apt install docker-compose -y

# Verify installation
docker --version
docker-compose --version
```

### 5.3 Create .env on Pi 5

```bash
# SSH into Pi
ssh pi@your-pi-ip

# Create .env file
cd ~/decentralized-discord
nano .env
```

Paste your environment variables:

```
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@db.xyz.supabase.co:5432/postgres"
VITE_MATRIX_HOMESERVER_URL="http://matrix:8008"
VITE_IPFS_GATEWAY="https://gateway.pinata.cloud/ipfs"
VITE_IPFS_API_URL="http://localhost:5001"
VITE_WALLET_CONNECT_PROJECT_ID="your-id"
VITE_SUPABASE_URL="https://xyz.supabase.co"
VITE_SUPABASE_ANON_KEY="your-anon-key"
```

Save: `Ctrl+X`, then `Y`, then `Enter`

### 5.4 Build and Run

```bash
# Build Docker image (takes ~10-15 minutes on Pi 5)
docker-compose -f docker-compose-supabase.yml build

# Start services
docker-compose -f docker-compose-supabase.yml up -d

# Check logs
docker-compose -f docker-compose-supabase.yml logs -f app
```

### 5.5 Verify It's Running

```bash
# Check running containers
docker ps

# Test database connection
docker-compose -f docker-compose-supabase.yml exec app pnpm db:push

# Check app is responding
curl http://localhost:3000
```

---

## Step 6: Set Up Cloudflare Tunnel (Optional but Recommended)

### 6.1 Install Cloudflare Tunnel

```bash
# SSH into Pi
ssh pi@your-pi-ip

# Download cloudflared
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64

# Make executable
chmod +x cloudflared-linux-arm64

# Move to PATH
sudo mv cloudflared-linux-arm64 /usr/local/bin/cloudflared

# Verify
cloudflared --version
```

### 6.2 Create Tunnel

```bash
# Authenticate with Cloudflare
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create decentralized-discord

# Get tunnel ID
cloudflared tunnel list
```

### 6.3 Configure Tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: decentralized-discord
credentials-file: /home/pi/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: discord.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

### 6.4 Run Tunnel

```bash
# Start tunnel
cloudflared tunnel run decentralized-discord

# Or run as service
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

---

## Step 7: Backup & Monitoring

### 7.1 Enable Supabase Backups

1. Go to Supabase dashboard
2. **Settings** → **Backups**
3. Enable automatic backups (free tier has daily backups)

### 7.2 Monitor Database Usage

```bash
# Check database size
SELECT pg_size_pretty(pg_database_size('postgres'));
```

Free tier: 500MB storage

### 7.3 Set Up Alerts

1. Supabase dashboard → **Settings** → **Billing**
2. Enable email alerts when approaching limits

---

## Troubleshooting

### Database Connection Error

**Error:** `ECONNREFUSED` or `connection timeout`

**Solution:**
```bash
# Verify connection string
echo $DATABASE_URL

# Check if Supabase project is active
# Go to Supabase dashboard and verify project status

# Restart app
docker-compose -f docker-compose-supabase.yml restart app
```

### Schema Migration Error

**Error:** `relation "users" does not exist`

**Solution:**
```bash
# Re-run migrations
docker-compose -f docker-compose-supabase.yml exec app pnpm db:push

# Check Supabase SQL Editor for tables
# Go to Supabase → SQL Editor → Run query to list tables
```

### Out of Storage

**Error:** `disk quota exceeded`

**Solution:**
- Free tier: 500MB limit
- Delete old messages or files
- Or upgrade to paid plan ($25/month for 8GB)

### Slow Queries

**Solution:**
- Free tier uses shared compute
- Upgrade to paid for better performance
- Or optimize queries

---

## Cost Breakdown

| Item | Cost | Notes |
|------|------|-------|
| Pi 5 | $60 (one-time) | Hardware |
| microSD | $10-15 (one-time) | Storage |
| Supabase | Free | 500MB database, 2GB file storage |
| Cloudflare Tunnel | Free | Or $5/month for custom domains |
| Domain | $10/year | Optional |
| **Total** | **~$80-90 initial + $10/year** | Very affordable! |

---

## Next Steps

1. ✅ Create Supabase account
2. ✅ Get connection string
3. ✅ Update .env file
4. ✅ Push schema to Supabase
5. ✅ Deploy to Pi 5
6. ✅ Set up Cloudflare Tunnel
7. ✅ Test the app

Once running, you can:
- Implement real-time Matrix messaging
- Add voice/video calling
- Set up NFT Nitro subscriptions
- Deploy to production

---

## Useful Commands

```bash
# View logs
docker-compose -f docker-compose-supabase.yml logs -f app

# Stop services
docker-compose -f docker-compose-supabase.yml down

# Restart app
docker-compose -f docker-compose-supabase.yml restart app

# Check database
docker-compose -f docker-compose-supabase.yml exec app psql $DATABASE_URL -c "SELECT * FROM users;"

# Backup database (from Pi 5)
pg_dump $DATABASE_URL > backup.sql

# Restore database
psql $DATABASE_URL < backup.sql
```

---

## Support

- **Supabase Docs:** https://supabase.com/docs
- **Docker Docs:** https://docs.docker.com
- **Cloudflare Tunnel:** https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/

Good luck! 🚀
