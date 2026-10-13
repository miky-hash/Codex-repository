# 유튜브 저장 (yt-saver)

Termux(안드로이드)에서 돌리는 개인용 유튜브 다운로더예요. Flask + yt-dlp + ffmpeg.
같은 폰의 브라우저에서 `http://127.0.0.1:5000` 으로 접속해 써요.

## 설치 (폰)

1. `ytapp_setup.sh` 하나만 폰의 Download 폴더로 받아요.
2. Termux에서 `bash ~/storage/downloads/ytapp_setup.sh`
3. 이후에는 `ytstart` 만 입력하면 서버가 켜지고 브라우저가 열려요.

## 파일

| 파일 | 하는 일 |
| --- | --- |
| `app.py` | Flask 서버 → 폰의 `~/ytapp/app.py` |
| `static/index.html` | 화면 (HTML/CSS/JS 한 파일) → `~/ytapp/static/index.html` |
| `start.sh` | 실행 스크립트 → `~/ytapp/start.sh`, `$PREFIX/bin/ytstart` 로 링크 |
| `setup.template.sh` | 설치 스크립트 틀. `#@embed <파일>` 자리에 위 파일들이 들어가요 |
| `build.sh` | 틀 + 위 파일들 → `ytapp_setup.sh` |
| `ytapp_setup.sh` | **만들어지는 파일, 직접 고치지 않기.** 폰에 옮기는 설치 스크립트 |

### 고칠 때

`app.py` / `static/index.html` / `start.sh` / `setup.template.sh` 를 고친 뒤:

```bash
bash yt-saver/build.sh          # ytapp_setup.sh 다시 만들기
bash yt-saver/build.sh --check  # 커밋 전에 최신인지 확인
```

## 정해진 것

- 실행 명령: `ytstart` (예전 `~/.bashrc` alias 방식은 로드 안 되는 문제가 있어서 `$PREFIX/bin` 링크로 바꿈)
- 실행할 때마다 `pip install -U yt-dlp` (403 오류 예방)
- 저장 위치 우선순위: SD카드(`~/storage/external-1` = `/storage/XXXX-XXXX/Android/data/com.termux/files`) → 내장 `Download/YouTube` → `~/YouTube`
- 영상: MP4, 화질 선택(기본 1080p 이하 최고). 화질 이름은 세로 영상 때문에 가로·세로 중 짧은 쪽 기준
- 음악: MP3 192k, 제목·채널 메타데이터 + 썸네일 앨범커버
- API: `GET /api/storage`, `POST /api/info`, `POST /api/download`, `GET /api/status/<id>`

## 디자인

- 색: paper #E9EDF0 / card #F7F9FA / ink #18212B / mute #5F6B77 / rec #D92B25 / tape #E09A12 (다크모드 별도)
- 글꼴: Pretendard (jsdelivr CDN, 오프라인이면 시스템 글꼴)
- 강조 포인트는 진행 막대 하나: 20칸 LED 미터 + 받는 중일 때 깜빡이는 빨간 REC 점

## 알려진 한계 / 확인 필요

- 설치 스크립트가 `termux-setup-storage` 를 실행하지 않아요. 한 번도 안 했다면 `~/storage` 가 없어서
  `~/YouTube`(Termux 내부, 다른 앱에서 안 보임)에 저장돼요. (리눅스에서 서버를 띄워 확인함)
- 서버가 `127.0.0.1` 에만 열려서 같은 기기에서만 접속돼요. 다른 기기(탭 등)에서 쓰려면 `0.0.0.0` 으로 열어야 하는데,
  인증이 없어서 같은 와이파이의 누구나 쓸 수 있게 돼요.
- 안드로이드 정책상 Termux는 SD카드의 자기 전용 폴더(Android/data/com.termux)에만 쓸 수 있음.
  → Termux를 지우면 이 폴더도 같이 지워짐.
  → 갤러리·음악 앱에 안 뜰 수 있음 (미확인, 실제 기기에서 확인 필요)
- 진행률은 영상/소리 파일을 따로 받을 때 각각 0→100%로 다시 시작함
- 다운로드 목록은 서버 메모리에만 있어서 서버를 끄면 사라짐
- 실제 Termux 기기에서 설치·다운로드는 아직 테스트 전

## 다음에 해볼 만한 것

- 재생목록 일괄 다운로드
- 저장 기록 유지 (JSON 파일)
- 받은 파일을 앱에서 바로 열기/공유
