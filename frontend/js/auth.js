import { setToken } from './api.js';

const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      errorEl.textContent = 'Invalid username or password';
      return;
    }
    const data = await res.json();
    setToken(data.token);
    window.location.href = '/';
  } catch (err) {
    errorEl.textContent = 'Could not connect to server';
  }
});
