(() => {
  'use strict';
  const DB_NAME='nmda-file-vault-v1', STORE='files', VERSION=1;
  let dbPromise=null;
  function openDb(){
    if(dbPromise)return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,VERSION);
      req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'});};
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||new Error('无法打开附件临时仓库'));
    });
    return dbPromise;
  }
  async function transact(mode,fn){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,mode),store=tx.objectStore(STORE);let value;try{value=fn(store,tx);}catch(e){reject(e);return;}tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error||new Error('附件临时仓库操作失败'));tx.onabort=()=>reject(tx.error||new Error('附件临时仓库操作被中止'));});}
  async function putFile(file){
    if(!(file instanceof Blob))throw new Error('只能保存本地文件对象。');
    const id=`${Date.now()}-${crypto.randomUUID()}`;
    const record={id,name:String(file.name||'attachment'),type:String(file.type||'application/octet-stream'),size:Number(file.size||0),lastModified:Number(file.lastModified||Date.now()),createdAt:Date.now(),blob:file};
    await transact('readwrite',store=>store.put(record));
    return {id:record.id,name:record.name,type:record.type,size:record.size,lastModified:record.lastModified};
  }
  async function get(id){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readonly'),req=tx.objectStore(STORE).get(String(id||''));req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error||new Error('读取附件失败'));});}
  async function meta(id){const r=await get(id);return r?{id:r.id,name:r.name,type:r.type,size:r.size,lastModified:r.lastModified,createdAt:r.createdAt}:null;}
  async function chunkBase64(id,offset=0,length=262144){const r=await get(id);if(!r)return null;const blob=r.blob.slice(Math.max(0,offset),Math.max(0,offset)+Math.max(1,length));const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';const step=0x8000;for(let i=0;i<bytes.length;i+=step)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(bytes.length,i+step)));return btoa(binary);}
  async function removeMany(ids){const list=[...new Set((ids||[]).filter(Boolean).map(String))];if(!list.length)return;await transact('readwrite',store=>{for(const id of list)store.delete(id);});}
  async function cleanup(maxAgeMs=6*60*60*1000){const cutoff=Date.now()-maxAgeMs,db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),req=store.openCursor();let removed=0;req.onsuccess=()=>{const cur=req.result;if(!cur)return;if(Number(cur.value?.createdAt||0)<cutoff){cur.delete();removed++;}cur.continue();};tx.oncomplete=()=>resolve(removed);tx.onerror=()=>reject(tx.error||new Error('清理附件失败'));});}
  globalThis.NMDAVault={putFile,get,meta,chunkBase64,removeMany,cleanup};
})();
