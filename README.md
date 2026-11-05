# ElevenLabs Voice Studio

Không cần cài thêm gì: app chạy bằng Ruby, `osascript` và `afconvert` có sẵn trên macOS.

## Chạy app
Nhấp đúp **`Chạy App.command`** (lần đầu: chuột phải → Open), trình duyệt sẽ mở http://localhost:8765.
Hoặc chạy bằng Terminal: `ruby server.rb`

## Các bước
1. **API & Giọng**: dán API key → Kết nối → app tải các giọng clone/của bạn (có nghe thử, copy ID, xoá).
2. **Clone giọng**: đặt tên + tải file mẫu → tạo giọng mới bằng Instant Voice Cloning trên tài khoản của bạn.
3. **Kịch bản**: tải `.xlsx` / `.csv` / `.txt`. App tự tìm sheet và các cột STT, Cảnh, Nhân Vật, Lời Thoại, Lời thoại có tag (bạn có thể chỉnh lại).
   Gán giọng cho từng nhân vật. Bấm "Tự ghép theo tên" nếu tên giọng trùng tên nhân vật. Lựa chọn được lưu lại cho các tập sau.
4. **Tạo & Xuất**: chọn model, chất lượng, thư mục xuất → **Tạo toàn bộ**.

## Chất lượng WAV
App gọi API với `output_format=pcm_48000` / `pcm_44100` (PCM không nén, chất lượng cao nhất ElevenLabs trả về) rồi đóng gói thành WAV 16-bit mono.
Nếu gói của bạn không hỗ trợ, app tự hạ xuống mức tiếp theo (44.1k → 24k …). Lưu ý: PCM 44.1 kHz cần gói Pro trở lên.

## Tên file
Mặc định: `{stt}_{scene}_{char}.wav`, ví dụ `001_C01_VINH HOA.wav`. Có tuỳ chọn chia thư mục con theo nhân vật hoặc theo cảnh.
