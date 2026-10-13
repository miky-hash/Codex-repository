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
import os, glob, shutil, threading, uuid
from flask import Flask, request, jsonify, send_from_directory
import yt_dlp

HERE = os.path.dirname(os.path.abspath(__file__))


def pick_save_dir():
    """SD카드(Termux 전용 폴더) → 내장 Download → Termux 홈 순서로 고른다."""
    home = os.path.expanduser("~")
    sd = [os.path.join(home, "storage", "external-1"), os.path.join(home, "storage", "external")]
    sd += sorted(glob.glob("/storage/*-*/Android/data/com.termux/files"))
    for base in sd:
        if os.path.isdir(base):
            path = os.path.join(base, "YouTube")
            try:
                os.makedirs(path, exist_ok=True)
                test = os.path.join(path, ".write_test")
                open(test, "w").close()
                os.remove(test)
                return path, "sd", "SD카드"
            except OSError:
                pass
    dl = os.path.join(home, "storage", "downloads")
    if os.path.isdir(dl):
        path = os.path.join(dl, "YouTube")
        os.makedirs(path, exist_ok=True)
        return path, "internal", "내장 저장소"
    path = os.path.join(home, "YouTube")
    os.makedirs(path, exist_ok=True)
    return path, "termux", "Termux 내부"


SAVE_DIR, SAVE_KIND, SAVE_LABEL = pick_save_dir()
app = Flask(__name__, static_folder=None)
jobs = {}


def friendly(err):
    s = str(err).replace("ERROR: ", "")
    low = s.lower()
    if "403" in s:
        return "유튜브가 요청을 막았어요. Termux에서 ytstart를 다시 실행하면 yt-dlp가 업데이트돼요."
    if "not a valid url" in low or "unsupported url" in low:
        return "유튜브 영상 링크가 아니에요. 링크를 다시 확인하세요."
    if "not a bot" in low:
        return "유튜브가 봇 확인을 요구했어요. 잠시 뒤에 다시 하거나 와이파이를 바꿔 보세요."
    if "private" in low:
        return "비공개 영상이라 받을 수 없어요."
    if "confirm your age" in low:
        return "연령 제한 영상이라 로그인 없이는 받을 수 없어요."
    if "unavailable" in low:
        return "볼 수 없는 영상이에요. 삭제됐거나 지역 제한이 걸려 있어요."
    if "no space" in low:
        return "저장 공간이 부족해요."
    if "ffmpeg" in low or "ffprobe" in low:
        return "ffmpeg가 없어요. 설치 스크립트를 다시 실행하세요."
    if "getaddrinfo" in low or "timed out" in low or "network is unreachable" in low:
        return "인터넷 연결을 확인하세요."
    return "받지 못했어요: " + s[-200:]


def fmt_speed(b):
    if not b:
        return ""
    return f"{b / 1048576:.1f}MB/s" if b >= 1048576 else f"{b / 1024:.0f}KB/s"


def fmt_eta(s):
    if s is None:
        return ""
    s = int(s)
    return f"{s // 60}분 {s % 60}초" if s >= 60 else f"{s}초"


