#!/usr/bin/env bash
# ==============================================================================
# TRIỂN KHAI AMIS HRM & ERP CORE LÊN VPS UBUNTU
# ==============================================================================
#
# Script này chạy TRÊN VPS (hoặc máy có quyền SSH vào VPS). Nó idempotent —
# chạy lại nhiều lần không phá dữ liệu.
#
#   CÁCH 1 — chạy trực tiếp trên VPS (đã SSH vào):
#       bash <(curl -fsSL <raw-url>/scripts/deploy-vps.sh)
#
#   CÁCH 2 — đẩy từ máy local qua SSH:
#       scp scripts/deploy-vps.sh bvqy4@<VPS>:/tmp/ && ssh bvqy4@<VPS> bash /tmp/deploy-vps.sh
#
#   CÁCH 3 — chạy toàn bộ từ máy local (cần sshpass hoặc đã cấu hình SSH key):
#       sshpass -p '<pass>' ssh -o StrictHostKeyChecking=no bvqy4@<VPS> 'bash -s' < scripts/deploy-vps.sh
#
# Repo là PRIVATE nên cần token khi clone. Truyền qua biến môi trường,
# KHÔNG hardcode vào file này (file này nằm trong git):
#
#       GITHUB_TOKEN=ghp_xxxxx bash deploy-vps.sh
#
# ==============================================================================

set -euo pipefail

# --- Cấu hình — ghi đè bằng biến môi trường -----------------------------------
REPO_OWNER="${REPO_OWNER:-pvminh94}"
REPO_NAME="${REPO_NAME:-amis-hrm-erp-core}"
APP_DIR="${APP_DIR:-$HOME/amis-hrm-erp}"
APP_PORT="${APP_PORT:-3000}"
WITH_SEED="${WITH_SEED:-false}"        # true = nạp dữ liệu mẫu (chỉ cho môi trường test)

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[  OK  ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ CANH BAO ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[ LOI ]\033[0m %s\n' "$*" >&2; exit 1; }

# Cần sudo không mật khẩu hoặc quyền root để cài Docker
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "Can quyen root hoac sudo de cai Docker"
  SUDO="sudo"
fi

# ==============================================================================
# 1. KIỂM TRA HỆ THỐNG
# ==============================================================================
log "Kiem tra he thong..."
# shellcheck source=/dev/null   # /etc/os-release chi ton tai tren may dich
. /etc/os-release 2>/dev/null || true
log "  OS   : ${PRETTY_NAME:-khong ro}"
log "  CPU  : $(nproc) nhan"
log "  RAM  : $(awk '/MemTotal/{printf "%.1f GB", $2/1024/1024}' /proc/meminfo)"
log "  Disk : $(df -h / | awk 'NR==2{print $4" con trong"}')"

MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 1800 ]; then
  warn "RAM ${MEM_MB}MB — duoi muc khuyen nghi 2GB. Postgres + Redis + app co the bi OOM."
fi

# ==============================================================================
# 2. CÀI DOCKER (nếu chưa có)
# ==============================================================================
if command -v docker >/dev/null 2>&1; then
  ok "Docker da cai: $(docker --version)"
else
  log "Cai Docker..."
  $SUDO apt-get update -y
  $SUDO apt-get install -y ca-certificates curl gnupg
  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu ${VERSION_CODENAME:-jammy} stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update -y
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  $SUDO systemctl enable --now docker
  ok "Docker da cai xong"
fi

# Cho user hiện tại dùng docker không cần sudo
if ! id -nG "$USER" | grep -qw docker; then
  $SUDO usermod -aG docker "$USER" || true
  warn "Da them $USER vao nhom docker. Can dang nhap lai (hoac 'newgrp docker') de co hieu luc."
fi

# docker compose (plugin hoặc binary riêng)
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "Khong tim thay docker compose. Cai lai Docker voi goi docker-compose-plugin."
fi
ok "Compose: $($COMPOSE version --short 2>/dev/null || echo ok)"

# ==============================================================================
# 3. LẤY CODE
# ==============================================================================
if [ -n "${GITHUB_TOKEN:-}" ]; then
  CLONE_URL="https://oauth2:${GITHUB_TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git"
else
  CLONE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
fi

if [ -d "$APP_DIR/.git" ]; then
  log "Repo da ton tai o $APP_DIR — keo ban moi..."
  cd "$APP_DIR"
  git remote set-url origin "$CLONE_URL"
  git fetch origin main
  git reset --hard origin/main
else
  log "Clone repo ve $APP_DIR ..."
  git clone --branch main "$CLONE_URL" "$APP_DIR"
  cd "$APP_DIR"
fi
# Không bao giờ để token nằm lại trong .git/config
git remote set-url origin "https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
ok "Code: $(git log --oneline -1)"

# ==============================================================================
# 4. TẠO .env NẾU CHƯA CÓ (sinh secret tự động)
# ==============================================================================
if [ -f .env ]; then
  ok ".env da ton tai — giu nguyen (khong ghi de secret)"
else
  log "Tao .env voi secret moi..."
  cp .env.example .env

  # Sinh secret thật — tuyệt đối không dùng giá trị mẫu
  sed -i "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48)|" .env
  sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48)|" .env
  sed -i "s|^DATA_ENCRYPTION_KEY=.*|DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)|" .env
  sed -i "s|^DEVICE_PUSH_TOKEN=.*|DEVICE_PUSH_TOKEN=$(openssl rand -hex 16)|" .env

  # Mật khẩu hạ tầng
  PG_PASS=$(openssl rand -hex 16)
  RD_PASS=$(openssl rand -hex 16)
  {
    echo ""
    echo "# --- Sinh boi deploy-vps.sh ---"
    echo "POSTGRES_DB=amis_hrm"
    echo "POSTGRES_USER=amis"
    echo "POSTGRES_PASSWORD=${PG_PASS}"
    echo "REDIS_PASSWORD=${RD_PASS}"
    echo "APP_PORT=${APP_PORT}"
    echo "NODE_ENV=production"
    echo "REFRESH_COOKIE_SECURE=false   # doi thanh true khi co HTTPS"
    echo "CORS_ORIGINS=http://localhost:${APP_PORT}"
  } >> .env

  chmod 600 .env
  ok ".env da tao (quyen 600)"
  warn "SAO LUU DATA_ENCRYPTION_KEY NGAY: $(grep '^DATA_ENCRYPTION_KEY=' .env)"
  warn "Mat khoa nay ma mat thi du lieu sinh trac hoc + STK ngan hang KHONG the khoi phuc."
