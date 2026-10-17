import {expect,type BrowserContext} from '@playwright/test';
const origin='http://127.0.0.1:3107';
// Share only a test administrator cookie across files. Repeated setup logins
// must not consume the production login limiter's capacity for the UI test.
export const auth=new Map<string,{csrf:string;cookies:Awaited<ReturnType<BrowserContext['cookies']>>}>();
export async function signIn(context:BrowserContext){
  const cached=auth.get('admin');if(cached){await context.addCookies(cached.cookies);return cached.csrf;}
  const login=await context.request.post('/api/auth/login',{headers:{Origin:origin},data:{password:'TEST_ONLY-browser-password'}});
  expect(login.ok(),await login.text()).toBeTruthy();const {csrf}=await login.json();
  auth.set('admin',{csrf,cookies:(await context.cookies()).filter(cookie=>cookie.name==='lab_admin')});return csrf as string;
}