def run_job(jid, url, mode, height):
    job = jobs[jid]

    def hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes", 0)
            job["percent"] = done * 100 / total if total else job["percent"]
            info = d.get("info_dict") or {}
            if mode == "mp3":
                what = "오디오"
            else:
                what = "소리" if info.get("vcodec") == "none" else "영상"
            parts = [f"{what} 받는 중", fmt_speed(d.get("speed"))]
            eta = fmt_eta(d.get("eta"))
            if eta:
                parts.append(f"{eta} 남음")
            job.update(state="downloading", text="  ".join(p for p in parts if p))
        elif d["status"] == "finished":
            job["percent"] = 100

    def pp_hook(d):
        if d["status"] == "started":
            name = d.get("postprocessor", "")
            text = {
                "Merger": "영상과 소리를 합치는 중",
                "ExtractAudio": "MP3로 바꾸는 중",
                "EmbedThumbnail": "앨범 커버 넣는 중",
                "Metadata": "제목·채널 정보 넣는 중",
            }.get(name)
            if text:
                job.update(state="converting", percent=100, text=text)

    opts = {
        "outtmpl": os.path.join(SAVE_DIR, "%(title)s.%(ext)s"),
        "progress_hooks": [hook],
        "postprocessor_hooks": [pp_hook],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "windowsfilenames": True,
    }
    if mode == "mp3":
        opts.update({
            "format": "bestaudio/best",
            "writethumbnail": True,
            "postprocessors": [
                {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
                {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"},
                {"key": "FFmpegMetadata", "add_metadata": True},
                {"key": "EmbedThumbnail"},
            ],
        })
    else:
        h = int(height) if height else 1080
        opts.update({
            "format": (f"bv*[height<={h}][ext=mp4]+ba[ext=m4a]/"
                       f"bv*[height<={h}]+ba/b[height<={h}]/b"),
            "merge_output_format": "mp4",
        })

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
        files = info.get("requested_downloads") or [{}]
        name = os.path.basename(files[0].get("filepath") or "") or info.get("title", "")
        job.update(state="done", percent=100, text=f"저장됨: {name}")
    except Exception as e:
        job.update(state="error", text=friendly(e))


@app.route("/")
def index():
    return send_from_directory(os.path.join(HERE, "static"), "index.html")


@app.get("/api/storage")
def storage():
    try:
        free = f"{shutil.disk_usage(SAVE_DIR).free / 1073741824:.1f}GB"
    except OSError:
        free = ""
    return jsonify(kind=SAVE_KIND, label=SAVE_LABEL, path=SAVE_DIR, free=free)


@app.post("/api/info")
def info():
    url = ((request.get_json(silent=True) or {}).get("url") or "").strip()
    if not url:
        return jsonify(error="유튜브 링크를 넣어 주세요."), 400
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as ydl:
            i = ydl.extract_info(url, download=False)
    except Exception as e:
        return jsonify(error=friendly(e)), 400
    if i.get("_type") == "playlist":
        return jsonify(error="재생목록 링크예요. 영상 하나의 링크를 넣어 주세요."), 400

    # 세로 영상은 height가 긴 쪽(예: 1920)이라, 짧은 쪽 기준으로 화질 이름을 붙인다.
    by_label = {}
    for f in i.get("formats") or []:
        hgt = f.get("height")
        if not hgt or f.get("vcodec") in (None, "none"):
            continue
        short = min(hgt, f.get("width") or hgt)
        if short < 144:
            continue
        by_label[short] = max(by_label.get(short, 0), hgt)
    quals = [{"h": h, "short": s, "label": f"{s}p"} for s, h in sorted(by_label.items(), reverse=True)]

    return jsonify(
        url=i.get("webpage_url") or url,
        title=i.get("title") or "제목 없음",
        uploader=i.get("uploader") or i.get("channel") or "",
        duration=i.get("duration") or 0,
        thumb=i.get("thumbnail") or "",
        quals=quals,
    )


@app.post("/api/download")
def download():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify(error="유튜브 링크를 넣어 주세요."), 400
    mode = "mp3" if data.get("mode") == "mp3" else "mp4"
    jid = uuid.uuid4().hex[:8]
    jobs[jid] = {"state": "waiting", "percent": 0, "text": "준비 중"}
    threading.Thread(target=run_job, args=(jid, url, mode, data.get("height")), daemon=True).start()
    return jsonify(id=jid)


@app.get("/api/status/<jid>")
def status(jid):
    return jsonify(jobs.get(jid) or {"state": "error", "percent": 0,
                                     "text": "서버가 다시 켜져서 진행 상황을 잃었어요. 다시 받아 주세요."})


if __name__ == "__main__":
    print(f"저장 위치: {SAVE_LABEL} ({SAVE_DIR})")
    app.run(host="127.0.0.1", port=5000, threaded=True)
PYEOF

# ───────────────────────── 화면 (index.html) ─────────────────────────
cat > ~/ytapp/static/index.html <<'HTMLEOF'
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#E9EDF0" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#10161C" media="(prefers-color-scheme: dark)">
<title>유튜브 저장</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<style>
:root{--paper:#E9EDF0;--card:#F7F9FA;--ink:#18212B;--mute:#5F6B77;--line:#CED5DB;--off:#D7DDE2;--rec:#D92B25;--tape:#E09A12;--r:14px}
@media (prefers-color-scheme:dark){:root{--paper:#10161C;--card:#18212A;--ink:#E5E9EC;--mute:#909BA6;--line:#29333D;--off:#26313B;--rec:#FF4D43;--tape:#F2B53A}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 Pretendard,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;font-variant-numeric:tabular-nums}
main{max-width:600px;margin:0 auto;padding:max(20px,env(safe-area-inset-top)) 16px 56px}
button{font:inherit;cursor:pointer;border:0;border-radius:10px;padding:11px 16px;font-weight:600}
button:disabled{opacity:.45;cursor:default}
:focus-visible{outline:2px solid var(--tape);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0 20px}
h1{font-size:26px;font-weight:800;letter-spacing:-.02em;margin:0}
.where{display:inline-flex;align-items:center;gap:7px;background:transparent;border:1px solid var(--line);color:var(--mute);border-radius:999px;padding:6px 12px;font-size:13px;font-weight:500}
.where .dot{width:8px;height:8px;border-radius:50%;background:var(--mute)}
.where.sd .dot{background:var(--tape)}
.path{font-size:12px;color:var(--mute);word-break:break-all;margin:-10px 2px 16px}

.slot{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:6px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:8px}
.slot:focus-within{border-color:var(--ink)}
.slot input{grid-column:1/-1;width:100%;min-width:0;border:0;background:transparent;color:var(--ink);font:inherit;font-size:17px;padding:10px 8px;outline:none}
.slot input::placeholder{color:var(--mute)}
.ghost{background:transparent;color:var(--mute);padding:10px 12px}
.primary{background:var(--ink);color:var(--paper)}
.slot .primary{grid-column:3}
.msg{min-height:1.5em;font-size:14px;color:var(--mute);margin:8px 4px 16px}
.msg.err{color:var(--rec)}

.pick{background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;margin-bottom:28px}
.pick img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:var(--off)}
.pick .in{padding:16px;display:grid;gap:14px}
.pick h2{font-size:18px;line-height:1.35;font-weight:700;margin:0 0 2px;word-break:keep-all;overflow-wrap:anywhere}
.pick .sub{margin:0;font-size:14px;color:var(--mute)}
.seg{display:grid;grid-template-columns:1fr 1fr;background:var(--paper);border-radius:12px;padding:4px}
.seg button{background:transparent;color:var(--mute);padding:10px}
.seg button[aria-checked=true]{background:var(--card);color:var(--ink);box-shadow:0 0 0 1px var(--line)}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chips[hidden]{display:none}
.chips button{background:transparent;border:1px solid var(--line);color:var(--ink);padding:7px 14px;border-radius:999px;font-size:14px;font-weight:500}
.chips button[aria-checked=true]{background:var(--ink);border-color:var(--ink);color:var(--paper);font-weight:700}
.go{width:100%;padding:15px;font-size:17px}

.queue h2{font-size:15px;font-weight:700;color:var(--mute);margin:0 0 10px}
#list{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.item{display:grid;grid-template-columns:104px 1fr;gap:12px;align-items:start;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:10px}
.item img{width:104px;aspect-ratio:16/9;object-fit:cover;border-radius:8px;background:var(--off);display:block}
.item .t{margin:0 0 8px;font-size:14px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meter{display:flex;align-items:center;gap:8px}
.rec{flex:none;width:8px;height:8px;border-radius:50%;background:var(--off)}
.item.live .rec{background:var(--rec);animation:blink 1.1s steps(2,start) infinite}
.leds{flex:1;display:grid;grid-template-columns:repeat(20,1fr);gap:2px;height:12px}
.leds i{background:var(--off);border-radius:2px}
.leds i.on{background:var(--tape)}
.item.done .leds i{background:var(--ink)}
.item.fail .leds i.on{background:var(--rec)}
.pct{font-size:13px;font-weight:700;min-width:3.1em;text-align:right}
.st{margin:6px 0 0;font-size:12px;color:var(--mute);overflow-wrap:anywhere}
.item.fail .st{color:var(--rec)}
.empty{font-size:14px;color:var(--mute);margin:0}
@keyframes blink{to{visibility:hidden}}
@media (prefers-reduced-motion:reduce){.item.live .rec{animation:none}}
@media (min-width:720px){main{max-width:660px}.item{grid-template-columns:136px 1fr}.item img{width:136px}}
</style>
</head>
<body>
<main>
  <header class="top">
    <h1>유튜브 저장</h1>
    <button id="where" class="where" type="button" aria-controls="wherePath"><span class="dot"></span><span id="whereLabel">저장 위치 확인 중</span></button>
  </header>
  <p id="wherePath" class="path" hidden></p>

  <form id="f" class="slot" autocomplete="off">
    <label for="url" class="sr">유튜브 링크</label>
    <input id="url" type="url" inputmode="url" placeholder="유튜브 링크를 붙여넣으세요">
    <button type="button" id="paste" class="ghost">붙여넣기</button>
    <button type="submit" id="load" class="primary">불러오기</button>
  </form>
  <p id="msg" class="msg" role="status" aria-live="polite"></p>

  <section id="pick" class="pick" hidden aria-label="저장 방식 고르기">
    <img id="thumb" alt="">
    <div class="in">
      <div><h2 id="title"></h2><p id="sub" class="sub"></p></div>
      <div class="seg" role="radiogroup" aria-label="형식">
        <button type="button" role="radio" data-mode="mp4">영상</button>
        <button type="button" role="radio" data-mode="mp3">음악 MP3</button>
      </div>
      <div id="quals" class="chips" role="radiogroup" aria-label="화질"></div>
      <button type="button" id="go" class="primary go">영상 저장하기</button>
    </div>
  </section>

  <section class="queue" aria-labelledby="qh">
    <h2 id="qh">저장 목록</h2>
    <ul id="list"></ul>
    <p id="empty" class="empty">아직 저장한 게 없어요. 위에 링크를 넣어 보세요.</p>
  </section>
</main>

<script>
const $ = s => document.querySelector(s);
const state = { info: null, mode: 'mp4', h: null };
// 썸네일이 없거나 못 불러오면 깨진 아이콘 대신 빈 회색 칸만 보이게
document.addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.removeAttribute('src'); }, true);
const setImg = (el, src) => src ? (el.src = src) : el.removeAttribute('src');

async function api(path, body) {
  const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  let r, d = {};
  try { r = await fetch(path, opt); }
  catch (e) { throw new Error('서버에 연결할 수 없어요. Termux에서 ytstart가 켜져 있는지 확인하세요.'); }
  try { d = await r.json(); } catch (e) {}
  if (!r.ok || d.error) throw new Error(d.error || '요청을 처리하지 못했어요.');
  return d;
}
function say(t, err) { const m = $('#msg'); m.textContent = t || ''; m.classList.toggle('err', !!err); }
function dur(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
}

api('/api/storage').then(d => {
  $('#where').classList.toggle('sd', d.kind === 'sd');
  $('#whereLabel').textContent = d.label + '에 저장';
  $('#wherePath').textContent = d.path + (d.free ? ` (남은 공간 ${d.free})` : '');
}).catch(() => { $('#whereLabel').textContent = '저장 위치를 모름'; });
$('#where').onclick = () => { const p = $('#wherePath'); p.hidden = !p.hidden; };

$('#paste').onclick = async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (t) { $('#url').value = t; $('#f').requestSubmit(); }
  } catch (e) { say('붙여넣기 권한이 없어요. 입력칸을 길게 눌러 붙여넣으세요.', true); }
};

$('#f').onsubmit = async e => {
  e.preventDefault();
  const url = $('#url').value.trim();
  if (!url) { say('유튜브 링크를 넣어 주세요.', true); return; }
  const b = $('#load'); b.disabled = true;
  say('영상 정보를 불러오는 중이에요.');
  try { state.info = await api('/api/info', { url }); showPick(state.info); say(''); }
  catch (err) { $('#pick').hidden = true; say(err.message, true); }
  finally { b.disabled = false; }
};

function showPick(d) {
  setImg($('#thumb'), d.thumb);
  $('#title').textContent = d.title;
  $('#sub').textContent = [d.uploader, dur(d.duration)].filter(Boolean).join(', ');
  const q = $('#quals'); q.innerHTML = '';
  const def = d.quals.find(x => x.short <= 1080) || d.quals[0];
  state.h = def ? def.h : null;
  d.quals.forEach(x => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = x.label;
    b.setAttribute('aria-checked', x === def);
    b.onclick = () => { state.h = x.h; q.querySelectorAll('button').forEach(o => o.setAttribute('aria-checked', o === b)); };
    q.appendChild(b);
  });
  setMode('mp4');
  $('#pick').hidden = false;
}
function setMode(m) {
  state.mode = m;
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-checked', b.dataset.mode === m));
  $('#quals').hidden = m !== 'mp4' || !$('#quals').children.length;
  $('#go').textContent = m === 'mp3' ? 'MP3로 저장하기' : '영상 저장하기';
}
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));

