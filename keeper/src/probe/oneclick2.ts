import "../env.js";
import { Aptos, AptosConfig, Network, Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import { trackTestAccounts } from "../../../web/scripts/lib/test-accounts.mjs";
trackTestAccounts(Account);
import { getUsdcAddress } from "@decibeltrade/sdk";
import { LiveDecibelClient } from "../hedge/decibel-client.js";
const P="0xd368b820fdfbfe004679cdb0facef4b920c4fc0c2c80bd2fecf3843a93427bd1";
const USDC=getUsdcAddress(P).toString();
const aptos=new Aptos(new AptosConfig({network:Network.TESTNET}));
const hedger=Account.fromPrivateKey({privateKey:new Ed25519PrivateKey(process.env.HEDGER_PRIVATE_KEY!.replace(/^ed25519-priv-/,""))});
const user=Account.generate();
const run=async(sender:Account,f:string,args:any[],fee?:Account)=>{const t=await aptos.transaction.build.simple({sender:sender.accountAddress,withFeePayer:!!fee,data:{function:f as any,functionArguments:args},options:{maxGasAmount:100000}});
 const a=aptos.transaction.sign({signer:sender,transaction:t}); const fp=fee?aptos.transaction.signAsFeePayer({signer:fee,transaction:t}):undefined;
 const r=await aptos.transaction.submit.simple({transaction:t,senderAuthenticator:a,feePayerAuthenticator:fp}); try{const w=await aptos.waitForTransaction({transactionHash:r.hash}); console.log(f.split("::").pop(),w.success,w.vm_status,r.hash,(w as any).gas_used); return w;}catch(e:any){console.log(f.split("::").pop(),"FAIL",e.transaction?.vm_status??e.message,r.hash);} };
await run(hedger,`${P}::usdc::mint`,[user.accountAddress,100_000_000]);
const seeded=(await aptos.view({payload:{function:`${P}::dex_accounts::seeded_subacccount_address` as any,functionArguments:[user.accountAddress,Array.from(Buffer.from("treetrade-hedge"))]}}))[0] as string;
console.log("seeded",seeded);
let w=await run(user,`${P}::dex_accounts_entry::add_delegated_trader_and_deposit_to_subaccount`,[seeded,USDC,100_000_000,hedger.accountAddress,Math.floor(Date.now()/1000)+86400],hedger);
let sub=seeded;
if(!w?.success){ sub=(await aptos.view({payload:{function:`${P}::dex_accounts::primary_subaccount` as any,functionArguments:[user.accountAddress]}}))[0] as string;
 await run(user,`${P}::dex_accounts_entry::add_delegated_trader_and_deposit_to_subaccount`,[sub,USDC,100_000_000,hedger.accountAddress,Math.floor(Date.now()/1000)+86400],hedger);}


import { decibelConfig } from "../hedge/decibel-config.js";
const c=new LiveDecibelClient(decibelConfig(),hedger);
const m=await c.marketSpec("BTC/USD"); const mark=await c.markPrice(m);
const size=(800n*10n**15n/mark)/m.lotSize*m.lotSize; // 800 USD: mark has 6dp, size 9dp
const price=(mark*99n/100n)/m.tickSize*m.tickSize;
console.log("mark",mark,"size",size,"perms ok",JSON.stringify(await c.delegation(sub,m),(k,v)=>typeof v==="bigint"?v.toString():v));
const r=await c.placeOrder({market:m,price,size,isBuy:false,reduceOnly:false,clientOrderId:"probe-1click",subaccount:sub} as any); console.log("order",JSON.stringify(r));
await new Promise(r=>setTimeout(r,8000));
console.log("pos",JSON.stringify(await c.position(sub,m),(k,v)=>typeof v==="bigint"?v.toString():v));
const r2=await c.placeOrder({market:m,price:(mark*101n/100n)/m.tickSize*m.tickSize,size,isBuy:true,reduceOnly:true,clientOrderId:"probe-1click-c",subaccount:sub} as any); console.log("close",JSON.stringify(r2));
await new Promise(r=>setTimeout(r,8000));
console.log("pos",JSON.stringify(await c.position(sub,m),(k,v)=>typeof v==="bigint"?v.toString():v));
