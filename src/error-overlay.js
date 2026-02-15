// Error overlay — catches uncaught errors and unhandled rejections
window.addEventListener('error', function (event) {
  const overlay = document.getElementById('error-overlay');
  overlay.style.display = 'block';
  overlay.innerText += 'Error: ' + event.message + '\nAt: ' + event.filename + ':' + event.lineno + ':' + event.colno + '\n\n';
});
window.addEventListener('unhandledrejection', function (event) {
  const overlay = document.getElementById('error-overlay');
  overlay.style.display = 'block';
  overlay.innerText += 'Unhandled Rejection: ' + event.reason + '\n\n';
});
