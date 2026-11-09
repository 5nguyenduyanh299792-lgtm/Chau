# Sổ Tiền Trọ

Web app ghi chép chi phí phòng trọ hằng tháng: tiền trọ, điện, nước và các khoản khác.
Chỉ có **1 file `index.html`** (HTML + CSS + JavaScript thuần), không cần backend. Dữ liệu lưu trong `localStorage` của trình duyệt.

## Cách dùng

- Mở trực tiếp file `index.html` bằng trình duyệt (Chrome, Safari, Edge…), hoặc
- Bật **GitHub Pages** cho repo (Settings → Pages → Deploy from branch) để dùng trên điện thoại qua đường link.
  Trên điện thoại có thể chọn "Thêm vào màn hình chính" để mở như một ứng dụng.

> Dữ liệu chỉ nằm trên trình duyệt đang dùng. Muốn chuyển sang máy khác: **Lịch sử → Xuất JSON**, rồi ở máy mới chọn **Nhập từ file JSON**.

## Tính năng

**Nhập chi phí**
- Chọn tháng/năm (có nút chuyển nhanh tháng trước/sau)
- Tiền trọ, tiền điện, tiền nước; tiền trọ tự điền theo tháng trước
- Tính điện/nước **theo chỉ số công tơ** (số cũ, số mới × đơn giá); số cũ và đơn giá tự lấy từ tháng trước
- Khoản khác tuỳ ý (wifi, rác, gửi xe…), có nút thêm nhanh và "Lấy từ tháng trước"
- Ghi chú, số người ở chung (tự chia tiền mỗi người)
- Trạng thái Chưa đóng / Đã đóng kèm ngày đóng
- Tổng cộng tự cập nhật khi gõ; không cho lưu nếu số tiền để trống hoặc âm
- Sửa, xoá bản ghi đã lưu; chia sẻ/sao chép bản tóm tắt để gửi Zalo, Messenger

**Tổng quan**
- Thẻ tháng hiện tại: tổng tiền, chi tiết từng khoản, trạng thái, nhắc hạn đóng tiền
- So sánh với tháng trước (tổng và từng khoản, số kWh)
- Biểu đồ cột 12 tháng chia màu trọ/điện/nước/khác (bấm cột để xem chi tiết, có dạng bảng)
- Tổng chi cả năm, trung bình mỗi tháng, tháng cao/thấp nhất, số tiền còn chưa đóng

**Lịch năm**: đủ 12 tháng, đánh dấu hôm nay, ngày đóng tiền và hạn đóng; chấm xanh = đã đóng, đỏ = chưa đóng, xám = chưa nhập. Bấm vào tháng để mở.

**Máy tính bỏ túi**: nút nổi ở mọi trang (phím tắt `Alt + M`), + − × ÷ %, xoá, xoá lùi, lịch sử phép tính, gõ được bằng bàn phím, nút "Dùng kết quả" để chèn vào ô đang nhập.

**Lịch sử & dữ liệu**: danh sách các tháng, lọc theo năm và trạng thái; xuất CSV (mở bằng Excel) và JSON; nhập lại từ JSON (gộp hoặc thay thế); xoá toàn bộ dữ liệu có hộp xác nhận.

**Giao diện**: tiếng Việt, ưu tiên điện thoại, đẹp trên máy tính (thanh điều hướng chuyển sang cột bên trái), chế độ Sáng / Tối / Tự động, tiền định dạng kiểu Việt Nam `1.250.000 đ`.

## Chạy bằng Node / Google AI Studio

Repo có sẵn `package.json` (Vite) để chạy trên các nền tảng cần dev server như Google AI Studio:

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # xuất ra thư mục dist/
```
