// Runs before first paint on every workbench page: a saved choice wins, else the OS scheme.
try {
  const saved = localStorage.getItem('inklab.theme');
  document.documentElement.dataset.theme = saved === 'light' || saved === 'dark'
    ? saved : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
} catch { document.documentElement.dataset.theme = 'dark'; }
