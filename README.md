# Ploby

외주 프로젝트의 **작업 대금과 프로젝트 경비를 미리 확보하고, 양측이 합의한 조건에 따라 지급하는 양자 간 에스크로**입니다.

> **AI는 정보를 해석하지만 돈을 움직일 권한은 갖지 않습니다.**

제품의 목적, 흐름, 의사결정, 권한, 회계는 [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md)가 1급 기준이며, 이 문서는 수정하지 않는 불변 문서입니다 (문서 안에서는 제품을 이전 이름인 SmartEscrow로 부릅니다). 그 문서 §22에 따라 현재 동작은 코드와 테스트가 기준이고, 이 README와 [`docs/api.md`](docs/api.md)가 현재 구현을 설명합니다. 목표 아키텍처의 세부 결정은 [`docs/adr`](docs/adr/README.md)에 있습니다. 아래에서 **현재 구현**과 **목표 설계**를 구분해 적습니다.

## 현재 구현

| 영역 | 현재 구현 | 목표 설계 (미구현) |
| --- | --- | --- |
| 정책 | 양측이 같은 정책 해시에 서명해야 발효되는 불변·버전형 정책. 경비 규칙은 PCP 규칙 언어(양식 또는 문장 → 두 번의 독립 판독 → 읽어드리기) | RFC 8785 + keccak256, EIP-712 서명 (현재: 정렬 JSON + sha256, 데모 키 HMAC 서명) |
| 작업 대금 | 선예치·예약된 마일스톤, 제출 통지, 클라이언트 검수 기한, 인수 기준 기반 이의, 분쟁 해결자, 침묵 시 지급, 미납·착수 기한 | 온체인 제출 통지와 기한 |
| 경비 | 구매 전 약정 → 구매 보고 → 영수증 제출 통지 → 정산, 사후 청구, 약정 상한 초과분은 변경 주문 | 공급자 직접 지급, 외화 |
| 판정 | §6 순서의 결정론적 규칙(배분·상태·기간·결제 방식·공급자·카테고리·수취인·건별 한도·경비/카테고리 예산·가용 잔액) → BLOCK, 판독 불신·위험 신호(중복·분할·가격 이상) → HOLD, 모두 통과 → APPROVE(예약) | 증빙 확인 서비스, 인보이스 배분 레지스트리 |
| HOLD | 유형별(CLIENT_REVIEW, POLICY_OR_SYSTEM_AMBIGUITY, EVIDENCE_DEFECT, INTEGRITY_RISK, EXCESS_AMOUNT) 클라이언트 기한·분쟁 해결 기한·최종 대체 결과, 누구나 실행하는 타임아웃 | 체인 시간 기준 permissionless 타임아웃 |
| 생명주기 | DRAFT → ACTIVE → CLOSING → CLOSED / CANCELLED, 새 약정 일시정지, 미예약 잔액 환불 | 보안 동결, RECOVERY_ONLY, 마이그레이션 |
| 기록 | 모든 변경이 서명된 해시 체인 로그 한 줄, 로그만으로 같은 상태 재생. 원문 증빙은 로그 밖에 저장하고 로그에는 해시·매니페스트 해시만 | 암호화 증빙 저장소, 온체인 해시 앵커 |
| 집행 | 오프체인 엔진이 규칙을 집행. `.env`에 배포 주소와 키가 있으면 Base Sepolia `ExpenseEscrow`가 경비 BLOCK·HOLD를 기록하고 정산액을 MockUSDC로 지급. 마일스톤·환불은 오프체인 | 프로젝트별 불변 `ProjectEscrow` |
| AI | Kiln `qwen3-32b`: 경비 규칙 문장, 견적서·영수증 판독, 변경 주문 초안. 실패하면 HOLD, 절대 자동 승인 없음. 모델의 사고 과정은 저장하지 않음 | — |
| 화면 | 역할별 공간(클라이언트·작업자·분쟁 해결자), 데모 시계 | 지갑 로그인 |

`src/ExpenseEscrow.sol`은 Base Sepolia용 레거시 프로토타입입니다. `.env`에 주소와 키가 있으면 앱이 경비 예치·기록·정산을 그 컨트랙트에 보냅니다. 마일스톤 지급, 일시정지, 환불은 장부에 남고 MockUSDC로 움직이지 않습니다. 실제 자금에 사용하면 안 됩니다 ([`DECISIONS.md`](DECISIONS.md)).