$('#go').onclick = async () => {
  const i = state.info; if (!i) return;
  const b = $('#go'); b.disabled = true;
  try {
    const d = await api('/api/download', { url: i.url, mode: state.mode, height: state.h });
    addItem(d.id, i, state.mode);
    $('#pick').hidden = true; $('#url').value = ''; state.info = null;
  } catch (err) { say(err.message, true); }
  finally { b.disabled = false; }
};

function addItem(id, i, mode) {
  $('#empty').hidden = true;
  const li = document.createElement('li');
  li.className = 'item live';
  li.innerHTML = '<img alt=""><div><p class="t"></p><div class="meter"><span class="rec"></span><div class="leds">'
    + '<i></i>'.repeat(20) + '</div><b class="pct">0%</b></div><p class="st">준비 중</p></div>';
  setImg(li.querySelector('img'), i.thumb);
  li.querySelector('.t').textContent = (mode === 'mp3' ? '[MP3] ' : '') + i.title;
  $('#list').prepend(li);
  poll(id, li);
}
async function poll(id, li) {
  let d;
  try { d = await api('/api/status/' + id); }
  catch (e) { setTimeout(() => poll(id, li), 2000); return; }
  const p = Math.max(0, Math.min(100, d.percent || 0));
  li.querySelectorAll('.leds i').forEach((x, k) => x.classList.toggle('on', k < Math.round(p / 5)));
  li.querySelector('.pct').textContent = Math.floor(p) + '%';
  li.querySelector('.st').textContent = d.text || '';
  li.classList.toggle('live', d.state === 'downloading');
  li.classList.toggle('done', d.state === 'done');
  li.classList.toggle('fail', d.state === 'error');
  if (d.state !== 'done' && d.state !== 'error') setTimeout(() => poll(id, li), 800);
}
</script>
</body>
</html>
HTMLEOF

# ───────────────────────── 실행 스크립트 ─────────────────────────
cat > ~/ytapp/start.sh <<'SHEOF'
#!/data/data/com.termux/files/usr/bin/bash
pkill -f "python.*ytapp/app.py" 2>/dev/null || true
echo "yt-dlp 업데이트 확인 중..."
pip install -U -q yt-dlp 2>/dev/null || echo "(업데이트 건너뜀 - 인터넷 확인)"
termux-wake-lock 2>/dev/null || true
(sleep 3; termux-open-url http://127.0.0.1:5000) &
echo "서버 실행 중: http://127.0.0.1:5000  (끄려면 Ctrl+C)"
python ~/ytapp/app.py
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
