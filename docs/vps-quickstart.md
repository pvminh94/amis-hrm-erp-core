# Chạy dự án trên VPS Ubuntu Server — hướng dẫn từng bước

Toàn bộ lệnh dưới đây chạy **trên VPS**, trừ Bước 1.

---

## Bước 0 — Tạo token GitHub mới (2 phút)

Repo là **private** nên VPS cần token để tải code. Token cũ nên thu hồi vì nó
đã lộ dạng plaintext và có scope `delete_repo`.

1. Mở https://github.com/settings/tokens
2. **Generate new token (classic)**
3. Tick **chỉ** scope `repo` — không cần gì khác
4. Expiration: 90 ngày
5. Copy token (`ghp_...`) — **chỉ hiện một lần**

Gọi token này là `TOKEN` trong các lệnh bên dưới.

---

## Bước 1 — SSH vào VPS (chạy trên máy bạn)

```bash
ssh bvqy4@100.99.239.8
```

Nhập mật khẩu khi được hỏi.

> `100.99.239.8` là IP Tailscale. Máy bạn phải **đang bật Tailscale và nằm
> trong cùng tailnet** mới vào được. Kiểm tra bằng `tailscale status`.
> Nếu muốn vào từ internet, dùng IP public của VPS thay thế.

> **Nên đổi sang SSH key** thay vì mật khẩu:
> ```bash
> # trên máy bạn
> ssh-keygen -t ed25519 -C "vps-amis"
> ssh-copy-id bvqy4@100.99.239.8
> # rồi tắt mật khẩu trong /etc/ssh/sshd_config: PasswordAuthentication no
> ```

---

## Bước 2 — Kiểm tra VPS đủ sức chạy không (10 giây)

```bash
lsb_release -ds; nproc; free -h | head -2; df -h / | tail -1
```

Cần tối thiểu **2 vCPU / 2 GB RAM / 20 GB disk trống**. Dưới mức đó Postgres
+ Redis + app dễ bị OOM-kill.

---

## Bước 3 — Tải script về VPS

```bash
TOKEN='ghp_dán_token_vào_đây'

curl -fsSL -H "Authorization: token $TOKEN" \
  https://raw.githubusercontent.com/pvminh94/amis-hrm-erp-core/main/scripts/deploy-vps.sh \
  -o /tmp/deploy-vps.sh
```

Kiểm tra tải đúng chưa:

```bash
wc -l /tmp/deploy-vps.sh     # phải ra ~256 dòng
head -3 /tmp/deploy-vps.sh   # phải thấy "#!/usr/bin/env bash"
```

Nếu ra `404` → token sai hoặc hết hạn. Nếu file chỉ vài dòng → token thiếu
scope `repo`.

---

## Bước 4 — Chạy

```bash
GITHUB_TOKEN="$TOKEN" bash /tmp/deploy-vps.sh
```

Muốn kèm dữ liệu mẫu (36 nhân sự + 30 ngày chấm công + bảng lương thật):

```bash
GITHUB_TOKEN="$TOKEN" WITH_SEED=true bash /tmp/deploy-vps.sh
```

**Lần đầu mất 5–10 phút** (cài Docker + build image). Các lần sau chỉ ~1 phút.

### Script tự làm những gì

| Bước | Việc |
|---|---|
| 1 | Kiểm tra CPU/RAM/disk, cảnh báo nếu RAM < 2GB |
| 2 | Cài Docker + compose plugin nếu chưa có |
| 3 | Clone repo về `~/amis-hrm-erp` (đã có thì `git reset --hard origin/main`) |
| 4 | Tạo `.env` với secret **mới** sinh bằng `openssl` — không ghi đè nếu đã có |
| 5 | `docker compose up -d --build` |
| 6 | Chờ Postgres + Redis `healthy` (dùng `docker inspect`, in tiến độ mỗi 10s) |
| 7 | Chờ API trả lời `/health` |
| 8 | Chạy smoke test trong container |
| 9 | Seed nếu `WITH_SEED=true` |

