import { doMaintenance } from '../../lib/api.mjs';
import { storeErrorDetail } from '../../lib/store.mjs';
export default async () => {
  try{if(!process.env.DATABASE_URL || !process.env.SETUP_TOKEN)throw Error('Missing DATABASE_URL or SETUP_TOKEN');const result=await doMaintenance();console.log('[daily-settlement]',JSON.stringify(result));return new Response('OK');}
  catch(e){console.error('[daily-settlement]',e.code||'SETTLEMENT_ERROR',e.message+storeErrorDetail(e));return new Response('Error',{status:500});}
};
