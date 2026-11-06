# AWS EC2 par deploy karna

Yeh guide free AWS account par ek naya Ubuntu server banakar poora app chalane ke steps hai. Isme nginx frontend serve karega aur `/api` ko Node par bhejega, isliye dono ek hi address par rahenge.

```
Browser -> EC2 (nginx :80/:443) -> /            built React files
                                -> /api         Node + PM2 on 127.0.0.1:5000 -> MongoDB
```

Niche jahan `YOUR_IP` likha hai wahan apna Elastic IP lagana.

## Pehle yeh samajh lo: free kya hai

- July 2025 ke baad bane AWS accounts credit-based Free plan par hote hain. Usme purana "12 months 750 hours" wala rule nahi hai. Exact credit amount aur validity apne account ke **Billing > Free Tier / Credits** page par dekho.
- Instance wahi choose karo jis par console me **Free tier eligible** label ho. Naye accounts ke liye `t3.micro` eligible hai.
- Public IPv4 address par AWS ka charge lag sakta hai (lagbhag $0.005 per hour, yaani $3 to $4 mahina). Yeh credits se kat sakta hai, isliye billing page zaroor dekhte rehna.
- Stop kiya hua instance ka Elastic IP bhi charge hota hai. Agar kaam khatam ho jaye to instance terminate karo aur Elastic IP release karo.

**Sabse pehle budget alert lagao:** Billing > Budgets > Create budget > Zero spend budget, aur apna email daalo.

## Step 1. Instance banao

EC2 console kholo, upar right se region **Asia Pacific (Mumbai) ap-south-1** choose karo, phir **Launch instance**.

| Setting | Value |
| --- | --- |
| Name | `leave-tracker` |
| AMI | Ubuntu Server 24.04 LTS (64-bit x86) |
| Instance type | `t3.micro` (Free tier eligible label dekh lo) |
| Key pair | Create new, RSA, `.pem`, naam `leave-tracker-key` |
| Storage | 20 GiB gp3 |

**Network settings > Edit**, security group me sirf yeh rules:

| Type | Port | Source |
| --- | --- | --- |
| SSH | 22 | My IP |
| HTTP | 80 | Anywhere |
| HTTPS | 443 | Anywhere |

Port 5000 aur 27017 kabhi mat kholna. Node aur MongoDB sirf server ke andar rahenge.

`.pem` file download ho jayegi. Ise safe jagah rakho, dobara nahi milegi, aur Git me kabhi mat daalna.

## Step 2. Elastic IP lagao

Bina iske har restart par IP badal jayega.

EC2 > Elastic IPs > Allocate Elastic IP address > Allocate. Phir us IP par Actions > Associate > apna instance choose karo.

## Step 3. Server se connect karo

Windows PowerShell me, jis folder me `.pem` hai wahan:

```powershell
icacls leave-tracker-key.pem /inheritance:r
icacls leave-tracker-key.pem /grant:r "$($env:USERNAME):R"
ssh -i leave-tracker-key.pem ubuntu@YOUR_IP
```

Pehli baar `yes` likhna hoga. Ab aage ke saare commands server par chalenge.

## Step 4. Server tayyar karo

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx git ufw

# 1 GB RAM kam hai, isliye 2 GB swap banao. Frontend build ke liye zaroori hai.
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Node.js LTS
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

# Server firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

## Step 5. Database

**Recommended: MongoDB Atlas free cluster.** `t3.micro` ki 1 GB RAM me app aur MongoDB dono chalana tight rehta hai, aur Atlas backup ki tension bhi kam karta hai.

1. cloud.mongodb.com par free cluster banao, region Mumbai rakho.
2. Database Access me ek user banao aur strong password do.
3. Network Access me sirf apna `YOUR_IP/32` add karo. `0.0.0.0/0` mat lagana.
4. Connect > Drivers se connection string copy karo. Yahi `MONGO_URI` banega.

Agar server par hi MongoDB chalana ho to official docs ke steps follow karo: https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-ubuntu/ . Uske baad `MONGO_URI=mongodb://127.0.0.1:27017/` rahega aur authorization on karna hoga.

## Step 6. Code laao

```bash
sudo mkdir -p /var/www/leave-tracker/web
sudo chown -R ubuntu:ubuntu /var/www/leave-tracker
cd /var/www/leave-tracker
git clone https://github.com/Mohan-Kumar-Dalei/leave-tracker-backend.git api
git clone https://github.com/Mohan-Kumar-Dalei/leave-tracker-frontend.git frontend
```

Repo private ho to GitHub username ke saath password ki jagah Personal Access Token dena hoga.

## Step 7. Backend chalao

```bash
cd /var/www/leave-tracker/api
npm ci --omit=dev
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
nano .env
```

