# Sổ Tiền Trọ

Web app ghi chép chi phí phòng trọ hằng tháng: tiền trọ, điện, nước và các khoản khác.
Giao diện tiếng Việt, ưu tiên điện thoại. Dữ liệu lưu trên trình duyệt (`localStorage`) và có thể đồng bộ lên Firestore khi đăng nhập Google.

## Cấu trúc

- `index.html` — giao diện (HTML + CSS)
- `src/main.js` — toàn bộ logic của app
- `src/sync.js`, `src/firebase.js` — đồng bộ Firestore và đăng nhập Google
- `src/server/ai.js` — gọi Gemini để phân tích chi phí khi dùng "AI điền" (cần `GEMINI_API_KEY`)
- `firestore.rules` — luật bảo mật Firestore: mỗi người chỉ đọc/ghi dữ liệu của mình

## Tính năng

**Nhập chi phí**: chọn tháng/năm; tiền trọ (tự điền theo tháng trước), tiền điện, tiền nước; khoản khác tuỳ ý (tên + số tiền); ghi chú; trạng thái Chưa đóng / Đã đóng kèm ngày đóng; tổng tự cộng khi nhập; sửa và xoá được; không cho lưu khi số tiền để trống hoặc âm. Có ô **AI điền** để gõ hoặc nói chi phí.

**Tổng quan**: thẻ tháng hiện tại (tổng tiền, chi tiết từng khoản, trạng thái), so sánh với tháng trước, biểu đồ cột 12 tháng chia màu trọ/điện/nước/khác, tổng chi cả năm và trung bình mỗi tháng.

**Lịch năm**: đủ 12 tháng, có nút chuyển năm, đánh dấu hôm nay; chấm xanh = đã đóng, đỏ = chưa đóng, xám = chưa nhập; bấm vào tháng để mở.

**Máy tính bỏ túi**: nút nổi ở mọi trang, + − × ÷ %, xoá, xoá lùi, lịch sử phép tính, gõ được bằng bàn phím, nút "Dùng kết quả" để chèn vào ô đang nhập.

**Lịch sử & dữ liệu**: danh sách các tháng, lọc theo năm; xuất CSV (mở bằng Excel), JSON và báo cáo PDF; nhập lại từ JSON; xoá toàn bộ dữ liệu có hộp xác nhận.

**Giao diện**: chế độ sáng/tối, tiền định dạng `1.250.000 đ`, thanh điều hướng dưới cùng (chuyển thành cột bên trái trên máy tính).

## Chạy

```bash
npm install
npm run dev     # http://localhost:3000
```
