# Free Cloud Database Alternatives for Pi 5 Setup

Since PlanetScale is no longer free, here are the best free alternatives for running Decentralized Discord on Raspberry Pi 5 with cloud-based storage:

## Best Free Options

### 1. **Neon (Recommended for PostgreSQL)**

**What it is:** Serverless PostgreSQL with free tier

**Free Tier:**
- ✅ 3 projects
- ✅ 10GB storage
- ✅ Shared compute
- ✅ Automatic backups
- ✅ Connection pooling

**Cost:** Free tier, $19+/month for paid

**Setup:**
```bash
# 1. Create account at https://neon.tech
# 2. Create new project
# 3. Get connection string

# 3. Update .env
DATABASE_URL="postgresql://user:password@ep-xyz.us-east-1.neon.tech/discord?sslmode=require"

# 4. Update docker-compose-cloud.yml to use PostgreSQL instead of MySQL
```

**Pros:**
- ✅ Generous free tier (10GB)
- ✅ Fast and reliable
- ✅ Great for small projects
- ✅ Automatic backups

**Cons:**
- ❌ Uses PostgreSQL (need to update schema from MySQL)
- ❌ Shared compute (slower than dedicated)

---

### 2. **Supabase (PostgreSQL + Extras)**

**What it is:** PostgreSQL with built-in auth, real-time, and storage

**Free Tier:**
- ✅ 500MB database storage
- ✅ 2GB file storage
- ✅ Real-time subscriptions
- ✅ Built-in authentication
- ✅ REST API

**Cost:** Free tier, $25+/month for paid

**Setup:**
```bash
# 1. Create account at https://supabase.com
# 2. Create new project
# 3. Get connection string from Project Settings

# 3. Update .env
DATABASE_URL="postgresql://postgres:password@db.xyz.supabase.co:5432/postgres"
```

**Pros:**
- ✅ PostgreSQL + extras (auth, real-time, storage)
- ✅ Great for full-stack apps
- ✅ Built-in file storage (good for IPFS backup)
- ✅ Real-time subscriptions (useful for chat)

**Cons:**
- ❌ Only 500MB free (small limit)
- ❌ Uses PostgreSQL (need schema update)

---

### 3. **Turso (SQLite in the Cloud)**

**What it is:** SQLite distributed globally with free tier

**Free Tier:**
- ✅ 3 databases
- ✅ 9GB total storage
- ✅ Unlimited bandwidth
- ✅ Global replication

**Cost:** Free tier, $29+/month for paid

**Setup:**
```bash
# 1. Install turso CLI
# 2. Create account at https://turso.tech
# 3. Create database

turso db create discord

# 4. Get connection string
turso db show discord

# 5. Update .env
DATABASE_URL="libsql://discord-xyz.turso.io?authToken=token"
```

**Pros:**
- ✅ SQLite (lightweight, perfect for Pi 5)
- ✅ 9GB free storage
- ✅ Global replication
- ✅ Low latency

**Cons:**
- ❌ SQLite (different from MySQL schema)
- ❌ Less mature than PostgreSQL

---

### 4. **Railway (Generous Free Tier)**

**What it is:** Full-stack hosting with free database tier

**Free Tier:**
- ✅ $5 free credit/month
- ✅ MySQL database included
- ✅ Runs on shared resources
- ✅ Good for testing

**Cost:** Free tier ($5/month credit), then pay-as-you-go

**Setup:**
```bash
# 1. Create account at https://railway.app
# 2. Create new project
# 3. Add MySQL plugin
# 4. Get connection string

# 5. Update .env
DATABASE_URL="mysql://user:password@containers-us-west-xyz.railway.app:6603/railway"
```

**Pros:**
- ✅ MySQL (matches your schema)
- ✅ $5/month free credit
- ✅ Easy setup
- ✅ Good for small projects

**Cons:**
- ❌ Limited free tier ($5/month)
- ❌ Not truly free (credit-based)

---

### 5. **Render (Free Tier with Limitations)**

**What it is:** Full-stack hosting with PostgreSQL

**Free Tier:**
- ✅ PostgreSQL database
- ✅ 90 days of data retention
- ✅ 256MB RAM
- ✅ Shared CPU

**Cost:** Free tier, $7+/month for paid

**Setup:**
```bash
# 1. Create account at https://render.com
# 2. Create PostgreSQL database
# 3. Get connection string

# 3. Update .env
DATABASE_URL="postgresql://user:password@dpg-xyz.render.com/discord"
```

