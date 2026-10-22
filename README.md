# MPA Mail Tools · 웹 EML → PST 변환기

Windows와 macOS의 **브라우저 안에서** EML을 Unicode PST로 변환합니다. 실행 파일 다운로드, 프로그램 설치, Outlook 설치, 별도 서버가 필요하지 않습니다. 선택한 메일과 첨부파일은 서버로 전송하지 않습니다. 변환된 PST만 사용자가 저장합니다.

## 사용

1. 배포된 웹사이트에서 EML 파일을 드래그하거나 **폴더 선택**을 누릅니다.
2. 결과 파일 이름과 원본 EML 첨부 여부를 선택합니다.
3. 총 100MB 이하이면 **PST로 변환하기 → PST 저장하기**로 저장합니다. 총 100MB를 넘으면 **저장 폴더 선택** 후 변환하세요. 새 작업 폴더 안에 여러 PST가 차례로 저장됩니다.

폴더 선택 시 폴더 구조를 유지합니다. `.eml`, `.EML`, `.eml.15`를 지원합니다. Windows에서 보이는 `Outlook.File.eml.15`는 일반 EML의 형식 이름인 경우가 많습니다.

권장 브라우저는 Windows/macOS의 최신 Chrome 또는 Edge입니다. OS와 무관하게 WebAssembly 및 로컬 파일 선택 기능을 사용합니다. Safari용 엔진 다운로드가 현재 빌드 환경의 네트워크 정책에 차단되어 Safari 실행 검증은 하지 못했습니다.

## 보존 범위와 한도