`.env` me yeh values rakho. Upar wala random output `JWT_ACCESS_SECRET` me jayega.

```ini
NODE_ENV=production
PORT=5000
MONGO_URI=apna-atlas-connection-string
MONGO_DB_NAME=leave_tracker
JWT_ACCESS_SECRET=upar-wala-random-output
CLIENT_ORIGINS=http://YOUR_IP
APP_URL=http://YOUR_IP
COOKIE_SECURE=false
TRUST_PROXY=1
SEED_ADMIN_NAME=HR Admin
SEED_ADMIN_EMAIL=apna-admin-email
SEED_ADMIN_PASSWORD=ek-strong-password
```

Pehla admin, leave types aur holidays banao, aur app start karo:

```bash
chmod 600 .env
npm run seed
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

`pm2 startup` ek `sudo env PATH=...` command print karega. Use copy karke chalao, taaki reboot par app apne aap start ho.

Seed ke baad `.env` se `SEED_ADMIN_PASSWORD` hata do. Phir check karo:

```bash
curl http://127.0.0.1:5000/api/health
```

`"database":"up"` aana chahiye.

## Step 8. Frontend build karo

```bash
cd /var/www/leave-tracker/frontend
npm ci
npm run build
cp -r dist/* /var/www/leave-tracker/web/
```

## Step 9. nginx lagao

```bash
sudo cp /var/www/leave-tracker/api/deploy/nginx.conf /etc/nginx/sites-available/leave-tracker
sudo sed -i 's/YOUR_DOMAIN_OR_IP/YOUR_IP/' /etc/nginx/sites-available/leave-tracker
sudo ln -sf /etc/nginx/sites-available/leave-tracker /etc/nginx/sites-enabled/leave-tracker
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Ab browser me `http://YOUR_IP` kholo. Login page aa jayega.

**Dhyan rakho:** abhi site plain HTTP par hai, yaani password network par encrypted nahi ja raha. Asli employees ko dene se pehle Step 11 zaroor karo.

## Step 10. Asli email chalu karo

Jab tak SMTP set nahi hai, mail server par `.mail-outbox/` folder me save hote hain, kisi ko jaate nahi.

Gmail ke liye:

1. Google account me 2-Step Verification on karo.
2. https://myaccount.google.com/apppasswords se App Password banao.
3. `.env` me add karo:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=apna-gmail
SMTP_PASS=16-akshar-ka-app-password
MAIL_FROM=Leave Tracker <apna-gmail>
```

```bash
pm2 restart leave-tracker-api --update-env
```

Gmail me rozana ki sending limit hoti hai. Team badi ho to AWS SES ya kisi mail service par jaana behtar hai.

## Step 11. HTTPS lagao (domain chahiye)

Domain ka DNS `A` record apne Elastic IP par point karo, phir:

```bash
sudo sed -i 's/server_name .*/server_name yourdomain.com;/' /etc/nginx/sites-available/leave-tracker
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

Phir `.env` update karo:

```ini
CLIENT_ORIGINS=https://yourdomain.com
APP_URL=https://yourdomain.com
COOKIE_SECURE=true
```

```bash
pm2 restart leave-tracker-api --update-env
```

## Naya code deploy karna

```bash
cd /var/www/leave-tracker/api
git pull && npm ci --omit=dev && pm2 restart leave-tracker-api

cd /var/www/leave-tracker/frontend
git pull && npm ci && npm run build && rm -rf /var/www/leave-tracker/web/* && cp -r dist/* /var/www/leave-tracker/web/
```

## Kuch galat ho to

| Problem | Kya dekhna hai |
| --- | --- |
| Site nahi khulti | Security group me port 80 open hai? `sudo systemctl status nginx` |
| 502 Bad Gateway | `pm2 status` aur `pm2 logs leave-tracker-api` |
| Login par `This origin is not allowed` | `.env` ka `CLIENT_ORIGINS` browser ke address se exact match hona chahiye, end me `/` nahi |
| Login hota hai par turant logout | HTTP par `COOKIE_SECURE=true` to nahi hai? |
| Database connect nahi | Atlas Network Access me Elastic IP hai? Password me special character URL encode kiya? |
| Build ke dauran process killed | Swap bana hai ya nahi: `free -h` |
| Dashboard live update nahi hota | nginx config me `/api/notifications/stream` block laga hai? |
| Mail nahi aa rahi | `pm2 logs` me `[mail]` lines dekho, App Password sahi hai? |

## Backup

Atlas free cluster me automatic backup ki suvidha limited hai, isliye hafte me ek baar export le lo:

```bash
mongodump --uri="APNA_MONGO_URI" --db=leave_tracker --out=backup-$(date +%F)
```

`mongodump` ke liye MongoDB Database Tools install karne honge.
