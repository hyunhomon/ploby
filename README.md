# Ploby

**Declared function (GWDC Challenge B):** Ploby keeps an AI purchasing agent's spending inside the budget a client funded: the agent can only *request* purchases, code decides each request against a policy both parties signed, a contract on Monad testnet holds and moves the money, and every approval and every stop is recorded so that anyone can reconstruct whether a payment was allowed.

**기능 선언:** Ploby는 클라이언트가 예치한 예산 안에서만 AI 구매 에이전트가 돈을 쓰게 합니다. 에이전트는 구매를 *요청*만 할 수 있고, 양측이 서명한 정책으로 코드가 요청마다 판정하며, Monad testnet 컨트랙트가 돈을 보관·지급하고, 모든 승인과 멈춤이 기록되어 누구든 지급이 허용 범위 안이었는지 재구성할 수 있습니다.

> **AI는 정보를 해석하지만 돈을 움직일 권한은 갖지 않습니다.**

외주 프로젝트의 **작업 대금과 프로젝트 경비를 미리 확보하고, 양측이 합의한 조건에 따라 지급하는 양자 간 에스크로**입니다. 사용자는 홈페이지 리뉴얼을 맡긴 작은 카페(클라이언트, 카페 온담)와 이를 맡은 웹 스튜디오(작업자, 한결웹스튜디오)입니다. 도메인·호스팅·디자인 툴 같은 프로젝트 경비는 작업자가 선결제하고 나중에 받지 못하거나, 클라이언트가 카드를 넘겨주고 무엇이 왜 결제됐는지 모르는 문제가 있습니다. 결제 레일은 누가 누구에게 보냈는지만 남기고, 누가 어떤 조건으로 허락했는지는 남기지 않습니다.

## Challenge B 한눈에

