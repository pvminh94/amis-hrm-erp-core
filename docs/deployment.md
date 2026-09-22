# Hướng dẫn triển khai production — AMIS HRM & ERP Core

Tài liệu này viết cho người vận hành thật, không phải bản demo. Đọc hết phần
**[Những gì CHƯA được kiểm chứng](#những-gì-chưa-được-kiểm-chứng)** trước khi
đưa lên môi trường có dữ liệu thật.

---

## 1. Yêu cầu hạ tầng

| Thành phần | Tối thiểu | Khuyến nghị (500–2.000 NV) | Ghi chú |
|---|---|---|---|
| CPU | 2 vCPU | 4 vCPU | Node single-thread; worker chạy tiến trình riêng |
| RAM | 2 GB | 8 GB | Postgres cần `shared_buffers` ≈ 25% RAM |
| Disk | 40 GB SSD | 200 GB SSD | Bảng `RawPunch` phình nhanh nhất — xem mục 8 |
| PostgreSQL | 14 | **16** | Bắt buộc (dùng `uuid-ossp`, `pgcrypto`) |
| Redis | 6 | **7** | BullMQ + rate limit |
| Node.js | 20.x | 20.x LTS | Không dùng 18 — Prisma 5 + `node:` prefix |

**Không chạy API và worker chung một tiến trình.** Job tính lương cho 2.000
nhân viên chiếm CPU vài chục giây; nếu chạy chung, toàn bộ request chấm công
trong khoảng đó sẽ timeout.

---

## 2. Triển khai bằng Docker Compose (nhanh nhất)

### 2.0 Một lệnh trên VPS Ubuntu

Nếu chỉ muốn dựng nhanh trên VPS Ubuntu (đã có Docker hoặc cho script tự cài):

```bash
# Repo private => phải truyền token khi clone
GITHUB_TOKEN=ghp_xxxxx bash scripts/deploy-vps.sh

# Kèm dữ liệu mẫu:
GITHUB_TOKEN=ghp_xxxxx WITH_SEED=true bash scripts/deploy-vps.sh
```

Script idempotent (chạy lại không phá dữ liệu), tự sinh JWT secret / khoá mã
hoá / mật khẩu Postgres-Redis bằng `openssl`, chờ health check, rồi in ra các
việc còn phải làm trước khi mở ra Internet. Đã lint bằng shellcheck 0.10.

Chạy từ máy local qua SSH (cần `sshpass`):

```bash
sshpass -p '<pass>' ssh -o StrictHostKeyChecking=no bvqy4@<IP-VPS> \
  'GITHUB_TOKEN=ghp_xxxxx bash -s' < scripts/deploy-vps.sh
```

> Nếu VPS chỉ có IP Tailscale (`100.x.x.x`), máy chạy lệnh phải nằm trong
> tailnet đó.

### 2.1 Chuẩn bị


```bash
git clone <repo> && cd amis-hrm-erp
cp .env.example .env
```

### 2.2 Bắt buộc đổi các giá trị sau trong `.env`

```bash
# Sinh secret thật — KHÔNG dùng giá trị mẫu
openssl rand -base64 48   # → JWT_ACCESS_SECRET
openssl rand -base64 48   # → JWT_REFRESH_SECRET
openssl rand -hex 32      # → DATA_ENCRYPTION_KEY (64 ký tự hex)

# Mật khẩu hạ tầng
POSTGRES_PASSWORD=<mật khẩu mạnh>
REDIS_PASSWORD=<mật khẩu mạnh>

# Chạy production
NODE_ENV=production
REFRESH_COOKIE_SECURE=true          # BẮT BUỘC khi có HTTPS
CORS_ORIGINS=https://hrm.congty.vn  # Liệt kê rõ, KHÔNG dùng *
DEVICE_PUSH_TOKEN=<token riêng cho thiết bị>
```

> ⚠️ **`DATA_ENCRYPTION_KEY` không được đổi sau khi đã có dữ liệu.** Toàn bộ
> vector khuôn mặt 512-D, số CCCD và số tài khoản ngân hàng được mã hoá AES-256-GCM
> bằng khoá này. Mất khoá = mất vĩnh viễn dữ liệu đó, không có cách khôi phục.
> Lưu vào vault/secret manager và sao lưu ngoại tuyến **trước khi** seed dữ liệu thật.

### 2.3 Khởi động

```bash
docker compose up -d --build

# Kiểm tra
docker compose ps                     # cả 4 service phải healthy
curl -s http://localhost:3000/health  # {"status":"ok",...}
docker compose logs -f app            # migration chạy ở đây
```

Container `app` tự chạy `prisma migrate deploy` trước khi start, nên schema
luôn khớp với code.

### 2.4 Nạp dữ liệu mẫu (chỉ cho môi trường test)

```bash
docker compose exec app npx tsx prisma/seed.ts
# hoặc từ máy host nếu đã cài Node:
npm run db:seed
```

Seed sinh ra: 36 nhân sự · 30 ngày lịch phân ca · ~3.500 quẹt thẻ thô ·
bảng lương tính thật bằng engine · 7 đơn từ ở đủ trạng thái · đơn hàng bán.
Mật khẩu mặc định của mọi tài khoản: `Amis@123456` → **đổi ngay sau lần đăng nhập đầu**.

Seed dùng PRNG có seed cố định nên chạy bao nhiêu lần cũng ra đúng một bộ dữ
liệu — thuận tiện đối soát.

---

## 3. Triển khai không dùng Docker

```bash
# 1. Cài đặt
npm ci --omit=dev
npx prisma generate
npm run build                    # → dist/src/main.js

# 2. Migration
npx prisma migrate deploy        # CHỈ deploy, không dùng `db push` ở production

# 3. Chạy — HAI tiến trình riêng
NODE_ENV=production node dist/src/main.js &                    # API
NODE_ENV=production node dist/src/application/workers/worker.js &   # Worker
```

Dùng systemd hoặc pm2 để quản lý hai tiến trình. Với pm2:

```bash
pm2 start dist/src/main.js --name amis-api -i 2
pm2 start dist/src/application/workers/worker.js --name amis-worker -i 1
pm2 save && pm2 startup
```

**Không scale worker bằng cluster mode (`-i N`).** BullMQ đã tự phân phối job
giữa các worker; chạy thêm cluster sẽ tạo ra tiến trình trùng lặp và nhân đôi
kết nối Redis. Muốn tăng công suất worker thì tăng số container/instance.

---

## 4. Cấu hình reverse proxy (Nginx)

Bắt buộc: TLS, và phải truyền đúng header để app lấy được IP thật (dùng cho
rate limit + audit trail đơn từ).

```nginx
server {
    listen 443 ssl http2;
    server_name hrm.congty.vn;

    ssl_certificate     /etc/letsencrypt/live/hrm.congty.vn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hrm.congty.vn/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 25m;   # ảnh khuôn mặt từ thiết bị + import Excel

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;   # job xuất file UNC có thể lâu
    }
}

# Webhook thiết bị: CHỈ mở cho IP nội bộ của máy chấm công
server {
    listen 8443 ssl;
    server_name hrm.congty.vn;
    # allow 192.168.1.0/24; deny all;   # <-- bật dòng này ở production

    location /api/v1/attendance/devices/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_request_buffering off;   # Hikvision đẩy multipart stream
    }
}
```

App đã đặt `trust proxy = 1`, nên nó sẽ đọc `X-Forwarded-For` do Nginx gửi.
**Không bật `trust proxy = true`** (tin mọi hop) khi app đứng sau nhiều lớp
proxy — kẻ gọi có thể giả IP để vượt rate limit.

---

## 5. Kết nối thiết bị chấm công

### 5.1 Ronald Jack / ZKTeco (giao thức ADMS / Push SDK)

Trên máy chấm công, vào **Comm. → Cloud Server Setting**:

| Trường | Giá trị |
|---|---|
| Server Address | `hrm.congty.vn` (hoặc IP nội bộ) |
| Server Port | `8443` |
| Domain Name / URL | `/api/v1/attendance/devices/adms` |
| Enable Proxy | Bật |
| HTTPS | Bật nếu có cert hợp lệ |

Sau đó máy sẽ tự đăng ký kèm `?sn=<serial>`. **Serial này phải được khai
trước** trong bảng `Device` (cột `serialNumber`), nếu không app trả 403.

```sql
INSERT INTO "Device" (id, code, name, protocol, "serialNumber", "pushToken", "isActive")
VALUES (gen_random_uuid(), 'DEV_RJ_SX', 'Máy xưởng SX', 'ronald_jack',
        'RJ-W600-002', '<DEVICE_PUSH_TOKEN>', true);
```

### 5.2 Hikvision FaceID (ISAPI HTTP Listening)

Gọi ISAPI của thiết bị để cấu hình nó đẩy sự kiện về server:

```bash
# Lấy digest challenge
curl -i -u admin:MatKhauMay http://192.168.1.64/ISAPI/Event/notification/httpHosts

# PUT XML cấu hình (app tự sinh XML này qua buildHttpListeningXml)
curl -X PUT -u admin:MatKhauMay \
  -H "Content-Type: application/xml" \
  --data @httphosts.xml \
  http://192.168.1.64/ISAPI/Event/notification/httpHosts
```

Nội dung `httphosts.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<HttpHostNotificationList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
  <HttpHostNotification>
    <id>1</id>
    <url>/api/v1/attendance/devices/hikvision</url>
    <protocolType>HTTPS</protocolType>
    <parameterFormatType>XML</parameterFormatType>
    <addressingFormatType>ipaddress</addressingFormatType>
    <ipAddress>hrm.congty.vn</ipAddress>
    <portNo>8443</portNo>
    <httpAuthenticationMethod>none</httpAuthenticationMethod>
  </HttpHostNotification>
</HttpHostNotificationList>
```

Thiết bị Hikvision định danh bằng **MAC address**, nên cột `serialNumber`
trong bảng `Device` phải chứa MAC của máy (dạng `aa:bb:cc:dd:ee:ff`).

### 5.3 Chống gian lận — ba lớp, đều phải bật

1. **Geofencing**: `latitude`/`longitude`/`geofenceRadiusM` trên `OrgUnit`.
   Quẹt ngoài bán kính bị từ chối cứng (`OUTSIDE_HARD_RADIUS`).
2. **Đối soát WiFi BSSID**: bật `GEO_WIFI_BSSID_REQUIRED=true` và khai
   `wifiBssids` trên `OrgUnit`. iOS **không** cho app đọc BSSID — nếu có
   người dùng iPhone, để `false` và chấp nhận chỉ cảnh báo.
3. **Liveness**: ngưỡng `LIVENESS_MIN_CONFIDENCE=0.62`. Chặn được ảnh in 2D
   và phát lại màn hình (phân tích phổ FFT tìm vân moiré + độ sắc chi tiết).

---

## 6. Vận hành hàng tháng

### 6.1 Quy trình chốt lương

```
DRAFT ──lock──> LOCKED ──approve──> APPROVED ──pay──> PAID
```

| Bước | Ai làm | API | Hệ quả |
|---|---|---|---|
| Tính lương | HR | `POST /pay-runs/:id/calculate` | Chỉ chạy được khi DRAFT |
| Khoá | HR Head | `POST /pay-runs/:id/lock` | Không sửa được nữa |
| Duyệt | Kế toán trưởng | `POST /pay-runs/:id/approve` | **Tự động** đẩy job `post-gl-journal` → sinh bút toán kép |
| Chi | Kế toán | `POST /pay-runs/:id/pay` | Đẩy job xuất file UNC + gửi phiếu lương |

Trước khi bấm **approve**, soát bút toán bằng
`GET /pay-runs/:id/journal-preview` — endpoint này **không ghi** gì vào DB,
chỉ tính trước để kế toán kiểm tra tổng Nợ = tổng Có.

### 6.2 Lịch tự động (cron trong worker)

| Giờ | Việc |
|---|---|
| 06:30 mỗi ngày (Asia/Ho_Chi_Minh) | Chốt công ca đêm hôm trước — bắt những ca chưa có lượt quẹt ra |
| 23:00 ngày mùng 1 | Tính thuế luỹ tiến hàng loạt cho kỳ trước |

Nếu worker chết quá 06:30, ca đêm sẽ **không** được chốt. Kiểm tra bằng:

```sql
SELECT "workDate", count(*) FROM "DailyAttendance"
WHERE "checkOutAt" IS NULL AND "isLocked" = false
GROUP BY 1 ORDER BY 1 DESC LIMIT 7;
```

### 6.3 Giám sát

```bash
# Hàng đợi có bị dồn không
redis-cli -a "$REDIS_PASSWORD" llen bull:sync-raw-punch:wait
redis-cli -a "$REDIS_PASSWORD" llen bull:calc-progressive-tax:failed

# Job thất bại
redis-cli -a "$REDIS_PASSWORD" zcard bull:calc-progressive-tax:failed
```

Cảnh báo nên đặt: `failed > 0` trên bất kỳ hàng đợi nào, và `wait > 1000`
trên `sync-raw-punch` (nghĩa là worker không theo kịp thiết bị đẩy log).

---

## 7. Sao lưu & khôi phục

```bash
# Sao lưu DB (chạy mỗi đêm)
pg_dump -Fc -h localhost -U amis amis_hrm > /backup/amis_$(date +%F).dump

# Sao lưu Redis (hàng đợi — mất thì mất job chưa chạy)
redis-cli -a "$REDIS_PASSWORD" --rdb /backup/redis_$(date +%F).rdb

# Khôi phục
pg_restore -h localhost -U amis -d amis_hrm --clean --if-exists /backup/amis_2026-03-05.dump
```

**Ba thứ phải sao lưu cùng nhau, không thiếu thứ nào:**
1. Database
2. `DATA_ENCRYPTION_KEY`
3. Thư mục file (`/var/amis` — file UNC, ảnh khuôn mặt)

Thiếu (2) thì khôi phục DB cũng vô nghĩa với dữ liệu sinh trắc học.

---

## 8. Bảo trì dung lượng

Bảng `RawPunch` là append-only và lớn nhanh nhất: mỗi nhân viên 2–8 quẹt/ngày
→ 2.000 NV × 5 quẹt × 26 ngày ≈ **260.000 dòng/tháng**.

```sql
-- Lưu quẹt thô 24 tháng, cũ hơn thì đưa sang kho lạnh
CREATE TABLE IF NOT EXISTS "RawPunch_archive" (LIKE "RawPunch" INCLUDING ALL);
INSERT INTO "RawPunch_archive" SELECT * FROM "RawPunch"
  WHERE "punchAt" < now() - interval '24 months';
DELETE FROM "RawPunch" WHERE "punchAt" < now() - interval '24 months';
```

Đừng xoá `DailyAttendance` — đó là căn cứ pháp lý khi có tranh chấp lao động.

---

## 9. Những gì CHƯA được kiểm chứng

Nói thẳng để không ai bị bất ngờ:

| Hạng mục | Trạng thái | Lý do |
|---|---|---|
| **300 test tự động** | ✅ Đã chạy, pass toàn bộ | Domain logic, parser thiết bị, HTTP integration |
| `tsc --noEmit` | ✅ 0 lỗi | |
| `npm run build` | ✅ Thành công | `dist/src/main.js` sinh ra đúng |
| Server khởi động + trả lời HTTP | ✅ Đã kiểm bằng curl thật | `/health` 200, helmet/CORS/401/404/429 đúng |
| SQL migration | ✅ Đã sinh bằng `prisma migrate diff` (1.284 dòng, 37 bảng, 69 index, 37 FK) | **Chưa chạy trên PostgreSQL thật** |
| `prisma migrate deploy` | ⚠️ **Chưa chạy** | Sandbox không có PostgreSQL |
| `docker compose up` | ⚠️ **Chưa chạy** | Sandbox không có Docker |
| `npm run db:seed` | ⚠️ **Chưa chạy** | Cần DB thật |
| Kết nối thiết bị thật | ⚠️ **Chưa kiểm** | Cần máy Ronald Jack/Hikvision vật lý |
| Gửi email phiếu lương | ⚠️ **Chưa kiểm** | Cần SMTP thật |

**Việc đầu tiên phải làm trên môi trường thật**, theo đúng thứ tự:

```bash
docker compose up -d postgres redis
docker compose exec app npx prisma migrate deploy   # ← xác nhận migration chạy được
docker compose exec app npx tsx prisma/seed.ts      # ← xác nhận schema + engine khớp nhau
docker compose up -d app worker
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"Amis@123456"}'   # ← phải trả về accessToken
```

Nếu bước `migrate deploy` báo lỗi, **dừng lại** và đối chiếu
`prisma/migrations/20260305000000_init/migration.sql` với schema trước khi đi tiếp.

---

## 10. Thông số pháp lý — cần rà soát định kỳ

Toàn bộ tham số thuế/BHXH **không hardcode** trong logic mà nằm ở
`src/config/tax-regime.ts` và `src/config/insurance.ts`, có ngày hiệu lực.
Mỗi kỳ lương, `PayRun.policySnapshot` **đóng băng** bộ tham số đã dùng — sửa
file config sau này sẽ không làm sai các kỳ đã chốt.

| Tham số | Giá trị hiện tại | Căn cứ |
|---|---|---|
| Mức tham chiếu (lương cơ sở) | 2.340.000 → **2.530.000** từ 01/07/2026 | NĐ 161/2026/NĐ-CP |
| Trần BHXH/BHYT | 20 × mức tham chiếu = **50.600.000** | Điều 31 Luật BHXH 2024 |
| Trần BHTN | 20 × lương tối thiểu vùng (I: 106,2tr) | NĐ 293/2025/NĐ-CP |
| BHXH NLĐ / NSDLĐ | 10,5% / 21,5% (+0,5% BHTNLĐ) | Luật BHXH 2024 |
| Giảm trừ gia cảnh | **15,5tr** bản thân / **6,2tr** mỗi người phụ thuộc, từ 01/01/2026 | NQ 110/2025/UBTVQH15 |
| Biểu thuế TNCN | 5 bậc (10/30/60/100tr) | Luật 109/2025/QH15 |

> ⚠️ **Ngày hiệu lực của biểu thuế 5 bậc đang có hai cách đọc**: 01/01/2026
> hay 01/07/2026. Hệ thống xử lý bằng cách cung cấp **cả ba** chế độ
> (`LEGACY_7B` 7 bậc, `BRIDGE_2026H1`, `VN_2026_5B`) và chọn theo ngày của kỳ
> lương; có thể ép cứng bằng `PAYROLL_TAX_REGIME`. **Hãy hỏi cơ quan thuế địa
> phương và chốt lại trước kỳ lương đầu tiên.** Giảm trừ gia cảnh 15,5/6,2 triệu
> thì rõ ràng là 01/01/2026, không có tranh cãi.

---

## 11. Xử lý sự cố thường gặp

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| Thiết bị đẩy log nhưng không thấy công | `serialNumber` chưa khai trong bảng `Device` | App trả 403 — xem `docker compose logs app` |
| Thiết bị retry liên tục | Webhook trả 5xx | Body rác giờ trả 400/403 thay vì 500; nếu vẫn 500 thì xem log Prisma |
| Ca đêm không được chốt | Worker chết lúc 06:30 | Chạy tay job `close-night-shift` với `workDate` cần chốt |
| Đăng nhập báo "Origin không nằm trong danh sách" | `CORS_ORIGINS` thiếu domain | Thêm domain, **không** dùng `*` |
| `Can't reach database server` | Postgres chưa sẵn sàng | `docker compose ps` — chờ healthy rồi mới start app |
| Redis `OOM command not allowed` | Hàng đợi đầy (`noeviction`) | **Cố ý**: thà báo lỗi còn hơn âm thầm xoá job lương. Xử lý worker trước, đừng tăng maxmemory |
| PIT kỳ cũ bị tính lại khác | Đổi `PAYROLL_TAX_REGIME` | Không được — mỗi kỳ đã đóng băng `policySnapshot` |
