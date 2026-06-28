// Shared API + token layer for LiftLog (browser ES module).
const TOKEN_KEY = 'liftlog_token';
const API = '/api';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(token) { localStorage.setItem(TOKEN_KEY, token); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }

export async function api(method, path, body) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    clearToken();
    window.location.href = '/login.html';
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`API ${method} ${path} failed: ${res.status}`);
  return res.json();
}

export const GET    = (path)       => api('GET', path);
export const POST   = (path, body) => api('POST', path, body);
export const PATCH  = (path, body) => api('PATCH', path, body);
export const DELETE = (path)       => api('DELETE', path);
