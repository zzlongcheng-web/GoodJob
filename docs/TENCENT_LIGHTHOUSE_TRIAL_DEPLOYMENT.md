# Golden Gain CRM — 腾讯云轻量服务器试用部署（2026-11-17）

> 本文只适用于 GitHub PR #10 的 **Golden Gain CRM 发布候选源码**，不适用于旧镜像 1.7.2、原项目演示账号或公开旧教程。不应在正式生产客户数据上试装。部署完必须完成 2–5 名员工真实权限 UAT。

## 购买建议

- 腾讯云 Lighthouse / Ubuntu Server 24.04 LTS / Linux x86_64。
- 4 vCPU、8 GB RAM、至少 100 GB SSD（推荐 180 GB 套餐）、公网 IP。
- 地域优先按**实际员工位置**选；内地团队如需国际 API，可以考虑香港通用型，但必须实测内地跨境延时；内地地域需要满足 ICP 备案规定。
- 只允许 TCP 80/443 公网入站，TCP 22 限定管理员 IP；禁止公网开放 3100、3306、4188。
- 先购买一个月验证速度和内存。备份应同时保存在独立的加密存储中，不要只依赖同一台机器的 SSD。

## 在全新 Ubuntu 上安装并试用

在 root 或具有 sudo 权限的账号执行；不要复制任何密码到公开聊天窗口。

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates nginx
sudo git clone --single-branch --branch release/golden-gain-candidate-20261117 \
  https://github.com/zzlongcheng-web/GoodJob.git /opt/Golden-Gain-CRM
cd /opt/Golden-Gain-CRM
git rev-parse HEAD
# 上一条必须与发布报告批准的 PR #10 SHA 一致。
sudo bash deploy/docker-compose/install-docker-ubuntu.sh
sudo bash deploy/docker-compose/configure.sh
# 根据提示填写 CRM 域名、公司自己的管理员邮箱、至少 12 位初始强密码。
# 该脚本默认 GOODJOB_IMAGE_MODE=local，只从本仓库源代码构建。
sudo bash deploy/docker-compose/preflight.sh
sudo bash deploy/docker-compose/install.sh
sudo bash deploy/docker-compose/manage.sh status
curl -fsS http://127.0.0.1:4188/api/health
```

说明：Docker 安装脚本末尾输出的旧 SVN/Gitee 链接不是当前 CRM 源码地址，不要执行；以本指南的 GitHub PR #10 为准。首次构建会安装 Node 依赖、LibreOffice 及中文字体，必须保证机器可访问 npm、SheetJS 官方 CDN 与容器镜像仓库。

## 域名和 HTTPS

1. 为 CRM 子域名（例如 crm.example.com）创建 DNS A 记录，指向腾讯云实例公网 IPv4。
2. 使用服务器主机 Nginx 将来自子域名的 HTTP/HTTPS 反代到 `http://127.0.0.1:4188`；请设置 Host、X-Forwarded-Proto、X-Forwarded-For 和 WebSocket Upgrade 头。不要把 4188 映射到公网。
3. 确认 Nginx 的代理配置无误并申请该子域名的 HTTPS 证书（例如使用 certbot）。
4. 在 `/opt/goodjobcrm/shared/deploy.env` 中设置：
   ```text
   PUBLIC_SCHEME=https
   PUBLIC_ORIGIN=https://crm.example.com
   SESSION_COOKIE_SECURE=true
   ```
   用实际域名替换示例值。注意 `docker compose restart` 不会重新载入环境变量！请在服务器上执行下面的容器重建（不删除任何数据卷），再核对网站 HTTPS：
   ```bash
   RELEASE_ID="$(sudo cat /opt/goodjobcrm/shared/state/current-release)"
   cd /opt/Golden-Gain-CRM
   sudo env GOODJOB_RELEASE_ID="$RELEASE_ID" docker compose --project-name goodjobcrm \
     --env-file /opt/goodjobcrm/shared/deploy.env \
     -f deploy/docker-compose/compose.yml \
     up -d --no-build --force-recreate backend communication gateway
   ```
   最简单的方式是 **先配置 Nginx 和 HTTPS，再运行 configure.sh，并如实选择已启用 HTTPS**，这样无需修改配置。正式 SSL 生效前不要输入客户资料。
5. 只通过 `https://crm.example.com` 登录，管理员必须更改密码、配置 MFA。初始管理员邮箱必须是公司自己的邮箱。

## 首轮试用任务

- 创建测试员工 A、B 和主管；验证两员工私有客户、WhatsApp 会话、附件和导出相互隔离。
- 创建不同国家的测试线索、跟进记录和测试订单，核对月度 61 家考核口径与 Excel/PDF。
- 不导入正式客户总库；不启用真实 WhatsApp 自动发送、群发邮件、电话拨号，直到相关官方接口、权限和审计完成验收。
- 在隔离环境做一次 MySQL 备份及恢复演练，记录恢复证据。
- 完成 `docs/RELEASE_ACCEPTANCE_CHECKLIST_2026-11-17.md` 中的正式生产验收项后，才能考虑公司生产上线。
- 对该版本未配套的宝塔自动更新工具，安装器会跳过并告警；试用期不要使用旧版 1.7.2 的自动更新或镜像脚本。

## 注意

在 `configure.sh` 中给容器应用账户授予的密钥文件组权限必须为 GID 1001；容器应是非 root 的 UID/GID 1001。本修复另有实际 Docker 文件挂载读取测试，避免首次安装出现密钥权限错误。
