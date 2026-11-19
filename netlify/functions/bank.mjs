import { handleApi } from '../../lib/api.mjs';
export default async (request) => {
  if(!process.env.DATABASE_URL || !process.env.SETUP_TOKEN)return new Response(JSON.stringify({error:'服务器尚未配置 DATABASE_URL 和 SETUP_TOKEN'}),{status:503,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  return handleApi(request);
};
export const config={path:'/api/*'};
