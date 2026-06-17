# ShopERP Pro — Deployment Guide

---

## ⭐ Option A — Local WiFi Server (FREE, recommended for single shop)

Run the server on your main billing PC. Every phone, tablet, or other PC
on the **same WiFi** can then open the live app and see real-time data.

**Requirements:** Node.js installed on the main PC  
**Cost:** ₹0

### One-time setup

```bash
# From the project root folder:
cd server
npm install
```

### Start the server (do this every time you open the shop)

**Mac — double-click:** `START_LOCAL_SERVER.command`  
**Windows — double-click:** `START_LOCAL_SERVER.bat`

Or from terminal:
```bash
cd server
node local.js
```

### What you'll see when it starts

```
╔════════════════════════════════════════════════════╗
║   ShopERP Pro — Local Server  ✅ Running           ║
╠════════════════════════════════════════════════════╣
║  This PC  →  http://localhost:3000               ║
║  Phone / Tablet / Other PC on WiFi →               ║
║             http://192.168.1.5:3000               ║
╚════════════════════════════════════════════════════╝
```

### On other devices (phone / tablet / second PC)

1. Connect to the **same WiFi** as the main PC
2. Open browser → go to the URL shown (`http://192.168.x.x:3000`)
3. First time: click **Register** → enter Shop Name + Username + Password
4. Every device that logs in sees the **same live inventory, sales, repairs**

### How data is stored

- Single file: `server/shoperpro.db` (SQLite)
- Backup by copying this one file
- All your sales, inventory, repairs, customers — everything in one file

---

## Option B — Cloud Server (access from anywhere, small cost)

## Architecture
```
Browser → Nginx (port 443) → Node.js server (port 3000) → PostgreSQL
```

---

## Step 1 — SSH into your IntraServer VPS

```bash
ssh root@YOUR_SERVER_IP
# or via DirectAdmin SSH key
```

---

## Step 2 — Install Node.js (if not already installed)

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs
node -v   # should print v20.x.x
```

---

## Step 3 — Install PostgreSQL

```bash
yum install -y postgresql-server postgresql-contrib
postgresql-setup initdb
systemctl enable postgresql && systemctl start postgresql

# Create DB and user
sudo -u postgres psql <<'SQL'
CREATE DATABASE shoperpro;
CREATE USER shoperpro_user WITH ENCRYPTED PASSWORD 'STRONG_PASSWORD_HERE';
GRANT ALL PRIVILEGES ON DATABASE shoperpro TO shoperpro_user;
\q
SQL
```

---

## Step 4 — Upload project files

```bash
# On your Mac — upload via SCP:
scp -r /Volumes/Ravi_Backup/Ravi-M2-Backup/Deepak/ShopPro/M/2/ShopERP_Pro_Electron/server \
       root@YOUR_SERVER_IP:/home/YOUR_CPANEL_USER/shoperpro/

scp /Volumes/Ravi_Backup/Ravi-M2-Backup/Deepak/ShopPro/M/2/ShopERP_Pro_Electron/app/ShopERP_Pro_v8.html \
    root@YOUR_SERVER_IP:/home/YOUR_CPANEL_USER/shoperpro/server/public/index.html
```

---

## Step 5 — Run database schema

```bash
cd /home/YOUR_CPANEL_USER/shoperpro/server
sudo -u postgres psql -d shoperpro -f schema.sql
```

---

## Step 6 — Configure environment

```bash
cp .env.example .env
nano .env
# Fill in: DB_HOST, DB_NAME, DB_USER, DB_PASSWORD, JWT_SECRET, ALLOWED_ORIGIN

# Generate JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## Step 7 — Install dependencies and start with PM2

```bash
cd /home/YOUR_CPANEL_USER/shoperpro/server
npm install --production

# Install PM2 globally
npm install -g pm2

# Edit ecosystem.config.js — replace YOUR_CPANEL_USER with your actual username
nano ecosystem.config.js

# Start app
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot
```

---

## Step 8 — Configure Nginx in DirectAdmin

In DirectAdmin panel:
1. Go to **Advanced Features → Custom Nginx Configuration**
2. Copy the contents of `nginx.conf`
3. Replace `yourdomain.com` with your actual domain
4. Save → Test → Reload Nginx

OR if you have VPS root access:
```bash
cp nginx.conf /etc/nginx/conf.d/shoperpro.conf
# Edit the domain name inside
nginx -t && systemctl reload nginx
```

---

## Step 9 — Enable HTTPS (Let's Encrypt via DirectAdmin)

In DirectAdmin:
1. **SSL Certificates → Let's Encrypt**
2. Select your domain → Issue Certificate
3. Nginx auto-picks up the certs

---

## Step 10 — Update the frontend API URL

In `app/ShopERP_Pro_v8.html`, find this line (~line 2165):

```javascript
const SHOPERPRO_API_URL = '';
```

Change it to:

```javascript
const SHOPERPRO_API_URL = 'https://yourdomain.com';
```

Then re-upload: `public/index.html`

---

## Daily Commands

```bash
pm2 status            # check if server is running
pm2 logs shoperpro    # view live logs
pm2 restart shoperpro # restart after changes
pm2 stop shoperpro    # stop server
```

---

## Multi-tenant flow

1. Each shop owner visits `https://yourdomain.com`
2. Clicks "Register here" → enters Shop Name + Username + Password
3. Gets their own isolated data in PostgreSQL
4. Staff members: owner goes to Settings → Add Staff → gives them login

---

## Security checklist before going live

- [ ] Change `DB_PASSWORD` to a strong random password
- [ ] Generate a 64-char `JWT_SECRET`
- [ ] Set `ALLOWED_ORIGIN` to your exact domain (not `*`)
- [ ] Enable firewall: only ports 22, 80, 443 open
- [ ] Set up daily PostgreSQL backups
- [ ] Enable fail2ban for SSH brute-force protection