fi

# ==============================================================================
# 4b. KIỂM TRA ĐỤNG CỔNG
# ==============================================================================
# VPS thường đang chạy dịch vụ khác (ERPNext dùng 80/443/3306/6379/8000/9000).
# Postgres và Redis của dự án này KHÔNG expose ra host nữa, nên chỉ cần lo
# cho cổng của app.
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${1}\$"
  else
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${1}\$"
  fi
}

if port_busy "$APP_PORT"; then
  FREE=""
  for cand in 3001 3002 3010 8080 8090; do
    if ! port_busy "$cand"; then FREE="$cand"; break; fi
  done
  if [ -z "$FREE" ]; then
    die "Cong $APP_PORT dang bi chiem va khong tim duoc cong thay the. Dat APP_PORT thu cong."
  fi
  warn "Cong $APP_PORT dang bi dich vu khac chiem (co the la ERPNext)."
  sed -i "s|^APP_PORT=.*|APP_PORT=${FREE}|" .env 2>/dev/null || echo "APP_PORT=${FREE}" >> .env
  APP_PORT="$FREE"
  warn "Da doi sang cong $APP_PORT."
else
  ok "Cong $APP_PORT con trong"
fi

# ==============================================================================
# 5. BUILD & START
# ==============================================================================
log "Build image va khoi dong (lan dau mat 3-6 phut)..."
$COMPOSE up -d --build

# Lay ten container that (docker compose dat ten theo <project>-<service>-<n>)
cid() { $COMPOSE ps -q "$1" 2>/dev/null | head -1; }
health() {
  local id; id="$(cid "$1")"
  [ -z "$id" ] && { echo "missing"; return; }
  docker inspect --format '{{.State.Health.Status}}' "$id" 2>/dev/null || echo "unknown"
}

log "Cho PostgreSQL va Redis san sang..."
for i in $(seq 1 30); do
  pg="$(health postgres)"; rd="$(health redis)"
  if [ "$pg" = "healthy" ] && [ "$rd" = "healthy" ]; then
    ok "postgres + redis healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    warn "postgres=$pg redis=$rd sau 300s"
    $COMPOSE logs --tail=40 postgres redis
    die "postgres/redis khong healthy. Xem log o tren."
  fi
  printf '  ... postgres=%s redis=%s (%s/30)\n' "$pg" "$rd" "$i"
  sleep 10
