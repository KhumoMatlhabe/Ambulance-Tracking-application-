export function redirectToLogin() {
  window.location.href = '/login.html';
}

export function clearAuthAndRedirect() {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('user_info');
  redirectToLogin();
}

// Global Logout Utility Function
function logoutUser() {
  clearAuthAndRedirect();
}