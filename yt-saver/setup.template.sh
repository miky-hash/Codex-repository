#!/data/data/com.termux/files/usr/bin/bash
# 유튜브 저장 앱 원클릭 설치 (Termux 전용)
# 실행: bash ~/storage/downloads/ytapp_setup.sh
set -e

echo "[1/4] Termux 패키지 설치 (python, ffmpeg)"
pkg update -y
yes | pkg upgrade -y || true
pkg install -y python ffmpeg

echo "[2/4] 파이썬 라이브러리 설치 (flask, yt-dlp, mutagen)"
pip install -U flask yt-dlp mutagen

echo "[3/4] 앱 파일 만들기 (~/ytapp)"
mkdir -p ~/ytapp/static

# ───────────────────────── 서버 (app.py) ─────────────────────────
cat > ~/ytapp/app.py <<'PYEOF'
#@embed app.py
PYEOF

# ───────────────────────── 화면 (index.html) ─────────────────────────
cat > ~/ytapp/static/index.html <<'HTMLEOF'
#@embed static/index.html
HTMLEOF

# ───────────────────────── 실행 스크립트 ─────────────────────────
cat > ~/ytapp/start.sh <<'SHEOF'
#@embed start.sh
SHEOF

chmod +x ~/ytapp/start.sh
ln -sf ~/ytapp/start.sh "$PREFIX/bin/ytstart"

echo "[4/4] 완료! 이제 언제든 'ytstart' 만 입력하면 실행돼요."
if [ -d ~/storage/external-1 ] || [ -d ~/storage/external ]; then
  echo "저장 위치: SD카드 (Android/data/com.termux/files/YouTube)"
else
  echo "SD카드를 못 찾았어요. 지금은 내장 Download/YouTube에 저장돼요."
  echo "SD카드를 꽂은 상태에서 termux-setup-storage 를 다시 실행하면 SD카드로 바뀌어요."
fi