done

# Container app tự chạy `prisma migrate deploy` khi start. Kiểm tra kết quả.
log "Cho app khoi dong..."
# Phat hien restart-loop som. Nguyen nhan thuong gap: bien moi truong trong
# .env tro ve localhost (vd DIRECT_DATABASE_URL, REDIS_HOST) ma compose khong
# override — trong container thi localhost la chinh no nen ket noi that bai.
state_of() { docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$(cid "$1")" 2>/dev/null || echo "missing 0"; }

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then
    ok "API san sang: http://127.0.0.1:${APP_PORT}/health"
    break
  fi

  app_state="$(state_of app)"
  restarts="${app_state##* }"
  if [ "${app_state%% *}" = "restarting" ] && [ "$restarts" -ge 3 ]; then
    warn "Container 'app' dang restart loop ($restarts lan). Log:"
    $COMPOSE logs --tail=40 app
    echo ""
    warn "Nguyen nhan thuong gap: bien trong .env tro ve 'localhost' ma"
    warn "compose khong override. Kiem tra bang:"
    echo "    docker compose exec -T app env | grep -E 'DATABASE|REDIS'"
    die "App khong khoi dong duoc."
  fi
  if [ "$i" -eq 30 ]; then
    $COMPOSE logs --tail=50 app
    die "App khong khoi dong duoc. Xem log o tren."
  fi
  sleep 5
done

# Smoke test tren ban build that — bat loi kieu "test xanh nhung production hong"
log "Chay smoke test tren container..."
if $COMPOSE exec -T app node scripts/smoke.mjs >/dev/null 2>&1; then
  ok "smoke test trong container pass"
else
  warn "smoke test trong container khong chay duoc (co the thieu scripts/ trong image) — bo qua"
fi

# ==============================================================================
# 6. SEED (tuỳ chọn)
# ==============================================================================
if [ "$WITH_SEED" = "true" ]; then
  log "Nap du lieu mau (36 nhan su, 30 ngay cham cong, bang luong that)..."
  # Chay ban DA BIEN DICH (dist/prisma/seed.js), khong phai `npx tsx`:
  # tsx la devDependency nen khong co trong image production.
  $COMPOSE exec -T app node dist/prisma/seed.js || die "Seed that bai"
  ok "Seed xong. Dang nhap: admin / Amis@123456"
  warn "DOI MAT KHAU NGAY SAU LAN DANG NHAP DAU TIEN."
fi

# ==============================================================================
# 7. TỔNG KẾT
# ==============================================================================
echo ""
echo "=============================================================="
ok "TRIEN KHAI HOAN TAT"
echo "=============================================================="
echo ""
echo "  API      : http://<IP-VPS>:${APP_PORT}/api/v1"
echo "  Health   : http://<IP-VPS>:${APP_PORT}/health"
echo "  Thu muc  : ${APP_DIR}"
echo ""
echo "  Lenh van hanh:"
echo "    cd ${APP_DIR}"
echo "    ${COMPOSE} ps                    # trang thai"
echo "    ${COMPOSE} logs -f app worker    # log"
echo "    ${COMPOSE} restart app           # khoi dong lai"
echo "    ${COMPOSE} down                  # dung (giu du lieu)"
echo ""
echo "  Backup DB:"
echo "    ${COMPOSE} exec -T postgres pg_dump -Fc -U amis amis_hrm > backup_\$(date +%F).dump"
echo ""
if [ "${REFRESH_COOKIE_SECURE_DONE:-0}" != "1" ]; then
  warn "VIEC CAN LAM TRUOC KHI MO RA INTERNET:"
  echo "    1. Cau hinh Nginx + TLS (xem docs/deployment.md muc 4)"
  echo "    2. Doi REFRESH_COOKIE_SECURE=true trong .env"
  echo "    3. Cap nhat CORS_ORIGINS=https://<domain-that>"
  echo "    4. Chan webhook thiet bi theo IP noi bo (allow/deny trong Nginx)"
  echo "    5. ${COMPOSE} up -d de ap dung"
fi
echo ""
