# Hướng dẫn thiết lập và chạy Axiom trên Windows

Tài liệu này hướng dẫn cách chạy và phát triển Axiom trên Windows (bao gồm cả Git Bash, PowerShell và WSL2).

---

## 1. Yêu cầu hệ thống trên Windows

- **Node.js**: Phiên bản `>= 22` ([Tải về từ nodejs.org](https://nodejs.org/)).
- **Python**: Phiên bản `>= 3.10` ([Tải từ python.org](https://www.python.org/downloads/) hoặc Microsoft Store).
- **Git for Windows**: Bao gồm Git Bash ([git-scm.com](https://git-scm.com/)).

---

## 2. Thiết lập tự động (1 lệnh duy nhất)

Mở PowerShell trong thư mục gốc của dự án `nhom-30` và chạy:

```powershell
.\scripts\setup-windows.ps1
```

Script này sẽ tự động:
1. Kiểm tra phiên bản Node.js và Python.
2. Tạo virtual environment Python tại `~/.axiom/venv`.
3. Cài đặt `pytest` vào virtual environment.
4. Cấu hình Git hooks (`.githooks`).

---

## 3. Cách chạy kiểm tra (Local CI) trên Windows

### Cách A: Dùng Git Bash (Khuyến nghị)
Trong Git Bash:
```bash
./scripts/ci-local.sh
```
Script sẽ tự động nhận diện môi trường Windows (`MINGW`/`MSYS`), trỏ `AXIOM_PYTHON` vào `~/.axiom/venv/Scripts/python.exe`, bật cờ `AXIOM_ALLOW_LOCAL_TESTS=1` và chạy toàn bộ 6 bước kiểm tra.

Khi đẩy code và mở PR:
```bash
./scripts/ship.sh
```

### Cách B: Dùng PowerShell
Trong PowerShell:
```powershell
.\scripts\ci-local.ps1
```

### Cách C: Chạy unit test thông thường
```powershell
npm test
```

---

## 4. Chạy Eval (Đánh giá UC-01 đến UC-04)

Trên Windows native, bạn có thể chạy eval pipeline:
```bash
# Chạy smoke test (mock)
npm run eval -- --uc 01 --mock
npm run eval -- --uc 04 --mock

# Chạy eval với model thật (cần đăng nhập /login)
$env:AXIOM_ALLOW_LOCAL_TESTS="1"   # trên PowerShell
export AXIOM_ALLOW_LOCAL_TESTS=1   # trên Git Bash
npm run eval -- --uc 04
```

---

## 5. Sử dụng WSL2 (Nếu muốn cách ly sandbox bwrap 100% như Linux)

Nếu bạn muốn có môi trường Linux chuẩn (có sandbox `bubblewrap` cách ly mạng và filesystem y hệt máy eval):
1. Cài đặt WSL2: `wsl --install`
2. Mở terminal WSL (Ubuntu) trong thư mục dự án:
   ```bash
   sudo apt update && sudo apt install -y bubblewrap python3-pytest python3-venv nodejs npm
   npm install
   ./scripts/ci-local.sh
   ```
