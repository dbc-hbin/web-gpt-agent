<h1 align="center">Web GPT Agent</h1>

<p align="center"><strong>ChatGPT Web 기반의 고성능 로컬 코딩 및 시스템 제어 에이전트 런타임</strong></p>

<p align="center">
  <a href="#주요-특징-및-포크-개선점">포크 개선점</a> &nbsp;·&nbsp;
  <a href="#런타임-및-도구-구조">도구 구조</a> &nbsp;·&nbsp;
  <a href="#cli-명령어-가이드">CLI 가이드</a> &nbsp;·&nbsp;
  <a href="#빌드-및-시작하기">시작하기</a> &nbsp;·&nbsp;
  <a href="LICENSE">라이선스</a>
</p>

<br />

## 개요

**Web GPT Agent**는 고가의 API 과금 없이 평소 사용하는 **ChatGPT Web 대화창을 에이전트의 두뇌로 활용**하여 로컬 파일 편집, 터미널 명령 실행, 멀티 워커 협업, 브라우저 및 OS 네이티브 제어를 안전하게 수행하는 독립형 데스크톱 및 데몬 환경입니다.

원격 ChatGPT 대화창이 모델 실행과 추론을 담당하고, 로컬의 Web GPT Agent 런타임(Core, Desktop, Plugins)이 로컬 파일시스템과 프로세스, 브라우저를 MCP(Model Context Protocol)를 통해 안전하게 연결합니다.

---

## 주요 특징 및 포크 개선점 (vs Chat On Steroids)

Web GPT Agent는 [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids)를 기반으로 설계 및 아키텍처를 대대적으로 개편한 포크 프로젝트입니다. 모델 컨텍스트 낭비, 불필요한 GUI 의존성, 복잡한 외부 드라이버 설정을 제거하고 안정성과 성능을 극대화했습니다.

### 1. 툴의 코드모드화 (Code Mode via QuickJS Sandbox)
- **컨텍스트 오염 및 토큰 낭비 제거**: 수십 개의 개별 툴(`read`, `apply_patch`, `exec_command` 등) 스키마를 모델에 그대로 나열하지 않고, **`exec_read`**, **`exec`**, **`wait`**, **`tools_search`** 4개의 메타 도구로 캡슐화했습니다.
- **프로그래밍 방식의 도구 합성**: 격리된 QuickJS 샌드박스 내부에서 모델이 간단한 JavaScript 코드를 작성하여 파일 읽기, 검색, 결과 가공을 한 번의 왕복으로 처리합니다.
  ```js
  // exec_read 예시: 여러 파일을 읽고 필요한 내용만 추출하여 반환
  const data = await tools.read({ paths: ["/workspace/src/app.ts", "/workspace/src/config.ts"] });
  text(data);
  ```
- **대규모 출력 제어**: 파일 내용이나 터미널 출력이 수 MB에 달해도 모델 컨텍스트를 마비시키지 않으며, `text(...)` 및 `image(...)` 같은 명시적 출력 헬퍼를 통해 필요한 결과만 안전하게 반환합니다.
- **비동기 긴 작업 제어**: 10초 이상의 긴 작업은 백그라운드 셀로 양보(`yield`)된 뒤 `wait` 도구를 통해 폴링 및 출력을 수집합니다.

### 2. CUA Driver 내장 및 화면/커서 분리 (Embedded CUA Runtime)
- **내장형 임베디드 런타임**: 외부 CuaDriver 데몬이나 별도 앱 설치 없이, 검증된 CUA Driver(0.29.1) 바이너리와 SDK를 앱 프로세스 내부에 자체 임베디드 형태로 탑재했습니다.
- **작업 방해 없는 브라우저 제어 (Background Chrome CDP)**:
  - 브라우저 탭 제어(`browser_snapshot`, `browser_click` 등)는 Chrome 확장 프로그램의 디버거 인터페이스를 통해 **백그라운드에서 직접 수행**됩니다.
  - 브라우저 조작 중에도 **사용자의 실제 마우스 커서나 OS 창 포커스를 전혀 빼앗지 않습니다.**
- **독립된 OS 네이티브 제어 (Native Desktop CUA)**:
  - 전체 화면 캡처, OS 창 제어, 네이티브 키/마우스 입력이 필요한 경우에만 세션 격리와 명시적인 macOS 권한(화면 기록, 손쉬운 사용) 하에 독립적으로 실행됩니다.

### 3. MCP 서버 데몬화 (Headless Node.js Daemon)
- **GUI 없는 독립 백그라운드 런타임**: Electron 창 없이도 순수 Node.js 프로세스로 구동되는 **`wgpt daemon`**을 지원합니다.
- **단일 작업 원장 (`work.sqlite`)**: 데스크톱 GUI 앱과 CLI 데몬이 동일한 Core / Desktop / Plugins MCP 엔드포인트 및 영속 작업 원장을 공유합니다.
- **원격 및 모바일 지속성**: 창을 닫거나 터미널 세션이 종료되어도 백그라운드에서 작업이 유지되며, 동일한 대화창을 통해 모바일(ChatGPT 앱)이나 로컬 CLI(`wgpt work`)로 작업 상태를 모니터링하고 제어할 수 있습니다.

### 4. 격리된 Git Worktree 기반 멀티 에이전트
- **작업 공간 오염 방지**: 메인 에이전트와 서브 워커 에이전트가 사용자의 작업 트리를 직접 건드리지 않고, 각 작업마다 전용 Git Worktree(`wgpt/<work_id>/...`)를 생성하여 병렬로 코드를 수정합니다.
- **안전한 통합**: 작업이 완료되고 검증을 통과한 변경사항만 통합 브랜치를 거쳐 적용됩니다.

