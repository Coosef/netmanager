#!/usr/bin/env bash
# ============================================================
#  NetManager – Sunucuya Otomatik Kurulum
#  Bu dosyayı sunucuya kopyalayıp çalıştır:
#    chmod +x install.sh && sudo ./install.sh
# ============================================================
set -euo pipefail

# ─── Renkler ────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[HATA]${NC}  $*" >&2; }
step()    { echo -e "\n${BOLD}${BLUE}▶ $*${NC}"; }

# ─── Root kontrolü ──────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "Bu script root olarak çalıştırılmalı: sudo ./install.sh"
  exit 1
fi

# ─── Değişkenler ────────────────────────────────────────────
REPO_URL="https://github.com/Coosef/netmanager.git"
APP_DIR="/opt/netmanager"

# ─── Hoşgeldin ekranı ───────────────────────────────────────
echo ""
echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║       NetManager Otomatik Kurulum        ║${NC}"
echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

# ─── OS tespiti ─────────────────────────────────────────────
step "İşletim sistemi tespit ediliyor"
if command -v apt-get &>/dev/null; then
  PKG_MGR="apt"
  info "Debian/Ubuntu tabanlı sistem"
elif command -v dnf &>/dev/null; then
  PKG_MGR="dnf"
  info "Fedora/RHEL/Rocky tabanlı sistem"
elif command -v yum &>/dev/null; then
  PKG_MGR="yum"
  info "CentOS/RHEL tabanlı sistem"
else
  error "Desteklenmeyen Linux dağıtımı (apt/dnf/yum gerekli)"
  exit 1
fi

