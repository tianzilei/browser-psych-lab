try {
  const response=await fetch('/api/auth/me');
  if(response.ok)await import('./main.js');
  else location.replace('/');
} catch {location.replace('/');}
export {};
