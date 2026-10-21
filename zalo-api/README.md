# zalo-api

Server Node (Fastify + [zca-js](https://github.com/RFS-ADRENO/zca-js) + SQLite) đăng nhập một **tài khoản Zalo cá nhân** bằng QR, lưu tin nhắn/nhóm/bạn bè/file vào `DATA_DIR`, mở REST API để đọc và gửi, và đẩy sự kiện realtime qua webhook và WebSocket.

Đây là tích hợp không chính thức (giả lập Zalo Web). Tài khoản có thể bị khóa hoặc cấm: dùng số phụ, không gửi hàng loạt. Chỉ một phiên Zalo Web được giữ kết nối realtime cho mỗi tài khoản; mở chat.zalo.me trên trình duyệt sẽ làm service bị ngắt (nó tự nối lại sau 60 giây).

## Chạy
```
cp .env.example .env      # đổi API_KEY (openssl rand -hex 24)
docker compose up -d --build
docker compose logs -f zalo
```
Chạy không Docker: `npm install && npm run dev` (Node 22+).

## Đăng nhập (làm 1 lần)
Mở `http://localhost:3001/qr?key=<API_KEY>`, rồi trên điện thoại: Zalo → biểu tượng QR → quét mã, và bấm xác nhận. Phiên lưu ở `DATA_DIR/auth/credentials.json` (quyền 0600, tương đương mật khẩu tài khoản, đừng chia sẻ). Mất volume = phải quét lại. `POST /logout` xoá phiên, `POST /login` sinh QR mới.

## ID
- `uid` của một người là **một số duy nhất**: cùng giá trị làm `chat_id` của chat 1:1, `sender_id` trong tin nhóm và `id` thành viên trong `/groups/:id`.
- `chat_id` của nhóm là `groupId`, tách biệt với `uid`.
- Mọi `id` là chuỗi số, giữ nguyên dạng chuỗi (số lớn hơn giới hạn của JSON number).

## API (header `x-api-key: <API_KEY>`, hoặc `Authorization: Bearer`, hoặc `?key=`)
| Endpoint | Mô tả |
|---|---|
| GET /health | không cần key |
| GET /status, /me, /qr | trạng thái (`state`: qr, scanned, open, reconnecting…), tài khoản, trang QR |
| POST /login, /logout | sinh QR mới, xoá phiên |
| GET /users/:id?refresh=1 | tên, avatar, số điện thoại (nếu có) từ `uid` |
| GET /users?ids=a,b,c | nhiều người một lần |
| GET /users/search?phone= hoặc ?username= | tìm người chưa kết bạn |
| GET /chats | danh sách chat (1:1 và nhóm) kèm tên |
| GET /chats/:id/messages?limit&before&after&sender&kind&q | tin đã lưu |
| POST /chats/:id/fetch-history `{count}` | nhóm: lấy thêm tin cũ; 1:1: xin qua sự kiện |
| GET /messages/:chat/:id?raw=1 | một tin (kèm JSON gốc) |
| GET /messages/:chat/:id/media | tải file/ảnh/video/voice về (tự tải nếu chưa có) |
| POST /messages/send `{chat_id,text,chat_type?,quote_id?,mentions?}` | gửi text; `mentions: [{uid,pos,len}]` |
| POST /messages/send-file | multipart (`chat_id`, `text`, `file`…) hoặc JSON `{chat_id,text,files:[{url\|base64,filename}]}` |
| GET /groups, /groups/:id?refresh=1 | nhóm và thành viên (`id`, `role`, `display_name`) |
| POST /groups/refresh | đồng bộ lại toàn bộ nhóm |
| GET /friends?refresh=1&q= | danh sách bạn |
| GET /friends/requests?status=pending&direction= | lời mời bắt được qua realtime |
| GET /friends/sent | lời mời đã gửi (từ Zalo) |
| POST /friends/request `{user_id,message}` | gửi lời mời |
| POST /friends/:id/accept, /reject | chấp nhận, từ chối lời mời đến |
| DELETE /friends/request/:id, /friends/:id | huỷ lời mời đã gửi, xoá bạn |
| GET /friends/:id/status | quan hệ với một người |
| GET /events?after_id&limit | nhật ký sự kiện (để nhận bù khi mất kết nối) |
| POST/GET/DELETE /webhooks | đăng ký webhook `{url,secret?,events?}` |
| GET /ws?after_id&types= | WebSocket realtime |

## Sự kiện realtime
Dạng `{id, type, ts, data}`. Webhook gửi POST JSON, có header `x-signature: sha256=<hmac>` nếu đặt `secret`, thử lại 4 lần.

| `type` | Khi nào |
|---|---|
| `message` | tin mới (`data` giống phần tử của `/chats/:id/messages`; `from_me` cho tin bạn gửi từ máy khác) |
| `file_received` | tin có file/ảnh/video/voice (`downloaded`, `download_path`) |
| `message_deleted` | thu hồi tin |
| `friend_request` | có lời mời kết bạn mới (`direction: incoming`, `user`, `message`) |
| `friend_event` | `added`, `removed`, `canceled`, `rejected`… |
| `group_event` | `join`, `leave`, `remove_member`, `add_admin`, `join_request`… |
| `reaction` | thả cảm xúc |
| `connection` | `open`, `logged_out` |

## Lưu ý
- Zalo không có API liệt kê lời mời kết bạn đã nhận. `/friends/requests` chỉ có những lời mời đến lúc service đang chạy; lời mời đến lúc offline không thấy được.
- Lịch sử chat 1:1 chỉ có từ lúc đăng nhập và tin nhận được sau đó; nhóm có thể lấy thêm bằng `fetch-history`.
- API_KEY nằm trong query ở `/qr?key=` và `/ws?key=`: chỉ dùng trên localhost hoặc sau HTTPS.
- Cổng chỉ bind `127.0.0.1`; muốn public hãy đặt reverse proxy có HTTPS.
