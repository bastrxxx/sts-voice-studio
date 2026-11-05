# STS Voice Studio (ElevenLabs)

Web app chạy hoàn toàn trên trình duyệt, dùng được trên **Windows / macOS**, không cần cài đặt.

👉 **Dùng online:** https://bastrxxx.github.io/sts-voice-studio/
(Dùng **Chrome** hoặc **Edge** để app ghi file WAV thẳng vào thư mục bạn chọn.)

## Tính năng
1. **API & Giọng**: nhập API key ElevenLabs, xem danh sách giọng clone/của bạn (nghe thử, copy ID, xoá).
2. **Clone giọng**: tải file mẫu, tạo giọng mới bằng Instant Voice Cloning.
3. **Kịch bản**: tải `.xlsx` / `.csv` / `.txt`. App tự nhận diện các cột STT, Cảnh, Nhân Vật, Lời Thoại, Lời thoại có tag.
   Gán giọng cho từng nhân vật. Bấm "Tự ghép theo tên" để ghép tự động; lựa chọn được lưu cho các tập sau.
4. **Tạo & Xuất**: chọn model, chất lượng, thư mục → tạo toàn bộ file WAV.

## Chất lượng WAV
App gọi API với `output_format=pcm_48000` / `pcm_44100` (PCM không nén) rồi đóng gói thành WAV 16-bit mono.
Nếu gói của bạn không hỗ trợ, app tự hạ xuống mức thấp hơn (44.1k → 24k …). PCM 44.1 kHz cần gói Pro trở lên.

## Bảo mật
API key chỉ lưu trong trình duyệt (localStorage) của máy đang dùng, không gửi đi đâu ngoài `api.elevenlabs.io`.

## Chạy offline trên Mac (tuỳ chọn)
Nhấp đúp `Chạy App.command` → mở http://localhost:8765 (server Ruby có sẵn của macOS, có proxy dự phòng tới ElevenLabs).