Script **idempotent** — chạy lại không phá dữ liệu, `.env` cũ được giữ nguyên.

---

## Bước 5 — Kiểm tra kết quả

```bash
cd ~/amis-hrm-erp

docker compose ps                              # 4 service phải Up/healthy
curl -s http://127.0.0.1:3000/health           # {"status":"ok",...}
docker compose logs --tail=30 app              # migration + "API sẵn sàng"
```

Nếu có seed, đăng nhập thử:

```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"Amis@123456"}'
```

Phải trả về `accessToken`. **Đổi mật khẩu ngay** nếu mở ra ngoài.

---

## Bước 6 — Mở cổng để truy cập từ ngoài

Mặc định chỉ nghe trong VPS. Muốn gọi từ máy bạn:

```bash
sudo ufw allow 3000/tcp
sudo ufw reload
```

Rồi truy cập `http://100.99.239.8:3000/health`.

> Trong tailnet thì chỉ thiết bị trong tailnet vào được — đủ an toàn để test.
> Muốn mở ra internet thật thì **bắt buộc** phải có TLS trước (Bước 7).

---

## Bước 7 — Trước khi dùng thật (bắt buộc)

```bash
cd ~/amis-hrm-erp
nano .env
```

Đổi 3 dòng:

```ini
REFRESH_COOKIE_SECURE=true                          # cookie refresh chỉ đi qua HTTPS
CORS_ORIGINS=https://hrm.ten-mien-that.vn           # KHÔNG để *
GEO_WIFI_BSSID_REQUIRED=true                        # nếu muốn đối soát WiFi văn phòng
```

Rồi dựng Nginx + TLS theo `docs/deployment.md` mục 4, và:

```bash
docker compose up -d
```

---

## Lỗi thường gặp

| Thấy gì | Vì sao | Làm gì |
|---|---|---|
| `curl: (22) 404` khi tải script | Token sai / hết hạn / thiếu scope `repo` | Tạo lại token, tick đúng `repo` |
| `permission denied` khi chạy docker | User chưa vào group `docker` | `newgrp docker` hoặc đăng nhập lại |
| `postgres=starting` mãi không `healthy` | Disk đầy hoặc RAM cạn | `df -h`, `free -h`, xem `docker compose logs postgres` |
| `Can't reach database server` trong log app | App start trước Postgres | Script đã chờ healthy; nếu vẫn lỗi thì `docker compose restart app` |
| Build image lỗi ở `prisma generate` | Mạng tới npm bị chặn | `curl -I https://registry.npmjs.org` kiểm tra |
| `port is already allocated` | Cổng 3000 bị chiếm | Đổi `APP_PORT` trong `.env` rồi `docker compose up -d` |
| Container app restart liên tục | Migration lỗi | `docker compose logs app` — **dừng lại**, đối chiếu SQL trước khi đi tiếp |

Xem toàn bộ log:

```bash
docker compose logs -f --tail=100
```

---

## Sao lưu (làm ngay sau khi chạy ổn)

```bash
cd ~/amis-hrm-erp

# Database
docker compose exec -T postgres pg_dump -Fc -U amis amis_hrm > ~/backup_$(date +%F).dump

# Khoá mã hoá — MẤT CÁI NÀY LÀ MẤT DỮ LIỆU SINH TRẮC + STK NGÂN HÀNG VĨNH VIỄN
grep '^DATA_ENCRYPTION_KEY=' .env > ~/encryption-key.txt
chmod 600 ~/encryption-key.txt
```

**Copy cả hai file ra khỏi VPS.** Khoá mã hoá không nằm trong database, mất
file `.env` là không thể giải mã lại dữ liệu đã lưu.

---

## Gỡ cài đặt

```bash
cd ~/amis-hrm-erp
docker compose down          # dừng, GIỮ dữ liệu
docker compose down -v       # dừng và XOÁ SẠCH volume (mất toàn bộ dữ liệu)
```