| 기준 | Ploby에서 | 증거 |
| --- | --- | --- |
| Declared function & user need | 위 한 문장. **AI가 하는 일**: 작업자의 구매 에이전트가 견적을 골라 구매 계획을 세움, 견적서·영수증 판독, 경비 규칙 문장을 규칙으로 컴파일(두 번의 독립 판독), 변경 주문 초안. **코드가 하는 일**: 모든 판정(§6 순서의 규칙), 돈의 예약·지급·환불, 기한과 타임아웃, 서명된 해시 체인 로그, 체인 호출 | [`escrow/agent.py`](escrow/agent.py), [`escrow/ai.py`](escrow/ai.py), [`escrow/expenses.py`](escrow/expenses.py) |
| Boundaries & stopping | 경계 = 양측이 서명한 정책(허용 공급자·카테고리, **부가세·수수료 포함** 건별 한도, 경비 예산, 기간, 가용 잔액, 클라이언트 일시정지). 강제 위치 ① 엔진이 돈을 예약하기 전에 에이전트 말이 아니라 공급자 문서를 직접 읽어 규칙 적용 ② 컨트랙트가 정책의 작업자 지갑에만 지급, 예치금 초과 불가, 일시정지 중 새 예약 불가. 멈춤도 BLOCK/HOLD 판정으로 로그와 체인에 기록 | [`docs/evidence.md`](docs/evidence.md): 경계 밖으로 밀어낸 실행 5건(부가세로 한도 초과, 목록 밖 공급자, 인젝션 청구서, 클라이언트 정지, 기간 경과) 모두 로그 줄 + tx |
| Kiln integration & efficiency | Kiln `qwen3-32b` (주최 측이 gpt-oss-120b에서 모델을 바꿈 — Kiln에서 gpt-oss-120b는 404). 흐름별 계측: `agent`, `quote`, `write`/`read`/`reread`, `change`. 결제 판정에는 LLM 호출 0회, 규칙은 프로젝트당 한 번 컴파일, 요청마다 문서 판독 1회, 캐시·프리픽스 캐시 | [`docs/efficiency.md`](docs/efficiency.md), `python3 harness/usage_report.py` |
| Blockchain integration | Monad testnet(10143) [PlobyEscrow `0x0c54…1762`](https://testnet.monadvision.com/address/0x0c54143Ba8480c9C041E27C5FDed6e13B2541762) + [tKRW `0xE73a…af58`](https://testnet.monadvision.com/address/0xE73a03D814434987f33f5E2b6b51c1dD8A44af58). 엔진은 판정 전에 컨트랙트의 **일시정지 여부와 가용 잔액을 읽고**, 판정을 **기록하고**(decide), 돈을 **정산**(settle·refund)합니다. 모든 호출에 그 로그 줄의 해시 체인 헤드가 실리고, tx 해시는 로그에 되써집니다 | [`docs/chain.md`](docs/chain.md), [`src/PlobyEscrow.sol`](src/PlobyEscrow.sol), [`evidence/`](evidence) |
| Approval & evidence | 클라이언트가 예산 부여(정책 서명 + 예치 tx), 지출 추적(에이전트 작업·판정·tx 링크, 온체인 잔액 대 원장), 에이전트 정지(일시정지 tx → 다음 요청 BLOCK 기록), 영수증(정산 기록 + 검증 탭). 제3자는 기록만으로 재구성: `python3 -m escrow.audit` | [`escrow/audit.py`](escrow/audit.py), 화면의 **검증** 탭, [`evidence/audit.txt`](evidence/audit.txt) |

증거를 직접 다시 확인하려면 (키 없이, 공개 RPC만 사용):

```bash
python3 -m escrow.audit evidence/projects/p16821e868189/log.jsonl --data evidence
```

제품의 목적, 흐름, 의사결정, 권한, 회계는 [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md)가 1급 기준이며, 이 문서는 수정하지 않는 불변 문서입니다 (문서 안에서는 제품을 이전 이름인 SmartEscrow로 부릅니다). 그 문서 §22에 따라 현재 동작은 코드와 테스트가 기준이고, 이 README와 [`docs/api.md`](docs/api.md)가 현재 구현을 설명합니다. 목표 아키텍처의 세부 결정은 [`docs/adr`](docs/adr/README.md)에 있습니다. 아래에서 **현재 구현**과 **목표 설계**를 구분해 적습니다.

## 현재 구현

| 영역 | 현재 구현 | 목표 설계 (미구현) |
| --- | --- | --- |
| 정책 | 양측이 같은 정책 해시에 서명해야 발효되는 불변·버전형 정책. 경비 규칙은 PCP 규칙 언어(양식 또는 문장 → 두 번의 독립 판독 → 읽어드리기) | RFC 8785 + keccak256, EIP-712 서명 (현재: 정렬 JSON + sha256, 데모 키 HMAC 서명) |
| 작업 대금 | 선예치·예약된 마일스톤, 제출 통지, 클라이언트 검수 기한, 인수 기준 기반 이의, 분쟁 해결자, 침묵 시 지급, 미납·착수 기한 | 온체인 제출 통지와 기한 |
| 경비 | 구매 전 약정 → 구매 보고 → 영수증 제출 통지 → 정산, 사후 청구, 약정 상한 초과분은 변경 주문. **작업자의 구매 에이전트**가 계획을 세워 요청을 올림 (BLOCK이면 다음 후보, HOLD면 대기, 정지면 중단) | 공급자 직접 지급, 외화 |
| 판정 | §6 순서의 결정론적 규칙(배분·상태·기간·결제 방식·공급자·카테고리·수취인·건별 한도·경비/카테고리 예산·가용 잔액) → BLOCK, 판독 불신·위험 신호(중복·분할·가격 이상) → HOLD, 모두 통과 → APPROVE(예약). 컨트랙트의 일시정지·가용 잔액을 판정 전에 읽어 더 엄격한 쪽을 따름 | 증빙 확인 서비스, 인보이스 배분 레지스트리 |
| HOLD | 유형별(CLIENT_REVIEW, POLICY_OR_SYSTEM_AMBIGUITY, EVIDENCE_DEFECT, INTEGRITY_RISK, EXCESS_AMOUNT) 클라이언트 기한·분쟁 해결 기한·최종 대체 결과, 누구나 실행하는 타임아웃 | 체인 시간 기준 permissionless 타임아웃 |
| 생명주기 | DRAFT → ACTIVE → CLOSING → CLOSED / CANCELLED, 새 약정 일시정지, 미예약 잔액 환불 | 보안 동결, RECOVERY_ONLY, 마이그레이션 |
| 기록 | 모든 변경이 서명된 해시 체인 로그 한 줄, 로그만으로 같은 상태 재생. 원문 증빙은 로그 밖에 저장하고 로그에는 해시·매니페스트 해시만. 체인 호출마다 로그 헤드가 온체인에 남음 | 암호화 증빙 저장소 |
| 집행 | **Monad testnet `PlobyEscrow`**: 예치·예약·지급·환불을 온체인에서 집행하고 APPROVE·HOLD·BLOCK 판정을 기록. 판정 자체는 오프체인 엔진 | 프로젝트별 불변 `ProjectEscrow`가 판정까지 강제 |
| AI | Kiln `qwen3-32b`: 구매 계획(에이전트), 경비 규칙 문장, 견적서·영수증 판독, 변경 주문 초안. 실패하면 HOLD 또는 계획 없음, 절대 자동 승인 없음. 모델의 사고 과정은 저장하지 않음 | — |
| 감사 | `python3 -m escrow.audit`: 서명·해시 체인·재생, 지급마다 근거(정책·규칙·승인·대체 결과), 멈춤 목록, 로그의 tx를 공개 체인과 대조 | — |
| 화면 | 역할별 공간(클라이언트·작업자·분쟁 해결자), 한국어·영어, 구매 에이전트, 온체인 잔액, **검증** 탭, 데모 시계 | 지갑 로그인 |

`src/ExpenseEscrow.sol`은 Base Sepolia용 레거시 프로토타입으로 저장소에 남아 있지만 **현재 앱과 연결되어 있지 않습니다.** 앱은 `src/PlobyEscrow.sol`을 씁니다. 두 컨트랙트 모두 테스트넷 전용이며 실제 자금에 사용하면 안 됩니다 ([`DECISIONS.md`](DECISIONS.md)).

## 실행

필요한 것: Python 3 (표준 라이브러리만), Node.js 20.19+ 또는 22.12+와 npm, 선택 사항으로 Kiln API 키와 Foundry(체인 쓰기용 `cast`).

```shell
cp .env.example .env            # KILN_API_KEY를 넣으면 실제 판독, 없으면 판독이 HOLD가 됨. 체인 키를 넣으면 온체인 미러링
python3 -m escrow.server        # 저장소 루트에서 실행. API: http://127.0.0.1:3010/api  (데이터: var/)
cd frontend && npm ci && npm run dev        # 화면: http://localhost:5173  (/api를 3010으로 프록시)
```

화면 오른쪽 위에서 한국어·영어와 클라이언트·작업자·분쟁 해결자의 공간을 전환합니다. 선택한 언어는 브라우저에 저장됩니다. 상세 화면은 요약·작업·경비·계약·변경 요청·기록·검증·관리로 나뉩니다. 요약에는 예약 대금, 우선 확인할 일, 온체인 잔액과 엔진 원장 비교를 표시합니다. 작업자는 **경비** 탭에서 구매 에이전트에게 일을 맡기고, 클라이언트는 같은 탭에서 에이전트가 무엇을 요청했고 규칙이 무엇을 답했는지 봅니다. **데모 도구**를 열면 데모 시계로 시간을 앞당길 수 있습니다. 경과한 기한의 최종 대체 결과가 적용됩니다. 새 프로젝트는 기본 정보 → 경비 규칙 → 작업과 대금 → 확인 및 생성 순서로 작성합니다. 시각·상호작용 규칙은 [디자인 시스템](docs/design-system.md)을 참고하세요. 샘플 문서(견적서·영수증·제출물)는 `escrow/quotes/`, `escrow/samples/`에 있습니다. 3분 데모 순서는 [`docs/demo.md`](docs/demo.md)에 있습니다.

## 검증

```shell
python3 harness/check.py        # 오프라인 검사 60개: 모델·네트워크 없이 PROJECT_OVERVIEW 원칙, 에이전트, 감사, 컨트랙트 규칙(파이썬 모델) 확인
forge test                      # PlobyEscrow 12개 + 레거시 컨트랙트 테스트
cd frontend && npm run build    # 타입 검사 + 프로덕션 빌드
python3 harness/evidence.py     # Kiln + Monad testnet으로 챌린지 증거 실행 (docs/evidence.md, evidence/)
python3 -m escrow.audit <프로젝트 id>   # 기록만으로 검증 (var/ 또는 --data)
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
| `escrow/ai.py`, `escrow/agent.py` | Kiln 판독(경비 규칙, 문서, 변경 주문 초안)과 작업자의 구매 에이전트 — 모델 출력만 기록 |
| `escrow/chain.py`, `src/PlobyEscrow.sol`, `src/TestKRW.sol` | 로그를 컨트랙트 호출로 바꾸는 미러와 Monad testnet 컨트랙트 (`deployments/monad-testnet.json`, `script/deploy_ploby.py`) |
| `escrow/audit.py` | 기록만으로 하는 감사 |
| `frontend/` | React 19 + Vite 7 역할별 화면 |
| `harness/check.py`, `harness/evidence.py` | 오프라인 검증, 챌린지 증거 실행 |
| `evidence/` | 증거 실행의 로그·증빙 파일·감사 결과 |
| `src/ExpenseEscrow.sol`, `script/Deploy.s.sol` | 레거시 Solidity 프로토타입 (현재 앱과 미연결) |
| `docs/` | 제품·흐름·아키텍처·용어·ADR·Kiln·API·체인·효율·증거 문서 |

## 한계

- 판정은 오프체인 엔진이 합니다. 컨트랙트는 돈의 이동(지급 대상·금액 상한·일시정지)을 강제하고 판정을 기록하지만, 규칙 자체를 온체인에서 다시 계산하지는 않습니다. 운영자 키가 탈취되면 정책 밖 판정을 기록할 수는 있어도, 작업자 외에게 돈을 보내거나 예치금보다 많이 움직일 수는 없습니다.
- 서명은 서버가 보관한 데모 키의 HMAC입니다. 역할 전환은 지갑 로그인이 아니며, 데모 클라이언트 지갑과 운영자 키는 서버의 `.env`에 있습니다.
- 증빙은 텍스트 문서(E1)만 받고, 암호화 없이 `var/docs/`에 저장합니다.
- 분쟁 해결자는 미납 단위를 거절만 할 수 있습니다 (해지 보상은 미구현).
- tKRW 테스트 토큰 전제의 데모이며, 규제·수탁·보안 감사는 비범위입니다 ([`PROJECT_OVERVIEW.md` §18](PROJECT_OVERVIEW.md#18-현재-한계와-비범위)).
