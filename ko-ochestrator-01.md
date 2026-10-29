# 별도 Orchestrator Agent의 호출 및 연계 구조

**별도의 Orchestrator Agent를 만든다면, 다른 에이전트의 API를 도구(tool)로 등록하고 모델이 필요한 도구를 선택하는 방식으로 연동한다.** 실제 HTTP 요청은 모델이 아니라 **에이전트 실행 코드(runtime)**가 수행한다.

## 1. 호출 구조

```text
사업자 포털
    ↓ 신청 제출
업무 API
    ↓ 작업 생성
Orchestrator Agent
    │
    │ 모델: 현재 상태를 보고 호출할 도구 선택
    ↓
도구 실행 코드
    ↓ 인증된 HTTP 요청
Data Assembly / Underwriting 등 에이전트 API
    ↓ 처리 결과
도구 실행 코드
    ↓ 구조화된 결과 전달
Orchestrator Agent
    ↓ 다음 행동 선택 또는 대기·종료
```

예를 들어 Data Assembly 호출은 다음 세 단계로 이루어진다.

```text
모델의 도구 선택:
  start_data_collection(application_id="app-001")

도구 실행 코드:
  POST data-assembly-service/v1/collection-jobs

서비스의 응답:
  {"job_id": "job-001", "status": "PENDING"}
```

**모델은 “수집 작업을 시작하라”를 선택하고, 코드는 주소·인증·요청 형식·접근권한을 책임진다.** 서비스 URL이나 인증 토큰을 모델이 임의로 생성하게 하지 않는다.

## 2. 제공할 도구

원문의 5개 에이전트와 연결하는 도구를 만들 수 있다.

| 도구 예시 | 연결 대상 | 용도 |
|---|---|---|
| `get_consent_status` | Consent Lifecycle | 현재 동의 범위와 상태 확인 |
| `start_data_collection` | Data Assembly | 허용된 범위의 수집 시작 |
| `get_collection_status` | Data Assembly | 수집 상태와 데이터 묶음 확인 |
| `request_underwriting` | Cash-Flow Underwriting | 검증된 자료로 평가 요청 |
| `request_risk_review` | Early-Warning | 갱신된 자료의 위험 징후 분석 요청 |
| `request_collection_support` | Collections | 상환 상태에 맞는 안내·지원 검토 요청 |

이는 내부 도구 이름의 예시다. **모든 도구를 모든 상황에 노출할 필요는 없다.** 신청 심사 중에는 채권 회수 도구를 사용할 수 없도록 상태에 따라 제한한다.

또한 `get_consent_status`를 먼저 호출했더라도 **실제 데이터 수집 도구에서 동의를 다시 검사**해야 한다. 모델의 호출 순서는 보안 경계가 아니다.

## 3. 결과를 보고 다음 요청을 선택하는 협업

예를 들어 Data Assembly가 다음 결과를 반환했다고 가정한다.

```json
{
  "status": "NEEDS_ATTENTION",
  "dataset_id": "dataset-001",
  "issues": [
    {
      "code": "PG_STATUS_UNRESOLVED",
      "settlement_id": "settlement-012"
    }
  ],
  "allowed_actions": [
    "refresh_pg_status",
    "request_human_review"
  ]
}
```

Orchestrator Agent는 상황을 보고 허용된 행동을 선택한다.

```text
첫 조회에서 일시적인 갱신 지연
    → PG 상태 재조회 요청

재조회 후에도 지급 여부 불명확
    → 담당자 확인 요청

필수 검증 통과
    → 여신 평가 요청
```

이때 `allowed_actions`는 **코드의 정책 판정 결과**여야 하며, 실행 직전에도 다시 검증한다. 모델은 ‘필수 검증을 생략하고 심사를 진행’하는 새 행동을 만들어 실행할 수 없다.

## 4. 오래 기다리는 작업은 Agent 혼자 관리하지 않는다

LLM 에이전트는 다음 문제를 자동으로 해결해주지 않는다.

- 고객이 내일 자료를 보완하는 경우.
- 담당자가 몇 시간 뒤 승인하는 경우.
- 서비스가 재시작되는 경우.
- 같은 완료 알림이 두 번 도착하는 경우.

따라서 **Orchestrator Agent를 만들더라도 DB·백그라운드 실행기 또는 Durable 같은 지속 실행 기반은 필요하다.**

```text
작업 완료·고객 응답·담당자 결정
              ↓
지속 실행 기반이 사건과 상태를 저장
              ↓
필요할 때 Orchestrator Agent 실행
              ↓
모델이 다음 행동 제안
              ↓
정책 검사 후 도구 실행
              ↓
결과 저장 → 대기 또는 종료
```

대기하는 동안 LLM을 계속 호출하지 않는다. 폴링 간격·타임아웃·재시도 횟수는 코드가 관리한다.

## 5. Durable과 함께 사용할 때의 역할 분담

| 구성 | 책임 |
|---|---|
| Durable Orchestrator | 실행 이력, 대기, 타이머, 재시도, 복구 |
| Orchestrator Agent | 현재 상황에서 다음에 수행할 허용된 작업 선택 |
| 5개 업무 에이전트 | 데이터 취합·심사·경보·상환 지원·동의 관리 |
| 정책·도구 코드 | 권한, 선행조건, 실제 API 호출, 중복 실행 방지 |

Durable 안에서는 Orchestrator Agent 호출 자체를 **Activity로 실행**한다. 모델 호출을 재생되는 Orchestrator 본문에 직접 넣지 않는다.

**다만 이번 프로젝트는 주요 업무 순서가 명확하므로, 별도 LLM Orchestrator가 반드시 필요하지는 않다.** 도입한다면 ‘자료 문제에 따라 재조회·보완·담당자 이관을 조율하는 역할’처럼 분명한 판단 가치를 부여해야 한다.

단순히 정해진 순서대로 5개 API를 호출한다면 코드 오케스트레이터가 더 단순하고 예측 가능하다.
