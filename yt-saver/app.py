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
