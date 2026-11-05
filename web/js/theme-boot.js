// Before anything is drawn: the colour theme this person chose last time (js/theme.js keeps it here).
try { var c = localStorage.getItem('sw-theme-css'); if (c) { var s = document.createElement('style'); s.id = 'theme-vars'; s.textContent = c; document.head.appendChild(s); } } catch (e) { /* private window */ }
