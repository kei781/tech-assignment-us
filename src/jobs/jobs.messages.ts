/** 응답 사유 메시지. SPEC §4 */
export const MESSAGES = {
  success: 'success',
  notFound: '존재하지 않는 데이터입니다.',
  searchEmpty: '데이터가 존재하지 않습니다.',
  alreadyDone: '이미 완료된 프로세스입니다.',
  inProgress: '처리중인 프로세스입니다.',
  invalidId: 'id는 UUID 형식이어야 합니다.',
} as const;
