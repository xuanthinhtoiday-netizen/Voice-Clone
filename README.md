# VoxForge — Unlimited Neural TTS & Zero-Shot Voice Cloning Studio

Phòng thu chuyển văn bản thành giọng nói **không giới hạn ký tự** và **nhân bản giọng nói (Voice Cloning)** tiếng Việt & đa ngôn ngữ, tối ưu cho máy tính cá nhân (hỗ trợ chạy offline 100% trên CPU lẫn tăng tốc trên GPU Cloud).

## Tinh hoa các kho mã nguồn mở được kết hợp

| Nguồn mã nguồn mở | Vai trò trong VoxForge |
|---|---|
| **`contextboxai/ViZipvoice` (`k2-fsa/ZipVoice`)** | **Clone giọng tiếng Việt chuẩn 99%** (Flow-Matching 7.000 giờ tiếng Việt + tiếng Anh), đối chiếu chính xác `ref_text` (tự động nhận diện bằng `faster-whisper`), hỗ trợ xuất ONNX INT8 chạy offline không giới hạn trên CPU lẫn GPU Cloud (`ZipVoice GPU`). |
| **`rany2/edge-tts`** | **300+ giọng Microsoft Neural** đa ngôn ngữ (`Hoài My`, `Nam Minh`, Multilingual...), xử lý song song 4 luồng (~40x thời gian thực) và trích xuất mốc thời gian từng từ tạo phụ đề `.srt` / `.vtt`. |
| **`pnnbao97/VieNeu-TTS`** (`v3nano` ONNX) | 11 giọng tiếng Việt Bắc/Nam chạy offline ONNX CPU siêu nhanh kèm tag cảm xúc `[cười]`, `[thở dài]`. |
| **`hexgrad/kokoro`** (`kokoro-onnx`) | Mô hình 82M Apache-2.0 chạy offline CPU + **Voice Style Blending** (trộn 2 giọng theo tỷ lệ `%`). |
| **`SWivid/F5-TTS`** (`hynt/F5-TTS-Vietnamese`) | Lõi Flow-Matching bổ sung trên GPU Cloud + kiến trúc chia đoạn thông minh không giới hạn ký tự, ghép nối Cosine Crossfade và chuẩn hóa tuyến tính `-20 dBFS` không rè. |

## Tính năng nổi bật

- **Tạo giọng nói không giới hạn ký tự**: Dán văn bản dài hàng trăm nghìn ký tự hoặc nhập tệp `.txt`, `.md`, `.srt`, `.vtt`; chia đoạn theo dấu câu & theo dõi tiến độ từng đoạn theo thời gian thực (SSE).
- **Kho giọng Clone (Voice Vault)**: Ghi âm trực tiếp từ micro với câu mẫu gợi ý hoặc tải tệp âm thanh (`WAV, MP3, M4A, OGG, WebM, FLAC`), tự động phân tích cao độ `F0`, chấm điểm chất lượng và nhận diện `ref_text`.
- **Hội thoại Podcast (Dialogue Director)**: Phối nhiều nhân vật bằng giọng có sẵn và giọng Clone cá nhân trong cùng một bản thu kèm phụ đề đồng bộ.
- **Trình phát Mastering Dock**: Sóng âm tương tác tua nhanh, phát nguyên bản 100% khi không bật EQ, và ngăn kéo **EQ / Reverb / Âm nền** bằng Web Audio API + tải nhanh **MP3 / WAV / SRT**.
- **Giao diện phòng thu tối giản**: Thiết kế split-pane sáng, sạch, tập trung vào thao tác biên tập với font **Be Vietnam Pro** & **IBM Plex Mono**.

## Triển khai trọn bộ lên Cloudflare Workers (Hono.js + React)

Toàn bộ giao diện React (`frontend/dist`) và **AI Backend viết bằng Hono.js** (`worker/src/index.ts`) được đóng gói qua `wrangler.jsonc` (**Workers Static Assets**):
- **Edge Neural TTS (300+ giọng, không giới hạn ký tự & phụ đề SRT)**: Chạy trực tiếp trên Cloudflare Workers qua WebSocket (`worker/src/edgeDrm.ts`, `worker/src/edgeTts.ts`) — không cần server Python.
- **Zero-Shot Voice Cloning (`ZipVoice GPU`, `F5-TTS Việt`, `VieNeu v3 Turbo 48kHz`)**: Chạy từ Hono.js Worker gọi tới NVIDIA A10G GPU Cloud (`worker/src/gradioClone.ts`).
- **Kho giọng Clone & Thư viện âm thanh**: Lưu ngay trong **IndexedDB** của trình duyệt (không cần cài D1/R2 trả phí).

### Cách 1: Đẩy trực tiếp từ GitHub trên Cloudflare Dashboard
1. Vào **Cloudflare Dashboard → Compute (Workers & Pages) → Create → Workers → Import a repository** (chọn tab **Workers**, không chọn Pages).
2. Chọn repository **`Voice-Clone`** (nhánh `main`).
3. Điền cấu hình:
   - **Build command**: `npm run build`
   - **Deploy command**: `npx wrangler deploy`
   - **Root directory**: để trống (`/`)
   - *(Tùy chọn)* Thêm **Environment variable / Secret**: `HF_TOKEN` (Read token miễn phí từ `huggingface.co/settings/tokens`) để tăng quota GPU Clone cho toàn bộ người dùng, hoặc mỗi người có thể dán trực tiếp trong mục **Mô hình AI** trên web.
4. Nhấn **Save and Deploy**.

### Cách 2: Chạy thử & Deploy bằng CLI
```bash
npm install
npm run build
npm run dev       # Chạy thử cục bộ tại http://127.0.0.1:8787
npm run deploy    # Deploy thẳng lên Cloudflare Workers
```

---

## Cài đặt & Khởi chạy cục bộ (Python Offline CPU)

### 1. Cài đặt Backend (Python 3.11)
```bash
python -m venv .venv
.venv\Scripts\activate

pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
```

### 2. Xuất mô hình ViZipVoice ONNX INT8 (chạy 1 lần cho chế độ Clone Offline)
```bash
python scripts/export_vizipvoice_onnx.py
```

### 3. Build Frontend (Node.js 20+)
```bash
cd frontend
npm install
npm run build
cd ..
```

### 4. Chạy ứng dụng
Nhấp đúp vào `start.bat` hoặc chạy:
```bash
uvicorn backend.main:app --host 127.0.0.1 --port 8000
```
Truy cập: **http://127.0.0.1:8000**

*(Tùy chọn: vào mục **Mô hình AI** và dán một Hugging Face Token miễn phí từ `huggingface.co/settings/tokens` để tăng tốc `ZipVoice GPU` lên ~2–4 giây/đoạn trên NVIDIA A10G).*
