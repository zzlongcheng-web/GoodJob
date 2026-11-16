#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EUID:-$(id -u)}" -eq 0 ]] || { printf '请使用 root 执行\n' >&2; exit 1; }
command -v apt-get >/dev/null 2>&1 || { printf '此脚本仅支持 Ubuntu/Debian 系列\n' >&2; exit 1; }
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || { printf '此脚本仅支持 Ubuntu；当前系统：%s\n' "${PRETTY_NAME:-未知}" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release subversion openssl rsync iproute2 tar gzip

install -d -m 0755 /etc/apt/keyrings
if [[ ! -s /etc/apt/keyrings/docker.gpg ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod 0644 /etc/apt/keyrings/docker.gpg
fi

architecture="$(dpkg --print-architecture)"
codename="${VERSION_CODENAME:-}"
[[ -n "$codename" ]] || { printf '无法识别 Ubuntu 版本代号\n' >&2; exit 1; }
cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$architecture signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $codename stable
EOF

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker version
docker compose version
printf '\nDocker、Compose、SVN 已安装。下一步执行：\n'
printf '  请先下载并核验已审查的固定提交源码，放到 /opt/goodjobcrm-src\n'
printf '  cd /opt/goodjobcrm-src/deploy/docker-compose && ./configure.sh\n'\nprintf '  将 /opt/goodjobcrm/shared/deploy.env 中 GOODJOB_IMAGE_MODE 改为 local\n'\nprintf '  然后运行 ./preflight.sh && ./install.sh （请先确保 DNS/HTTPS 已准备）\n'
