# chat-apis

Bộ REST API không chính thức cho các app chat và mạng xã hội, dùng tài khoản cá nhân đăng nhập như một thiết bị liên kết. Mỗi app là một service độc lập, cùng kiểu: Fastify + SQLite + Docker, xác thực bằng `x-api-key`, đẩy sự kiện realtime qua webhook và WebSocket.

| Thư mục | App | Thư viện nền |
|---|---|---|
| [`whatsapp-api/`](whatsapp-api) | WhatsApp | Baileys (fork trong thư mục này), service ở `whatsapp-api/bot` |
| [`zalo-api/`](zalo-api) | Zalo (tài khoản cá nhân) | zca-js |

Cả hai đều là tích hợp không chính thức. Dùng tài khoản cá nhân có thể dẫn đến việc tài khoản bị khóa hoặc cấm; dùng số phụ và không gửi hàng loạt.

Quy ước chung xem [AGENTS.md](AGENTS.md).