### 5. 네이티브 한국어 로케일 완비
- 설정(Settings), 셋업 가이드, 복구 카운트다운 타이머, 에이전트 통신 및 도구 실행 결과창까지 매끄러운 한국어 UI를 기본 제공합니다.

---

## 런타임 및 도구 구조

Web GPT Agent는 3개의 논리적 MCP 엔드포인트를 노출합니다. 일반적인 코딩 및 작업 제어에는 **Core** 하나만 등록하면 충분합니다.

```text
       ChatGPT Web (Model / Browser)
                   │
           [MCP over Tunnel]
                   ▼
┌──────────────────────────────────────────────┐
│             Web GPT Agent                    │
│   (Electron Backend  또는  wgpt daemon)       │
├──────────────────────┬───────────────────────┤
│ Core (`...-core`)    │ Desktop (`...-desktop`)│
│  - exec_read, exec   │  - Browser Tab Tools  │
│  - wait, tools_search│  - Native CUA Driver  │
│  - work (작업 제어)  │    (Screen / Input)   │
│  - agents (워커 분업)│                       │
├──────────────────────┴───────────────────────┤
│ Plugins (`...-plugins`): 외부 MCP 프록시      │
└──────────────────────────────────────────────┘
```

| 커넥터 이름 | MCP 서버 식별자 | 주요 제공 도구 | 설명 |
|---|---|---|---|
| **Web GPT Agent** | `web-gpt-agent-core` | `exec_read`, `exec`, `wait`, `tools_search`, `work`, `agents` | 파일 읽기/편집, 터미널 실행, 워크트리 작업 제어, 멀티 워커 조율 |
| **Web GPT Agent Desktop** | `web-gpt-agent-desktop` | `exec`, `wait`, `tools_search` | 백그라운드 브라우저 탭 조작 + 내장 CUA 화면/입력 제어 (선택 사항) |
| **Web GPT Agent Plugins** | `web-gpt-agent-plugins` | `exec`, `wait`, `tools_search` | 로컬/원격 외부 MCP 서버 연동 (선택 사항) |

---

## CLI 명령어 가이드 (`wgpt`)

패키지된 CLI(`wgpt`) 또는 소스 빌드를 통해 호스트와 작업을 직접 제어할 수 있습니다.

### 1. 백엔드 호스트 및 데몬 제어
```sh
# Electron 백엔드 제어 (GUI 연동)
wgpt host start
wgpt host status
wgpt host stop

# 순수 Node.js 헤드리스 데몬 제어 (GUI 불필요)
wgpt daemon start --data-dir /path/to/data
wgpt daemon status --data-dir /path/to/data
wgpt daemon stop --data-dir /path/to/data
```

### 2. 로컬 작업(Work) 관리
```sh
# 새로운 격리 작업 시작
wgpt work start --project /absolute/path/to/repo --goal "빌드 에러 수정 및 테스트 통과"

# 작업 목록 조회 및 상태 확인
wgpt work list
wgpt work status <work_id>

# 실행 중인 작업에 조향 메시지 전송
wgpt work instruct <work_id> --text "README 변경사항도 함께 정리해줘"

# 작업 일시정지 및 재개
wgpt work pause <work_id>
wgpt work resume <work_id>

# 실시간 이벤트 스트림 확인
wgpt work events <work_id> --follow
```

---

## 빌드 및 시작하기

### 사전 요구사항
- **Node.js**: 22 이상
- **운영체제**: macOS 13 Ventura 이상 (Apple Silicon 권장), Windows 10/11, Linux
- **브라우저**: Chrome 계열 (Chrome, Edge, Brave 등)

### 소스에서 빌드
```sh
# 1. 의존성 설치 및 필수 바이너리 준비
npm ci
npm run rg          # 내장 ripgrep 준비
npm run tunnel      # 터널 클라이언트 준비

# 2. 애플리케이션 및 CLI 빌드
npm run build

# 3. macOS 언팩 번들 패키징
npm run dist:dir:mac:arm64
```
빌드가 완료되면 `release/mac-arm64/Web GPT Agent.app` 경로에 실행 가능한 애플리케이션이 생성됩니다.

### 초기 설정 순서
1. **앱 실행 및 작업 폴더 승인**:
   - `Web GPT Agent.app` 실행 후 **설정(Settings) → 작업공간(Workspace)**에서 접근을 허용할 폴더를 지정합니다.
2. **공개 터널 연결**:
   - **설정 → 셋업(Setup)**에서 Cloudflare Quick Tunnel 또는 OpenAI Platform 터널을 설정하고 **연결(Connect)**을 누릅니다.
3. **ChatGPT에 MCP 커넥터 등록**:
   - ChatGPT 웹 설정 → **Developer mode** 활성화 후 **Plugins / Custom Apps**에서 `Tunnel` 타입으로 등록합니다.
   - 앱 이름: `Web GPT Agent`
   - URL: 셋업 카드에 표시된 엔드포인트 URL
4. **크롬 확장 프로그램 로드**:
   - 앱 내 **확장 프로그램 폴더 열기** 클릭.
   - Chrome의 `chrome://extensions`에서 **개발자 모드**를 켜고 **압축해제된 확장 프로그램을 로드합니다(Load unpacked)**로 해당 폴더를 선택합니다. (페어링 자동 수행)
5. **대화 시작**:
   - ChatGPT 대화창에서 원하는 모델을 선택하고 작업을 지시하면 로컬 도구가 동작합니다.

---

## 라이선스

이 프로젝트는 [MIT License](LICENSE)에 따라 배포됩니다.
Copyright (c) 2026 Web GPT Agent contributors.
Copyright (c) 2026 Chat On Steroids contributors.
