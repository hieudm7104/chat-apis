# whatsapp-bot

Server Node (Fastify + Baileys + SQLite) đăng nhập một account WhatsApp như "thiết bị liên kết",
lưu mọi tin nhắn/group/contact/media vào `DATA_DIR` và mở REST API để đọc.

## Chạy
```
cp .env.example .env      # đổi API_KEY
docker compose up -d --build
docker compose logs -f bot
```

## Đăng nhập account bot (làm 1 lần)
Cách 1 — QR: mở `http://localhost:3000/qr?key=<API_KEY>` rồi trên điện thoại:
WhatsApp → Thiết bị đã liên kết → Liên kết thiết bị → quét.

Cách 2 — mã 8 ký tự:
```
curl -X POST localhost:3000/pairing-code -H 'x-api-key: <API_KEY>' \
     -H 'content-type: application/json' -d '{"phone":"84xxxxxxxxx"}'
```
Trên điện thoại: Liên kết thiết bị → Liên kết bằng số điện thoại → nhập mã.

Phiên đăng nhập nằm ở volume `bot-data` (`/data/auth`). Mất volume = phải pair lại. Không chia sẻ thư mục này.

## API (header `x-api-key: <API_KEY>`)
| Endpoint | Mô tả |
|---|---|
| GET /health | không cần key |
| GET /status, /me | trạng thái kết nối, account bot |
| GET /chats | danh sách chat + số tin đã lưu |
| GET /contacts?q= | contact (có `lid`, `phone_number`, `name`, `notify`, `username`) |
| GET /groups, /groups/:jid | group + thành viên (`?refresh=1` lấy mới từ WA) |
| GET /chats/:jid/messages?limit&before&after&sender&q | tin nhắn đã lưu |
| GET /messages/:chat/:id?raw=1 | 1 tin, kèm toàn bộ JSON gốc |
| GET /messages/:chat/:id/media | tải ảnh/video/audio/file (tự tải lại nếu chưa có) |
| GET /profile-picture/:jid | URL ảnh đại diện |
| GET /lid-map | bảng LID ↔ số điện thoại |
| POST /messages/send `{chat_id\|jid,text,quote_id?,mentions?}` | gửi text (trích dẫn, @mention bằng mảng jid) |
| POST /messages/send-file | multipart (`chat_id`, `text`, `voice`, `file`…) hoặc JSON `{chat_id,text,files:[{url\|base64,filename}]}` |
| GET /users/:id?refresh=1 | tên từ jid, lid hoặc số điện thoại; trả cả `lid`, `jid`, `phone_number` |
| GET /users?ids=a,b,c | nhiều người một lần |
| GET /friends | danh bạ của bot (WhatsApp không có lời mời kết bạn; `/friends/requests` luôn rỗng, accept/reject trả 501) |
| GET /communities, /communities/:id | danh sách và chi tiết Community (`group_count`, `announce_group_id`) |
| GET /communities/:id/groups | các group trong Community (nhóm thông báo có `is_announce_group=1`) |
| GET /communities/:id/members | thành viên Community |
| GET /events?after_id&limit | nhật ký sự kiện (nhận bù khi mất kết nối) |
| POST/GET/DELETE /webhooks | đăng ký webhook `{url,secret?,events?}` |
| GET /ws?after_id&types= | WebSocket realtime |
| POST /chats/:jid/fetch-history `{count}` | xin điện thoại gửi thêm tin cũ (điện thoại phải online) |
| POST /logout | gỡ thiết bị |

`jid` ví dụ: `84901234567@s.whatsapp.net`, `1203630xxxxxxxx@g.us`, `xxxx@lid`.

## Sự kiện realtime
Dạng `{id, type, ts, data}`, cùng định dạng với zalo-api. Webhook gửi POST JSON, có header `x-signature: sha256=<hmac>` nếu đặt `secret`, thử lại 4 lần.

| `type` | Khi nào |
|---|---|
| `message` | tin mới (`chat_id`, `sender_id`, `sender_alt`, `sender_name`, `kind`, `text`, `from_me`) |
| `file_received` | tin có ảnh/video/voice/file/sticker (`downloaded`, `download_path`) |
| `message_deleted` | thu hồi tin |
| `group_event` | thành viên vào/ra, đổi quản trị, đổi thông tin group |
| `connection` | `open`, `close`, `logged_out` |

## ID
Mỗi người có hai ID: số điện thoại (`84…@s.whatsapp.net`) và LID (`…@lid`). Group dùng LID hay số tuỳ `addressing_mode`, nên cùng một người có thể hiện bằng ID khác nhau ở chat riêng và trong group. `/users/:id` nhận cả hai dạng và trả `id` chuẩn (LID nếu biết), kèm `lid`, `jid`, `phone_number`; `/lid-map` là bảng đối chiếu.

## Lưu ý
- Lịch sử chỉ có từ lúc pair (history sync của điện thoại) + tin nhận được sau đó.
- `SYNC_FULL_HISTORY=true` hiện KHÔNG dùng được với baileys@7.0.0-rc14 (WhatsApp trả 428), xem `.env.example`.
- API_KEY nằm trong query ở `/qr?key=` — chỉ dùng trên localhost hoặc sau HTTPS.
- Cổng chỉ bind `127.0.0.1`; muốn public hãy đặt reverse proxy có HTTPS.