# ─── Temel paketler ─────────────────────────────────────────
step "Temel paketler kuruluyor"
if [[ "$PKG_MGR" == "apt" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg lsb-release git openssl python3
else
  $PKG_MGR install -y -q ca-certificates curl gnupg git openssl python3
fi
success "Temel paketler hazır"

# ─── Docker kurulumu ────────────────────────────────────────
step "Docker kontrol ediliyor"
if ! command -v docker &>/dev/null; then
  info "Docker kuruluyor..."
  if [[ "$PKG_MGR" == "apt" ]]; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg" \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  else
    $PKG_MGR install -y -q yum-utils
    yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    $PKG_MGR install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi
  systemctl enable --now docker
  success "Docker kuruldu: $(docker --version)"
else
  success "Docker zaten kurulu: $(docker --version)"
fi

# ─── Docker Compose kontrol ──────────────────────────────────
if ! docker compose version &>/dev/null; then
  info "Docker Compose plugin kuruluyor..."
  if [[ "$PKG_MGR" == "apt" ]]; then
    apt-get install -y -qq docker-compose-plugin
  else
    $PKG_MGR install -y -q docker-compose-plugin
  fi
fi
success "Docker Compose: $(docker compose version --short)"

# ─── Repo klonla veya güncelle ──────────────────────────────
step "Uygulama kodu hazırlanıyor"

if [[ -d "$APP_DIR/.git" ]]; then
  info "Repo mevcut, güncelleniyor..."
  git -C "$APP_DIR" pull --ff-only
  success "Repo güncellendi"
else
  # Önce public olarak dene
  info "Repo erişimi kontrol ediliyor..."
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    "https://api.github.com/repos/Coosef/netmanager" 2>/dev/null || echo "0")

  if [[ "$HTTP_CODE" == "200" ]]; then
    # Public repo — doğrudan klonla
    info "Public repo tespit edildi, klonlanıyor..."
    git clone "$REPO_URL" "$APP_DIR"
  else
    # Private repo — token iste
    warn "Private repo tespit edildi, GitHub token gerekli"
    echo ""
    echo -e "  GitHub → Settings → Developer settings → Personal access tokens"
    echo -e "  → 'repo' yetkili bir token oluştur ve buraya yapıştır:"
    echo ""
    read -rsp "  GitHub Token: " GH_TOKEN
    echo ""

    if [[ -z "$GH_TOKEN" ]]; then
      error "Token girilmedi, kurulum iptal edildi"
      exit 1
    fi

    # Token ile klonla, ardından token'ı git config'den temizle
    CLONE_URL="https://${GH_TOKEN}@github.com/Coosef/netmanager.git"
    if git clone "$CLONE_URL" "$APP_DIR"; then
      # Remote URL'den token'ı kaldır (güvenlik)
      git -C "$APP_DIR" remote set-url origin "$REPO_URL"
      success "Repo klonlandı (token temizlendi)"
    else
      error "Klonlama başarısız — token doğru mu?"
      exit 1
    fi
  fi
fi

# ─── .env oluştur ───────────────────────────────────────────
step ".env yapılandırması"
if [[ ! -f "$APP_DIR/.env" ]]; then
  info "Güvenli anahtarlar üretiliyor..."

  SECRET_KEY=$(openssl rand -hex 32)
  DB_PASSWORD=$(openssl rand -hex 16)
  FLOWER_PASS=$(openssl rand -hex 8)
  FERNET_KEY=$(python3 -c "import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())")

  cat > "$APP_DIR/.env" <<ENV
# === DATABASE ===
POSTGRES_USER=netmgr
POSTGRES_PASSWORD=${DB_PASSWORD}
POSTGRES_DB=network_manager

# === SECURITY ===
SECRET_KEY=${SECRET_KEY}
CREDENTIAL_ENCRYPTION_KEY=${FERNET_KEY}

# === REDIS ===
REDIS_URL=redis://redis:6379/0

# === APP ===
ENVIRONMENT=production
ACCESS_TOKEN_EXPIRE_MINUTES=480
ALLOWED_ORIGINS=*

# === CELERY ===
SSH_MAX_CONCURRENT=50
SSH_CONNECT_TIMEOUT=30
SSH_COMMAND_TIMEOUT=60

# === FLOWER ===
FLOWER_USER=admin
FLOWER_PASSWORD=${FLOWER_PASS}
ENV

  chmod 600 "$APP_DIR/.env"
  success ".env oluşturuldu (anahtarlar rastgele üretildi)"
else
  warn ".env zaten var — mevcut yapılandırma korundu"
  DB_PASSWORD=$(grep POSTGRES_PASSWORD "$APP_DIR/.env" | cut -d= -f2)
  FLOWER_PASS=$(grep FLOWER_PASSWORD "$APP_DIR/.env" | cut -d= -f2)
fi

# ─── Build & Başlat ─────────────────────────────────────────
step "Docker imajları build ediliyor"
cd "$APP_DIR"
info "Bu adım ilk kurulumda 3-10 dakika sürebilir..."
docker compose build
success "İmajlar hazır"

step "Servisler başlatılıyor"
docker compose up -d
success "Servisler başlatıldı (Nginx port 80 üzerinde)"

# ─── Sağlık kontrolü ────────────────────────────────────────
step "Servisler hazır olana kadar bekleniyor"
for i in $(seq 1 18); do
  RUNNING=$(docker compose ps -q 2>/dev/null | xargs -r docker inspect \
    --format '{{.State.Status}}' 2>/dev/null | grep -c "running" || echo 0)
  if [[ "$RUNNING" -ge 5 ]]; then
    success "$RUNNING konteyner çalışıyor"
    break
  fi
  echo -e "  ${CYAN}...${NC} $i/18 — $RUNNING konteyner aktif"
  sleep 5
done

# ─── Veritabanı migrasyonu ───────────────────────────────────
step "Veritabanı migrasyonu"
sleep 3
if docker compose exec -T backend alembic upgrade head 2>/dev/null; then
  success "Migrasyon tamamlandı"
else
  warn "Migrasyon başarısız olabilir — logları kontrol et: docker compose logs backend"
fi

# ─── Sunucu IP tespiti ──────────────────────────────────────
SERVER_IP=$(hostname -I | awk '{print $1}')

# ─── Sonuç ekranı ───────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║        NetManager başarıyla kuruldu!             ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Erişim Adresleri:${NC}"
echo -e "  ${CYAN}Ana Giriş ${NC}→  http://${SERVER_IP}        ${YELLOW}(Nginx — önerilen)${NC}"
echo -e "  ${CYAN}API Docs  ${NC}→  http://${SERVER_IP}:8000/docs"
echo -e "  ${CYAN}Flower    ${NC}→  http://${SERVER_IP}:5555  (admin / ${FLOWER_PASS})"
echo ""
echo -e "  ${BOLD}Veritabanı Şifresi:${NC} ${YELLOW}${DB_PASSWORD}${NC}"
echo -e "  ${BOLD}.env Konumu:${NC}        ${APP_DIR}/.env"
echo ""
echo -e "  ${BOLD}${CYAN}Cloudflare Tunnel / Reverse Proxy kurulumu:${NC}"
echo -e "  Trafiği ${YELLOW}http://${SERVER_IP}:80${NC} adresine yönlendir."
echo -e "  Agent WebSocket bağlantıları Nginx üzerinden otomatik"
echo -e "  yönetilir (3600s timeout, proxy_buffering kapalı)."
echo ""
echo -e "  ${BOLD}Faydalı komutlar:${NC}"
echo -e "  ${YELLOW}cd ${APP_DIR}${NC}"
echo -e "  ${YELLOW}docker compose ps${NC}              → servis durumu"
echo -e "  ${YELLOW}docker compose logs -f nginx${NC}   → Nginx logları"
echo -e "  ${YELLOW}docker compose logs -f backend${NC} → backend logları"
echo -e "  ${YELLOW}docker compose restart backend${NC} → yeniden başlat"
echo -e "  ${YELLOW}git pull && docker compose up -d${NC} → güncelle"
echo ""
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════${NC}"
