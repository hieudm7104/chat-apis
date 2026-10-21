# AGENTS.md

Hướng dẫn cho người và AI agent làm việc trong repo này.

## Cấu trúc

```
whatsapp-api/   Baileys (fork) + bot/ (service REST cho WhatsApp). Hướng dẫn riêng: whatsapp-api/AGENTS.md
zalo-api/       Service REST cho Zalo cá nhân (zca-js)
.github/        CI, chạy với working-directory whatsapp-api
```

Làm việc trong thư mục nào thì đọc AGENTS.md của thư mục đó trước; quy tắc ở `whatsapp-api/AGENTS.md` (Yarn 4, tab, nháy đơn, không dấu chấm phẩy, không `any`) là chuẩn style cho cả repo.

## Hợp đồng API chung

Mọi service phải có cùng bề mặt API để client chat bot dùng thay thế nhau được. Khác biệt riêng của từng app (ví dụ Communities của WhatsApp) thêm ở endpoint riêng, không đổi endpoint chung.

## Bí mật

Không commit `.env`, thư mục `auth`, `data`, cookie hay IMEI của Zalo. Phiên đăng nhập tương đương mật khẩu tài khoản.
