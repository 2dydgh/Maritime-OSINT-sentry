#!/bin/bash
set -euo pipefail

echo "=== Maritime OSINT Sentry — Server Setup ==="

# 1. 시스템 업데이트
echo "[1/5] Updating system..."
sudo apt-get update && sudo apt-get upgrade -y

# 2. Docker 설치
echo "[2/5] Installing Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER
    echo "Docker installed. Log out and back in for group changes."
fi

# 3. Docker Compose 플러그인 확인
echo "[3/5] Checking Docker Compose..."
docker compose version || {
    echo "ERROR: Docker Compose plugin not found"
    exit 1
}

# 4. Swap 메모리 설정 (ARM 1GB RAM에서 필수)
echo "[4/5] Setting up swap..."
if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    echo "Swap enabled: 2GB"
else
    echo "Swap already exists"
fi

# 5. 방화벽 설정 (Oracle Cloud는 iptables 사용)
echo "[5/5] Configuring firewall..."
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || sudo iptables-save | sudo tee /etc/iptables/rules.v4

echo ""
echo "=== Setup complete! ==="
echo "Next steps:"
echo "  1. Clone your repo: git clone <your-repo-url> ~/osint-sentry"
echo "  2. Copy env file:   cp deploy/.env.prod.example deploy/.env.prod"
echo "  3. Edit env file:   nano deploy/.env.prod"
echo "  4. Start services:  cd deploy && docker compose --env-file .env.prod -f docker-compose.prod.yml up -d"
