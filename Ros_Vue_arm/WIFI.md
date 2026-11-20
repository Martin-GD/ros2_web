# Wi-Fi 设置

在机器人中控台顶部查看 **Wi-Fi IP** 和当前网络名称，点击 **Wi-Fi 连接** 打开设置。

1. 页面自动扫描附近的 Wi-Fi，也可点击“重新扫描”。列表显示信号强度、频段、加密方式和当前连接。
2. 选择网络，输入密码后点击“连接 Wi-Fi”。已保存的网络可留空使用原密码。
3. 成功后保存连接并启用自动连接；连接失败时尝试恢复原 Wi-Fi。

切换网络可能使网页与设备断开。电脑或手机需接入同一网络，再使用设备的新 IP 访问 `http://设备IP:5173`。设备通过 DHCP 获取无线 IP，地址可能改变。也可通过已配置的有线地址 `http://192.168.2.2:5173` 访问，电脑需在同一有线网段。

支持个人 WPA/WPA2、WPA3、OWE、开放网络，以及 **WPA-Enterprise / 802.1X 的 PEAP + MSCHAPv2**。暂不支持 WEP、EAP-TLS、TTLS 或手动添加隐藏 SSID。顶部显示无线接口的 IPv4，每 3 秒更新；无法读取时显示“读取失败”，不会把旧地址当作当前状态。

## 南科大校园网（802.1X）

1. 如尚未设置无线认证密码，在校园网内访问 <https://wxrz.sustech.edu.cn/>，使用 CAS 注册并设置 **eduroam 系统登录密码**。
2. 打开网页的“Wi-Fi 连接”，扫描并选择标有 `802.1X` / `EAP` 的校园无线网络，不要选择需要网页认证的开放 SSID。
3. 用户名填写完整邮箱：学生为 `学号@mail.sustech.edu.cn`，教职工为 `账号@sustech.edu.cn`。密码填写 eduroam 密码，**不是 CAS 登录密码**。
4. 匿名身份在学校未要求时留空。程序固定使用 EAP `PEAP`、阶段 2 `MSCHAPv2`，CA 证书使用学校说明中的“不验证”方式。
5. 点击连接，等待认证和 DHCP。成功后顶部显示 RK 的无线 IP，并保存配置供下次自动连接。802.1X 激活最多等待 90 秒，失败后尝试恢复原网络。

已保存的校园网显示“使用已保存的校园网账号和密码”，勾选即可重连；取消勾选后需重新填写账号和密码。只改账号或匿名身份时也需要重新输入密码，避免把新账号与旧密码混用。同名的个人 Wi-Fi 配置不会作为校园网凭证复用。

本次实现“不验证 CA”，不做证书固定或首次信任（TOFU），因此不会校验认证服务器的证书身份。若学校要求 CA 验证，需另行配置 CA 和服务器域名。参数格式参考 [NetworkManager 的 PEAP/MSCHAPv2 配置示例](https://networkmanager.dev/docs/api/latest/nm-settings-keyfile.html)及 [802.1X 属性说明](https://networkmanager.dev/docs/api/latest/settings-802-1x.html)。

### 与 Web Portal 的区别

Web Portal 是先连接开放 Wi-Fi，再通过 CAS 网页认证的另一种方式。本功能不会自动执行 `http://172.16.16.20:803/sustc_cas.php` 的 CAS 登录，也不执行外部脚本或修改 MAC 地址。连接开放 SSID 并获取 IP，只代表接入局域网，不代表已经通过 Portal、可以访问互联网。

## 更新到 RK

本修改位于 `Ros_Vue_arm`，用于 RK 上的 Linux 网页服务，不需要重新烧录 RK 或 ESP32。Wi-Fi 设置操作的是**运行后端的那台机器**；要给 RK 配网，后端必须运行在 RK 上。

通过网线保持维护连接，在 RK 上用 root 执行下面的更新。首次将源码下载到独立目录，避免覆盖 RK 的地图、`ros_config.json`、导航点或其他部署配置：

```bash
git clone https://github.com/Martin-GD/ros2_web.git /root/ros2_web_source

# 已下载过源码时，改为更新该源码目录：
# git -C /root/ros2_web_source pull --ff-only

wifi_backup_dir="/root/ros2_web_wifi_backup_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$wifi_backup_dir"
cp -a /root/ros2_web/wifi.js "$wifi_backup_dir/"
cp -a /root/ros2_web/src/components/WifiSettings.vue "$wifi_backup_dir/"
cp -a /root/ros2_web/dist "$wifi_backup_dir/"

cp /root/ros2_web_source/Ros_Vue_arm/wifi.js /root/ros2_web/wifi.js
cp /root/ros2_web_source/Ros_Vue_arm/src/components/WifiSettings.vue \
  /root/ros2_web/src/components/WifiSettings.vue

cd /root/ros2_web
npm run build
systemctl restart ros2-web.service
```

已有可用 Node 依赖时直接构建即可；全新部署或依赖缺失时先在 RK 上执行 `npm ci --no-audit --no-fund`，不要从 x86 服务器复制 `node_modules`。如果构建失败，先修复构建，再重启服务。更新后刷新网页；仍显示旧页面时强制刷新浏览器缓存。

```bash
systemctl status ros2-web.service --no-pager
journalctl -u ros2-web.service -n 50 --no-pager
nmcli -f DEVICE,TYPE,STATE,CONNECTION device status
ip -4 addr show wlan0
```

最后一条命令的接口名按设备实际情况调整。校园网认证成功后，仍需确认校园网允许电脑、服务器和机器人互访；无线隔离等网络策略不会因认证成功而自动解除。

## 运行要求与实现

后端需要 `/usr/bin/nmcli` 和运行中的 NetworkManager，以及管理无线连接和写入 `/etc/NetworkManager/system-connections` 的权限。当前设备由 root 运行 ros2-web。只管理无线接口，优先使用 `wlan0`。

- `wifi.js`：NetworkManager 适配、网络扫描、异步连接任务及失败回退。
- `src/components/WifiSettings.vue`：中文设置弹窗和顶部状态。
- `GET /api/wifi/status`：无线状态及 IP。
- `POST /api/wifi/scan`：扫描网络。
- `POST /api/wifi/connect`：个人 Wi-Fi 提交 `{ssid, bssid, password}`；新建或修改校园网配置提交 `{ssid, bssid, identity, anonymous_identity, password}`，返回连接任务。`anonymous_identity` 可省略；复用已保存配置时账号和密码均留空。认证类型以设备扫描结果为准，不能由请求伪装。
- `GET /api/wifi/jobs/:id`：查询连接结果。

POST 请求使用 JSON 和 `X-Wifi-Settings: 1`，浏览器来源限设备本身的 5173/3000 端口。账号和密码不进入命令行参数、应用日志或 API 返回；NetworkManager 配置文件以 0600 权限保存凭证供开机重连，失败时清理新配置。原有已保存网络保留。服务沿用中控台现有的局域网访问方式。

设置弹窗阻止控制键事件传播，打开时停止键盘控制。账号、匿名身份和密码在提交、切换网络、重新扫描或收起弹窗后清空。

## 验证

```bash
node --test *.test.js
npm run build
```

自动化覆盖 SSID 转义和去重、PEAP 配置及凭证转义、个人/企业密码分别校验、保存配置的认证类型匹配、校园网重连和账号变更、凭证不进入命令行/API、连接成功保存、失败回退、回退失败报告、并发限制和 HTTP 请求校验。自动化使用模拟 NetworkManager，不会切换测试机器的真实网络；真实校园网认证需在 RK 上验证。