- 텍스트 및 HTML 본문, 한글 헤더, 보낸 사람, To/Cc/Bcc, 보낸 날짜와 수신 날짜, 메시지 ID와 MIME 헤더를 저장합니다.
- 수신 날짜는 첫 번째 유효한 `Received` 날짜를 사용하며 없으면 `Date`를 사용합니다. 유효한 날짜가 없으면 변환 시각을 사용합니다.
- 일반 첨부, 인라인 이미지 Content-ID, 첨부된 EML을 보존합니다. 기본값으로 원본 EML 전체를 별도 첨부하므로 원본을 그대로 추출할 수 있습니다.
- 읽음 상태의 일반 메일로 저장합니다. S/MIME 복호화, winmail.dat 내부 추출, 원래의 읽음 상태 복원은 하지 않습니다. 원본 EML을 보존하는 옵션을 권장합니다.
- **한 번에 1,000개, 원본 합계 4GiB, 파일당 100MiB**까지 선택합니다. 총 100MiB 초과는 Windows/macOS의 최신 Chrome 또는 Edge에서 저장 폴더의 쓰기 권한을 허용해야 합니다. 입력 버퍼는 파일 크기에 맞추고 첨부 버퍼의 추가 복사를 줄였습니다. 전체 메일이나 전체 결과를 한꺼번에 메모리에 보관하지 않습니다.
- 대용량 작업은 **원본 합계 약 100MiB 단위의 여러 Unicode PST**로 저장합니다. 파일 하나를 두 PST로 쪼개지는 않습니다. 각 PST의 메모리 스트림은 384MiB로 제한하며, JavaScript에서 결과 전체를 Blob/ArrayBuffer로 복사하지 않고 `ReadableStream.pipeTo(FileSystemWritableFileStream)`으로 디스크에 기록합니다. 단일 4GiB PST를 만드는 기능은 아닙니다.
- 선택한 저장 폴더 아래에 이름·시각·임의 식별자를 조합한 새 작업 폴더를 만들고 `이름-001.pst`, `이름-002.pst`처럼 저장합니다. 기존 파일은 덮어쓰지 않습니다. 원본 EML 보존 옵션을 켜면 결과 합계가 원본보다 커질 수 있으므로 충분한 디스크 공간이 필요합니다.
- 잘못된 EML은 제외하고 CSV 보고서에 남깁니다. 모든 파일이 실패하면 PST를 내보내지 않습니다. 중지하거나 저장 오류가 생기면 아직 저장하지 않은 부분은 폐기하고, 디스크에 저장을 마친 PST는 보존합니다. 성공 수는 저장을 마친 메일만 집계합니다.
- 탭을 닫으면 메모리상의 입력과 결과는 사라집니다. 기존 PST를 수정하거나 원본 파일을 변경하지 않습니다. 자동 재개와 중복 제거는 제공하지 않습니다.
- PST 생성 엔진은 Unicode PST를 작성합니다. 엔진의 알려진 제약으로 Outlook 검사 도구가 메시지 크기 재계산이나 검색 폴더 관련 안내를 표시할 수 있습니다. [PstBuilder 설명](https://github.com/ml-ls/PST-Builder#two-harmless-scanpst-notes)을 참고하세요.
- Windows/macOS 지원은 **변환 환경**을 뜻합니다. PST를 열거나 가져오려면 이를 지원하는 앱이 필요합니다. Mac용 새 Outlook은 PST 가져오기를 지원하지 않을 수 있습니다.

## GitHub Pages 배포

`gh-pages` 브랜치 루트에 이미 빌드된 정적 사이트를 게시합니다. 런타임 서버와 비밀 값은 필요하지 않습니다.

저장소 관리자가 [Settings → Pages](https://github.com/brlee94/mpa/settings/pages)에서 다음 값을 저장하면 됩니다.

- **Source:** Deploy from a branch
- **Branch:** gh-pages
- **Folder:** / (root)

활성화와 배포가 완료된 뒤의 기본 주소는 `https://brlee94.github.io/mpa/`입니다. 저장소의 Pages 설정에서 실제 게시된 주소와 배포 결과를 확인하세요. `gh-pages`에 파일을 업로드한 것만으로 사이트 활성화 성공을 뜻하지는 않습니다.

현재 환경은 Git 전송으로 브랜치 업로드가 가능하지만 GitHub 관리 API(`api.github.com`) 및 사이트 도메인에 대한 접근이 네트워크 정책에 차단되어 있습니다. 따라서 Pages 설정 변경과 공개 사이트 응답 검증은 이 환경에서 직접 수행할 수 없습니다. 저장소 관리자의 위 설정이 필요합니다.

## 빌드

개발할 때만 .NET SDK 10.0.402와 Node.js가 필요합니다. 사이트 사용자는 설치하지 않습니다.

```bash
bash scripts/publish-web.sh
```

`artifacts/web/wwwroot`가 배포할 전체 정적 사이트입니다. 하위 경로(`/mpa/`)에서 동작하도록 상대 base URL을 사용합니다. `.nojekyll`을 포함해 `_framework` 디렉터리가 Pages에서 제외되지 않게 합니다. 잠금 파일은 일반 빌드와 브라우저 배포용을 구분합니다.

로컬 확인:

```bash
python3 -m http.server 8765 --directory artifacts/web/wwwroot
```

브라우저로 로컬 서버에 접속하면 됩니다. 공개 사이트는 HTTPS를 사용하세요.

## 검증

Linux의 실제 Chromium에서 파일 선택 → 브라우저 WebAssembly 변환 → PST 저장을 실행한 뒤, **작성 엔진과 독립적인 XstReader**로 PST를 다시 읽어 검증했습니다.

검사 범위: Unicode PST 헤더, 실패 EML 제외, 한글 텍스트/HTML, 보낸 사람/To/Cc/Bcc/메시지 ID, 보낸 시각과 수신 시각, 첨부파일 바이트와 CID, 중첩 EML, 원본 EML의 바이트 보존, CSV 보고서, 원본 첨부 옵션, 잘못된 입력, 폴더 구조, 좁은 화면, 크기 제한, 중지, 메일 외부 전송 없음.

```bash
npm ci
# 배포 파일을 제공하는 로컬 정적 서버를 먼저 시작합니다.
WEB_URL=http://127.0.0.1:8765/ npm run test:web
WEB_URL=http://127.0.0.1:8765/ npm run test:web:large
```

`CHROMIUM_PATH`는 기본 `/usr/bin/chromium`입니다. 다른 경로이면 지정하세요. `DOTNET`으로 SDK 실행 파일 경로를 지정할 수 있습니다. `TEST_WEBKIT=1`로 WebKit도 실행할 수 있으나 해당 Playwright 브라우저 설치가 먼저 필요합니다. 검증 스크립트는 독립 PST 리더를 자동으로 빌드하고 `artifacts/web-checks`에 출력과 스크린샷을 남깁니다. 대용량 검사는 `artifacts/web-large-checks`에 결과를 남깁니다.

대용량 검사의 용량 경계(100MiB 파일·4GiB 합계)는 희소 파일의 메타데이터로 검사하며, 전체 4GiB 메일 본문을 변환하는 검사는 하지 않습니다. 실제 변환은 약 43MiB EML 세 개(총 약 128MiB)로 수행하고, 두 개의 PST에 들어간 32MiB 첨부와 원본 EML의 SHA-256을 독립 리더로 확인합니다. 자동화에서는 운영체제의 폴더 선택 대화상자만 대체하고, 실제 브라우저의 디스크 기반 FileSystemDirectoryHandle(OPFS)에 프로덕션 저장 코드를 실행합니다. 저장 공간 부족 오류도 주입해 미완성 PST 제거와 이전 결과 보존을 확인합니다.

Windows/macOS의 실제 Outlook에서 파일을 여는 검증은 이 Linux 환경에서 실행하지 못했습니다. 최초 사용 시 소량의 메일로 결과를 확인하세요.

## 구조 및 라이선스

- `src/EmlToPst.Web`: 한국어 Blazor WebAssembly UI. 메일 업로드 API 없음.
- `src/EmlToPst.Pst`: 메모리상의 PST 생성 및 MIME → 메시지 매핑. PstBuilder 1.3.0 사용.
- `src/EmlToPst.Core`: MimeKit 기반 MIME 파싱 및 첨부 처리.
- `tests/web`: 브라우저 및 독립 PST 읽기 검사.
- `tests/EmlToPst.Inspect`: 개발 검증용 XstReader. 웹앱에는 포함하지 않음.

웹 배포의 `licenses.txt`와 `third-party/`에 PstBuilder, MimeKit, BouncyCastle 및 .NET 고지를 제공합니다. 이전 Windows 휴대용 버전 소스는 남겨 두었으며 사용법은 [docs/windows-portable.md](docs/windows-portable.md)에 있습니다. 웹 버전은 해당 실행 파일을 사용하지 않습니다.
