# Golden Gain CRM — Docker / 宝塔部署与更新手册（安全修订版）

> **唯一有效的部署原则：从经过代码审查、CI 通过的固定 Git 提交构建应用。**
> 本文档已取代历史“公开仓库镜像最小包”安装教程。严禁按照旧步骤下载外部预构建的 CRM backend、communication 或 gateway 镜像。
> **本文档仅用于测试环境准备；正式上线必须先完成备份恢复、账号隔离与安全验收。**

## 1. 范围和准备

- 本目录是 **deploy/docker-compose**；源码同时包含 backend、frontend、whatsapp-plugin、integration-worker 等模块。
- 推荐在独立 VPS 安装，不修改现有 WordPress 网站。示例域名：**crm.goldengainmachinery.com**，实际以 DNS 为准。
- 需要 Linux (Ubuntu)、Docker Engine、Docker Compose v2、Git 和至少 10 GiB 可用磁盘；内存按并发与实际负载验证。
- MySQL、后端、Communication 和内部网关由 Docker Compose 管理；在宿主机上只开放必要的 80/443，禁止公网开放 3306、3100、4188。
- **禁止引入旧的外部应用镜像和旧版安装包。** 可按官方来源使用 MySQL 等基础镜像，但应用镜像必须由本次审核源码构建。
- 本手册使用 **local** 镜像模式。registry 模式仅可使用另行审核并明确配置的私有可信镜像，绝不默认拉取第三方仓库。

## 2. 从已审核的固定提交取得源码

在运维电脑或独立测试 VPS 上运行；由审查负责人提供完整 40 位、CI 通过的提交号：

~~~bash
git clone https://github.com/zzlongcheng-web/GoodJob.git /opt/goodjobcrm-src
cd /opt/goodjobcrm-src
APPROVED_SHA="填写已批准的完整40位提交号"
git checkout --detach "$APPROVED_SHA"
test "$(git rev-parse HEAD)" = "$APPROVED_SHA"
git status --short
~~~

必须确保工作区没有未审查的修改。不要执行旧文档中的外部镜像拉取、未经审核的更新计划任务，或从第三方 SVN 仓库取得应用源码。

## 3. 首次配置（独立、空白测试环境）

Docker 尚未安装时，可先审查并运行本目录的 **install-docker-ubuntu.sh**；它只安装系统 Docker 组件，不等于已完成 CRM 安全验收。

~~~bash
cd /opt/goodjobcrm-src/deploy/docker-compose
sudo ./configure.sh
~~~

