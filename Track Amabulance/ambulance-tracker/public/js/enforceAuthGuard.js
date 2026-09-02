const { redirectToLogin, clearAuthAndRedirect } = require("./auth-check");

/**
 * Client-Side Authentication Guard & Role Authorization
 * @param {Array<string>} requiredRoles - Allowed roles for the current page (e.g. ['DISPATCHER'])
 */
function enforceAuthGuard(requiredRoles = []) {
  const token = localStorage.getItem('auth_token');
  const userInfoRaw = localStorage.getItem('user_info');

  // 1. Redirect if token or user info is missing
  if (!token || !userInfoRaw) {
    console.warn("🔒 No authentication token found. Redirecting to login...");
    redirectToLogin();
    return null;
  }

  try {
    const user = JSON.parse(userInfoRaw);

    // 2. Decode JWT payload to check token expiration (without external libraries)
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    const jwtPayload = JSON.parse(jsonPayload);

    // Check expiration timestamp (exp is in seconds)
    const currentTime = Math.floor(Date.now() / 1000);
    if (jwtPayload.exp && jwtPayload.exp < currentTime) {
      alert("Your session has expired. Please log in again.");
      clearAuthAndRedirect();
      return null;
    }

    // 3. Role-Based Authorization Check
    if (requiredRoles.length > 0 && !requiredRoles.includes(user.role)) {
      alert(`Access Denied: Your account role (${user.role}) is not authorized to view this page.`);

      // Redirect user to their appropriate view based on role
      if (user.role === 'DRIVER') window.location.href = '/driver.html';
      else if (user.role === 'PATIENT') window.location.href = '/patient.html';
      else window.location.href = '/login.html';

      return null;
    }

    return user; // Successfully authenticated

  } catch (err) {
    console.error("Invalid token or user payload:", err);
    clearAuthAndRedirect();
    return null;
  }
}
