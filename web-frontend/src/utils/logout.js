// src/utils/logout.js
export async function logoutAndGoLogin() {
  try {
    const API_BASE = process.env.REACT_APP_API_BASE;
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch (e) {
    // 네트워크 에러여도 어차피 세션은 없어질 수 있으니 그냥 로그인으로 보냄
    console.warn('Logout request failed (ignored):', e);
  } finally {
    // 세션 정리 후 로그인 페이지로
    window.location.replace('/login');
  }
}
