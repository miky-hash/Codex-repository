#!/data/data/com.termux/files/usr/bin/bash
# 유튜브 저장 앱 원클릭 설치 (Termux 전용)
# 실행: bash ~/storage/downloads/ytapp_setup.sh
set -e

# 내장 Download에 실제로 파일을 쓸 수 있는지 (권한을 나중에 끈 경우도 잡으려고 직접 써 본다)
storage_ok() {
  touch ~/storage/downloads/.ytapp_test 2>/dev/null && rm -f ~/storage/downloads/.ytapp_test
}

echo "[1/5] 저장소 권한 확인"
if storage_ok; then
  echo "저장소 권한 있음"
else
  echo "곧 뜨는 창에서 파일 접근을 '허용'해 주세요."
  termux-setup-storage || true
  for _ in $(seq 1 60); do
    storage_ok && break
    sleep 1
  done
  if storage_ok; then
    echo "저장소 연결됨"
  else
    echo "저장소 권한을 못 받았어요. 설치는 계속하지만 파일이 Termux 안(~/YouTube)에 저장돼서 다른 앱에서는 안 보여요."
    echo "나중에 termux-setup-storage 를 실행해 허용한 뒤 ytstart 를 다시 켜면 바뀌어요."
  fi
fi

echo "[2/5] Termux 패키지 설치 (python, ffmpeg)"
pkg update -y
yes | pkg upgrade -y || true
pkg install -y python ffmpeg

echo "[3/5] 파이썬 라이브러리 설치 (flask, yt-dlp, mutagen)"
pip install -U flask yt-dlp mutagen

echo "[4/5] 앱 파일 만들기 (~/ytapp)"
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

echo "[5/5] 완료! 이제 언제든 'ytstart' 만 입력하면 실행돼요."
if [ -d ~/storage/external-1 ] || [ -d ~/storage/external ]; then
  echo "저장 위치: SD카드 (Android/data/com.termux/files/YouTube)"
elif ! storage_ok; then
  echo "저장 위치: Termux 내부 (~/YouTube) - 저장소 권한이 없어요."
else
  echo "SD카드를 못 찾았어요. 지금은 내장 Download/YouTube에 저장돼요."
  echo "SD카드를 꽂은 상태에서 termux-setup-storage 를 다시 실행하면 SD카드로 바뀌어요."
fi
