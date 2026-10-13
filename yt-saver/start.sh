#!/data/data/com.termux/files/usr/bin/bash
pkill -f "python.*ytapp/app.py" 2>/dev/null || true
echo "yt-dlp 업데이트 확인 중..."
pip install -U -q yt-dlp 2>/dev/null || echo "(업데이트 건너뜀 - 인터넷 확인)"
termux-wake-lock 2>/dev/null || true
(sleep 3; termux-open-url http://127.0.0.1:5000) &
echo "서버 실행 중: http://127.0.0.1:5000  (끄려면 Ctrl+C)"
python ~/ytapp/app.py
