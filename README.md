# STS Voice Studio (ElevenLabs)

Web app chạy hoàn toàn trên trình duyệt, dùng được trên **Windows / macOS**, không cần cài đặt.

👉 **Dùng online:** https://bastrxxx.github.io/sts-voice-studio/
(Dùng **Chrome** hoặc **Edge** để app ghi file WAV thẳng vào thư mục bạn chọn.)

## Tính năng
0. **Đăng nhập**: cần đăng nhập để dùng app (có tuỳ chọn ghi nhớ, nút đăng xuất).
1. **API & Giọng**: nhập / **xoá sạch** API key, xem và tìm giọng clone (nghe thử, copy ID, xoá).
2. **Tạo voice**: Text to Speech giống ElevenLabs: chọn giọng, model, định dạng (WAV/MP3/Opus/μ-law), stability,
   similarity, style, speed, speaker boost, ngôn ngữ, chuẩn hoá văn bản, seed, chèn tag cảm xúc v3; có lịch sử, tải xuống và lưu vào thư mục.
3. **Clone / Thiết kế giọng**: Instant Voice Cloning từ file mẫu, hoặc Voice Design từ mô tả bằng chữ.
4. **Kịch bản**: tải `.xlsx` / `.csv` / `.txt` hoặc tạo kịch bản trống. Sửa trực tiếp, **thêm / chèn / nhân bản / xoá dòng**,
   **thêm / xoá nhân vật**, gán giọng. Kịch bản tự lưu trong trình duyệt.
5. **Xuất WAV hàng loạt**: chọn thư mục; thư mục con **theo tập**, tập › cảnh, tập › nhân vật, nhân vật hoặc cảnh; lọc theo tập.

> Lưu ý: đây là website tĩnh nên phần đăng nhập chỉ là lớp khoá phía trình duyệt (chỉ lưu mã băm), không thay thế được bảo mật phía server.

## Chất lượng WAV
App gọi API với `output_format=pcm_48000` / `pcm_44100` (PCM không nén) rồi đóng gói thành WAV 16-bit mono.
Nếu gói của bạn không hỗ trợ, app tự hạ xuống mức thấp hơn (44.1k → 24k …). PCM 44.1 kHz cần gói Pro trở lên.

## Bảo mật
API key chỉ lưu trong trình duyệt (localStorage) của máy đang dùng, không gửi đi đâu ngoài `api.elevenlabs.io`.

## Chạy offline trên Mac (tuỳ chọn)
Nhấp đúp `Chạy App.command` → mở http://localhost:8765 (server Ruby có sẵn của macOS, có proxy dự phòng tới ElevenLabs).