**Pros:**
- ✅ Truly free (no credit card required for free tier)
- ✅ PostgreSQL
- ✅ Easy setup

**Cons:**
- ❌ Only 90 days data retention (spins down after 15 min inactivity)
- ❌ Uses PostgreSQL (need schema update)

---

## Comparison Table

| Service | Database | Free Storage | Cost | Best For |
|---------|----------|--------------|------|----------|
| **Neon** | PostgreSQL | 10GB | Free | Medium projects |
| **Supabase** | PostgreSQL | 500MB | Free | Full-stack with extras |
| **Turso** | SQLite | 9GB | Free | Lightweight, Pi 5 |
| **Railway** | MySQL | Included | $5/month credit | Testing |
| **Render** | PostgreSQL | Included | Free (limited) | Hobby projects |

---

## My Recommendation for Your Setup

### **Option 1: Neon (Best Overall)**
- 10GB free storage
- PostgreSQL (reliable)
- Good performance
- Easy to upgrade later

**Setup time:** 5 minutes

### **Option 2: Turso (Best for Pi 5)**
- SQLite (lightweight)
- 9GB free storage
- Perfect for Raspberry Pi
- Global replication

**Setup time:** 10 minutes (need to update schema)

### **Option 3: Railway (Easiest with MySQL)**
- Uses MySQL (matches your schema)
- $5/month free credit
- No schema changes needed
- Easy setup

**Setup time:** 5 minutes

---

## How to Switch from PlanetScale

### Step 1: Choose Your Database

Pick one from above (I recommend **Neon** or **Turso**)

### Step 2: Create Account & Database

Follow the service's setup guide to create a database

### Step 3: Get Connection String

Each service provides a `DATABASE_URL` or connection string

### Step 4: Update Environment Variables

```bash
# Update .env file
DATABASE_URL="your-new-connection-string"
```

### Step 5: Update docker-compose-cloud.yml (if needed)

If switching from MySQL to PostgreSQL/SQLite:

```yaml
# Remove MySQL service if using cloud database
# services:
#   db:  # <-- Remove this section
#     image: mysql:8
#     ...

# Update DATABASE_URL in app service
environment:
  DATABASE_URL: ${DATABASE_URL}
```

### Step 6: Run Migrations

```bash
# Push schema to new database
pnpm db:push
```

### Step 7: Test Connection

```bash
# Run on Pi 5
docker-compose -f docker-compose-cloud.yml up -d
```

---

## Schema Compatibility Notes

### MySQL to PostgreSQL

If switching from MySQL to PostgreSQL, most changes are automatic with Drizzle ORM, but note:

- `AUTO_INCREMENT` → `SERIAL` (automatic)
- `VARCHAR` → `VARCHAR` (same)
- `ENUM` → `ENUM` (same)
- `TIMESTAMP` → `TIMESTAMP` (same)

Drizzle handles most conversions automatically with `pnpm db:push`

### MySQL to SQLite

If switching to Turso (SQLite):

- Some advanced features may not work (e.g., some constraints)
- SQLite is simpler but less powerful
- Good for small projects like yours

---

## Cost Breakdown (Updated)

### Option 1: Neon + Pi 5 + Cloudflare

- Pi 5: $60 (one-time)
- microSD: $10-15 (one-time)
- Neon: Free (10GB)
- Cloudflare Tunnel: Free
- Domain: $10/year
- **Total: ~$80-90 initial, $10/year ongoing**

### Option 2: Turso + Pi 5 + Cloudflare

- Pi 5: $60 (one-time)
- microSD: $10-15 (one-time)
- Turso: Free (9GB)
- Cloudflare Tunnel: Free
- Domain: $10/year
- **Total: ~$80-90 initial, $10/year ongoing**

### Option 3: Railway + Pi 5

- Pi 5: $60 (one-time)
- microSD: $10-15 (one-time)
- Railway: $5/month credit (usually enough)
- Cloudflare Tunnel: Free
- Domain: $10/year
- **Total: ~$80-90 initial, $70/year ongoing**

---

## Next Steps

1. **Choose a database service** from the options above
2. **Create account and database**
3. **Get connection string**
4. **Update .env file**
5. **Run `pnpm db:push` to migrate schema**
6. **Test on Pi 5**

Need help setting up any of these? Let me know which one you choose!
