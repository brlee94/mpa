# EML → PST 변환기 다운로드

[Windows x64용 ZIP 다운로드 (약 47MB)](https://github.com/brlee94/mpa/raw/refs/heads/eml-to-pst-download/downloads/EmlToPst-Windows-x64.zip)

Windows 10/11 x64와 설치된 **클래식 Outlook**, 정상적인 기본 프로필이 필요합니다. 새 Outlook만으로는 동작하지 않습니다.

1. ZIP을 로컬 폴더에 압축 해제합니다.
2. `EmlToPst.exe`를 실행합니다. 추가 런타임 설치나 관리자 권한은 필요하지 않습니다.
3. EML 폴더 또는 파일과 새로운 PST 저장 위치를 선택합니다.
4. 변환 결과는 Outlook의 **파일 → 열기 및 내보내기 → Outlook 데이터 파일 열기**에서 확인합니다.

원본 EML과 기존 PST는 수정하지 않습니다. 기본 설정으로 각 메일에 원본 EML을 추가로 첨부합니다. 본문·날짜·보낸 사람·수신자·첨부파일을 가져오며 하위 폴더 구조를 유지합니다. 실패 내역은 PST 옆 CSV 보고서에 기록됩니다. 자세한 조건과 사용법, 제삼자 라이선스, Windows 검증 스크립트는 ZIP에 포함되어 있습니다.

## 검증 상태

빌드와 EML 처리 자동 검사 12개는 통과했습니다. 실제 Outlook에서 PST 생성 및 Windows GUI 실행은 Linux 빌드 서버에서 검증하지 못했습니다. 먼저 소량의 메일로 결과를 확인하세요. 실행 파일은 코드 서명되지 않았습니다.

## 무결성

ZIP SHA-256:

```text
7d60567ee9e92552b26cf7c3632d005e1c51c5d1049b4b533cc95f9e7fe92175
```

이 브랜치는 다운로드 파일 전달용입니다.
