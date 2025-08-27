# AI 기반 더미 매출 데이터 생성기 PRD

## 1. 개요

AI 기반 더미 매출 데이터 생성기는 사용자가 입력한 조건(예: 연 매출 목표, 데이터 생성 기간)을 기반으로, OpenAI API를 활용해 실제와 유사한 매출 데이터를 자동 생성하는 시스템이다. 생성된 데이터는 CSV 파일로 다운로드하거나, 관리자 DB에 직접 업로드할 수 있다.

## 2. 목표

- OpenAI API를 활용해 조건 기반 더미 매출 데이터 자동 생성
- 관리자가 연 매출 목표와 기간을 선택하여 손쉽게 테스트 데이터 확보
- 생성된 데이터를 CSV로 저장하거나 데이터베이스에 업로드 가능
- 기존 대시보드에 통합된 자연스러운 UI 제공

## 3. 주요 기능

- 사용자 입력 폼: 연 매출 목표, 데이터 기간(1/3/5/7개월)
- OpenAI Prompt 자동 구성 및 API 호출
- GPT 응답 기반 JSON → CSV 변환
- CSV 다운로드 기능
- 관리자 DB로 업로드 기능 (선택)
- 생성 결과를 표 및 그래프로 간략 시각화 (예정)

## 4. 기술 스택

- 프론트엔드: React.js, Tailwind CSS, file-saver, papaparse
- 백엔드: Node.js (Express), OpenAI SDK, csv-writer
- API: OpenAI GPT-4 API
- 파일 포맷: CSV

## 5. 디렉토리 구조 (예시)

```
src/
  ├── pages/
  │   └── ProductAIGenerator.js          # 전체 페이지
  ├── components/
  │   └── AIDummyDataGenerator.js        # 입력 UI 및 기능
  └── utils/
      └── promptBuilder.js               # CSV 변환 유틸
server/
  ├── routes/
  │   └── dummySalesRouter.js
  ├── controllers/
  │   └── dummySalesController.js
  └── services/
      └── openaiService.js               # GPT 프롬프트 생성 및 호출
```

## 6. 화면 설계

- **AI 데이터 생성 카드**: 오늘 매출 카드 아래 배치
  - 연 매출 목표 (입력 필드)
  - 기간 선택 (1/3/5/7개월 드롭다운)
  - 생성 버튼 → 로딩 상태 → 결과 확인
- **생성 결과 모달**: 배경 블러 처리
  - CSV 다운로드 버튼
  - (선택) DB 업로드 버튼

## 7. API 연동 예시

- `POST /api/dummy-sales/generate`  
  → GPT-4에 프롬프트 전송 후 응답(JSON) 반환

- `GET /api/dummy-sales/download`  
  → CSV로 변환하여 클라이언트에 다운로드 제공

- `POST /api/dummy-sales/upload`  
  → 생성된 데이터를 DB에 삽입

## 8. 프롬프트 예시 (OpenAI API용)

```
사용자는 연 매출 목표 3억 원, 데이터 기간 3개월을 선택했습니다.
이에 따라 다음 조건의 더미 매출 데이터를 생성해주세요:

- 총 매출 합계가 약 7,500만 원 수준이 되도록 조정
- 날짜별로 상품명, 카테고리, 판매수량, 단가, 매출액을 포함
- 인기 상품은 전체 매출의 20% 이상 차지
- 주말은 평일 대비 매출 상승
- 현실적인 유통매장 판매 흐름 반영

출력 형식은 JSON 배열로, 다음 구조를 따릅니다:
[
  {
    "date": "2025-05-01",
    "product": "삼다수 500ml",
    "category": "생수",
    "quantity": 30,
    "price": 1000,
    "total": 30000
  },
  ...
]
```

## 9. 일정

- PRD 작성: 2025-08-01  
- 기능 개발 시작: 2025-08-02  
- 프론트+백엔드 연동 완료: 2025-08-05  
- 테스트 및 시각화 추가: 2025-08-07  
- 기능 배포: 2025-08-10  

## 10. 기타

- 관리자만 사용할 수 있도록 권한 체크 필요
- 향후 분류별 인기 상품 통계 연동 가능
- GPT 응답 실패 대비 에러 핸들링 및 재시도 처리
