# Image Text Selector - Tiện ích Bôi Đen & Copy Chữ Trên Ảnh (Chrome / Edge)

Tiện ích mở rộng (Browser Extension) chuẩn **Manifest V3** cho cả **Google Chrome** và **Microsoft Edge**, cho phép người dùng bôi đen chữ trực tiếp trên ảnh web và nhấn `Ctrl + C` / `Ctrl + V` như văn bản thông thường.

---

## 📁 Cấu Trúc Thư Mục Dự Án

```
image-text-select-extension/
├── manifest.json              # Manifest V3 (v1.2.0)
├── background.js              # Service Worker: menu chuột phải, phím tắt, chụp màn hình, điều phối OCR
├── content.js                 # Chạy trên web: nút hover, lớp chữ bôi đen, chọn vùng, bảng kết quả
├── styles.css
├── offscreen/                 # Trang ẩn chạy Tesseract OCR (Web Worker hoạt động ổn định, không bị CSP của web chặn)
├── libs/                      # Tesseract.js v7 + worker + core WASM + dữ liệu tiếng Việt/Anh (chạy OFFLINE)
├── popup/                     # Cài đặt: ngôn ngữ, nút hover, tự động copy, nút chọn vùng
└── icons/, test.html, sample-quote.png
```

## ⚡ Nâng cấp v1.2.0 – Tốc độ

Đo trên Chrome thật (ảnh 1600×900, engine đã khởi động sẵn): **~0,85 giây** ở chế độ Nhanh, ~1,75 giây ở chế độ Chính xác. Bản 1.1.0 bị treo ở bước "Đang khởi tạo".

- **Sửa lỗi treo:** thêm `'wasm-unsafe-eval'` vào CSP của extension (Manifest V3 mặc định chặn WebAssembly).
- **Tesseract.js v7** (có bản relaxed-SIMD) + bộ dữ liệu **"fast"** cho tiếng Việt/Anh; có thể đổi sang "Chính xác hơn" trong popup.
- **Khởi động sẵn engine** khi rê chuột vào ảnh; worker được giữ 5 phút giữa các lần quét.
- **Nạp ảnh dạng PGM** thay cho `canvas.toBlob()` (bị trình duyệt trì hoãn ~1 giây trong trang ẩn).
- **Lượt quét phụ trên ảnh thu nhỏ** để bắt tiêu đề cỡ chữ rất lớn.
- **Nhớ kết quả** theo từng ảnh: mở lại là có ngay.
- **Ctrl+C luôn có dấu cách và xuống dòng** đúng theo từng dòng chữ.

## ✨ Nâng cấp v1.1.0

- **Sửa lỗi cốt lõi:** trước đây Tesseract chạy trong content script và tải worker/ngôn ngữ từ CDN nên bị trình duyệt chặn. Nay OCR chạy trong offscreen document, toàn bộ engine + tiếng Việt/Anh đóng gói sẵn → **dùng offline, nhanh hơn, riêng tư hơn**.
- **Quét theo vùng chọn (Alt+Shift+O / menu chuột phải / popup):** lấy chữ từ ảnh nền, canvas, video, ảnh chụp... và sửa lại ngay trong bảng kết quả.
- **Giữ xuống dòng khi copy:** chữ được nhóm theo từng dòng; vùng bôi đen co giãn khít với chữ gốc.
- **Overlay co giãn đúng** khi đổi kích thước/cuộn, không rò rỉ listener, không chặn click vào ảnh/liên kết.
- **Tiền xử lý ảnh:** phóng to ảnh nhỏ, lọc từ độ tin cậy thấp.
- **Hỗ trợ ảnh `blob:`/`data:`**, thêm 6 ngôn ngữ (Trung phồn thể, Pháp, Đức, Tây Ban Nha, Nga, Thái – tải lần đầu từ mạng).
- **Cài đặt mới:** bật/tắt nút hover, tự động copy sau khi quét; hiển thị tiến độ chi tiết.
- Giảm quyền: bỏ `scripting`.

---

## 🚀 Hướng Dẫn Cài Đặt (Chỉ mất 30 giây)

### Dành cho Google Chrome:
1. Mở trình duyệt Chrome và truy cập: `chrome://extensions/`
2. Bật công tắc **"Chế độ dành cho nhà phát triển" (Developer mode)** ở góc trên bên phải.
3. Bấm vào nút **"Tải tiện ích đã giải nén" (Load unpacked)** ở góc trên bên trái.
4. Chọn thư mục: `thư mục image-text-select-extension`.

### Dành cho Microsoft Edge:
1. Mở Microsoft Edge và truy cập: `edge://extensions/`
2. Bật công tắc **"Chế độ dành cho nhà phát triển" (Developer mode)** ở menu bên trái.
3. Bấm nút **"Tải phần mở rộng chưa được đóng gói" (Load unpacked)**.
4. Chọn thư mục: `thư mục image-text-select-extension`.

---

## 🧪 Cách Thử Nghiệm

1. Mở file `test.html` trực tiếp bằng trình duyệt Chrome hoặc Edge (kéo file `test.html` thả vào trình duyệt).
2. Bạn sẽ thấy 2 cách kích hoạt:
   - **Cách 1**: Rê chuột lên bức ảnh mẫu, bấm vào nút **"📝 Bôi đen chữ"** vừa hiện lên ở góc trên ảnh.
   - **Cách 2**: Bấm chuột phải trực tiếp vào ảnh -> Chọn **"📝 Bôi đen chữ trên ảnh này (OCR)"**.
3. Sau khi nhận diện xong:
   - Dùng chuột quét bôi đen các dòng chữ trên ảnh và nhấn `Ctrl + C`.
   - Nhấp vào ô Textarea bên dưới và bấm `Ctrl + V` để kiểm tra kết quả!
   - Hoặc bấm nút **"📋 Copy toàn bộ"** trên thanh công cụ nổi phía trên ảnh.

---

## ⚙️ Cơ Chế Kỹ Thuật Chính

1. **Vượt qua hạn chế CORS ảnh:**
   - Ảnh trên các trang web khác domain thường gây lỗi `Tainted canvas`. Extension sử dụng `background.js` (với quyền `<all_urls>`) để tải ảnh trực tiếp thành chuỗi `Base64` an toàn trước khi nạp vào bộ nhận diện OCR.
2. **Tính toán co giãn Responsive (Scale Matrix):**
   - Tọa độ Bounding Box của chữ (`bbox: x0, y0, x1, y1`) được scale tương ứng theo tỉ lệ giữa kích thước thật của ảnh (`naturalWidth`, `naturalHeight`) và kích thước hiển thị trên màn hình (`clientWidth`, `clientHeight`).
3. **Lớp phủ chữ trong suốt (Transparent Overlay):**
   - Các từ được đặt chính xác vào vị trí ảnh dưới dạng thẻ `<span>` trong suốt (`color: transparent`). Khi người dùng quét chuột, họ sẽ thấy vệt highlight quen thuộc và copy chuẩn xác theo định dạng chữ của trang web.