按照提示输入真实的公司管理邮箱（不得使用共享演示账号）、管理员姓名、强随机密码、CRM 域名及 HTTPS 状态。配置写在 **/opt/goodjobcrm/shared/deploy.env**，密钥保存在 **/opt/goodjobcrm/shared/secrets/**；不要提交到 Git、聊天记录或截图。

**必须核对**：

~~~bash
sudo grep -E '^(GOODJOB_IMAGE_MODE|ENABLE_API_DOCS|DOMAIN|PUBLIC_SCHEME|SESSION_COOKIE_SECURE)=' \
  /opt/goodjobcrm/shared/deploy.env
~~~

验收要求：
- GOODJOB_IMAGE_MODE=local
- ENABLE_API_DOCS=false
- 生产 HTTPS 时 PUBLIC_SCHEME=https 且 SESSION_COOKIE_SECURE=true
- 不存在任何未经审核的应用镜像仓库引用
- 首次部署仅创建明确配置的公司管理员；**不会自动创建 40 或 50 个公测管理员**

本次 Docker 安装方式已删除自动创建 50 名测试管理员的调用及相关密钥生成。已有数据库中的历史账号不会因代码升级而自动删除；必须在备份后由授权管理员逐一审查和停用。

## 4. 预检、构建及首次启动

**前提：** 使用固定提交的完整源码，并已核对实际服务器、安全配置和域名。

~~~bash
cd /opt/goodjobcrm-src/deploy/docker-compose
sudo ./preflight.sh
sudo env GOODJOB_RELEASE_ID="$APPROVED_SHA" GOODJOB_BUILD_BEFORE_INSTALL=true ./install.sh
sudo ./manage.sh status
~~~

如果 **APPROVED_SHA** 未从前述 shell 会话保留，请重新赋值并核对；不要使用空值。此流程本地编译当前源码并构建 Docker 应用镜像，不应从外部仓库获取应用镜像。不要将此示例当作已经完成实际 VPS 部署。

健康检查：

~~~bash
curl -fsS http://127.0.0.1:4188/api/health
~~~

还须人工检查 **docker compose** 的实际镜像来源、运行容器、健康状态、日志和 MySQL 配置（MySQL 要求 log_bin 关闭）。核对应用显示 Golden Gain CRM。

## 5. 宝塔 / Nginx 域名与 HTTPS

- 单独创建 CRM 子域名的网站配置。只修改 CRM 自己的 server 块，不能覆盖现有外贸独立站、其他域名或全局配置。
- 将 CRM HTTPS 网站的请求反向代理到 **127.0.0.1:4188**；WebSocket 所需 Upgrade/Connection 头应保留。
- 在宝塔中签发有效 TLS 证书后配置 HTTPS，并确认安全 Cookie 和正确的 PUBLIC_ORIGIN。
- 修改 Nginx 前备份站点配置，验证 **nginx -t** 通过才重载；不要重复创建已有的 location /。
- 上线前从外网检查 3306、3100、4188 不可直接访问，API 调试文档不公开。

## 6. 备份、恢复、更新（必须先演练）

### 备份

~~~bash
cd /opt/goodjobcrm-src/deploy/docker-compose
sudo ./backup.sh
~~~

备份包含 MySQL、上传文件和 Communication 媒体，以及包含敏感密钥的部署配置。核验 SHA256SUMS，并加密、限制访问、异地保存；不能仅在同一块 VPS 磁盘上保留备份。应配置每日自动备份并定期检查。

### 恢复

**restore.sh 会覆盖数据库及文件，只能在隔离测试 VPS 上演练。** 先确认备份路径、恢复前后记录数及实际登录功能，禁止直接在生产库执行示例恢复。

### 更新

1. 技术负责人批准新提交 SHA；复核完整 CI、安全审计、兼容性、迁移及备份。
2. 用 Git 按完整 SHA 更新独立源码目录，核对 HEAD，无未审查的工作区修改。
3. 在当前 CRM 部署版本稳定的前提下，先生成并验证备份，再按固定 SHA 进行本地构建与安装。
4. 验证健康检查、真实权限、订单/客户数据、WhatsApp 账号映射、文件读写及任务报表。
5. **rollback.sh 只回滚应用镜像，不反向执行数据库迁移。** 需要恢复数据库时必须基于经验证的备份，由技术负责人批准执行。

**不要使用 update-docker.sh / update-from-svn.sh 作为默认升级入口**：后者依赖显式指定的 SVN 源，不能用它自动寻找新版本；宝塔旧版定时“拉取远端镜像”的计划任务必须停用。

## 7. Ubuntu 非 Docker 安装方式的强制约束

根目录的 **deploy-ubuntu.sh** 属于另一种部署方式，不能和 Docker 安装混用。其安全修订版要求：

- PROVISION_BETA_ADMINS 默认 false；即使被显式设成 true，脚本也会立即拒绝执行。
- ENABLE_API_DOCS 默认 false。
- 必须在隔离测试服务器和已审核源码上使用；不准凭旧文档在现有生产服务器直接运行。

## 8. 上线阻断条件

任何一项不满足都不得导入正式客户数据：
- 当前提交的全部 CI、编译和浏览器冒烟测试成功，有 GitHub 原始日志。
- 没有默认固定密码的超级管理员；历史演示/公测账号已由管理员逐个核实和停用。
- 剩余 High 风险依赖已经评估和接受或修复，密钥、权限、审计日志合规。
- 备份恢复演练通过，并有异地备份。
- 真实 5–15 人角色隔离、WhatsApp 多账号隔离、任务/绩效、重要客户流程通过验收。
- 已检查部署的确是批准提交构建的镜像，没有旧应用镜像，也没有自动第三方升级任务。

**许可证声明：** 保留源代码中的 Apache-2.0、GPL 和第三方版权材料；品牌名改变不代表改变许可证。