## 실행

필요한 것: Python 3 (표준 라이브러리만), Node.js 20.19+ 또는 22.12+와 npm, 선택 사항으로 Kiln API 키와 Foundry.

```shell
cp .env.example .env            # KILN_API_KEY를 넣으면 실제 판독, 없으면 판독이 HOLD가 됨
python3 -m escrow.server        # 저장소 루트에서 실행. API: http://127.0.0.1:3010/api  (데이터: var/)
cd frontend && npm ci && npm run dev        # 화면: http://localhost:5173  (/api를 3010으로 프록시)
```

화면 오른쪽 위에서 한국어·영어와 클라이언트·작업자·분쟁 해결자의 공간을 전환합니다. 선택한 언어는 브라우저에 저장됩니다. 상세 화면은 요약·작업·경비·계약·변경 요청·기록·관리로 나뉘며, 요약에는 예약 대금과 우선 확인할 일 3개를 표시합니다. **데모 도구**를 열면 데모 시계로 시간을 앞당길 수 있습니다. 경과한 기한의 최종 대체 결과가 적용됩니다. 새 프로젝트는 기본 정보 → 경비 규칙 → 작업과 대금 → 확인 및 생성 순서로 작성합니다. 시각·상호작용 규칙은 [디자인 시스템](docs/design-system.md)을 참고하세요. 샘플 문서(견적서·영수증·제출물)는 `escrow/quotes/`, `escrow/samples/`에 있습니다.

## 검증

```shell
python3 harness/check.py        # 오프라인 불변식 47개: 모델·네트워크 없이 PROJECT_OVERVIEW 원칙과 성공 기준 확인
forge test                      # 레거시 컨트랙트 테스트
cd frontend && npm run build    # 타입 검사 + 프로덕션 빌드
python3 -m pcp spend            # Kiln 키 사용액 (팀 공용 예산)
```

## 구조

| 경로 | 내용 |
| --- | --- |
| `pcp/` | 규칙 언어, 두 번의 독립 판독 컴파일러, 읽어드리기, 판정, Kiln 클라이언트(캐시·계측·예산 가드) |
| `pipeline.json`, `domains/escrow.json` | 단계별 모델 라우팅, 공급자 레지스트리와 카테고리 대표값 |
| `escrow/policy.py` | 정책 문서, 해시, 서명, 마일스톤, 최종 대체 결과 표 |
| `escrow/core.py`, `milestones.py`, `expenses.py`, `changes.py`, `engine.py` | 상태와 원장, 마일스톤, 경비, 변경 주문, 키퍼와 역할별 화면 모델 |
| `escrow/store.py`, `escrow/server.py` | 로그 저장·재생, 데모 시계, 증빙 저장소, HTTP API |
| `escrow/ai.py` | Kiln 판독(경비 규칙, 문서, 변경 주문 초안) — 판독 결과만 기록 |
| `frontend/` | React 19 + Vite 7 역할별 화면 |
| `harness/check.py` | 오프라인 검증 |
| `src/`, `test/`, `script/` | 레거시 Solidity 프로토타입. 경비 정산만 앱과 연결 |
| `docs/` | 제품·흐름·아키텍처·용어·ADR·Kiln·API 문서 |

## 한계

- 규칙과 기한은 오프체인 엔진이 집행합니다. 체인은 그 결과 중 경비 예치·BLOCK·HOLD·정산만 복사하고, 실패한 트랜잭션은 로그를 되돌리지 않습니다.
- 서명은 서버가 보관한 데모 키의 HMAC입니다. 역할 전환은 지갑 로그인이 아닙니다.
- 증빙은 텍스트 문서(E1)만 받고, 암호화 없이 `var/docs/`에 저장합니다.
- 분쟁 해결자는 미납 단위를 거절만 할 수 있습니다 (해지 보상은 미구현).
- MockUSDC·테스트 토큰 전제의 데모이며, 규제·수탁·보안 감사는 비범위입니다 ([`PROJECT_OVERVIEW.md` §18](PROJECT_OVERVIEW.md#18-현재-한계와-비범위)).
